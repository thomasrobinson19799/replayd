//! replayd single binary: ingest + pipeline + dashboard API in one process (PRD §3).

use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Context;
use axum::{Router, routing::get};
use replayd_common::config::Config;
use replayd_ingest::{EventJob, IngestState, ProjectCache};
use tokio::sync::mpsc;
use tracing_subscriber::{EnvFilter, fmt};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn base_router(prom: metrics_exporter_prometheus::PrometheusHandle) -> Router {
    Router::new()
        .route("/healthz", get(|| async { "ok" }))
        // scraped from the internal network on :8080; nginx answers 404 for /metrics (§7)
        .route(
            "/metrics",
            get(move || {
                let p = prom.clone();
                async move {
                    (
                        [(axum::http::header::CONTENT_TYPE, "text/plain; version=0.0.4")],
                        p.render(),
                    )
                }
            }),
        )
}

/// Prometheus recorder with latency buckets suited to the budgets (ingest p99 < 5 ms, alert > 20 ms).
fn install_metrics() -> anyhow::Result<metrics_exporter_prometheus::PrometheusHandle> {
    use metrics_exporter_prometheus::{Matcher, PrometheusBuilder};
    let fast = [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.25, 1.0];
    let slow = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 10.0, 60.0];
    Ok(PrometheusBuilder::new()
        .set_buckets_for_metric(Matcher::Full("replayd_ingest_latency_seconds".into()), &fast)?
        .set_buckets_for_metric(Matcher::Full("replayd_api_latency_seconds".into()), &slow)?
        .set_buckets_for_metric(Matcher::Suffix("_seconds".into()), &slow)?
        .install_recorder()?)
}

/// Named queue → current depth.
type QueueDepth = (&'static str, Box<dyn Fn() -> usize + Send + Sync>);

/// Disk + queue gauges every 15 s (§7: `replayd_disk_used_bytes`, `replayd_disk_free_bytes`, `replayd_queue_depth`).
fn spawn_gauges(data_dir: std::path::PathBuf, queues: Vec<QueueDepth>) {
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(15));
        loop {
            t.tick().await;
            let d = data_dir.clone();
            if let Ok(Ok((total, avail))) = tokio::task::spawn_blocking(move || {
                std::fs::create_dir_all(&d)?;
                Ok::<_, std::io::Error>((fs4::total_space(&d)?, fs4::available_space(&d)?))
            })
            .await
            {
                metrics::gauge!("replayd_disk_free_bytes").set(avail as f64);
                metrics::gauge!("replayd_disk_used_bytes").set(total.saturating_sub(avail) as f64);
                metrics::gauge!("replayd_disk_total_bytes").set(total as f64);
            }
            for (q, depth) in &queues {
                metrics::gauge!("replayd_queue_depth", "queue" => *q).set(depth() as f64);
            }
        }
    });
}

/// Dashboard API request log + latency (§7 log fields: req_id, latency_ms; never payloads, keys or tokens).
async fn api_log(req: axum::extract::Request, next: axum::middleware::Next) -> axum::response::Response {
    let started = std::time::Instant::now();
    let method = req.method().clone();
    // path template-ish: ids collapsed so the label/log stays low-cardinality
    let path = req
        .uri()
        .path()
        .split('/')
        .map(|s| {
            if s.len() > 12 || s.chars().all(|c| c.is_ascii_digit()) && !s.is_empty() {
                ":id"
            } else {
                s
            }
        })
        .collect::<Vec<_>>()
        .join("/");
    let req_id = uuid::Uuid::now_v7();
    let res = next.run(req).await;
    let ms = started.elapsed().as_secs_f64() * 1e3;
    let status = res.status().as_u16();
    metrics::histogram!("replayd_api_latency_seconds").record(ms / 1e3);
    if status >= 500 {
        tracing::warn!(%req_id, method = %method, path = %path, status, latency_ms = ms, "api request");
    } else {
        tracing::info!(%req_id, method = %method, path = %path, status, latency_ms = ms, "api request");
    }
    res
}

/// Retries the first DB contact so the server can start before Postgres is ready.
async fn wait_for_db(pool: &replayd_db::Pool) -> anyhow::Result<()> {
    let mut delay = Duration::from_millis(250);
    for attempt in 1..=40 {
        match pool.get().await {
            Ok(c) => {
                c.simple_query("SELECT 1").await?;
                return Ok(());
            }
            Err(e) => {
                tracing::warn!(attempt, error = %e, "waiting for postgres");
                tokio::time::sleep(delay).await;
                delay = (delay * 2).min(Duration::from_secs(5));
            }
        }
    }
    anyhow::bail!("postgres not reachable")
}

/// Daily partition maintenance (§5.8): keep partitions from yesterday to 7 days ahead.
fn spawn_partitions(pool: replayd_db::Pool) {
    tokio::spawn(async move {
        let mut t = tokio::time::interval(Duration::from_secs(3600));
        loop {
            t.tick().await;
            match pool.get().await {
                Ok(c) => match replayd_db::ensure_partitions(&c, 1, 7).await {
                    Ok(n) if n > 0 => tracing::info!(created = n, "partitions created"),
                    Ok(_) => {}
                    Err(e) => tracing::error!(error = %e, "partition maintenance failed"),
                },
                Err(e) => tracing::error!(error = %e, "partition maintenance: no connection"),
            }
        }
    });
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_env_filter(EnvFilter::try_from_env("REPLAYD_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let cfg = Config::load().context("loading config")?;
    let prom = install_metrics().context("metrics recorder")?;

    let pool = replayd_db::pool(&cfg.database_url, cfg.db_pool_size)?;
    wait_for_db(&pool).await?;
    {
        let c = pool.get().await?;
        replayd_db::ensure_partitions(&c, 1, 7)
            .await
            .context("ensuring partitions")?;
    }
    spawn_partitions(pool.clone());
    // Bucket tier for finished recordings (D-37); off unless configured.
    let replay_store = cfg
        .object_storage
        .as_ref()
        .map(|o| replayd_objstore::ReplayStore::from_config(o, &cfg.data_dir).map(Arc::new))
        .transpose()
        .context("object storage")?;
    // retention (§5.8): daily 03:00 Asia/Tehran
    let _retention =
        replayd_storage::retention::spawn(pool.clone(), cfg.data_dir.clone(), replay_store.clone());

    let projects = Arc::new(ProjectCache::default());
    let n = projects.reload(&pool).await.context("loading projects")?;
    tracing::info!(projects = n, "project cache loaded");
    projects.spawn_refresh(pool.clone(), Duration::from_secs(cfg.ingest.project_refresh_secs));

    let (events_tx, events_rx) = mpsc::channel::<EventJob>(cfg.ingest.events_queue);
    // Error pipeline: 3 workers share the bounded queue (§5.5).
    // Source maps (T-30): one cache shared by the pipeline (lookups) and the API (uploads invalidate it).
    let maps = replayd_pipeline::SourceMaps::new(&cfg.data_dir);
    // Telegram alerts (T-32): bounded signal channel from the pipeline (try_send; full → counted, dropped).
    let (signals_tx, signals_rx) = mpsc::channel(10_000);
    let pipeline_signals_weak = signals_tx.downgrade();
    let alerts = replayd_alerts::Alerts::new(
        pool.clone(),
        projects.clone(),
        cfg.public_url.clone(),
        cfg.telegram_api.clone(),
    );
    let pipeline = replayd_pipeline::Shared::with_maps(
        pool.clone(),
        projects.clone(),
        Some(signals_tx),
        Some(maps.clone()),
    );
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut workers = replayd_pipeline::spawn(pipeline, events_rx, 3, shutdown_rx.clone());

    // Replay storage: sharded .rpl writers + session aggregator (§5.3, §5.4).
    let writers =
        replayd_storage::Writers::start(replayd_storage::WriterConfig::new(cfg.data_dir.clone()), None)
            .context("starting replay writers")?;
    let _uploader = replay_store
        .clone()
        .map(|s| replayd_storage::uploader::spawn(s, writers.clone(), cfg.data_dir.clone()));
    let (sessions_tx, sessions_rx) = mpsc::channel(50_000);
    let sink_sessions_weak = sessions_tx.downgrade();
    workers.push(replayd_storage::aggregator::spawn(
        pool.clone(),
        sessions_rx,
        shutdown_rx,
    ));
    let sink: Arc<dyn replayd_ingest::ReplaySink> = Arc::new(replayd_storage::StorageSink {
        writers: writers.clone(),
        sessions: sessions_tx,
    });

    // queue depth gauges hold weak senders only (they must not keep the channels open on shutdown)
    let weak = |tx: &mpsc::Sender<_>| tx.downgrade();
    let (wq_events, wq_signals) = (weak(&events_tx), pipeline_signals_weak);
    let wq_sessions = sink_sessions_weak;
    spawn_gauges(
        cfg.data_dir.clone(),
        vec![
            (
                "events",
                Box::new(move || {
                    wq_events
                        .upgrade()
                        .map(|s| s.max_capacity() - s.capacity())
                        .unwrap_or(0)
                }),
            ),
            (
                "signals",
                Box::new(move || {
                    wq_signals
                        .upgrade()
                        .map(|s| s.max_capacity() - s.capacity())
                        .unwrap_or(0)
                }),
            ),
            (
                "sessions",
                Box::new(move || {
                    wq_sessions
                        .upgrade()
                        .map(|s| s.max_capacity() - s.capacity())
                        .unwrap_or(0)
                }),
            ),
        ],
    );
    let ingest = Arc::new(IngestState::new(
        projects.clone(),
        cfg.ingest.clone(),
        cfg.trusted_proxies.clone(),
        events_tx,
        Some(sink),
    ));
    ingest.spawn_sweeper();

    replayd_api::bootstrap_admin(
        &pool,
        cfg.bootstrap_admin_email.as_deref(),
        cfg.bootstrap_admin_password.as_deref(),
    )
    .await
    .map_err(|e| anyhow::anyhow!("bootstrap admin: {e}"))?;
    let api = replayd_api::ApiState::with_maps(
        pool.clone(),
        projects.clone(),
        cfg.public_url.clone(),
        cfg.secure_cookies,
        cfg.trusted_proxies.clone(),
        cfg.data_dir.clone(),
        maps,
    )
    .await?
    .with_alerts(alerts.clone())
    .with_replay_store(replay_store);
    // ends when the pipeline (the only sender) is dropped
    let _alerts_task = replayd_alerts::spawn(alerts, signals_rx);

    let app = base_router(prom)
        .merge(replayd_ingest::router(ingest, cfg.sdk_dir.clone()))
        .merge(replayd_api::router(api).layer(axum::middleware::from_fn(api_log)));
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    tracing::info!(addr = %cfg.listen, version = env!("CARGO_PKG_VERSION"), "replayd listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    // Stop accepting, then let the pipeline drain the queue and flush (bounded wait).
    tracing::info!("shutting down: draining queues");
    let w = writers.clone();
    let _ = tokio::task::spawn_blocking(move || w.sync_all()).await;
    let _ = shutdown_tx.send(true);
    let drained =
        tokio::time::timeout(Duration::from_secs(20), futures_util::future::join_all(workers)).await;
    if drained.is_err() {
        tracing::warn!("pipeline drain timed out");
    }
    Ok(())
}

/// SIGINT (Ctrl-C) or SIGTERM (`docker stop`, systemd).
async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let term = async {
        match tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate()) {
            Ok(mut s) => {
                s.recv().await;
            }
            Err(_) => std::future::pending::<()>().await,
        }
    };
    #[cfg(not(unix))]
    let term = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {},
        _ = term => {},
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::Body;
    use axum::http::{Request, StatusCode};
    use tower::ServiceExt;

    #[tokio::test]
    async fn healthz_ok() {
        let prom = metrics_exporter_prometheus::PrometheusBuilder::new()
            .build_recorder()
            .handle();
        let res = base_router(prom.clone())
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
        let res = base_router(prom)
            .oneshot(Request::get("/metrics").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
