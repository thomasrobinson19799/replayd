//! Bounded hourly aggregates. No payloads are read and no ingest work is added.
use crate::{
    ApiState,
    auth::Auth,
    error::{ApiError, ApiResult},
    projects::resolve,
    rbac::Perm,
};
use axum::{
    Json,
    extract::{Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;

#[derive(Deserialize)]
pub struct StatsQuery {
    range: Option<String>,
}

pub async fn get(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
    Query(q): Query<StatsQuery>,
) -> ApiResult<Json<Value>> {
    let pid = resolve(&st, &pid)?;
    user.require(&st, pid, Perm::View)?;
    let hours: i32 = match q.range.as_deref().unwrap_or("24h") {
        "24h" => 24,
        "7d" => 168,
        "14d" => 336,
        _ => return Err(ApiError::BadRequest("range must be 24h, 7d or 14d".into())),
    };
    let c = st.pool.get().await?;
    let rows = c.query(
        "WITH activity AS (
           SELECT date_trunc('hour', ts) AS hour, COALESCE(platform, 'web') AS platform, count(*) AS events, 0::bigint AS sessions
           FROM events WHERE project_id = $1 AND ts >= now() - make_interval(hours => $2) AND ts <= now() GROUP BY 1, 2
           UNION ALL
           SELECT date_trunc('hour', started_at), platform, 0::bigint, count(*) FROM sessions
           WHERE project_id = $1 AND started_at >= now() - make_interval(hours => $2) AND started_at <= now() GROUP BY 1, 2
         ) SELECT (extract(epoch FROM hour)*1000)::bigint, platform, sum(events)::bigint, sum(sessions)::bigint
           FROM activity GROUP BY hour, platform ORDER BY hour, platform", &[&pid, &hours]).await?;
    let buckets: Vec<Value> = rows.iter().map(|r| json!({"ts": r.get::<_, i64>(0), "platform": r.get::<_, String>(1), "events": r.get::<_, i64>(2), "sessions": r.get::<_, i64>(3)})).collect();
    let issues: i64 = c.query_one("SELECT count(*) FROM issues WHERE project_id = $1 AND last_seen >= now() - make_interval(hours => $2)", &[&pid, &hours]).await?.get(0);
    Ok(Json(
        json!({"hours": hours, "issues": issues, "buckets": buckets}),
    ))
}
