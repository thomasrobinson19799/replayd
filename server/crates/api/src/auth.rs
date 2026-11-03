//! Dashboard authentication: argon2id passwords, 256-bit random session tokens (only their SHA-256 is
//! stored), HttpOnly session cookie + double-submit CSRF token (§8).

use std::sync::Arc;

use argon2::Argon2;
use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, header};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::{Digest, Sha256};

use crate::ApiState;
use crate::error::ApiError;
use crate::rbac::{Perm, Role, allowed};

pub const SESSION_COOKIE: &str = "rp_session";
pub const CSRF_COOKIE: &str = "rp_csrf";
pub const SESSION_DAYS: i64 = 14;

pub fn random_token() -> String {
    let mut b = [0u8; 32];
    getrandom::getrandom(&mut b).expect("os rng");
    URL_SAFE_NO_PAD.encode(b)
}

pub fn token_hash(token: &str) -> Vec<u8> {
    Sha256::digest(token.as_bytes()).to_vec()
}

pub fn hash_password(pw: &str) -> Result<String, ApiError> {
    let salt = SaltString::generate(&mut argon2::password_hash::rand_core::OsRng);
    Argon2::default()
        .hash_password(pw.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|e| ApiError::Internal(format!("hash: {e}")))
}

/// Constant-ish time: always runs one argon2 verification, also for unknown users.
pub fn verify_password(pw: &str, stored: Option<&str>) -> bool {
    static DUMMY: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(|| hash_password("dummy-password-for-timing").unwrap_or_default());
    let h = stored.unwrap_or(DUMMY.as_str());
    let ok = PasswordHash::new(h)
        .map(|ph| Argon2::default().verify_password(pw.as_bytes(), &ph).is_ok())
        .unwrap_or(false);
    ok && stored.is_some()
}

pub fn validate_password(pw: &str) -> Result<(), ApiError> {
    if pw.chars().count() < 10 {
        return Err(ApiError::BadRequest(
            "password must be at least 10 characters".into(),
        ));
    }
    if pw.len() > 256 {
        return Err(ApiError::BadRequest("password too long".into()));
    }
    Ok(())
}

pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for v in headers.get_all(header::COOKIE) {
        let Ok(s) = v.to_str() else { continue };
        for part in s.split(';') {
            if let Some((k, val)) = part.trim().split_once('=')
                && k == name
            {
                return Some(val.to_string());
            }
        }
    }
    None
}

pub fn set_cookie_headers(token: &str, csrf: &str, secure: bool, max_age_secs: i64) -> [String; 2] {
    let sec = if secure { "; Secure" } else { "" };
    [
        format!("{SESSION_COOKIE}={token}; Path=/api; HttpOnly; SameSite=Lax; Max-Age={max_age_secs}{sec}"),
        format!("{CSRF_COOKIE}={csrf}; Path=/; SameSite=Lax; Max-Age={max_age_secs}{sec}"),
    ]
}

/// Authenticated dashboard user (extractor). Mutating requests must carry `X-CSRF-Token`.
#[derive(Debug, Clone)]
pub struct Auth {
    pub user_id: i32,
    pub email: String,
    pub name: Option<String>,
    pub is_superadmin: bool,
    pub csrf: String,
    pub token_hash: Vec<u8>,
}

impl Auth {
    pub fn role(&self, st: &ApiState, project_id: i32) -> Option<Role> {
        st.members.role(self.user_id, project_id)
    }
    pub fn can(&self, st: &ApiState, project_id: i32, perm: Perm) -> bool {
        allowed(self.is_superadmin, self.role(st, project_id), perm)
    }
    pub fn require(&self, st: &ApiState, project_id: i32, perm: Perm) -> Result<(), ApiError> {
        if self.can(st, project_id, perm) {
            Ok(())
        } else if self.role(st, project_id).is_none() && !self.is_superadmin {
            // don't reveal existence of projects the user can't see
            Err(ApiError::NotFound)
        } else {
            Err(ApiError::Forbidden)
        }
    }
    pub fn require_superadmin(&self) -> Result<(), ApiError> {
        if self.is_superadmin {
            Ok(())
        } else {
            Err(ApiError::Forbidden)
        }
    }
}

impl FromRequestParts<Arc<ApiState>> for Auth {
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, st: &Arc<ApiState>) -> Result<Self, Self::Rejection> {
        let token = cookie(&parts.headers, SESSION_COOKIE).ok_or(ApiError::Unauthorized)?;
        let th = token_hash(&token);
        let c = st.pool.get().await?;
        let row = c
            .query_opt(
                "SELECT u.id, u.email, u.name, u.is_superadmin, s.csrf_token FROM user_sessions s \
                 JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now() AND NOT u.disabled",
                &[&th],
            )
            .await?
            .ok_or(ApiError::Unauthorized)?;
        let auth = Auth {
            user_id: row.get(0),
            email: row.get(1),
            name: row.get(2),
            is_superadmin: row.get(3),
            csrf: row.get(4),
            token_hash: th,
        };
        let mutating = !matches!(parts.method, Method::GET | Method::HEAD | Method::OPTIONS);
        if mutating {
            let sent = parts
                .headers
                .get("x-csrf-token")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("");
            if sent.is_empty() || !constant_eq(sent.as_bytes(), auth.csrf.as_bytes()) {
                return Err(ApiError::Forbidden);
            }
        }
        Ok(auth)
    }
}

fn constant_eq(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len() && a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn password_roundtrip_and_tokens() {
        let h = hash_password("correct horse battery").unwrap();
        assert!(h.starts_with("$argon2id$"));
        assert!(verify_password("correct horse battery", Some(&h)));
        assert!(!verify_password("wrong", Some(&h)));
        assert!(!verify_password("correct horse battery", None));
        let t = random_token();
        assert_eq!(t.len(), 43);
        assert_ne!(t, random_token());
        assert_eq!(token_hash(&t).len(), 32);
        assert!(validate_password("short").is_err());
    }

    #[test]
    fn cookies() {
        let mut h = HeaderMap::new();
        h.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; rp_session=abc; rp_csrf=x"),
        );
        assert_eq!(cookie(&h, SESSION_COOKIE).as_deref(), Some("abc"));
        assert_eq!(cookie(&h, "zz"), None);
        let [s, c] = set_cookie_headers("t", "c", true, 60);
        assert!(s.contains("HttpOnly") && s.contains("Secure") && s.contains("SameSite=Lax"));
        assert!(!c.contains("HttpOnly"));
        assert!(constant_eq(b"abc", b"abc") && !constant_eq(b"abc", b"abd"));
    }
}
