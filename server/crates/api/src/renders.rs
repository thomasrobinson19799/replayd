//! Bounded, restart-persistent MP4 spool. Chromium/ffmpeg run in a separate, networkless service.
use crate::{
    ApiState,
    auth::Auth,
    error::{ApiError, ApiResult},
    sessions, shares,
};
use axum::{
    Json,
    body::Body,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, StatusCode, header},
    response::Response,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    net::{IpAddr, SocketAddr},
    path::{Path as FsPath, PathBuf},
    sync::Arc,
    time::{Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::Mutex,
};

const MAX_JOBS: usize = 512;
const MAX_ACTIVE: usize = 12;
const MAX_FILE: u64 = 2 << 30;
const MAX_DISK: u64 = 32 << 30;
const TTL: u64 = 86_400_000;
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn io(e: std::io::Error) -> ApiError {
    ApiError::Internal(e.to_string())
}
fn later() -> ApiError {
    ApiError::Conflict("Render capacity is full. Please try later.".into())
}

#[derive(Serialize, Deserialize, Clone)]
pub struct Job {
    pub id: String,
    pub sid: String,
    pub project_id: i32,
    pub day: String,
    pub source_len: u64,
    pub covered_until: i64,
    pub created_at: u64,
}
#[derive(Serialize, Deserialize, Clone)]
pub struct Progress {
    pub state: String,
    pub progress: u32,
    pub updated_at: u64,
    pub finished_at: Option<u64>,
}
#[derive(Default)]
struct Admission {
    requests: HashMap<[u8; 32], VecDeque<Instant>>,
}
pub struct Renders {
    root: PathBuf,
    gate: Mutex<Admission>,
    salt: String,
}
impl Renders {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            gate: Mutex::new(Admission::default()),
            salt: crate::auth::random_token(),
        }
    }
    fn key(&self, ip: IpAddr) -> [u8; 32] {
        Sha256::digest(format!("{}:{ip}", self.salt)).into()
    }
    async fn job(&self, sid: &str) -> Option<Job> {
        read_json(&self.root.join(sid).join("job.json")).await
    }
    async fn progress(&self, job: &Job) -> Progress {
        read_json(&self.root.join(&job.sid).join("status.json"))
            .await
            .unwrap_or(Progress {
                state: "queued".into(),
                progress: 0,
                updated_at: job.created_at,
                finished_at: None,
            })
    }
    async fn entries(&self) -> ApiResult<Vec<Job>> {
        tokio::fs::create_dir_all(&self.root).await.map_err(io)?;
        let mut entries = tokio::fs::read_dir(&self.root).await.map_err(io)?;
        let mut jobs = Vec::new();
        while let Some(e) = entries.next_entry().await.map_err(io)? {
            if jobs.len() >= MAX_JOBS {
                break;
            }
            if let Ok(sid) = uuid::Uuid::parse_str(&e.file_name().to_string_lossy()) {
                if let Some(job) = self.job(&sid.to_string()).await {
                    jobs.push(job);
                } else {
                    // Called under the admission lock: an unpublished snapshot is
                    // left by an interrupted copy, never by a concurrent admission.
                    self.remove(&sid.to_string()).await;
                }
            }
        }
        Ok(jobs)
    }
    pub async fn remove(&self, sid: &str) {
        let _ = tokio::fs::remove_dir_all(self.root.join(sid)).await;
    }
    pub async fn sweep(&self, pool: &replayd_db::Pool) {
        let _guard = self.gate.lock().await;
        if let Ok(jobs) = self.entries().await {
            for job in jobs {
                let p = self.progress(&job).await;
                let expired = now().saturating_sub(p.finished_at.unwrap_or(job.created_at)) >= TTL;
                let exists = if let Ok(c) = pool.get().await {
                    c.query_opt("SELECT 1 FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = $1::text::uuid AND s.project_id = $2 AND s.file_day >= (now() AT TIME ZONE 'UTC')::date - p.retention_days + 1 LIMIT 1", &[&job.sid, &job.project_id]).await.ok().map(|r| r.is_some())
                } else {
                    None
                };
                if expired || exists == Some(false) {
                    self.remove(&job.sid).await;
                }
            }
        }
    }
}
async fn read_json<T: serde::de::DeserializeOwned>(p: &FsPath) -> Option<T> {
    let f = tokio::fs::File::open(p).await.ok()?;
    let mut b = Vec::new();
    f.take(16_384).read_to_end(&mut b).await.ok()?;
    serde_json::from_slice(&b).ok()
}
async fn snapshot(st: &ApiState, row: &replayd_db::tokio_postgres::Row) -> ApiResult<PathBuf> {
    sessions::locate_recording(
        st,
        row.get(1),
        &row.get::<_, String>(29),
        &row.get::<_, String>(0),
    )
    .await
}
async fn status_for(st: &ApiState, row: &replayd_db::tokio_postgres::Row) -> ApiResult<Json<Value>> {
    let sid: String = row.get(0);
    let Some(job) = st.renders.job(&sid).await else {
        return Ok(Json(json!({"state":"none"})));
    };
    let p = st.renders.progress(&job).await;
    if now().saturating_sub(p.finished_at.unwrap_or(job.created_at)) >= TTL {
        return Ok(Json(json!({"state":"none"})));
    }
    let current = tokio::fs::metadata(snapshot(st, row).await?)
        .await
        .map_err(io)?
        .len();
    Ok(Json(
        json!({"state":p.state,"progress":p.progress,"covered_until":job.covered_until,"partial": current > job.source_len, "expires_at":p.finished_at.map(|t|t+TTL)}),
    ))
}

#[derive(Deserialize, Default)]
pub struct Start {
    #[serde(default)]
    latest: bool,
}
async fn enqueue(
    st: &ApiState,
    row: &replayd_db::tokio_postgres::Row,
    req: Start,
    ip: Option<IpAddr>,
) -> ApiResult<Json<Value>> {
    let sid: String = row.get(0);
    let mut admission = st.renders.gate.lock().await;
    if let Some(job) = st.renders.job(&sid).await {
        let p = st.renders.progress(&job).await;
        if p.state == "queued"
            || p.state == "rendering"
            || (p.state == "ready" && !req.latest && now().saturating_sub(p.finished_at.unwrap_or(0)) < TTL)
        {
            return status_for(st, row).await;
        }
    }
    let jobs = st.renders.entries().await?;
    let mut active = 0;
    let mut used = 0u64;
    for job in &jobs {
        let p = st.renders.progress(job).await;
        if p.state == "queued" || p.state == "rendering" {
            active += 1;
            used += MAX_FILE + job.source_len;
        } else {
            used += tokio::fs::metadata(st.renders.root.join(&job.sid).join("output.mp4"))
                .await
                .map(|m| m.len())
                .unwrap_or(0);
        }
    }
    if active >= MAX_ACTIVE || jobs.len() >= MAX_JOBS || used + MAX_FILE * 2 > MAX_DISK {
        return Err(later());
    }
    let key = ip.map(|ip| st.renders.key(ip));
    if let Some(key) = key {
        let t = Instant::now();
        admission.requests.retain(|_, v| {
            while v.front().is_some_and(|x| t.duration_since(*x).as_secs() >= 3600) {
                v.pop_front();
            }
            !v.is_empty()
        });
        if admission.requests.get(&key).is_some_and(|v| v.len() >= 10)
            || (!admission.requests.contains_key(&key) && admission.requests.len() >= 50_000)
        {
            return Err(ApiError::TooMany(3600));
        }
    }
    let path = snapshot(st, row).await?;
    let mut input = tokio::fs::File::open(path).await.map_err(io)?;
    let source_len = input.metadata().await.map_err(io)?.len();
    if source_len > MAX_FILE {
        return Err(later());
    }
    st.renders.remove(&sid).await;
    let dir = st.renders.root.join(&sid);
    tokio::fs::create_dir_all(&dir).await.map_err(io)?;
    let mut out = tokio::fs::File::create(dir.join("input.rpl")).await.map_err(io)?;
    tokio::io::copy(&mut (&mut input).take(source_len), &mut out)
        .await
        .map_err(io)?;
    out.flush().await.map_err(io)?;
    let job = Job {
        id: uuid::Uuid::now_v7().to_string(),
        sid,
        project_id: row.get(1),
        day: row.get(29),
        source_len,
        covered_until: row.get(3),
        created_at: now(),
    };
    tokio::fs::write(
        dir.join("job.tmp"),
        serde_json::to_vec(&job).map_err(|_| ApiError::Internal("render metadata".into()))?,
    )
    .await
    .map_err(io)?;
    tokio::fs::rename(dir.join("job.tmp"), dir.join("job.json"))
        .await
        .map_err(io)?;
    if let Some(key) = key {
        admission
            .requests
            .entry(key)
            .or_default()
            .push_back(Instant::now());
    }
    status_for(st, row).await
}
pub async fn status(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
) -> ApiResult<Json<Value>> {
    status_for(&st, &sessions::load(&st, &user, &sid).await?).await
}
pub async fn start(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
    Json(req): Json<Start>,
) -> ApiResult<Json<Value>> {
    enqueue(&st, &sessions::load(&st, &user, &sid).await?, req, None).await
}
pub async fn public_status(
    State(st): State<Arc<ApiState>>,
    Path(token): Path<String>,
) -> ApiResult<Json<Value>> {
    status_for(&st, &shares::resolve(&st, &token).await?).await
}
pub async fn public_start(
    State(st): State<Arc<ApiState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(token): Path<String>,
    headers: HeaderMap,
    Json(req): Json<Start>,
) -> ApiResult<Json<Value>> {
    let row = shares::resolve(&st, &token).await?;
    let ip = replayd_ingest::client_ip::client_ip(peer, &headers, &st.trusted_proxies);
    enqueue(&st, &row, req, Some(ip)).await
}
async fn file(st: &ApiState, row: &replayd_db::tokio_postgres::Row) -> ApiResult<Response> {
    let sid: String = row.get(0);
    let job = st.renders.job(&sid).await.ok_or(ApiError::NotFound)?;
    let p = st.renders.progress(&job).await;
    if p.state != "ready" || now().saturating_sub(p.finished_at.unwrap_or(0)) >= TTL {
        return Err(ApiError::NotFound);
    }
    let f = tokio::fs::File::open(st.renders.root.join(&sid).join("output.mp4"))
        .await
        .map_err(|_| ApiError::NotFound)?;
    let len = f.metadata().await.map_err(io)?.len();
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "video/mp4")
        .header(header::CONTENT_LENGTH, len)
        .header(
            header::CONTENT_DISPOSITION,
            format!("attachment; filename=\"replay-{sid}.mp4\""),
        )
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(f)))
        .map_err(|_| ApiError::Internal("video response".into()))
}
pub async fn download(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
) -> ApiResult<Response> {
    file(&st, &sessions::load(&st, &user, &sid).await?).await
}
pub async fn public_download(
    State(st): State<Arc<ApiState>>,
    Path(token): Path<String>,
) -> ApiResult<Response> {
    file(&st, &shares::resolve(&st, &token).await?).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn queue_reuse_rate_limit_expiry_and_session_cleanup() {
        let Some(pool) = replayd_db::test_pool() else {
            return;
        };
        let c = pool.get().await.unwrap();
        replayd_db::ensure_partitions(&c, 1, 7).await.unwrap();
        let slug = format!("render-test-{}", uuid::Uuid::now_v7());
        let pid: i32 = c.query_one("INSERT INTO projects (slug,name,public_key,upload_token_hash) VALUES ($1,'Render test','test','\\x00') RETURNING id", &[&slug]).await.unwrap().get(0);
        let dir = std::env::temp_dir().join(&slug);
        let projects = Arc::new(replayd_ingest::ProjectCache::default());
        projects.reload(&pool).await.unwrap();
        let st = ApiState::new(
            pool.clone(),
            projects,
            "http://localhost".into(),
            false,
            vec![],
            dir.clone(),
        )
        .await
        .unwrap();
        let mut ids = Vec::new();
        for _ in 0..13 {
            let id = uuid::Uuid::now_v7();
            let day: String = c.query_one("INSERT INTO sessions (id,project_id,started_at,last_at,file_day) VALUES ($1,$2,now(),now(),(now() AT TIME ZONE 'UTC')::date) RETURNING file_day::text", &[&id,&pid]).await.unwrap().get(0);
            let path = sessions::recording_path(&dir, pid, &day, &id.to_string());
            tokio::fs::create_dir_all(path.parent().unwrap()).await.unwrap();
            tokio::fs::write(path, replayd_common::rpl::encode_header(id.as_bytes()))
                .await
                .unwrap();
            ids.push(id);
        }
        for id in &ids[..12] {
            let row = sessions::load_public(&st, &id.to_string()).await.unwrap();
            assert_eq!(
                enqueue(&st, &row, Start::default(), None).await.unwrap().0["state"],
                "queued"
            );
        }
        let last = sessions::load_public(&st, &ids[12].to_string()).await.unwrap();
        assert!(matches!(
            enqueue(&st, &last, Start::default(), None).await,
            Err(ApiError::Conflict(_))
        ));
        let first = sessions::load_public(&st, &ids[0].to_string()).await.unwrap();
        let old = st.renders.job(&ids[0].to_string()).await.unwrap().id;
        assert_eq!(
            enqueue(&st, &first, Start::default(), Some("127.0.0.1".parse().unwrap()))
                .await
                .unwrap()
                .0["state"],
            "queued"
        );
        assert_eq!(st.renders.job(&ids[0].to_string()).await.unwrap().id, old);
        assert!(
            st.renders.gate.lock().await.requests.is_empty(),
            "reuse is not rate counted"
        );
        for id in &ids {
            st.renders.remove(&id.to_string()).await;
        }
        let ip = Some("127.0.0.1".parse().unwrap());
        for _ in 0..10 {
            let _ = enqueue(&st, &first, Start::default(), ip).await.unwrap();
            st.renders.remove(&ids[0].to_string()).await;
        }
        assert!(matches!(
            enqueue(&st, &first, Start::default(), ip).await,
            Err(ApiError::TooMany(_))
        ));
        let _ = enqueue(&st, &first, Start::default(), None).await.unwrap();
        let folder = st.renders.root.join(ids[0].to_string());
        tokio::fs::write(
            folder.join("status.json"),
            serde_json::to_vec(&Progress {
                state: "ready".into(),
                progress: 100,
                updated_at: now(),
                finished_at: Some(now() - TTL - 1),
            })
            .unwrap(),
        )
        .await
        .unwrap();
        assert_eq!(status_for(&st, &first).await.unwrap().0["state"], "none");
        st.renders.sweep(&pool).await;
        assert!(!folder.exists());
        let _ = enqueue(&st, &first, Start::default(), None).await.unwrap();
        c.execute("DELETE FROM sessions WHERE project_id = $1", &[&pid])
            .await
            .unwrap();
        st.renders.sweep(&pool).await;
        assert!(!folder.exists());
        c.execute("DELETE FROM projects WHERE id = $1", &[&pid])
            .await
            .unwrap();
        tokio::fs::remove_dir_all(dir).await.unwrap();
    }
}
