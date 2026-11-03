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

    let (events_tx, mut events_rx) = mpsc::channel::<EventJob>(cfg.ingest.events_queue);
    // Error pipeline consumer (T-16 replaces this drain).
    tokio::spawn(async move { while events_rx.recv().await.is_some() {} });

    let ingest = Arc::new(IngestState::new(
        projects.clone(),
        cfg.ingest.clone(),
        cfg.trusted_proxies.clone(),
        events_tx,
        None,
    ));
    ingest.spawn_sweeper();

    let app = base_router().merge(replayd_ingest::router(ingest, cfg.sdk_dir.clone()));
    let listener = tokio::net::TcpListener::bind(cfg.listen).await?;
    tracing::info!(addr = %cfg.listen, version = env!("CARGO_PKG_VERSION"), "replayd listening");
    axum::serve(listener, app.into_make_service_with_connect_info::<SocketAddr>())
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
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
