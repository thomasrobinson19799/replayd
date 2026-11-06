//! Capability links grant exactly one session, independently of the creator's role.
use std::sync::Arc;

use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode},
    response::Response,
};
use replayd_db::tokio_postgres::Row;
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    ApiState,
    auth::{self, Auth},
    error::{ApiError, ApiResult},
    sessions,
};

#[derive(Deserialize)]
pub struct Create {
    expiry: String,
}

fn hours(expiry: &str) -> ApiResult<i32> {
    match expiry {
        "1h" => Ok(1),
        "24h" => Ok(24),
        "7d" => Ok(168),
        "retention" => Ok(336),
        _ => Err(ApiError::BadRequest(
            "Choose 1 hour, 24 hours, 7 days or until retention".into(),
        )),
    }
}

pub async fn create(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
    Json(req): Json<Create>,
) -> ApiResult<Json<Value>> {
    let r = sessions::load(&st, &user, &sid).await?;
    let pid: i32 = r.get(1);
    let sid = Uuid::parse_str(&r.get::<_, String>(0)).map_err(|_| ApiError::NotFound)?;
    let id = Uuid::now_v7();
    let token = auth::random_token();
    let mut c = st.pool.get().await?;
    let tx = c.transaction().await?;
    let row = tx.query_opt(
        "INSERT INTO replay_shares (id, session_id, project_id, token_hash, creator_id, expires_at) \
         SELECT $1, s.id, s.project_id, $3, $4, LEAST(now() + make_interval(hours => $5), \
         (s.file_day + p.retention_days)::timestamp AT TIME ZONE 'UTC') \
         FROM sessions s JOIN projects p ON p.id = s.project_id \
         WHERE s.id = $2 AND s.project_id = $6 AND s.file_day >= (now() AT TIME ZONE 'UTC')::date - p.retention_days + 1 \
         RETURNING (extract(epoch from expires_at) * 1000)::bigint",
        &[&id, &sid, &auth::token_hash(&token), &user.user_id, &hours(&req.expiry)?, &pid],
    ).await?.ok_or(ApiError::NotFound)?;
    tx.execute(
        "INSERT INTO audit_log (user_id, action, target, data) VALUES ($1, 'share.create', $2, $3)",
        &[
            &user.user_id,
            &id.to_string(),
            &json!({"session_id": sid.to_string()}),
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(Json(
        json!({"id": id.to_string(), "url": format!("{}/share/{token}", st.public_url.trim_end_matches('/')), "expires_at": row.get::<_, i64>(0)}),
    ))
}

pub async fn list(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(sid): Path<String>,
) -> ApiResult<Json<Value>> {
    sessions::load(&st, &user, &sid).await?;
    let sid = Uuid::parse_str(&sid).map_err(|_| ApiError::NotFound)?;
    let c = st.pool.get().await?;
    let rows = c.query("SELECT l.id::text, COALESCE(u.name, u.email, 'Deleted user'), \
        (extract(epoch from LEAST(l.expires_at, (s.file_day + p.retention_days)::timestamp AT TIME ZONE 'UTC')) * 1000)::bigint \
        FROM replay_shares l JOIN sessions s ON s.id = l.session_id AND s.project_id = l.project_id \
        JOIN projects p ON p.id = l.project_id LEFT JOIN users u ON u.id = l.creator_id \
        WHERE l.session_id = $1 AND l.revoked_at IS NULL AND l.expires_at > now() \
        AND s.file_day >= (now() AT TIME ZONE 'UTC')::date - p.retention_days + 1 ORDER BY l.created_at DESC", &[&sid]).await?;
    Ok(Json(
        json!({"links": rows.iter().map(|r| json!({"id": r.get::<_, String>(0), "creator": r.get::<_, String>(1), "expires_at": r.get::<_, i64>(2)})).collect::<Vec<_>>()}),
    ))
}

pub async fn revoke(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path((sid, id)): Path<(String, String)>,
) -> ApiResult<StatusCode> {
    let row = sessions::load(&st, &user, &sid).await?;
    let pid: i32 = row.get(1);
    let id = Uuid::parse_str(&id).map_err(|_| ApiError::NotFound)?;
    let sid = Uuid::parse_str(&sid).map_err(|_| ApiError::NotFound)?;
    let mut c = st.pool.get().await?;
    let tx = c.transaction().await?;
    let n = tx.execute("UPDATE replay_shares SET revoked_at = now() WHERE id = $1 AND session_id = $2 AND project_id = $3 AND revoked_at IS NULL", &[&id, &sid, &pid]).await?;
    if n == 0 {
        return Err(ApiError::NotFound);
    }
    tx.execute(
        "INSERT INTO audit_log (user_id, action, target, data) VALUES ($1, 'share.revoke', $2, $3)",
        &[
            &user.user_id,
            &id.to_string(),
            &json!({"session_id": sid.to_string()}),
        ],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn resolve(st: &ApiState, token: &str) -> ApiResult<Row> {
    // Token validation never reflects the supplied value in errors or logs.
    if token.len() != 43
        || !token
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(ApiError::NotFound);
    }
    let c = st.pool.get().await?;
    let row = c.query_opt("SELECT l.session_id::text FROM replay_shares l JOIN sessions s ON s.id = l.session_id AND s.project_id = l.project_id \
        JOIN projects p ON p.id = l.project_id WHERE l.token_hash = $1 AND l.revoked_at IS NULL AND l.expires_at > now() \
        AND s.file_day >= (now() AT TIME ZONE 'UTC')::date - p.retention_days + 1 LIMIT 1", &[&auth::token_hash(token)]).await?.ok_or(ApiError::NotFound)?;
    sessions::load_public(st, &row.get::<_, String>(0)).await
}

pub async fn detail(State(st): State<Arc<ApiState>>, Path(token): Path<String>) -> ApiResult<Json<Value>> {
    let r = resolve(&st, &token).await?;
    let mut v = sessions::session_json(&r);
    let pid: i32 = r.get(1);
    if let Some(p) = st.projects.get(&pid.to_string()) {
        v["asset_base_url"] = json!(p.row.asset_base_url);
        v["asset_rewrite_from"] = json!(p.row.asset_rewrite_from);
    }
    v.as_object_mut().unwrap().remove("project_id");
    v.as_object_mut().unwrap().remove("file_day");
    v["errors"] = json!([]); // replay events supply the error tab, with no issue access
    v["can_view_sensitive"] = json!(true);
    v["can_delete"] = json!(false);
    Ok(Json(v))
}

pub async fn recording(
    State(st): State<Arc<ApiState>>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> ApiResult<Response> {
    let r = resolve(&st, &token).await?;
    sessions::serve_recording(&st, &r, true, headers).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn expiry_options_are_closed() {
        for (s, h) in [("1h", 1), ("24h", 24), ("7d", 168), ("retention", 336)] {
            assert_eq!(hours(s).unwrap(), h);
        }
        assert!(hours("forever").is_err());
    }
}
