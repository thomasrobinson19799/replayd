//! Issue read endpoints (§5.11): list with filters, detail, events (keyset pagination).
//! Status changes (T-31, PRD §6.1): resolve, resolve in next release, ignore (until date, until N more events,
//! forever), reopen; single and bulk. Regressions are detected by the pipeline upsert (replayd-pipeline worker).

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, Query, State};
use replayd_db::tokio_postgres::Row;
use replayd_db::tokio_postgres::types::ToSql;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::ApiState;
use crate::auth::Auth;
use crate::error::{ApiError, ApiResult};
use crate::projects::resolve;
use crate::rbac::Perm;

const ISSUE_COLS: &str = "id, project_id, level, source, type, title, culprit, status, \
    (extract(epoch from first_seen) * 1000)::bigint, (extract(epoch from last_seen) * 1000)::bigint, \
    first_release, last_release, platforms, times_seen, users_seen, symbolicated, resolved_in_release, \
    (extract(epoch from ignore_until) * 1000)::bigint, ignore_until_count, \
    (extract(epoch from resolved_at) * 1000)::bigint, (extract(epoch from regressed_at) * 1000)::bigint";

fn issue_json(r: &Row) -> Value {
    json!({
        "id": r.get::<_, i64>(0),
        "project_id": r.get::<_, i32>(1),
        "level": r.get::<_, String>(2),
        "source": r.get::<_, String>(3),
        "type": r.get::<_, Option<String>>(4),
        "title": r.get::<_, String>(5),
        "culprit": r.get::<_, Option<String>>(6),
        "status": r.get::<_, String>(7),
        "first_seen": r.get::<_, i64>(8),
        "last_seen": r.get::<_, i64>(9),
        "first_release": r.get::<_, Option<String>>(10),
        "last_release": r.get::<_, Option<String>>(11),
        "platforms": r.get::<_, Vec<String>>(12),
        "times_seen": r.get::<_, i64>(13),
        "users_seen": r.get::<_, i32>(14),
        "symbolicated": r.get::<_, bool>(15),
        "resolved_in_release": r.get::<_, Option<String>>(16),
        "ignore_until": r.get::<_, Option<i64>>(17),
        "ignore_until_count": r.get::<_, Option<i64>>(18),
        "resolved_at": r.get::<_, Option<i64>>(19),
        "regressed_at": r.get::<_, Option<i64>>(20),
    })
}

#[derive(Deserialize, Default)]
pub struct ListQuery {
    status: Option<String>,
    level: Option<String>,
    source: Option<String>,
    platform: Option<String>,
    release: Option<String>,
    q: Option<String>,
    sort: Option<String>,
    page: Option<i64>,
}

pub const PAGE: i64 = 50;

pub async fn list(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
    Query(q): Query<ListQuery>,
) -> ApiResult<Json<Value>> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::View)?;
    let mut sql = format!("SELECT {ISSUE_COLS} FROM issues WHERE project_id = $1");
    let mut params: Vec<Box<dyn ToSql + Sync + Send>> = vec![Box::new(id)];
    // `cond` uses `$?` for the (single) new parameter; it may appear more than once.
    fn add(sql: &mut String, params: &mut Vec<Box<dyn ToSql + Sync + Send>>, cond: &str, v: String) {
        params.push(Box::new(v));
        sql.push_str(&cond.replace("$?", &format!("${}", params.len())));
    }
    // default: open issues only
    match q.status.as_deref().unwrap_or("unresolved") {
        "all" => {}
        s => add(&mut sql, &mut params, " AND status = $?", s.to_string()),
    }
    if let Some(l) = q.level.filter(|s| !s.is_empty()) {
        add(&mut sql, &mut params, " AND level = $?", l);
    }
    if let Some(s) = q.source.filter(|s| !s.is_empty()) {
        add(&mut sql, &mut params, " AND source = $?", s);
    }
    if let Some(p) = q.platform.filter(|s| !s.is_empty()) {
        add(&mut sql, &mut params, " AND $? = ANY(platforms)", p);
    }
    if let Some(r) = q.release.filter(|s| !s.is_empty()) {
        add(
            &mut sql,
            &mut params,
            " AND (first_release = $? OR last_release = $?)",
            r,
        );
    }
    if let Some(text) = q.q.filter(|s| !s.trim().is_empty()) {
        let like = format!(
            "%{}%",
            text.trim()
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        add(
            &mut sql,
            &mut params,
            " AND (title ILIKE $? OR culprit ILIKE $?)",
            like,
        );
    }
    let order = match q.sort.as_deref() {
        Some("first_seen") => "first_seen DESC, id DESC",
        Some("times_seen") => "times_seen DESC, id DESC",
        Some("users_seen") => "users_seen DESC, id DESC",
        _ => "last_seen DESC, id DESC",
    };
    let page = q.page.unwrap_or(0).clamp(0, 10_000);
    sql.push_str(&format!(
        " ORDER BY {order} LIMIT {} OFFSET {}",
        PAGE + 1,
        page * PAGE
    ));
    let c = st.pool.get().await?;
    let refs: Vec<&(dyn ToSql + Sync)> = params.iter().map(|b| b.as_ref() as &(dyn ToSql + Sync)).collect();
    let rows = c.query(&sql, &refs).await?;
    let has_more = rows.len() as i64 > PAGE;
    let issues: Vec<Value> = rows.iter().take(PAGE as usize).map(issue_json).collect();
    Ok(Json(
        json!({ "issues": issues, "page": page, "has_more": has_more }),
    ))
}

async fn load_issue(st: &ApiState, user: &Auth, id: i64) -> ApiResult<Row> {
    let c = st.pool.get().await?;
    let r = c
        .query_opt(&format!("SELECT {ISSUE_COLS} FROM issues WHERE id = $1"), &[&id])
        .await?
        .ok_or(ApiError::NotFound)?;
    user.require(st, r.get(1), Perm::View)?;
    Ok(r)
}

const EVENT_COLS: &str = "id::text, (extract(epoch from ts) * 1000)::bigint, session_id::text, level, release, \
    environment, platform, url, user_id, browser, os, app_version, payload";

fn event_json(r: &Row) -> Value {
    json!({
        "id": r.get::<_, String>(0),
        "ts": r.get::<_, i64>(1),
        "session_id": r.get::<_, Option<String>>(2),
        "level": r.get::<_, Option<String>>(3),
        "release": r.get::<_, Option<String>>(4),
        "environment": r.get::<_, Option<String>>(5),
        "platform": r.get::<_, Option<String>>(6),
        "url": r.get::<_, Option<String>>(7),
        "user_id": r.get::<_, Option<String>>(8),
        "browser": r.get::<_, Option<String>>(9),
        "os": r.get::<_, Option<String>>(10),
        "app_version": r.get::<_, Option<String>>(11),
        "payload": r.get::<_, Value>(12),
    })
}

pub async fn get_one(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(id): Path<i64>,
) -> ApiResult<Json<Value>> {
    let r = load_issue(&st, &user, id).await?;
    let mut v = issue_json(&r);
    let c = st.pool.get().await?;
    let split = c
        .query(
            "SELECT COALESCE(platform, 'web'), count(*) FROM events WHERE issue_id = $1 GROUP BY 1",
            &[&id],
        )
        .await?;
    let mut platforms = serde_json::Map::new();
    for s in split {
        platforms.insert(s.get::<_, String>(0), json!(s.get::<_, i64>(1)));
    }
    v["platform_split"] = Value::Object(platforms);
    let latest = c
        .query_opt(
            &format!("SELECT {EVENT_COLS} FROM events WHERE issue_id = $1 ORDER BY ts DESC, id DESC LIMIT 1"),
            &[&id],
        )
        .await?;
    v["latest_event"] = latest.as_ref().map(event_json).unwrap_or(Value::Null);
    v["can_change_status"] = json!(user.can(&st, r.get(1), Perm::ChangeIssueStatus));
    Ok(Json(v))
}

#[derive(Deserialize)]
pub struct EventsQuery {
    /// `<ts_ms>_<uuid>` of the last event of the previous page.
    cursor: Option<String>,
}

pub async fn events(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(id): Path<i64>,
    Query(q): Query<EventsQuery>,
) -> ApiResult<Json<Value>> {
    load_issue(&st, &user, id).await?;
    let c = st.pool.get().await?;
    let rows = match q.cursor.as_deref().and_then(|s| s.split_once('_')) {
        Some((ts, eid)) => {
            let ts: i64 = ts
                .parse()
                .map_err(|_| ApiError::BadRequest("bad cursor".into()))?;
            let eid = uuid::Uuid::try_parse(eid).map_err(|_| ApiError::BadRequest("bad cursor".into()))?;
            c.query(
                &format!(
                    "SELECT {EVENT_COLS} FROM events WHERE issue_id = $1 \
                     AND (ts, id) < (to_timestamp($2::float8 / 1000), $3) ORDER BY ts DESC, id DESC LIMIT 21"
                ),
                &[&id, &(ts as f64), &eid],
            )
            .await?
        }
        None => {
            c.query(
                &format!(
                    "SELECT {EVENT_COLS} FROM events WHERE issue_id = $1 ORDER BY ts DESC, id DESC LIMIT 21"
                ),
                &[&id],
            )
            .await?
        }
    };
    let more = rows.len() > 20;
    let evs: Vec<Value> = rows.iter().take(20).map(event_json).collect();
    let next = if more {
        evs.last()
            .map(|e| format!("{}_{}", e["ts"], e["id"].as_str().unwrap_or_default()))
    } else {
        None
    };
    Ok(Json(json!({ "events": evs, "next_cursor": next })))
}

#[derive(Deserialize)]
pub struct StatusReq {
    /// `unresolved` | `resolved` | `ignored`
    status: String,
    /// with `resolved`: only events of a release other than the issue's current last release reopen it
    #[serde(default)]
    in_next_release: bool,
    /// with `ignored`: until this time (ms)
    ignore_until: Option<i64>,
    /// with `ignored`: until N more events
    ignore_count: Option<i64>,
}

#[derive(Deserialize)]
pub struct BulkReq {
    ids: Vec<i64>,
    #[serde(flatten)]
    change: StatusReq,
}

const SET_STATUS: &str = "UPDATE issues SET status = $3::text, \
    resolved_at = CASE WHEN $3::text = 'resolved' THEN now() END, \
    resolved_by = CASE WHEN $3::text = 'resolved' THEN $4::int END, \
    resolved_in_release = CASE WHEN $3::text = 'resolved' AND $5::bool THEN last_release END, \
    ignore_until = CASE WHEN $3::text = 'ignored' AND $6::bigint IS NOT NULL THEN to_timestamp($6::bigint / 1000.0) END, \
    ignore_until_count = CASE WHEN $3::text = 'ignored' AND $7::bigint IS NOT NULL THEN times_seen + $7::bigint END \
    WHERE id = ANY($1::bigint[]) AND project_id = ANY($2::int[])";

async fn set_status(st: &ApiState, user: &Auth, ids: &[i64], ch: &StatusReq) -> ApiResult<Vec<Value>> {
    if !matches!(ch.status.as_str(), "unresolved" | "resolved" | "ignored") {
        return Err(ApiError::BadRequest(
            "status: unresolved | resolved | ignored".into(),
        ));
    }
    if ids.is_empty() || ids.len() > 500 {
        return Err(ApiError::BadRequest("1–500 issue ids".into()));
    }
    if ch.ignore_count.is_some_and(|n| !(1..=1_000_000_000).contains(&n)) {
        return Err(ApiError::BadRequest("ignore_count: 1…1e9".into()));
    }
    let c = st.pool.get().await?;
    // every issue's project must allow the change (unknown ids / foreign projects → 404 like reads)
    let rows = c
        .query("SELECT id, project_id FROM issues WHERE id = ANY($1)", &[&ids])
        .await?;
    if rows.len() != ids.len() {
        return Err(ApiError::NotFound);
    }
    let mut pids: Vec<i32> = rows.iter().map(|r| r.get(1)).collect();
    pids.sort_unstable();
    pids.dedup();
    for p in &pids {
        user.require(st, *p, Perm::View)?;
        user.require(st, *p, Perm::ChangeIssueStatus)?;
    }
    let until = if ch.status == "ignored" {
        ch.ignore_until
    } else {
        None
    };
    let count = if ch.status == "ignored" {
        ch.ignore_count
    } else {
        None
    };
    c.execute(
        SET_STATUS,
        &[
            &ids,
            &pids,
            &ch.status,
            &user.user_id,
            &ch.in_next_release,
            &until,
            &count,
        ],
    )
    .await?;
    let out = c
        .query(
            &format!("SELECT {ISSUE_COLS} FROM issues WHERE id = ANY($1) ORDER BY id"),
            &[&ids],
        )
        .await?;
    crate::audit(
        st,
        user,
        "issue.status",
        &format!("{ids:?}"),
        json!({ "status": ch.status, "in_next_release": ch.in_next_release, "ignore_until": until, "ignore_count": count }),
    )
    .await?;
    Ok(out.iter().map(issue_json).collect())
}

/// `PATCH /api/issues/:id`
pub async fn patch_one(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(id): Path<i64>,
    Json(req): Json<StatusReq>,
) -> ApiResult<Json<Value>> {
    let mut v = set_status(&st, &user, &[id], &req).await?;
    Ok(Json(v.pop().unwrap_or(Value::Null)))
}

/// `PATCH /api/issues` `{ids, status, …}`
pub async fn patch_bulk(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Json(req): Json<BulkReq>,
) -> ApiResult<Json<Value>> {
    let v = set_status(&st, &user, &req.ids, &req.change).await?;
    Ok(Json(json!({ "issues": v })))
}
