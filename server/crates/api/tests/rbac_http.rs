//! RBAC matrix over HTTP (§5.10) against a real Postgres (skipped without REPLAYD_TEST_DATABASE_URL).

use std::net::SocketAddr;
use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{Method, Request, StatusCode, header};
use replayd_api::{ApiState, auth};
use replayd_ingest::ProjectCache;
use serde_json::{Value, json};
use tower::ServiceExt;

struct Session {
    cookie: String,
    csrf: String,
}

async fn call(
    app: &Router,
    s: Option<&Session>,
    m: Method,
    uri: &str,
    body: Option<Value>,
    csrf: bool,
) -> (StatusCode, Value) {
    let mut b = Request::builder().method(m).uri(uri);
    if let Some(s) = s {
        b = b.header(header::COOKIE, &s.cookie);
        if csrf {
            b = b.header("x-csrf-token", &s.csrf);
        }
    }
    let req = match body {
        Some(v) => b
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(v.to_string())),
        None => b.body(Body::empty()),
    }
    .unwrap();
    let r = app.clone().oneshot(req).await.unwrap();
    let st = r.status();
    let bytes = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
    (st, serde_json::from_slice(&bytes).unwrap_or(Value::Null))
}

async fn login(app: &Router, email: &str) -> Session {
    let r = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"email": email, "password": "test-password-123"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK, "login {email}");
    let cookies: Vec<String> = r
        .headers()
        .get_all(header::SET_COOKIE)
        .iter()
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string())
        .collect();
    let session = cookies
        .iter()
        .find(|c| c.starts_with("rp_session="))
        .unwrap()
        .clone();
    let csrf = cookies.iter().find(|c| c.starts_with("rp_csrf=")).unwrap()["rp_csrf=".len()..].to_string();
    Session {
        cookie: session,
        csrf,
    }
}

#[tokio::test]
async fn rbac_matrix_over_http() {
    let Some(pool) = replayd_db::test_pool() else {
        eprintln!("skipped: REPLAYD_TEST_DATABASE_URL not set");
        return;
    };
    let tag = std::process::id();
    let c = pool.get().await.unwrap();
    let hash = auth::hash_password("test-password-123").unwrap();
    let roles = ["super", "admin", "member", "viewer", "outsider"];
    let mut ids = vec![];
    for r in roles {
        let id: i32 = c
            .query_one(
                "INSERT INTO users (email, password_hash, is_superadmin) VALUES ($1, $2, $3) RETURNING id",
                &[&format!("{r}-{tag}@it.example"), &hash, &(r == "super")],
            )
            .await
            .unwrap()
            .get(0);
        ids.push(id);
    }
    let slug = format!("it-rbac-{tag}");
    let pid: i32 = c
        .query_one(
            "INSERT INTO projects (slug, name, public_key, upload_token_hash) VALUES ($1, 'RBAC', 'pk', '\\x00') RETURNING id",
            &[&slug],
        )
        .await
        .unwrap()
        .get(0);
    for (i, role) in [(1, "admin"), (2, "member"), (3, "viewer")] {
        c.execute(
            "INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3::text::project_role)",
            &[&pid, &ids[i], &role],
        )
        .await
        .unwrap();
    }
    let projects = Arc::new(ProjectCache::default());
    projects.reload(&pool).await.unwrap();
    let st = ApiState::new(
        pool.clone(),
        projects,
        "https://replay.example.com".into(),
        true,
        vec![],
    )
    .await
    .unwrap();
    let app = replayd_api::router(st).layer(MockConnectInfo(SocketAddr::from(([127, 0, 0, 1], 1))));
    let mut sessions = vec![];
    for r in roles {
        sessions.push(login(&app, &format!("{r}-{tag}@it.example")).await);
    }

    use StatusCode as S;
    let p = format!("/api/projects/{pid}");
    let cases: Vec<(Method, String, Option<Value>, [S; 5])> = vec![
        (
            Method::GET,
            p.clone(),
            None,
            [S::OK, S::OK, S::OK, S::OK, S::NOT_FOUND],
        ),
        (
            Method::GET,
            format!("/api/projects/{slug}"),
            None,
            [S::OK, S::OK, S::OK, S::OK, S::NOT_FOUND],
        ),
        (
            Method::GET,
            format!("{p}/issues"),
            None,
            [S::OK, S::OK, S::OK, S::OK, S::NOT_FOUND],
        ),
        (
            Method::PATCH,
            p.clone(),
            Some(json!({"name": "RBAC 2"})),
            [S::OK, S::OK, S::FORBIDDEN, S::FORBIDDEN, S::NOT_FOUND],
        ),
        (
            Method::GET,
            format!("{p}/members"),
            None,
            [S::OK, S::OK, S::FORBIDDEN, S::FORBIDDEN, S::NOT_FOUND],
        ),
        (
            Method::POST,
            format!("{p}/keys/rotate"),
            Some(json!({"kind": "upload"})),
            [S::OK, S::OK, S::FORBIDDEN, S::FORBIDDEN, S::NOT_FOUND],
        ),
        (
            Method::GET,
            "/api/users".into(),
            None,
            [S::OK, S::FORBIDDEN, S::FORBIDDEN, S::FORBIDDEN, S::FORBIDDEN],
        ),
        (
            Method::POST,
            "/api/projects".into(),
            Some(json!({"slug": format!("x-{tag}"), "name": "X"})),
            [S::CREATED, S::FORBIDDEN, S::FORBIDDEN, S::FORBIDDEN, S::FORBIDDEN],
        ),
        (
            Method::GET,
            "/api/me".into(),
            None,
            [S::OK, S::OK, S::OK, S::OK, S::OK],
        ),
    ];
    for (m, uri, body, expect) in &cases {
        for (i, s) in sessions.iter().enumerate() {
            let (code, _) = call(&app, Some(s), m.clone(), uri, body.clone(), true).await;
            assert_eq!(code, expect[i], "{m} {uri} as {}", roles[i]);
        }
    }
    // the telegram bot token is never returned in clear
    let (code, _) = call(
        &app,
        Some(&sessions[1]),
        Method::PATCH,
        &p,
        Some(json!({"telegram": {"bot_token": "123:SECRET", "chat_id": "-100"}})),
        true,
    )
    .await;
    assert_eq!(code, S::OK);
    let (_, v) = call(&app, Some(&sessions[1]), Method::GET, &p, None, true).await;
    assert_eq!(v["telegram"]["bot_token"], "***");
    let (_, v) = call(&app, Some(&sessions[3]), Method::GET, &p, None, true).await;
    assert_eq!(v["telegram"], Value::Null, "viewer never sees telegram settings");
    // masked token on update keeps the stored one
    call(
        &app,
        Some(&sessions[1]),
        Method::PATCH,
        &p,
        Some(json!({"telegram": {"bot_token": "***", "chat_id": "-200"}})),
        true,
    )
    .await;
    let tok: Value = c
        .query_one("SELECT telegram FROM projects WHERE id = $1", &[&pid])
        .await
        .unwrap()
        .get(0);
    assert_eq!(tok["bot_token"], "123:SECRET");
    assert_eq!(tok["chat_id"], "-200");

    // CSRF required for mutations even for superadmin; anonymous gets 401
    let (code, _) = call(
        &app,
        Some(&sessions[0]),
        Method::PATCH,
        &p,
        Some(json!({"name": "n"})),
        false,
    )
    .await;
    assert_eq!(code, S::FORBIDDEN);
    let (code, _) = call(&app, None, Method::GET, &p, None, false).await;
    assert_eq!(code, S::UNAUTHORIZED);
    // membership changes take effect immediately (cache invalidated)
    let (code, _) = call(
        &app,
        Some(&sessions[1]),
        Method::PUT,
        &format!("{p}/members/{}", ids[4]),
        Some(json!({"role": "viewer"})),
        true,
    )
    .await;
    assert_eq!(code, S::NO_CONTENT);
    let (code, _) = call(&app, Some(&sessions[4]), Method::GET, &p, None, true).await;
    assert_eq!(code, S::OK);
    // logout invalidates the session
    let (code, _) = call(
        &app,
        Some(&sessions[2]),
        Method::POST,
        "/api/auth/logout",
        None,
        true,
    )
    .await;
    assert_eq!(code, S::NO_CONTENT);
    let (code, _) = call(&app, Some(&sessions[2]), Method::GET, "/api/me", None, true).await;
    assert_eq!(code, S::UNAUTHORIZED);
    // wrong password → 401, audit log written
    let r = app
        .clone()
        .oneshot(
            Request::post("/api/auth/login")
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    json!({"email": format!("admin-{tag}@it.example"), "password": "nope-nope-nope"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), S::UNAUTHORIZED);
    let n: i64 = c
        .query_one("SELECT count(*) FROM audit_log WHERE user_id = ANY($1)", &[&ids])
        .await
        .unwrap()
        .get(0);
    assert!(n >= 4);

    c.execute(
        "DELETE FROM projects WHERE slug = ANY($1)",
        &[&vec![slug.clone(), format!("x-{tag}")]],
    )
    .await
    .unwrap();
    c.execute("DELETE FROM users WHERE id = ANY($1)", &[&ids])
        .await
        .unwrap();
}
