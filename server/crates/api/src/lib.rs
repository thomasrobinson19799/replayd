//! replayd-api: dashboard API (§5.11), auth, RBAC (§5.10), audit log.

pub mod auth;
pub mod error;
pub mod issues;
pub mod projects;
pub mod rbac;
pub mod redact_rpl;
pub mod sessions;
pub mod sourcemaps;
pub mod users;

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, patch, post, put};
use axum::{Json, Router};
use replayd_db::Pool;
use replayd_ingest::{BucketMap, ProjectCache};
use serde::Deserialize;
use serde_json::{Value, json};

use auth::Auth;
use error::{ApiError, ApiResult};

pub struct ApiState {
    pub pool: Pool,
    pub projects: Arc<ProjectCache>,
    pub members: rbac::Members,
    pub public_url: String,
    pub secure_cookies: bool,
    pub trusted_proxies: Vec<IpAddr>,
    /// Replay files root (`data/<pid>/<day>/<sid>.rpl`).
    pub data_dir: std::path::PathBuf,
    /// Source maps (shared with the error pipeline so uploads invalidate its cache), T-30.
    pub maps: Option<Arc<replayd_pipeline::SourceMaps>>,
    /// Telegram sender (test message from the settings tab), T-32.
    pub alerts: Option<Arc<replayd_alerts::Alerts>>,
    login_ip: BucketMap<IpAddr>,
    login_email: BucketMap<u64>,
}

impl ApiState {
    pub async fn new(
        pool: Pool,
        projects: Arc<ProjectCache>,
        public_url: String,
        secure_cookies: bool,
        trusted_proxies: Vec<IpAddr>,
        data_dir: std::path::PathBuf,
    ) -> Result<Arc<Self>, replayd_db::DbError> {
        let st = Self {
            pool,
            projects,
            members: rbac::Members::default(),
            public_url,
            secure_cookies,
            trusted_proxies,
            maps: None,
            alerts: None,
            data_dir,
            login_ip: BucketMap::new(50_000),
            login_email: BucketMap::new(50_000),
        };
        let c = st.pool.get().await?;
        st.members.reload(&c).await?;
        Ok(Arc::new(st))
    }

    /// Same as [`ApiState::new`] with source maps enabled.
    pub async fn with_maps(
        pool: Pool,
        projects: Arc<ProjectCache>,
        public_url: String,
        secure_cookies: bool,
        trusted_proxies: Vec<IpAddr>,
        data_dir: std::path::PathBuf,
        maps: Arc<replayd_pipeline::SourceMaps>,
    ) -> Result<Arc<Self>, replayd_db::DbError> {
        let st = Self::new(
            pool,
            projects,
            public_url,
            secure_cookies,
            trusted_proxies,
            data_dir,
        )
        .await?;
        let mut st = Arc::try_unwrap(st).unwrap_or_else(|_| unreachable!("fresh Arc"));
        st.maps = Some(maps);
        Ok(Arc::new(st))
    }

    /// Adds the Telegram sender (call before `router`).
    pub fn with_alerts(self: Arc<Self>, alerts: Arc<replayd_alerts::Alerts>) -> Arc<Self> {
        let mut st = Arc::try_unwrap(self).unwrap_or_else(|_| unreachable!("not shared yet"));
        st.alerts = Some(alerts);
        Arc::new(st)
    }

    pub async fn reload_members(&self) -> ApiResult<()> {
        let c = self.pool.get().await?;
        self.members.reload(&c).await?;
        Ok(())
    }

    pub async fn reload_projects(&self) -> ApiResult<()> {
        self.projects.reload(&self.pool).await?;
        Ok(())
    }
}

/// Records an admin action (§5.10: all admin actions → audit_log). `data` must never contain secrets.
pub async fn audit(st: &ApiState, user: &Auth, action: &str, target: &str, data: Value) -> ApiResult<()> {
    let c = st.pool.get().await?;
    c.execute(
        "INSERT INTO audit_log (user_id, action, target, data) VALUES ($1, $2, $3, $4)",
        &[&user.user_id, &action, &target, &data],
    )
    .await?;
    Ok(())
}

pub fn router(st: Arc<ApiState>) -> Router {
    Router::new()
        .route("/api/auth/login", post(login))
        .route("/api/auth/logout", post(logout))
        .route("/api/me", get(me))
        .route("/api/users", get(users::list).post(users::create))
        .route("/api/users/{id}", patch(users::update).delete(users::delete))
        .route("/api/projects", get(projects::list).post(projects::create))
        .route(
            "/api/projects/{pid}",
            get(projects::get_one)
                .patch(projects::update)
                .delete(projects::delete),
        )
        .route("/api/projects/{pid}/keys/rotate", post(projects::rotate_key))
        .route("/api/projects/{pid}/telegram/test", post(projects::telegram_test))
        .route("/api/projects/{pid}/members", get(projects::members))
        .route(
            "/api/projects/{pid}/members/{uid}",
            put(projects::set_member).delete(projects::remove_member),
        )
        .route("/api/projects/{pid}/issues", get(issues::list))
        .route("/api/issues", patch(issues::patch_bulk))
        .route("/api/issues/{id}", get(issues::get_one).patch(issues::patch_one))
        .route("/api/issues/{id}/events", get(issues::events))
        .route("/api/projects/{pid}/sessions", get(sessions::list))
        .route("/api/sessions/{sid}", get(sessions::get_one))
        .route("/api/sessions/{sid}/recording", get(sessions::recording))
        .route("/api/projects/{pid}/releases", post(sourcemaps::create_release))
        .route(
            "/api/projects/{pid}/releases/{release}/sourcemaps",
            post(sourcemaps::upload).layer(axum::extract::DefaultBodyLimit::max(64 << 20)),
        )
        .layer(axum::middleware::map_response(no_store))
        .with_state(st)
}

async fn no_store(mut r: Response) -> Response {
    r.headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    r
}

#[derive(Deserialize)]
struct LoginReq {
    email: String,
    password: String,
}

fn email_key(email: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in email.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

async fn login(
    State(st): State<Arc<ApiState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(req): Json<LoginReq>,
) -> ApiResult<Response> {
    let email = req.email.trim().to_ascii_lowercase();
    let now = Instant::now();
    let ip = replayd_ingest::client_ip::client_ip(peer, &headers, &st.trusted_proxies);
    // 10 attempts burst, then 1 per 6 s per IP; 5 burst, 1 per 12 s per account
    st.login_ip
        .take(ip, 1.0 / 6.0, 10.0, now)
        .map_err(ApiError::TooMany)?;
    st.login_email
        .take(email_key(&email), 1.0 / 12.0, 5.0, now)
        .map_err(ApiError::TooMany)?;

    let c = st.pool.get().await?;
    let row = c
        .query_opt(
            "SELECT id, password_hash, disabled FROM users WHERE email = $1",
            &[&email],
        )
        .await?;
    let stored: Option<String> = row.as_ref().map(|r| r.get(1));
    let pw = req.password.clone();
    let ok = tokio::task::spawn_blocking(move || auth::verify_password(&pw, stored.as_deref()))
        .await
        .unwrap_or(false);
    let Some(row) = row.filter(|r| ok && !r.get::<_, bool>(2)) else {
        return Err(ApiError::Unauthorized);
    };
    let user_id: i32 = row.get(0);
    let token = auth::random_token();
    let csrf = auth::random_token();
    c.execute(
        "INSERT INTO user_sessions (token_hash, user_id, csrf_token, expires_at) \
         VALUES ($1, $2, $3, now() + make_interval(days => $4))",
        &[
            &auth::token_hash(&token),
            &user_id,
            &csrf,
            &(auth::SESSION_DAYS as i32),
        ],
    )
    .await?;
    c.execute("DELETE FROM user_sessions WHERE expires_at < now()", &[])
        .await?;
    let mut r = Json(json!({ "ok": true, "csrf": csrf })).into_response();
    for v in auth::set_cookie_headers(&token, &csrf, st.secure_cookies, auth::SESSION_DAYS * 86400) {
        r.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_str(&v).map_err(|e| ApiError::Internal(e.to_string()))?,
        );
    }
    Ok(r)
}

async fn logout(State(st): State<Arc<ApiState>>, user: Auth) -> ApiResult<Response> {
    let c = st.pool.get().await?;
    c.execute(
        "DELETE FROM user_sessions WHERE token_hash = $1",
        &[&user.token_hash],
    )
    .await?;
    let mut r = StatusCode::NO_CONTENT.into_response();
    for v in auth::set_cookie_headers("", "", st.secure_cookies, 0) {
        r.headers_mut().append(
            header::SET_COOKIE,
            HeaderValue::from_str(&v).map_err(|e| ApiError::Internal(e.to_string()))?,
        );
    }
    Ok(r)
}

async fn me(State(st): State<Arc<ApiState>>, user: Auth) -> ApiResult<Json<Value>> {
    let projects: Vec<Value> = st
        .projects
        .all()
        .into_iter()
        .filter_map(|p| {
            let role = if user.is_superadmin {
                Some("admin")
            } else {
                user.role(&st, p.row.id).map(|r| r.as_str())
            }?;
            Some(json!({ "id": p.row.id, "slug": p.row.slug, "name": p.row.name, "role": role }))
        })
        .collect();
    Ok(Json(json!({
        "id": user.user_id,
        "email": user.email,
        "name": user.name,
        "is_superadmin": user.is_superadmin,
        "csrf": user.csrf,
        "projects": projects,
    })))
}

/// Creates the first superadmin from `REPLAYD_BOOTSTRAP_ADMIN_*` if there are no users yet.
pub async fn bootstrap_admin(pool: &Pool, email: Option<&str>, password: Option<&str>) -> ApiResult<bool> {
    let (Some(email), Some(password)) = (email, password) else {
        return Ok(false);
    };
    let c = pool.get().await?;
    let n: i64 = c.query_one("SELECT count(*) FROM users", &[]).await?.get(0);
    if n > 0 {
        return Ok(false);
    }
    auth::validate_password(password)?;
    let pw = password.to_string();
    let hash = tokio::task::spawn_blocking(move || auth::hash_password(&pw))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))??;
    c.execute(
        "INSERT INTO users (email, name, password_hash, is_superadmin) VALUES ($1, 'Admin', $2, true)",
        &[&email.trim().to_ascii_lowercase(), &hash],
    )
    .await?;
    tracing::info!("bootstrap superadmin created");
    Ok(true)
}
