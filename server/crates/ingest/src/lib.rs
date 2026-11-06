//! replayd-ingest: SDK-facing HTTP handlers (PRD §5.2).
//!
//! Validation is in-memory only: project + public key → Origin allowlist → token bucket per project and
//! per client IP → body size cap → payload magic check → bounded `try_send` (full → `503 Retry-After: 5`).
//! Handlers respond right after enqueueing; nothing on this path touches Postgres or disk, and replay
//! payloads are never decompressed (AGENTS.md rule 5).

pub mod client_ip;
pub mod ignore;
pub mod projects;
pub mod ratelimit;

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use axum::Router;
use axum::body::Body;
use axum::extract::{ConnectInfo, Path, Query, Request, State};
use axum::http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use bytes::Bytes;
use replayd_common::config::IngestConfig;
use serde::Deserialize;
use tokio::sync::mpsc;

pub use projects::{Project, ProjectCache};
pub use ratelimit::{BucketMap, Limits};

/// One `POST /ingest/:pid/events` body, handed to the error pipeline.
#[derive(Debug)]
pub struct EventJob {
    pub project_id: i32,
    pub received_ms: u64,
    /// gzip JSON array or plain JSON array of error events (§4.11).
    pub body: Bytes,
    pub user_agent: Option<String>,
}

/// Receives validated replay segments (implemented by the storage writer, T-21).
pub trait ReplaySink: Send + Sync + 'static {
    /// Must not block. `Err(retry_after_secs)` when the writer queue is full.
    fn submit(&self, project: &Project, body: Bytes, received_ms: u64) -> Result<(), ReplayReject>;
}

#[derive(Debug)]
pub enum ReplayReject {
    Busy,
    Invalid(&'static str),
}

pub struct IngestState {
    pub projects: Arc<ProjectCache>,
    pub limits: Limits,
    pub cfg: IngestConfig,
    pub trusted_proxies: Vec<IpAddr>,
    pub events_tx: mpsc::Sender<EventJob>,
    pub replay: Option<Arc<dyn ReplaySink>>,
}

impl IngestState {
    pub fn new(
        projects: Arc<ProjectCache>,
        cfg: IngestConfig,
        trusted_proxies: Vec<IpAddr>,
        events_tx: mpsc::Sender<EventJob>,
        replay: Option<Arc<dyn ReplaySink>>,
    ) -> Self {
        let limits = Limits {
            projects: BucketMap::new(100_000),
            ips: BucketMap::new(cfg.ip_buckets_max),
        };
        Self {
            projects,
            limits,
            cfg,
            trusted_proxies,
            events_tx,
            replay,
        }
    }

    /// Periodic sweep of idle IP buckets (keeps memory flat).
    pub fn spawn_sweeper(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(std::time::Duration::from_secs(60));
            loop {
                t.tick().await;
                let idle = (me.cfg.ip_burst / me.cfg.ip_rps.max(0.001)).max(60.0);
                me.limits.ips.sweep(idle, Instant::now());
            }
        });
    }
}

pub const DISABLE_HEADER: HeaderName = HeaderName::from_static("x-replayd-disable");
const EXPOSE: HeaderValue = HeaderValue::from_static("Retry-After, X-Replayd-Disable, ETag");

pub fn router(state: Arc<IngestState>, sdk_dir: PathBuf) -> Router {
    // Versioned SDK paths are immutable; `latest/` must be revalidated or sites never see a new release.
    let sdk_service = |dir: PathBuf, cache: &'static str| {
        tower::ServiceBuilder::new()
            .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(
                header::CACHE_CONTROL,
                HeaderValue::from_static(cache),
            ))
            .layer(tower_http::set_header::SetResponseHeaderLayer::overriding(
                header::ACCESS_CONTROL_ALLOW_ORIGIN,
                HeaderValue::from_static("*"),
            ))
            .service(tower_http::services::ServeDir::new(dir))
    };
    Router::new()
        .route("/ingest/{pid}/events", post(events).options(preflight))
        .route("/ingest/{pid}/replay", post(replay).options(preflight))
        .route("/ingest/{pid}/config", get(config).options(preflight))
        .nest_service(
            "/ingest/sdk/latest",
            sdk_service(sdk_dir.join("latest"), "public, max-age=300"),
        )
        .nest_service(
            "/ingest/sdk",
            sdk_service(sdk_dir, "public, max-age=31536000, immutable"),
        )
        .with_state(state)
}

#[derive(Deserialize)]
struct KeyQuery {
    key: Option<String>,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Result of the shared validation chain.
struct Gate {
    project: Arc<Project>,
    origin: Option<HeaderValue>,
}

fn status(code: StatusCode) -> Response {
    code.into_response()
}

fn with_cors(mut r: Response, origin: &Option<HeaderValue>) -> Response {
    if let Some(o) = origin {
        let h = r.headers_mut();
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o.clone());
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
        h.insert(header::ACCESS_CONTROL_EXPOSE_HEADERS, EXPOSE);
    }
    r
}

fn retry_after(code: StatusCode, secs: u64) -> Response {
    let mut r = status(code);
    r.headers_mut()
        .insert(header::RETRY_AFTER, HeaderValue::from(secs));
    r
}

#[allow(clippy::result_large_err)]
fn gate(
    st: &IngestState,
    pid: &str,
    key: Option<&str>,
    headers: &HeaderMap,
    peer: SocketAddr,
    rate_limit: bool,
) -> Result<Gate, Response> {
    let origin_hv = headers.get(header::ORIGIN).cloned();
    let Some(project) = st.projects.get(pid) else {
        return Err(status(StatusCode::FORBIDDEN));
    };
    if key != Some(project.row.public_key.as_str()) {
        return Err(status(StatusCode::FORBIDDEN));
    }
    let origin_str = origin_hv.as_ref().and_then(|o| o.to_str().ok());
    if !project.origin_allowed(origin_str) {
        return Err(status(StatusCode::FORBIDDEN));
    }
    // Only echo a real origin (not "null").
    let origin = origin_hv.filter(|o| o.as_bytes() != b"null");
    if rate_limit {
        let now = Instant::now();
        let c = &st.cfg;
        if let Err(s) = st
            .limits
            .projects
            .take(project.row.id, c.project_rps, c.project_burst, now)
        {
            return Err(with_cors(retry_after(StatusCode::TOO_MANY_REQUESTS, s), &origin));
        }
        let ip = client_ip::client_ip(peer, headers, &st.trusted_proxies);
        if let Err(s) = st.limits.ips.take(ip, c.ip_rps, c.ip_burst, now) {
            return Err(with_cors(retry_after(StatusCode::TOO_MANY_REQUESTS, s), &origin));
        }
    }
    Ok(Gate { project, origin })
}

fn record(project: &str, kind: &'static str, code: StatusCode, started: Instant, bytes: usize) {
    let status = code.as_u16().to_string();
    metrics::counter!("replayd_ingest_requests_total", "project" => project.to_string(), "kind" => kind, "status" => status)
        .increment(1);
    metrics::histogram!("replayd_ingest_latency_seconds", "kind" => kind)
        .record(started.elapsed().as_secs_f64());
    if bytes > 0 {
        metrics::counter!("replayd_ingest_bytes_total", "project" => project.to_string(), "kind" => kind)
            .increment(bytes as u64);
    }
}

async fn read_body(req: Request, limit: usize) -> Result<Bytes, StatusCode> {
    if let Some(len) = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        && len > limit
    {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    axum::body::to_bytes(req.into_body(), limit)
        .await
        .map_err(|_| StatusCode::PAYLOAD_TOO_LARGE)
}

fn accepted(origin: &Option<HeaderValue>) -> Response {
    with_cors(status(StatusCode::ACCEPTED), origin)
}

fn disabled(origin: &Option<HeaderValue>) -> Response {
    let mut r = status(StatusCode::ACCEPTED);
    r.headers_mut()
        .insert(DISABLE_HEADER, HeaderValue::from_static("3600"));
    with_cors(r, origin)
}

fn looks_like_json_array(b: &[u8]) -> bool {
    b.iter().find(|c| !c.is_ascii_whitespace()) == Some(&b'[')
}

async fn events(
    State(st): State<Arc<IngestState>>,
    Path(pid): Path<String>,
    Query(q): Query<KeyQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let started = Instant::now();
    let g = match gate(&st, &pid, q.key.as_deref(), req.headers(), peer, true) {
        Ok(g) => g,
        Err(r) => {
            record("unknown", "events", r.status(), started, 0);
            return r;
        }
    };
    let slug = g.project.row.slug.clone();
    if g.project.disabled {
        record(&slug, "events", StatusCode::ACCEPTED, started, 0);
        return disabled(&g.origin);
    }
    let ua = req
        .headers()
        .get(header::USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s[..s.len().min(512)].to_string());
    let body = match read_body(req, st.cfg.max_events_body).await {
        Ok(b) => b,
        Err(code) => {
            record(&slug, "events", code, started, 0);
            return with_cors(status(code), &g.origin);
        }
    };
    let n = body.len();
    if !(body.starts_with(&replayd_common::wire::GZIP_MAGIC) || looks_like_json_array(&body)) {
        record(&slug, "events", StatusCode::BAD_REQUEST, started, n);
        return with_cors(status(StatusCode::BAD_REQUEST), &g.origin);
    }
    let job = EventJob {
        project_id: g.project.row.id,
        received_ms: now_ms(),
        body,
        user_agent: ua,
    };
    let resp = match st.events_tx.try_send(job) {
        Ok(()) => accepted(&g.origin),
        Err(_) => {
            metrics::counter!("replayd_queue_rejected_total", "queue" => "events").increment(1);
            with_cors(retry_after(StatusCode::SERVICE_UNAVAILABLE, 5), &g.origin)
        }
    };
    record(&slug, "events", resp.status(), started, n);
    resp
}

async fn replay(
    State(st): State<Arc<IngestState>>,
    Path(pid): Path<String>,
    Query(q): Query<KeyQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
) -> Response {
    let started = Instant::now();
    let g = match gate(&st, &pid, q.key.as_deref(), req.headers(), peer, true) {
        Ok(g) => g,
        Err(r) => {
            record("unknown", "replay", r.status(), started, 0);
            return r;
        }
    };
    let slug = g.project.row.slug.clone();
    if g.project.disabled {
        record(&slug, "replay", StatusCode::ACCEPTED, started, 0);
        return disabled(&g.origin);
    }
    let Some(sink) = st.replay.clone() else {
        return with_cors(status(StatusCode::NOT_IMPLEMENTED), &g.origin);
    };
    let body = match read_body(req, st.cfg.max_replay_body).await {
        Ok(b) => b,
        Err(code) => {
            record(&slug, "replay", code, started, 0);
            return with_cors(status(code), &g.origin);
        }
    };
    let n = body.len();
    let resp = match sink.submit(&g.project, body, now_ms()) {
        Ok(()) => accepted(&g.origin),
        Err(ReplayReject::Busy) => {
            metrics::counter!("replayd_queue_rejected_total", "queue" => "replay").increment(1);
            with_cors(retry_after(StatusCode::SERVICE_UNAVAILABLE, 5), &g.origin)
        }
        Err(ReplayReject::Invalid(_)) => with_cors(status(StatusCode::BAD_REQUEST), &g.origin),
    };
    record(&slug, "replay", resp.status(), started, n);
    resp
}

async fn config(
    State(st): State<Arc<IngestState>>,
    Path(pid): Path<String>,
    Query(q): Query<KeyQuery>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    let g = match gate(&st, &pid, q.key.as_deref(), &headers, peer, true) {
        Ok(g) => g,
        Err(r) => {
            record("unknown", "config", r.status(), started, 0);
            return r;
        }
    };
    let p = &g.project;
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == p.config_etag.as_bytes());
    let mut r = if not_modified {
        status(StatusCode::NOT_MODIFIED)
    } else {
        let mut r = Response::new(Body::from(p.config_json.clone()));
        r.headers_mut()
            .insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
        r
    };
    let h = r.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("max-age=300"));
    if let Ok(v) = HeaderValue::from_str(&p.config_etag) {
        h.insert(header::ETAG, v);
    }
    let r = with_cors(r, &g.origin);
    record(&p.row.slug, "config", r.status(), started, 0);
    r
}

async fn preflight(headers: HeaderMap, method: Method) -> Response {
    debug_assert_eq!(method, Method::OPTIONS);
    let mut r = status(StatusCode::NO_CONTENT);
    let h = r.headers_mut();
    if let Some(o) = headers.get(header::ORIGIN) {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o.clone());
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
    }
    h.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST"),
    );
    h.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("content-type"),
    );
    h.insert(header::ACCESS_CONTROL_MAX_AGE, HeaderValue::from_static("86400"));
    r
}

#[cfg(test)]
mod tests;
