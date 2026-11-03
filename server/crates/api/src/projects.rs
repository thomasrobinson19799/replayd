//! `/api/projects` — projects, keys, settings (origins, asset base URL, Telegram, remote config,
//! fingerprint rules) and members.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, Auth};
use crate::error::{ApiError, ApiResult};
use crate::rbac::{Perm, Role};
use crate::{ApiState, audit};

/// Resolves a `{pid}` path segment (numeric id or slug) to a project id.
pub fn resolve(st: &ApiState, pid: &str) -> ApiResult<i32> {
    st.projects.get(pid).map(|p| p.row.id).ok_or(ApiError::NotFound)
}

fn host_of(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_string()
}

pub fn dsn(st: &ApiState, public_key: &str, slug: &str) -> String {
    let scheme = if st.public_url.starts_with("http://") {
        "http"
    } else {
        "https"
    };
    format!("{scheme}://{public_key}@{}/{slug}", host_of(&st.public_url))
}

fn mask_telegram(t: &Option<Value>) -> Value {
    match t {
        Some(Value::Object(m)) => {
            let mut m = m.clone();
            if m.get("bot_token")
                .and_then(Value::as_str)
                .is_some_and(|s| !s.is_empty())
            {
                m.insert("bot_token".into(), Value::String("***".into()));
            }
            Value::Object(m)
        }
        _ => Value::Null,
    }
}

fn project_json(st: &ApiState, user: &Auth, r: &replayd_db::tokio_postgres::Row) -> Value {
    let id: i32 = r.get("id");
    let slug: String = r.get("slug");
    let pk: String = r.get("public_key");
    let role = if user.is_superadmin {
        Some(Role::Admin)
    } else {
        user.role(st, id)
    };
    let is_admin = user.can(st, id, Perm::ProjectSettings);
    json!({
        "id": id,
        "slug": slug,
        "name": r.get::<_, String>("name"),
        "public_key": pk,
        "dsn": dsn(st, &pk, &slug),
        "allowed_origins": r.get::<_, Vec<String>>("allowed_origins"),
        "asset_base_url": r.get::<_, Option<String>>("asset_base_url"),
        "asset_rewrite_from": r.get::<_, Vec<String>>("asset_rewrite_from"),
        "retention_days": r.get::<_, i32>("retention_days"),
        "remote_config": r.get::<_, Value>("remote_config"),
        "fingerprint_rules": r.get::<_, Value>("fingerprint_rules"),
        "telegram": if is_admin { mask_telegram(&r.get("telegram")) } else { Value::Null },
        "created_at": r.get::<_, i64>("created_ms"),
        "role": role.map(|r| r.as_str()),
    })
}

const SELECT: &str = "SELECT id, slug, name, public_key, allowed_origins, asset_base_url, asset_rewrite_from, \
     retention_days, remote_config, fingerprint_rules, telegram, \
     (extract(epoch from created_at) * 1000)::bigint AS created_ms FROM projects";

pub async fn list(State(st): State<Arc<ApiState>>, user: Auth) -> ApiResult<Json<Value>> {
    let c = st.pool.get().await?;
    let rows = c.query(&format!("{SELECT} ORDER BY name"), &[]).await?;
    let v: Vec<Value> = rows
        .iter()
        .filter(|r| user.can(&st, r.get("id"), Perm::View))
        .map(|r| project_json(&st, &user, r))
        .collect();
    Ok(Json(json!({ "projects": v })))
}

pub async fn get_one(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::View)?;
    let c = st.pool.get().await?;
    let r = c
        .query_opt(&format!("{SELECT} WHERE id = $1"), &[&id])
        .await?
        .ok_or(ApiError::NotFound)?;
    Ok(Json(project_json(&st, &user, &r)))
}

fn valid_slug(s: &str) -> bool {
    (2..=64).contains(&s.len())
        && s.chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !s.starts_with('-')
        && !s.chars().all(|c| c.is_ascii_digit())
        && s != "sdk"
}

fn valid_origin(o: &str) -> bool {
    (o.starts_with("https://") || o.starts_with("http://")) && o.len() < 256 && !o.contains(' ')
}

fn new_public_key() -> String {
    format!("pk_{}", &auth::random_token()[..24])
}

fn new_upload_token() -> String {
    format!("rpu_{}", auth::random_token())
}

#[derive(Deserialize)]
pub struct CreateProject {
    slug: String,
    name: String,
    #[serde(default)]
    allowed_origins: Vec<String>,
}

pub async fn create(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Json(req): Json<CreateProject>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require_superadmin()?;
    let slug = req.slug.trim().to_ascii_lowercase();
    if !valid_slug(&slug) {
        return Err(ApiError::BadRequest(
            "slug: 2-64 chars, lowercase letters, digits and '-', not numeric".into(),
        ));
    }
    if req.name.trim().is_empty() || req.allowed_origins.iter().any(|o| !valid_origin(o)) {
        return Err(ApiError::BadRequest("invalid name or origins".into()));
    }
    let upload = new_upload_token();
    let c = st.pool.get().await?;
    let row = c
        .query_one(
            &format!(
                "WITH ins AS (INSERT INTO projects (slug, name, public_key, upload_token_hash, allowed_origins) \
                 VALUES ($1, $2, $3, $4, $5) RETURNING *) {} ",
                SELECT.replace("FROM projects", "FROM ins")
            ),
            &[&slug, &req.name.trim(), &new_public_key(), &auth::token_hash(&upload), &req.allowed_origins],
        )
        .await?;
    st.reload_projects().await?;
    audit(
        &st,
        &user,
        "project.create",
        &slug,
        json!({ "origins": req.allowed_origins }),
    )
    .await?;
    let mut v = project_json(&st, &user, &row);
    // shown exactly once
    v["upload_token"] = Value::String(upload);
    Ok((StatusCode::CREATED, Json(v)))
}

#[derive(Deserialize)]
pub struct UpdateProject {
    name: Option<String>,
    allowed_origins: Option<Vec<String>>,
    asset_base_url: Option<Option<String>>,
    asset_rewrite_from: Option<Vec<String>>,
    retention_days: Option<i32>,
    remote_config: Option<Value>,
    fingerprint_rules: Option<Value>,
    telegram: Option<Value>,
}

fn validate_rules(v: &Value) -> ApiResult<()> {
    let arr = v
        .as_array()
        .ok_or_else(|| ApiError::BadRequest("fingerprint_rules must be an array".into()))?;
    if arr.len() > 50 {
        return Err(ApiError::BadRequest("at most 50 fingerprint rules".into()));
    }
    for r in arr {
        let pat = r
            .get("pattern")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::BadRequest("rule.pattern required".into()))?;
        regex::RegexBuilder::new(pat)
            .size_limit(1 << 20)
            .build()
            .map_err(|e| ApiError::BadRequest(format!("invalid regex {pat:?}: {e}")))?;
    }
    Ok(())
}

pub async fn update(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
    Json(req): Json<UpdateProject>,
) -> ApiResult<Json<Value>> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::ProjectSettings)?;
    if let Some(o) = &req.allowed_origins
        && o.iter().any(|o| !valid_origin(o))
    {
        return Err(ApiError::BadRequest("invalid origin".into()));
    }
    if let Some(d) = req.retention_days
        && !(1..=14).contains(&d)
    {
        return Err(ApiError::BadRequest("retention_days must be 1..14".into()));
    }
    if let Some(rc) = &req.remote_config
        && !rc.is_object()
    {
        return Err(ApiError::BadRequest("remote_config must be an object".into()));
    }
    if let Some(r) = &req.fingerprint_rules {
        validate_rules(r)?;
    }
    let c = st.pool.get().await?;
    // Telegram: a masked "***" bot token keeps the stored one.
    let telegram = match req.telegram {
        Some(Value::Object(mut m)) => {
            if m.get("bot_token").and_then(Value::as_str) == Some("***") {
                let old: Option<Value> = c
                    .query_one("SELECT telegram FROM projects WHERE id = $1", &[&id])
                    .await?
                    .get(0);
                let tok = old
                    .and_then(|o| o.get("bot_token").cloned())
                    .unwrap_or(Value::Null);
                m.insert("bot_token".into(), tok);
            }
            Some(Some(Value::Object(m)))
        }
        Some(Value::Null) => Some(None),
        Some(_) => return Err(ApiError::BadRequest("telegram must be an object or null".into())),
        None => None,
    };
    let set_asset = req.asset_base_url.is_some();
    let asset: Option<String> = req.asset_base_url.flatten();
    let set_tg = telegram.is_some();
    let tg: Option<Value> = telegram.flatten();
    let row = c
        .query_opt(
            &format!(
                "WITH up AS (UPDATE projects SET name = COALESCE($2, name), \
                 allowed_origins = COALESCE($3, allowed_origins), \
                 asset_base_url = CASE WHEN $4 THEN $5 ELSE asset_base_url END, \
                 asset_rewrite_from = COALESCE($6, asset_rewrite_from), \
                 retention_days = COALESCE($7, retention_days), \
                 remote_config = COALESCE($8, remote_config), \
                 fingerprint_rules = COALESCE($9, fingerprint_rules), \
                 telegram = CASE WHEN $10 THEN $11 ELSE telegram END \
                 WHERE id = $1 RETURNING *) {}",
                SELECT.replace("FROM projects", "FROM up")
            ),
            &[
                &id,
                &req.name,
                &req.allowed_origins,
                &set_asset,
                &asset,
                &req.asset_rewrite_from,
                &req.retention_days,
                &req.remote_config,
                &req.fingerprint_rules,
                &set_tg,
                &tg,
            ],
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    st.reload_projects().await?;
    let changed: Vec<&str> = [
        ("name", req.name.is_some()),
        ("allowed_origins", req.allowed_origins.is_some()),
        ("asset_base_url", set_asset),
        ("asset_rewrite_from", req.asset_rewrite_from.is_some()),
        ("retention_days", req.retention_days.is_some()),
        ("remote_config", req.remote_config.is_some()),
        ("fingerprint_rules", req.fingerprint_rules.is_some()),
        ("telegram", set_tg),
    ]
    .into_iter()
    .filter_map(|(k, b)| b.then_some(k))
    .collect();
    audit(
        &st,
        &user,
        "project.update",
        &id.to_string(),
        json!({ "fields": changed }),
    )
    .await?;
    Ok(Json(project_json(&st, &user, &row)))
}

pub async fn delete(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
) -> ApiResult<StatusCode> {
    let id = resolve(&st, &pid)?;
    user.require_superadmin()?;
    let c = st.pool.get().await?;
    c.execute("DELETE FROM projects WHERE id = $1", &[&id]).await?;
    st.reload_projects().await?;
    st.reload_members().await?;
    audit(&st, &user, "project.delete", &id.to_string(), json!({})).await?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct RotateReq {
    kind: String,
}

pub async fn rotate_key(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
    Json(req): Json<RotateReq>,
) -> ApiResult<Json<Value>> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::ProjectSettings)?;
    let c = st.pool.get().await?;
    let out = match req.kind.as_str() {
        "public" => {
            let pk = new_public_key();
            c.execute("UPDATE projects SET public_key = $2 WHERE id = $1", &[&id, &pk])
                .await?;
            json!({ "public_key": pk })
        }
        "upload" => {
            let t = new_upload_token();
            c.execute(
                "UPDATE projects SET upload_token_hash = $2 WHERE id = $1",
                &[&id, &auth::token_hash(&t)],
            )
            .await?;
            json!({ "upload_token": t })
        }
        _ => return Err(ApiError::BadRequest("kind must be public or upload".into())),
    };
    st.reload_projects().await?;
    audit(
        &st,
        &user,
        "project.rotate_key",
        &id.to_string(),
        json!({ "kind": req.kind }),
    )
    .await?;
    Ok(Json(out))
}

pub async fn members(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(pid): Path<String>,
) -> ApiResult<Json<Value>> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::ProjectSettings)?;
    let c = st.pool.get().await?;
    let rows = c
        .query(
            "SELECT u.id, u.email, u.name, m.role::text FROM project_members m JOIN users u ON u.id = m.user_id \
             WHERE m.project_id = $1 ORDER BY u.email",
            &[&id],
        )
        .await?;
    let v: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({ "user_id": r.get::<_, i32>(0), "email": r.get::<_, String>(1),
                    "name": r.get::<_, Option<String>>(2), "role": r.get::<_, String>(3) })
        })
        .collect();
    Ok(Json(json!({ "members": v })))
}

#[derive(Deserialize)]
pub struct SetMember {
    role: String,
}

pub async fn set_member(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path((pid, uid)): Path<(String, i32)>,
    Json(req): Json<SetMember>,
) -> ApiResult<StatusCode> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::ProjectSettings)?;
    let role =
        Role::parse(&req.role).ok_or_else(|| ApiError::BadRequest("role: admin|member|viewer".into()))?;
    let c = st.pool.get().await?;
    c.execute(
        "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3::text::project_role) \
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role",
        &[&id, &uid, &role.as_str()],
    )
    .await
    .map_err(|e| {
        if e.as_db_error()
            .is_some_and(|d| d.code() == &replayd_db::tokio_postgres::error::SqlState::FOREIGN_KEY_VIOLATION)
        {
            ApiError::NotFound
        } else {
            e.into()
        }
    })?;
    st.reload_members().await?;
    audit(
        &st,
        &user,
        "member.set",
        &format!("{id}/{uid}"),
        json!({ "role": role.as_str() }),
    )
    .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn remove_member(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path((pid, uid)): Path<(String, i32)>,
) -> ApiResult<StatusCode> {
    let id = resolve(&st, &pid)?;
    user.require(&st, id, Perm::ProjectSettings)?;
    let c = st.pool.get().await?;
    c.execute(
        "DELETE FROM project_members WHERE project_id = $1 AND user_id = $2",
        &[&id, &uid],
    )
    .await?;
    st.reload_members().await?;
    audit(&st, &user, "member.remove", &format!("{id}/{uid}"), json!({})).await?;
    Ok(StatusCode::NO_CONTENT)
}
