//! Sessions (§5.11): list with filters (keyset, 50/page), detail (meta + error events), raw recording
//! download (`Range`, `ETag`, immutable once ended).

use std::path::PathBuf;
use std::sync::Arc;

use axum::Json;
use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use replayd_db::tokio_postgres::Row;
use replayd_db::tokio_postgres::types::ToSql;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncSeekExt};
use uuid::Uuid;

use crate::ApiState;
use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::projects::resolve;
use crate::rbac::Perm;

pub const PAGE: i64 = 50;
const DAY_MS: i64 = 86_400_000;

const COLS: &str = "id::text, project_id, (extract(epoch from started_at) * 1000)::bigint, \
    (extract(epoch from last_at) * 1000)::bigint, ended, duration_ms, entry_url, user_id, user_email, release, \
    environment, platform, app_version, device_model, os_version, webview_version, browser, browser_ver, os, vw, vh, \
    lang, error_count, warn_count, click_count, ws_disconnects, segments, bytes, has_gap, file_day::text";

pub(crate) fn session_json(r: &Row) -> Value {
    json!({
        "id": r.get::<_, String>(0),
        "project_id": r.get::<_, i32>(1),
        "started_at": r.get::<_, i64>(2),
        "last_at": r.get::<_, i64>(3),
        "ended": r.get::<_, bool>(4),
        "duration_ms": r.get::<_, i32>(5),
        "entry_url": r.get::<_, Option<String>>(6),
        "user_id": r.get::<_, Option<String>>(7),
        "user_email": r.get::<_, Option<String>>(8),
        "release": r.get::<_, Option<String>>(9),
        "environment": r.get::<_, Option<String>>(10),
        "platform": r.get::<_, String>(11),
        "app_version": r.get::<_, Option<String>>(12),
        "device_model": r.get::<_, Option<String>>(13),
        "os_version": r.get::<_, Option<String>>(14),
        "webview_version": r.get::<_, Option<String>>(15),
        "browser": r.get::<_, Option<String>>(16),
        "browser_ver": r.get::<_, Option<String>>(17),
        "os": r.get::<_, Option<String>>(18),
        "vw": r.get::<_, Option<i32>>(19),
        "vh": r.get::<_, Option<i32>>(20),
        "lang": r.get::<_, Option<String>>(21),
        "error_count": r.get::<_, i32>(22),
        "warn_count": r.get::<_, i32>(23),
        "click_count": r.get::<_, i32>(24),
        "ws_disconnects": r.get::<_, i32>(25),
        "segments": r.get::<_, i32>(26),
        "bytes": r.get::<_, i64>(27),
        "has_gap": r.get::<_, bool>(28),
        "file_day": r.get::<_, String>(29),
    })
}

#[derive(Deserialize, Default)]
pub struct ListQuery {
    /// ms since epoch; default now − 14 days
    from: Option<i64>,
    /// ms since epoch; default now
    to: Option<i64>,
    user: Option<String>,
    url: Option<String>,
    release: Option<String>,
    platform: Option<String>,
    app_version: Option<String>,
    browser: Option<String>,
    os: Option<String>,
    has_error: Option<bool>,
    has_ws_disconnect: Option<bool>,
    /// seconds
    min_duration: Option<i64>,
    /// `<started_ms>_<uuid>` of the last row of the previous page
    cursor: Option<String>,
}

type Params = Vec<Box<dyn ToSql + Sync + Send>>;

fn add(sql: &mut String, params: &mut Params, cond: &str, v: Box<dyn ToSql + Sync + Send>) {
    params.push(v);
    sql.push_str(&cond.replace("$?", &format!("${}", params.len())));
}

fn like(s: &str) -> String {
    format!(
        "%{}%",
        s.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
    )
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Builds the list query. Exposed for the query-plan benchmark.
pub fn build_list(project_id: i32, q: &ListQuery) -> ApiResult<(String, Params)> {
    let to = q.to.unwrap_or_else(|| now_ms() + 60_000);
    let from = q.from.unwrap_or(to - 14 * DAY_MS).max(to - 15 * DAY_MS);
    let mut sql = format!(
        "SELECT {COLS} FROM sessions WHERE project_id = $1 \
         AND started_at >= to_timestamp($2::float8 / 1000) AND started_at < to_timestamp($3::float8 / 1000)"
    );
    let mut p: Params = vec![Box::new(project_id), Box::new(from as f64), Box::new(to as f64)];
    if let Some(u) = q.user.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        if u.contains('@') {
            add(
                &mut sql,
                &mut p,
                " AND user_email = $?",
                Box::new(u.to_ascii_lowercase()),
            );
        } else {
            add(&mut sql, &mut p, " AND user_id = $?", Box::new(u.to_string()));
        }
    }
    if let Some(u) = q.url.as_deref().map(str::trim).filter(|s| s.len() >= 3) {
        add(&mut sql, &mut p, " AND urls ILIKE $?", Box::new(like(u)));
    }
    for (col, v) in [
        ("release", &q.release),
        ("platform", &q.platform),
        ("app_version", &q.app_version),
        ("browser", &q.browser),
    ] {
        if let Some(v) = v.as_deref().filter(|s| !s.is_empty()) {
            add(
                &mut sql,
                &mut p,
                &format!(" AND {col} = $?"),
                Box::new(v.to_string()),
            );
        }
    }
    if let Some(v) = q.os.as_deref().filter(|s| !s.is_empty()) {
        add(
            &mut sql,
            &mut p,
            " AND os ILIKE $?",
            Box::new(format!("{}%", v.replace('%', "\\%"))),
        );
    }
    if q.has_error == Some(true) {
        sql.push_str(" AND error_count > 0");
    }
    if q.has_ws_disconnect == Some(true) {
        sql.push_str(" AND ws_disconnects > 0");
    }
    if let Some(d) = q.min_duration.filter(|d| *d > 0) {
        add(
            &mut sql,
            &mut p,
            " AND duration_ms >= $?",
            Box::new((d * 1000).min(i32::MAX as i64) as i32),
        );
    }
    if let Some((ts, id)) = q.cursor.as_deref().and_then(|c| c.split_once('_')) {
        let ts: i64 = ts
            .parse()
            .map_err(|_| ApiError::BadRequest("bad cursor".into()))?;
        let id = Uuid::try_parse(id).map_err(|_| ApiError::BadRequest("bad cursor".into()))?;
        p.push(Box::new(ts as f64));
        p.push(Box::new(id));
        let n = p.len();
        sql.push_str(&format!(
            " AND (started_at, id) < (to_timestamp(${}::float8 / 1000), ${n})",
            n - 1
        ));
    }
    sql.push_str(&format!(" ORDER BY started_at DESC, id DESC LIMIT {}", PAGE + 1));
    Ok((sql, p))
}

pub async fn list(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::View)?;
    let (sql, params) = build_list(id, &q)?;
    let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|b| b.as_ref() as &(dyn ToSql + Sync)).collect();
    let c = st.pool.get().await?;
    let rows = c.query(&sql, &refs).await?;
    let more = rows.len() as i64 > PAGE;
    let sessions: Vec<Value> = rows.iter().take(PAGE as usize).map(session_json).collect();
    let next = if more {
        sessions
            .last()
            .map(|s| format!("{}_{}", s["started_at"], s["id"].as_str().unwrap_or_default()))
    } else {
        None
    };
    Ok(Json(json!({ "sessions": sessions, "next_cursor": next })))
}

pub(crate) async fn load(st: &ApiState, user: &Auth, sid: &str) -> ApiResult<Row> {
    let r = load_public(st, sid).await?;
    user.require(st, r.get(1), Perm::View)?;
    Ok(r)
}

pub(crate) async fn load_public(st: &ApiState, sid: &str) -> ApiResult<Row> {
    let id = Uuid::try_parse(sid).map_err(|_| ApiError::NotFound)?;
    let c = st.pool.get().await?;
    let r = c
        .query_opt(
            &format!("SELECT {COLS} FROM sessions WHERE id = $1 LIMIT 1"),
            &[&id],
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(r)
}

pub async fn get_one(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
) -> ApiResult<Json<Value>> {
    let r = load(&st, &user, &sid).await?;
    let mut v = session_json(&r);
    let id = Uuid::try_parse(&sid).map_err(|_| ApiError::NotFound)?;
    let c = st.pool.get().await?;
    let evs = c
        .query(
            "SELECT e.id::text, (extract(epoch from e.ts) * 1000)::bigint, e.level, e.issue_id, i.title, i.status, \
             e.payload->'ctx' FROM events e JOIN issues i ON i.id = e.issue_id WHERE e.session_id = $1 \
             ORDER BY e.ts LIMIT 500",
            &[&id],
        )
        .await?;
    v["errors"] = Value::Array(
        evs.iter()
            .map(|e| {
                json!({ "id": e.get::<_, String>(0), "ts": e.get::<_, i64>(1), "level": e.get::<_, Option<String>>(2),
                        "issue_id": e.get::<_, i64>(3), "title": e.get::<_, String>(4), "status": e.get::<_, String>(5) })
            })
            .collect(),
    );
    let pid: i32 = r.get(1);
    if let Some(p) = st.projects.get(&pid.to_string()) {
        v["asset_base_url"] = json!(p.row.asset_base_url);
        v["asset_rewrite_from"] = json!(p.row.asset_rewrite_from);
        v["project_slug"] = json!(p.row.slug);
    }
    v["can_view_sensitive"] = json!(user.can(&st, pid, Perm::ViewSensitive));
    v["can_delete"] = json!(user.can(&st, pid, Perm::Delete));
    Ok(Json(v))
}

pub async fn delete(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
) -> ApiResult<StatusCode> {
    let r = load(&st, &user, &sid).await?;
    let pid: i32 = r.get(1);
    user.require(&st, pid, Perm::Delete)?;
    if !r.get::<_, bool>(4) {
        return Err(ApiError::BadRequest("only ended sessions can be deleted".into()));
    }
    let id = Uuid::try_parse(&sid).map_err(|_| ApiError::NotFound)?;
    let day: String = r.get(29);
    let path = recording_path(&st.data_dir, pid, &day, &id.to_string());
    match tokio::fs::remove_file(&path).await {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(ApiError::Internal(e.to_string())),
    }
    // Local file first: an upload running right now sees it gone and removes the object it just wrote.
    // On failure the row stays, so the delete can be retried.
    if let Some(store) = &st.replay_store {
        store
            .delete_session(pid, &day, &id.to_string())
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    }
    let c = st.pool.get().await?;
    c.execute(
        "DELETE FROM sessions WHERE id = $1 AND project_id = $2",
        &[&id, &pid],
    )
    .await?;
    crate::audit(&st, &user, "session.delete", &sid, json!({})).await?;
    st.renders.remove(&id.to_string()).await;
    // Redacted derivatives remain inaccessible after the metadata deletion and are swept by retention.
    Ok(StatusCode::NO_CONTENT)
}

pub fn recording_path(data_dir: &std::path::Path, project_id: i32, day: &str, sid: &str) -> PathBuf {
    replayd_common::rpl::recording_path(data_dir, project_id, day, sid)
}

/// Plain file with the complete recording, wherever it currently lives.
pub(crate) async fn locate_recording(st: &ApiState, pid: i32, day: &str, sid: &str) -> ApiResult<PathBuf> {
    let Some(store) = &st.replay_store else {
        return Ok(recording_path(&st.data_dir, pid, day, sid));
    };
    store.materialize(pid, day, sid).await.map_err(|e| match e {
        replayd_objstore::Error::NotFound => ApiError::NotFound,
        e => ApiError::Internal(e.to_string()),
    })
}

/// The viewer's copy (T-35) or the file itself.
async fn prepare_recording(src: PathBuf, sensitive: bool) -> ApiResult<PathBuf> {
    if sensitive {
        return Ok(src);
    }
    tokio::task::spawn_blocking(move || crate::redact_rpl::ensure(&src))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ApiError::NotFound,
            _ => ApiError::Internal(e.to_string()),
        })
}

/// Parses `bytes=a-b` / `bytes=a-` / `bytes=-n` (single range only).
fn parse_range(h: &str, len: u64) -> Option<(u64, u64)> {
    let spec = h.strip_prefix("bytes=")?;
    if spec.contains(',') {
        return None;
    }
    let (a, b) = spec.split_once('-')?;
    let (start, end) = match (a.trim(), b.trim()) {
        ("", n) => {
            let n: u64 = n.parse().ok()?;
            (len.saturating_sub(n), len.checked_sub(1)?)
        }
        (s, "") => (s.parse().ok()?, len.checked_sub(1)?),
        (s, e) => (s.parse().ok()?, e.parse::<u64>().ok()?.min(len.checked_sub(1)?)),
    };
    (start <= end && start < len).then_some((start, end))
}

pub async fn recording(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let r = load(&st, &user, &sid).await?;
    let sensitive = user.can(&st, r.get(1), Perm::ViewSensitive);
    serve_recording(&st, &r, sensitive, headers).await
}

pub(crate) async fn serve_recording(
    st: &ApiState,
    r: &Row,
    sensitive: bool,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let pid: i32 = r.get(1);
    let ended: bool = r.get(4);
    let day: String = r.get(29);
    let sid_norm: String = r.get(0);
    // viewers get a copy without network headers/bodies and WS frame contents (T-35)
    let src = locate_recording(st, pid, &day, &sid_norm).await?;
    let path = prepare_recording(src, sensitive).await;
    // An upload or cache sweep can remove the file right after it was located: look once more.
    let opened = match &path {
        Ok(p) => tokio::fs::File::open(p).await.ok(),
        Err(_) => None,
    };
    let mut f = match (opened, st.replay_store.is_some()) {
        (Some(f), _) => f,
        (None, false) => {
            path?;
            return Err(ApiError::NotFound);
        }
        (None, true) => {
            let src = locate_recording(st, pid, &day, &sid_norm).await?;
            let p = prepare_recording(src, sensitive).await?;
            tokio::fs::File::open(&p).await.map_err(|_| ApiError::NotFound)?
        }
    };
    let meta = f
        .metadata()
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let len = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|m| m.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let etag = format!("\"{len:x}-{mtime:x}\"");
    if headers
        .get(header::IF_NONE_MATCH)
        .is_some_and(|v| v.as_bytes() == etag.as_bytes())
    {
        return Ok(StatusCode::NOT_MODIFIED.into_response());
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|h| parse_range(h, len).ok_or(()));
    let (status, start, end) = match range {
        None => (StatusCode::OK, 0, len.saturating_sub(1)),
        Some(Ok((a, b))) => (StatusCode::PARTIAL_CONTENT, a, b),
        Some(Err(())) => {
            let mut resp = StatusCode::RANGE_NOT_SATISFIABLE.into_response();
            resp.headers_mut().insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes */{len}")).unwrap(),
            );
            return Ok(resp);
        }
    };
    let count = if len == 0 { 0 } else { end - start + 1 };
    f.seek(std::io::SeekFrom::Start(start))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?;
    let stream = tokio_util::io::ReaderStream::with_capacity(f.take(count), 64 * 1024);
    let mut resp = Response::new(Body::from_stream(stream));
    *resp.status_mut() = status;
    let h = resp.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/octet-stream"),
    );
    h.insert(header::CONTENT_LENGTH, HeaderValue::from(count));
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    h.insert(header::ETAG, HeaderValue::from_str(&etag).unwrap());
    if status == StatusCode::PARTIAL_CONTENT {
        h.insert(
            header::CONTENT_RANGE,
            HeaderValue::from_str(&format!("bytes {start}-{end}/{len}")).unwrap(),
        );
    }
    // Immutable after the session ended (§5.3); live sessions keep growing.
    h.insert(
        "x-replayd-cache",
        HeaderValue::from_static(if ended { "immutable" } else { "live" }),
    );
    Ok(resp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-9", 100), Some((0, 9)));
        assert_eq!(parse_range("bytes=90-", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=50-500", 100), Some((50, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }

    #[test]
    fn list_sql_uses_partition_window_and_cursor() {
        let q = ListQuery {
            from: Some(1_000),
            to: Some(2_000_000_000),
            user: Some("Joe@X.com".into()),
            url: Some("/trade".into()),
            has_error: Some(true),
            cursor: Some("1730620000000_0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d".into()),
            ..Default::default()
        };
        let (sql, p) = build_list(1, &q).unwrap();
        assert!(sql.contains("started_at >= to_timestamp($2"));
        assert!(sql.contains("user_email = $4"));
        assert!(sql.contains("urls ILIKE $5"));
        assert!(sql.contains("error_count > 0"));
        assert!(sql.contains("(started_at, id) < (to_timestamp($6::float8 / 1000), $7)"));
        assert_eq!(p.len(), 7);
        assert!(
            build_list(
                1,
                &ListQuery {
                    cursor: Some("x_y".into()),
                    ..Default::default()
                }
            )
            .is_err()
        );
    }
}
