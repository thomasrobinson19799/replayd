//! Source-map upload + releases for CI (PRD §5.6), authenticated with the per-project upload token
//! (`Authorization: Bearer rpu_…`, stored as SHA-256). Not cookie/CSRF based: used by `@replayd/cli` and
//! `@replayd/vite-plugin` from CI.
//!
//! `POST /api/projects/:pid/releases/:release/sourcemaps` multipart: one part per map, the part *name* is the
//! `~/path` of the minified file the map belongs to (e.g. `~/_nuxt/entry.Cx1a.js`). Maps are validated,
//! written atomically under `data/_sourcemaps/<pid>/<release>/` and the release's cached lookups are
//! invalidated. Then events of that release whose issue is not yet symbolicated are reprocessed in the
//! background (frames + culprit; grouping keeps the existing issue).

use std::sync::Arc;

use axum::Json;
use axum::extract::{Multipart, Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use replayd_pipeline::SourceMaps;
use replayd_pipeline::stack::Frame;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ApiState;
use crate::auth::token_hash;
use crate::error::{ApiError, ApiResult};

/// Max bytes per uploaded map (nginx caps the whole request at 64 MB).
const MAX_MAP: usize = 48 << 20;
/// Events reprocessed per upload (newest first).
const REPROCESS_LIMIT: i64 = 5000;

fn valid_release(r: &str) -> bool {
    !r.is_empty() && r.len() <= 200 && !r.chars().any(char::is_control)
}

/// Resolves `pid` (id or slug) and checks the bearer upload token. Unknown project and bad token look the same.
async fn authorize(st: &ApiState, pid: &str, headers: &HeaderMap) -> ApiResult<i32> {
    let token = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)?;
    let p = st.projects.get(pid).ok_or(ApiError::Unauthorized)?;
    let c = st.pool.get().await?;
    let row = c
        .query_opt("SELECT upload_token_hash FROM projects WHERE id = $1", &[&p.row.id])
        .await?
        .ok_or(ApiError::Unauthorized)?;
    let stored: Vec<u8> = row.get(0);
    let given = token_hash(token.trim());
    // constant-time compare
    if stored.len() != given.len() || stored.iter().zip(&given).fold(0u8, |a, (x, y)| a | (x ^ y)) != 0 {
        return Err(ApiError::Unauthorized);
    }
    Ok(p.row.id)
}

async fn upsert_release(st: &ApiState, project_id: i32, release: &str) -> ApiResult<()> {
    let c = st.pool.get().await?;
    c.execute(
        "INSERT INTO releases (project_id, version) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        &[&project_id, &release],
    )
    .await?;
    Ok(())
}

#[derive(Deserialize)]
pub struct NewRelease {
    version: String,
}

/// `POST /api/projects/:pid/releases` `{version}` (`replayd releases new`)
pub async fn create_release(
    State(st): State<Arc<ApiState>>,
    Path(pid): Path<String>,
    headers: HeaderMap,
    Json(req): Json<NewRelease>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    let id = authorize(&st, &pid, &headers).await?;
    if !valid_release(&req.version) {
        return Err(ApiError::BadRequest("invalid release".into()));
    }
    upsert_release(&st, id, &req.version).await?;
    Ok((StatusCode::CREATED, Json(json!({ "project_id": id, "version": req.version }))))
}

pub async fn upload(
    State(st): State<Arc<ApiState>>,
    Path((pid, release)): Path<(String, String)>,
    headers: HeaderMap,
    mut mp: Multipart,
) -> ApiResult<Json<Value>> {
    let id = authorize(&st, &pid, &headers).await?;
    if !valid_release(&release) {
        return Err(ApiError::BadRequest("invalid release".into()));
    }
    let maps = st.maps.clone().ok_or(ApiError::Internal("source maps disabled".into()))?;
    let dir = maps.release_path(id, &release);
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let mut files: Vec<String> = vec![];
    while let Some(field) = mp
        .next_field()
        .await
        .map_err(|e| ApiError::BadRequest(format!("multipart: {e}")))?
    {
        let name = field.name().unwrap_or_default().to_string();
        if !name.starts_with("~/") || name.len() > 1024 || name.contains("..") {
            return Err(ApiError::BadRequest(format!("part name must be the file's ~/path: {name:.80}")));
        }
        let data = field
            .bytes()
            .await
            .map_err(|e| ApiError::BadRequest(format!("multipart: {e}")))?;
        if data.len() > MAX_MAP {
            return Err(ApiError::BadRequest(format!("{name}: map larger than 48 MB")));
        }
        if sourcemap::decode_slice(&data).is_err() {
            return Err(ApiError::BadRequest(format!("{name}: not a source map")));
        }
        let file = dir.join(replayd_pipeline::symbolicate::map_file(&name));
        let tmp = file.with_extension("tmp");
        tokio::fs::write(&tmp, &data)
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        tokio::fs::rename(&tmp, &file)
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
        files.push(name);
    }
    if files.is_empty() {
        return Err(ApiError::BadRequest("no source maps in the request".into()));
    }
    upsert_release(&st, id, &release).await?;
    maps.invalidate(id, &release);
    tracing::info!(project_id = id, release = %release, files = files.len(), "source maps uploaded");
    let st2 = st.clone();
    let rel = release.clone();
    tokio::spawn(async move {
        match reprocess(&st2, &maps, id, &rel).await {
            Ok((ev, is)) => tracing::info!(project_id = id, release = %rel, events = ev, issues = is, "reprocessed"),
            Err(e) => tracing::warn!(project_id = id, release = %rel, error = %e, "reprocess failed"),
        }
    });
    Ok(Json(json!({ "release": release, "files": files.len(), "reprocess": true })))
}

/// Re-symbolicates stored frames of `release` events whose issue is not symbolicated yet (§5.5 step 6).
/// Returns (events updated, issues marked symbolicated).
pub async fn reprocess(st: &ApiState, maps: &SourceMaps, project_id: i32, release: &str) -> ApiResult<(usize, usize)> {
    let c = st.pool.get().await?;
    let rows = c
        .query(
            "SELECT e.id, e.ts, e.issue_id, e.payload->'frames' FROM events e JOIN issues i ON i.id = e.issue_id \
             WHERE e.project_id = $1 AND e.release = $2 AND NOT i.symbolicated AND e.ts > now() - interval '15 days' \
             ORDER BY e.ts DESC LIMIT $3",
            &[&project_id, &release, &REPROCESS_LIMIT],
        )
        .await?;
    let mut updated = 0;
    let mut issues: std::collections::HashMap<i64, Option<String>> = std::collections::HashMap::new();
    let upd = c
        .prepare_cached("UPDATE events SET payload = jsonb_set(payload, '{frames}', $3) WHERE id = $1 AND ts = $2")
        .await?;
    for r in rows {
        let frames: Option<Value> = r.get(3);
        let Some(mut frames) = frames.and_then(|v| serde_json::from_value::<Vec<Frame>>(v).ok()) else {
            continue;
        };
        if !maps.symbolicate(project_id, release, &mut frames) {
            continue;
        }
        let id: uuid::Uuid = r.get(0);
        let ts: std::time::SystemTime = r.get(1);
        let v = serde_json::to_value(&frames).unwrap_or(Value::Null);
        c.execute(&upd, &[&id, &ts, &v]).await?;
        updated += 1;
        let culprit = frames
            .iter()
            .find(|f| f.in_app)
            .or(frames.first())
            .and_then(|f| f.orig.as_ref())
            .map(|o| if o.function.is_empty() { o.file.clone() } else { format!("{} ({})", o.function, o.file) });
        issues.entry(r.get(2)).or_insert(culprit);
    }
    for (iid, culprit) in &issues {
        c.execute(
            "UPDATE issues SET symbolicated = true, culprit = COALESCE($2, culprit) WHERE id = $1",
            &[iid, culprit],
        )
        .await?;
    }
    Ok((updated, issues.len()))
}
