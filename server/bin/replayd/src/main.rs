//! replayd single binary.

use std::net::SocketAddr;

use axum::{Router, routing::get};
use tracing_subscriber::{EnvFilter, fmt};

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

fn router() -> Router {
    Router::new().route("/healthz", get(|| async { "ok" }))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    fmt()
        .json()
        .flatten_event(true)
        .with_current_span(false)
        .with_env_filter(EnvFilter::try_from_env("REPLAYD_LOG").unwrap_or_else(|_| EnvFilter::new("info")))
        .init();
    let addr: SocketAddr = std::env::var("REPLAYD_LISTEN")
        .unwrap_or_else(|_| "0.0.0.0:8080".into())
        .parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, version = env!("CARGO_PKG_VERSION"), "replayd listening");
    axum::serve(listener, router())
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
        let res = router()
            .oneshot(Request::get("/healthz").body(Body::empty()).unwrap())
            .await
            .unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }
}
