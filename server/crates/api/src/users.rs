//! `/api/users` — superadmin only.

use std::sync::Arc;

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::auth::{self, Auth};
use crate::error::{ApiError, ApiResult};
use crate::{ApiState, audit};

pub(crate) fn user_json(r: &replayd_db::tokio_postgres::Row) -> Value {
    json!({
        "id": r.get::<_, i32>(0),
        "email": r.get::<_, String>(1),
        "name": r.get::<_, Option<String>>(2),
        "is_superadmin": r.get::<_, bool>(3),
        "disabled": r.get::<_, bool>(4),
        "created_at": r.get::<_, i64>(5),
    })
}

const USER_COLS: &str =
    "id, email, name, is_superadmin, disabled, (extract(epoch from created_at) * 1000)::bigint";

#[derive(Deserialize)]
pub struct ChangePassword {
    current_password: String,
    new_password: String,
}

/// Keep the calling session; revoke other sessions atomically with the password update.
pub async fn change_password(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Json(req): Json<ChangePassword>,
) -> ApiResult<StatusCode> {
    auth::validate_password(&req.new_password)?;
    auth::validate_password(&req.current_password)?;
    st.login_email
        .take(
            crate::email_key(&user.email),
            1.0 / 12.0,
            5.0,
            std::time::Instant::now(),
        )
        .map_err(ApiError::TooMany)?;
    let mut c = st.pool.get().await?;
    let stored: String = c
        .query_one("SELECT password_hash FROM users WHERE id = $1", &[&user.user_id])
        .await?
        .get(0);
    let old = stored.clone();
    let verified =
        tokio::task::spawn_blocking(move || auth::verify_password(&req.current_password, Some(&old)))
            .await
            .map_err(|e| ApiError::Internal(e.to_string()))?;
    if !verified {
        return Err(ApiError::BadRequest("current password is incorrect".into()));
    }
    let new_hash = hash(req.new_password).await?;
    let tx = c.transaction().await?;
    // Compare the old hash so concurrent changes cannot resurrect an obsolete password.
    let n = tx
        .execute(
            "UPDATE users SET password_hash = $2 WHERE id = $1 AND password_hash = $3 AND NOT disabled",
            &[&user.user_id, &new_hash, &stored],
        )
        .await?;
    if n != 1 {
        return Err(ApiError::BadRequest("account changed; sign in again".into()));
    }
    tx.execute(
        "DELETE FROM user_sessions WHERE user_id = $1 AND token_hash <> $2",
        &[&user.user_id, &user.token_hash],
    )
    .await?;
    tx.execute(
        "INSERT INTO audit_log (user_id, action, target, data) VALUES ($1, 'account.password', $2, '{}')",
        &[&user.user_id, &user.user_id.to_string()],
    )
    .await?;
    tx.commit().await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list(State(st): State<Arc<ApiState>>, user: Auth) -> ApiResult<Json<Value>> {
    user.require_superadmin()?;
    let c = st.pool.get().await?;
    let rows = c
        .query(&format!("SELECT {USER_COLS} FROM users ORDER BY id"), &[])
        .await?;
    Ok(Json(
        json!({ "users": rows.iter().map(user_json).collect::<Vec<_>>() }),
    ))
}

#[derive(Deserialize)]
pub struct CreateUser {
    email: String,
    name: Option<String>,
    password: String,
    #[serde(default)]
    is_superadmin: bool,
}

async fn hash(pw: String) -> ApiResult<String> {
    tokio::task::spawn_blocking(move || auth::hash_password(&pw))
        .await
        .map_err(|e| ApiError::Internal(e.to_string()))?
}

pub async fn create(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Json(req): Json<CreateUser>,
) -> ApiResult<(StatusCode, Json<Value>)> {
    user.require_superadmin()?;
    let email = req.email.trim().to_ascii_lowercase();
    if !email.contains('@') || email.len() > 254 {
        return Err(ApiError::BadRequest("invalid email".into()));
    }
    auth::validate_password(&req.password)?;
    let h = hash(req.password).await?;
    let c = st.pool.get().await?;
    let row = c
        .query_one(
            &format!(
                "INSERT INTO users (email, name, password_hash, is_superadmin) VALUES ($1, $2, $3, $4) \
                 RETURNING {USER_COLS}"
            ),
            &[&email, &req.name, &h, &req.is_superadmin],
        )
        .await?;
    let v = user_json(&row);
    audit(
        &st,
        &user,
        "user.create",
        &email,
        json!({ "is_superadmin": req.is_superadmin }),
    )
    .await?;
    Ok((StatusCode::CREATED, Json(v)))
}

#[derive(Deserialize)]
pub struct UpdateUser {
    name: Option<String>,
    password: Option<String>,
    disabled: Option<bool>,
    is_superadmin: Option<bool>,
}

pub async fn update(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(id): Path<i32>,
    Json(req): Json<UpdateUser>,
) -> ApiResult<Json<Value>> {
    user.require_superadmin()?;
    if id == user.user_id && (req.disabled == Some(true) || req.is_superadmin == Some(false)) {
        return Err(ApiError::BadRequest("cannot disable or demote yourself".into()));
    }
    let new_hash = match req.password {
        Some(pw) => {
            auth::validate_password(&pw)?;
            Some(hash(pw).await?)
        }
        None => None,
    };
    let c = st.pool.get().await?;
    let row = c
        .query_opt(
            &format!(
                "UPDATE users SET name = COALESCE($2, name), password_hash = COALESCE($3, password_hash), \
                 disabled = COALESCE($4, disabled), is_superadmin = COALESCE($5, is_superadmin) \
                 WHERE id = $1 RETURNING {USER_COLS}"
            ),
            &[&id, &req.name, &new_hash, &req.disabled, &req.is_superadmin],
        )
        .await?
        .ok_or(ApiError::NotFound)?;
    if new_hash.is_some() || req.disabled == Some(true) {
        c.execute("DELETE FROM user_sessions WHERE user_id = $1", &[&id])
            .await?;
    }
    audit(
        &st,
        &user,
        "user.update",
        &id.to_string(),
        json!({ "password_changed": new_hash.is_some(), "disabled": req.disabled, "is_superadmin": req.is_superadmin }),
    )
    .await?;
    Ok(Json(user_json(&row)))
}

pub async fn delete(
    State(st): State<Arc<ApiState>>,
    user: Auth,
    Path(id): Path<i32>,
) -> ApiResult<StatusCode> {
    user.require_superadmin()?;
    if id == user.user_id {
        return Err(ApiError::BadRequest("cannot delete yourself".into()));
    }
    let c = st.pool.get().await?;
    let n = c.execute("DELETE FROM users WHERE id = $1", &[&id]).await?;
    if n == 0 {
        return Err(ApiError::NotFound);
    }
    st.reload_members().await?;
    audit(&st, &user, "user.delete", &id.to_string(), json!({})).await?;
    Ok(StatusCode::NO_CONTENT)
}
