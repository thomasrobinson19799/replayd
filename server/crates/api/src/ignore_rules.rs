use crate::{
    ApiState,
    auth::Auth,
    error::{ApiError, ApiResult},
    projects::resolve,
    rbac::Perm,
};
use axum::{
    Json,
    extract::{Path, State},
    http::StatusCode,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::sync::Arc;
#[derive(Deserialize)]
pub struct Rule {
    kind: String,
    match_type: String,
    pattern: String,
}
pub async fn list(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
) -> ApiResult<Json<Value>> {
    let pid = resolve(&st, &pid)?;
    user.require(&st, pid, Perm::ProjectSettings)?;
    let c = st.pool.get().await?;
    let rows=c.query("SELECT id,kind,match_type,pattern,dropped_count,(extract(epoch from last_matched_at)*1000)::bigint FROM ignore_rules WHERE project_id=$1 ORDER BY id",&[&pid]).await?;
    Ok(Json(
        json!({"rules":rows.iter().map(|r|json!({"id":r.get::<_,i64>(0),"kind":r.get::<_,String>(1),"match_type":r.get::<_,String>(2),"pattern":r.get::<_,String>(3),"dropped_count":r.get::<_,i64>(4),"last_matched_at":r.get::<_,Option<i64>>(5)})).collect::<Vec<_>>()}),
    ))
}
async fn save(st: &ApiState, user: &Auth, pid: &str, id: Option<i64>, r: Rule) -> ApiResult<Json<Value>> {
    let pid = resolve(st, pid)?;
    user.require(st, pid, Perm::ProjectSettings)?;
    replayd_ingest::ignore::compile(&r.kind, &r.match_type, &r.pattern)
        .map_err(|s| ApiError::BadRequest(s.into()))?;
    let mut c = st.pool.get().await?;
    let tx = c.transaction().await?;
    tx.query_one("SELECT id FROM projects WHERE id=$1 FOR UPDATE", &[&pid])
        .await?;
    let actual = if let Some(id) = id {
        if tx
            .execute(
                "UPDATE ignore_rules SET kind=$3,match_type=$4,pattern=$5 WHERE project_id=$1 AND id=$2",
                &[&pid, &id, &r.kind, &r.match_type, &r.pattern],
            )
            .await?
            == 0
        {
            return Err(ApiError::NotFound);
        }
        id
    } else {
        let n: i64 = tx
            .query_one("SELECT count(*) FROM ignore_rules WHERE project_id=$1", &[&pid])
            .await?
            .get(0);
        if n >= 50 {
            return Err(ApiError::BadRequest("Maximum 50 ignore rules per project".into()));
        }
        tx.query_one(
            "INSERT INTO ignore_rules (project_id,kind,match_type,pattern) VALUES ($1,$2,$3,$4) RETURNING id",
            &[&pid, &r.kind, &r.match_type, &r.pattern],
        )
        .await?
        .get(0)
    };
    let action = if id.is_some() {
        "ignore_rule.update"
    } else {
        "ignore_rule.create"
    };
    tx.execute(
        "INSERT INTO audit_log (user_id,action,target,data) VALUES ($1,$2,$3,$4)",
        &[
            &user.user_id,
            &action,
            &actual.to_string(),
            &json!({"project_id":pid}),
        ],
    )
    .await?;
    tx.commit().await?;
    st.projects.ignores.reload(&st.pool).await?;
    Ok(Json(json!({"id":actual})))
}
pub async fn create(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
    Json(r): Json<Rule>,
) -> ApiResult<Json<Value>> {
    save(&st, &user, &pid, None, r).await
}
pub async fn update(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path((pid, id)): Path<(String, i64)>,
    Json(r): Json<Rule>,
) -> ApiResult<Json<Value>> {
    save(&st, &user, &pid, Some(id), r).await
}
pub async fn delete(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path((pid, id)): Path<(String, i64)>,
) -> ApiResult<StatusCode> {
    let pid = resolve(&st, &pid)?;
    user.require(&st, pid, Perm::ProjectSettings)?;
    let mut c = st.pool.get().await?;
    let tx = c.transaction().await?;
    if tx
        .execute(
            "DELETE FROM ignore_rules WHERE project_id=$1 AND id=$2",
            &[&pid, &id],
        )
        .await?
        == 0
    {
        return Err(ApiError::NotFound);
    }
    tx.execute(
        "INSERT INTO audit_log (user_id,action,target,data) VALUES ($1,'ignore_rule.delete',$2,$3)",
        &[&user.user_id, &id.to_string(), &json!({"project_id":pid})],
    )
    .await?;
    tx.commit().await?;
    st.projects.ignores.reload(&st.pool).await?;
    Ok(StatusCode::NO_CONTENT)
}
