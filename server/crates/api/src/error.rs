use axum::Json;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("forbidden")]
    Forbidden,
    #[error("not found")]
    NotFound,
    #[error("{0}")]
    BadRequest(String),
    #[error("{0}")]
    Conflict(String),
    #[error("too many requests")]
    TooMany(u64),
    #[error("internal error")]
    Internal(String),
}

impl From<replayd_db::DbError> for ApiError {
    fn from(e: replayd_db::DbError) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl From<replayd_db::tokio_postgres::Error> for ApiError {
    fn from(e: replayd_db::tokio_postgres::Error) -> Self {
        if let Some(db) = e.as_db_error()
            && db.code() == &replayd_db::tokio_postgres::error::SqlState::UNIQUE_VIOLATION
        {
            return ApiError::Conflict("already exists".into());
        }
        ApiError::Internal(e.to_string())
    }
}

impl From<deadpool_postgres::PoolError> for ApiError {
    fn from(e: deadpool_postgres::PoolError) -> Self {
        ApiError::Internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (code, msg) = match &self {
            ApiError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            ApiError::Forbidden => (StatusCode::FORBIDDEN, "forbidden".to_string()),
            ApiError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            ApiError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            ApiError::Conflict(m) => (StatusCode::CONFLICT, m.clone()),
            ApiError::TooMany(_) => (StatusCode::TOO_MANY_REQUESTS, "too many requests".to_string()),
            ApiError::Internal(e) => {
                // details go to logs only (never payloads/tokens: DB errors don't contain them)
                tracing::error!(error = %e, "api internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal error".to_string())
            }
        };
        let mut r = (code, Json(json!({ "error": msg }))).into_response();
        if let ApiError::TooMany(s) = self {
            r.headers_mut().insert(axum::http::header::RETRY_AFTER, s.into());
        }
        r
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
