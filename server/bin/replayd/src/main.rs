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

fn base_router() -> Router {
    Router::new().route("/healthz", get(|| async { "ok" }))
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

    let pool = replayd_db::pool(&cfg.database_url, cfg.db_pool_size)?;
    wait_for_db(&pool).await?;
    {
        let c = pool.get().await?;
        replayd_db::ensure_partitions(&c, 1, 7)
            .await
            .context("ensuring partitions")?;
    }
    spawn_partitions(pool.clone());

    let projects = Arc::new(ProjectCache::default());
    let n = projects.reload(&pool).await.context("loading projects")?;
    tracing::info!(projects = n, "project cache loaded");
    projects.spawn_refresh(pool.clone(), Duration::from_secs(cfg.ingest.project_refresh_secs));

    let (events_tx, events_rx) = mpsc::channel::<EventJob>(cfg.ingest.events_queue);
    // Error pipeline: 3 workers share the bounded queue (§5.5). Alert signals are wired in T-32.
    // Source maps (T-30): one cache shared by the pipeline (lookups) and the API (uploads invalidate it).
    let maps = replayd_pipeline::SourceMaps::new(&cfg.data_dir);
    let pipeline =
        replayd_pipeline::Shared::with_maps(pool.clone(), projects.clone(), None, Some(maps.clone()));
    let (shutdown_tx, shutdown_rx) = tokio::sync::watch::channel(false);
    let mut workers = replayd_pipeline::spawn(pipeline, events_rx, 3, shutdown_rx.clone());

    // Replay storage: sharded .rpl writers + session aggregator (§5.3, §5.4).
    let writers =
        replayd_storage::Writers::start(replayd_storage::WriterConfig::new(cfg.data_dir.clone()), None)
            .context("starting replay writers")?;
    let (sessions_tx, sessions_rx) = mpsc::channel(50_000);
    workers.push(replayd_storage::aggregator::spawn(
        pool.clone(),
        sessions_rx,
        shutdown_rx,
    ));
    let sink: Arc<dyn replayd_ingest::ReplaySink> = Arc::new(replayd_storage::StorageSink {
        writers: writers.clone(),
        sessions: sessions_tx,
    });

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
    .await?;

    let app = base_router()
        .merge(replayd_ingest::router(ingest, cfg.sdk_dir.clone()))
        .merge(replayd_api::router(api));
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
        let res = base_router()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
