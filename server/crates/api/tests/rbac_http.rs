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
    replayd_db::ensure_partitions(&c, 1, 7).await.unwrap();
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
    let iid: i64 = c
        .query_one(
            "INSERT INTO issues (project_id, fingerprint, level, source, title, first_seen, last_seen, last_release, times_seen) \
             VALUES ($1, '\\x01', 'error', 'onerror', 'TypeError: x', now(), now(), '1.0.0', 3) RETURNING id",
            &[&pid],
        )
        .await
        .unwrap()
        .get(0);
    // T-35: a recording with a network body and a WS frame, readable by members, filtered for viewers
    let data_dir = std::env::temp_dir().join(format!("rp-rbac-{tag}"));
    let sid = uuid::Uuid::now_v7();
    let day: String = c
        .query_one(
            "INSERT INTO sessions (id, project_id, started_at, last_at, file_day) VALUES ($1, $2, now(), now(), (now() AT TIME ZONE 'UTC')::date) RETURNING file_day::text",
            &[&sid, &pid],
        )
        .await
        .unwrap()
        .get(0);
    {
        use std::io::Write;
        let events = json!([
            {"type": 5, "timestamp": 1, "data": {"tag": "network", "payload": {"method": "GET", "url": "https://api/x", "status": 200, "resBody": "SECRET_BODY", "reqHeaders": {"x-a": "SECRET_HEADER"}}}},
            {"type": 5, "timestamp": 2, "data": {"tag": "ws", "payload": {"k": "frame", "id": 1, "dir": "in", "raw": "SECRET_FRAME"}}}
        ]);
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
        gz.write_all(events.to_string().as_bytes()).unwrap();
        let gz = gz.finish().unwrap();
        let mut body = (gz.len() as u32).to_le_bytes().to_vec();
        body.extend_from_slice(&gz);
        body.extend_from_slice(&0u16.to_le_bytes());
        let mut f = replayd_common::rpl::encode_header(sid.as_bytes()).to_vec();
        let h = replayd_common::rpl::FrameHeader {
            len: body.len() as u32,
            seq: 0,
            t0: 1,
            t1: 2,
            received_at: 0,
            flags: 0,
        };
        f.extend_from_slice(&h.encode());
        f.extend_from_slice(&body);
        let dir = data_dir.join(pid.to_string()).join(&day);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(format!("{}.rpl", sid.as_hyphenated())), f).unwrap();
    }
    let projects = Arc::new(ProjectCache::default());
    projects.reload(&pool).await.unwrap();
    let st = ApiState::new(
        pool.clone(),
        projects,
        "https://replay.example.com".into(),
        true,
        vec![],
        data_dir.clone(),
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
            format!("{p}/stats?range=24h"),
            None,
            [S::OK, S::OK, S::OK, S::OK, S::NOT_FOUND],
        ),
        (
            Method::GET,
            format!("{p}/stats?range=all"),
            None,
            [
                S::BAD_REQUEST,
                S::BAD_REQUEST,
                S::BAD_REQUEST,
                S::BAD_REQUEST,
                S::NOT_FOUND,
            ],
        ),
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
        // T-31: issue status — members and up, viewers read-only, outsiders don't see the issue
        (
            Method::PATCH,
            format!("/api/issues/{iid}"),
            Some(json!({"status": "resolved", "in_next_release": true})),
            [S::OK, S::OK, S::OK, S::FORBIDDEN, S::NOT_FOUND],
        ),
        (
            Method::PATCH,
            "/api/issues".into(),
            Some(json!({"ids": [iid], "status": "ignored", "ignore_count": 5})),
            [S::OK, S::OK, S::OK, S::FORBIDDEN, S::NOT_FOUND],
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
    // the last allowed bulk change applied: ignored until 5 more events (times_seen 3 → threshold 8)
    let r = c
        .query_one(
            "SELECT status, ignore_until_count, resolved_in_release FROM issues WHERE id = $1",
            &[&iid],
        )
        .await
        .unwrap();
    assert_eq!(r.get::<_, String>(0), "ignored");
    assert_eq!(r.get::<_, Option<i64>>(1), Some(8));
    assert_eq!(r.get::<_, Option<String>>(2), None);
    // resolve in next release pins the current last release
    let (code, v) = call(
        &app,
        Some(&sessions[2]),
        Method::PATCH,
        &format!("/api/issues/{iid}"),
        Some(json!({"status": "resolved", "in_next_release": true})),
        true,
    )
    .await;
    assert_eq!(code, S::OK);
    assert_eq!(v["resolved_in_release"], "1.0.0");
    assert_eq!(v["status"], "resolved");
    // T-35: recording — member sees bodies + frames, viewer gets the filtered copy, outsider 404
    let rec = |i: usize| {
        let app = app.clone();
        let s = &sessions[i];
        let uri = format!("/api/sessions/{sid}/recording");
        async move {
            let req = Request::get(&uri)
                .header(header::COOKIE, &s.cookie)
                .body(Body::empty())
                .unwrap();
            let r = app.oneshot(req).await.unwrap();
            let st = r.status();
            let b = axum::body::to_bytes(r.into_body(), 1 << 24).await.unwrap();
            let mut text = String::new();
            if st == S::OK {
                let idx = replayd_common::rpl::index(&b).unwrap();
                for f in idx.frames {
                    let body = &b[f.body_range()];
                    let n = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
                    let mut d = flate2::read::GzDecoder::new(&body[4..4 + n]);
                    std::io::Read::read_to_string(&mut d, &mut text).unwrap();
                }
            }
            (st, text)
        }
    };
    let (code, member) = rec(2).await;
    assert_eq!(code, S::OK);
    assert!(
        member.contains("SECRET_BODY") && member.contains("SECRET_FRAME") && member.contains("SECRET_HEADER")
    );
    let (code, viewer) = rec(3).await;
    assert_eq!(code, S::OK);
    for s in ["SECRET_BODY", "SECRET_FRAME", "SECRET_HEADER"] {
        assert!(!viewer.contains(s), "viewer recording leaks {s}: {viewer}");
    }
    assert!(viewer.contains("\"status\":200"), "metadata kept: {viewer}");
    assert_eq!(rec(4).await.0, S::NOT_FOUND);
    // session detail tells the dashboard what the user may see
    let (_, v) = call(
        &app,
        Some(&sessions[3]),
        Method::GET,
        &format!("/api/sessions/{sid}"),
        None,
        true,
    )
    .await;
    assert_eq!(v["can_view_sensitive"], false);
    // T-60: all project roles, including viewers, may create full-data capabilities.
    let share_path = format!("/api/sessions/{sid}/shares");
    let mut links = Vec::new();
    for (i, s) in sessions.iter().enumerate() {
        let (status, link) = call(
            &app,
            Some(s),
            Method::POST,
            &share_path,
            Some(json!({"expiry": "24h"})),
            true,
        )
        .await;
        assert_eq!(status, if i == 4 { S::NOT_FOUND } else { S::OK });
        if i < 4 {
            links.push(link);
        }
    }
    assert_eq!(
        call(
            &app,
            None,
            Method::POST,
            &share_path,
            Some(json!({"expiry": "1h"})),
            false
        )
        .await
        .0,
        S::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::POST,
            &share_path,
            Some(json!({"expiry": "1h"})),
            false
        )
        .await
        .0,
        S::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::POST,
            &share_path,
            Some(json!({"expiry": "forever"})),
            true
        )
        .await
        .0,
        S::BAD_REQUEST
    );
    let (_, listing) = call(&app, Some(&sessions[3]), Method::GET, &share_path, None, true).await;
    assert_eq!(listing["links"].as_array().unwrap().len(), 4);
    assert!(!listing.to_string().contains("token"));
    assert!(!listing.to_string().contains("url"));
    let link = &links[3];
    let token = link["url"].as_str().unwrap().rsplit('/').next().unwrap();
    let public_path = format!("/api/public/shares/{token}");
    let (status, public) = call(&app, None, Method::GET, &public_path, None, false).await;
    assert_eq!(status, S::OK);
    assert_eq!(public["id"], sid.to_string());
    assert_eq!(public["can_view_sensitive"], true);
    assert!(public.get("project_id").is_none());
    let response = app
        .clone()
        .oneshot(
            Request::get(format!("{public_path}/recording"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), S::OK);
    assert_eq!(response.headers()["referrer-policy"], "no-referrer");
    assert_eq!(response.headers()["cache-control"], "no-store");
    let bytes = axum::body::to_bytes(response.into_body(), 1 << 24).await.unwrap();
    let mut text = String::new();
    for f in replayd_common::rpl::index(&bytes).unwrap().frames {
        let body = &bytes[f.body_range()];
        let n = u32::from_le_bytes(body[..4].try_into().unwrap()) as usize;
        std::io::Read::read_to_string(&mut flate2::read::GzDecoder::new(&body[4..4 + n]), &mut text).unwrap();
    }
    assert!(text.contains("SECRET_BODY") && text.contains("SECRET_HEADER") && text.contains("SECRET_FRAME"));
    assert_eq!(
        rec(3).await.1,
        viewer,
        "share creation does not change authenticated viewer filtering"
    );
    let hash: Vec<u8> = c
        .query_one(
            "SELECT token_hash FROM replay_shares WHERE id = $1::text::uuid",
            &[&link["id"].as_str().unwrap()],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(hash, auth::token_hash(token));
    assert_ne!(hash, token.as_bytes());
    assert_eq!(
        call(
            &app,
            None,
            Method::GET,
            &format!("{public_path}/sessions/{}", uuid::Uuid::now_v7()),
            None,
            false
        )
        .await
        .0,
        S::NOT_FOUND
    );
    let revoke = format!("{share_path}/{}", link["id"].as_str().unwrap());
    assert_eq!(
        call(&app, Some(&sessions[4]), Method::DELETE, &revoke, None, true)
            .await
            .0,
        S::NOT_FOUND
    );
    assert_eq!(
        call(&app, Some(&sessions[3]), Method::DELETE, &revoke, None, true)
            .await
            .0,
        S::NO_CONTENT
    );
    assert_eq!(
        call(&app, None, Method::GET, &public_path, None, false).await.0,
        S::NOT_FOUND
    );
    for malformed in ["short", "!", "invalid-token"] {
        assert_eq!(
            call(
                &app,
                None,
                Method::GET,
                &format!("/api/public/shares/{malformed}"),
                None,
                false
            )
            .await
            .0,
            S::NOT_FOUND
        );
    }
    let expired = &links[0];
    c.execute(
        "UPDATE replay_shares SET expires_at = now() - interval '1 second' WHERE id = $1::text::uuid",
        &[&expired["id"].as_str().unwrap()],
    )
    .await
    .unwrap();
    let expired_token = expired["url"].as_str().unwrap().rsplit('/').next().unwrap();
    assert_eq!(
        call(
            &app,
            None,
            Method::GET,
            &format!("/api/public/shares/{expired_token}"),
            None,
            false
        )
        .await
        .0,
        S::NOT_FOUND
    );
    let audit_count: i64 = c.query_one("SELECT count(*) FROM audit_log WHERE action IN ('share.create','share.revoke') AND data->>'session_id' = $1", &[&sid.to_string()]).await.unwrap().get(0);
    assert_eq!(audit_count, 5, "only creation and revocation are audited");
    std::fs::remove_dir_all(&data_dir).ok();

    // T-62: only project admins / superadmins can manage ignore rules.
    let ignore_path = format!("/api/projects/{pid}/ignore-rules");
    let rule = json!({"kind":"error","match_type":"contains","pattern":"Noise"});
    let mut rule_ids = Vec::new();
    for (i, session) in sessions.iter().enumerate() {
        let expected = if i < 2 {
            S::OK
        } else if i < 4 {
            S::FORBIDDEN
        } else {
            S::NOT_FOUND
        };
        assert_eq!(
            call(&app, Some(session), Method::GET, &ignore_path, None, true)
                .await
                .0,
            expected
        );
        let (code, body) = call(
            &app,
            Some(session),
            Method::POST,
            &ignore_path,
            Some(rule.clone()),
            true,
        )
        .await;
        assert_eq!(code, expected);
        if i < 2 {
            rule_ids.push(body["id"].as_i64().unwrap());
        }
    }
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::POST,
            &ignore_path,
            Some(rule.clone()),
            false
        )
        .await
        .0,
        S::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::POST,
            &ignore_path,
            Some(json!({"kind":"error","match_type":"regex","pattern":"["})),
            true
        )
        .await
        .0,
        S::BAD_REQUEST
    );
    let edit_path = format!("{ignore_path}/{}", rule_ids[0]);
    for i in [2, 3, 4] {
        let expected = if i == 4 { S::NOT_FOUND } else { S::FORBIDDEN };
        assert_eq!(
            call(
                &app,
                Some(&sessions[i]),
                Method::PUT,
                &edit_path,
                Some(rule.clone()),
                true
            )
            .await
            .0,
            expected
        );
        assert_eq!(
            call(&app, Some(&sessions[i]), Method::DELETE, &edit_path, None, true)
                .await
                .0,
            expected
        );
    }
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::PUT,
            &edit_path,
            Some(json!({"kind":"network","match_type":"regex","pattern":"^wss:"})),
            true
        )
        .await
        .0,
        S::OK
    );
    // Fill near the cap; concurrent creations still cannot exceed 50.
    c.execute("INSERT INTO ignore_rules (project_id,kind,match_type,pattern) SELECT $1,'error','contains','x' FROM generate_series(1,47)", &[&pid]).await.unwrap();
    let (a, b) = tokio::join!(
        call(
            &app,
            Some(&sessions[1]),
            Method::POST,
            &ignore_path,
            Some(rule.clone()),
            true
        ),
        call(
            &app,
            Some(&sessions[0]),
            Method::POST,
            &ignore_path,
            Some(rule.clone()),
            true
        )
    );
    assert!((a.0 == S::OK && b.0 == S::BAD_REQUEST) || (b.0 == S::OK && a.0 == S::BAD_REQUEST));
    assert_eq!(
        c.query_one("SELECT count(*) FROM ignore_rules WHERE project_id=$1", &[&pid])
            .await
            .unwrap()
            .get::<_, i64>(0),
        50
    );
    assert_eq!(
        call(&app, Some(&sessions[1]), Method::DELETE, &edit_path, None, true)
            .await
            .0,
        S::NO_CONTENT
    );
    assert_eq!(
        c.query_one(
            "SELECT count(*) FROM audit_log WHERE action LIKE 'ignore_rule.%' AND data->>'project_id'=$1",
            &[&pid.to_string()]
        )
        .await
        .unwrap()
        .get::<_, i64>(0),
        5
    );

    // bad status → 400
    let (code, _) = call(
        &app,
        Some(&sessions[0]),
        Method::PATCH,
        &format!("/api/issues/{iid}"),
        Some(json!({"status": "deleted"})),
        true,
    )
    .await;
    assert_eq!(code, S::BAD_REQUEST);
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

    // Own password: CSRF and old-password validation, current session survives, others do not.
    let second = login(&app, &format!("viewer-{tag}@it.example")).await;
    let change = json!({"current_password": "test-password-123", "new_password": "replacement-password-456"});
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::POST,
            "/api/me/password",
            Some(change.clone()),
            false
        )
        .await
        .0,
        S::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::POST,
            "/api/me/password",
            Some(json!({"current_password":"wrong-password", "new_password":"replacement-password-456"})),
            true
        )
        .await
        .0,
        S::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::POST,
            "/api/me/password",
            Some(json!({"current_password":"test-password-123", "new_password":"short"})),
            true
        )
        .await
        .0,
        S::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::POST,
            "/api/me/password",
            Some(change),
            true
        )
        .await
        .0,
        S::NO_CONTENT
    );
    assert_eq!(
        call(&app, Some(&sessions[3]), Method::GET, "/api/me", None, true)
            .await
            .0,
        S::OK
    );
    assert_eq!(
        call(&app, Some(&second), Method::GET, "/api/me", None, true)
            .await
            .0,
        S::UNAUTHORIZED
    );
    let hash: String = c
        .query_one("SELECT password_hash FROM users WHERE id = $1", &[&ids[3]])
        .await
        .unwrap()
        .get(0);
    assert!(auth::verify_password("replacement-password-456", Some(&hash)));
    assert!(!auth::verify_password("test-password-123", Some(&hash)));

    // An admin may add an existing account by exact email without directory access.
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::POST,
            &format!("{p}/members"),
            Some(json!({"email":format!("outsider-{tag}@it.example"), "role":"member"})),
            true
        )
        .await
        .0,
        S::NO_CONTENT
    );
    // Viewer cannot delete; active sessions cannot be deleted even by an admin.
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::DELETE,
            &format!("/api/issues/{iid}"),
            None,
            true
        )
        .await
        .0,
        S::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[3]),
            Method::DELETE,
            &format!("/api/sessions/{sid}"),
            None,
            true
        )
        .await
        .0,
        S::FORBIDDEN
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::DELETE,
            &format!("/api/sessions/{sid}"),
            None,
            true
        )
        .await
        .0,
        S::BAD_REQUEST
    );
    c.execute("UPDATE sessions SET ended = true WHERE id = $1", &[&sid])
        .await
        .unwrap();
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::DELETE,
            &format!("/api/sessions/{sid}"),
            None,
            true
        )
        .await
        .0,
        S::NO_CONTENT
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::GET,
            &format!("/api/sessions/{sid}/recording"),
            None,
            true
        )
        .await
        .0,
        S::NOT_FOUND
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[1]),
            Method::DELETE,
            &format!("/api/issues/{iid}"),
            None,
            true
        )
        .await
        .0,
        S::NO_CONTENT
    );

    // User administration: reset and disable revoke sessions; self-demotion is rejected.
    assert_eq!(
        call(
            &app,
            Some(&sessions[0]),
            Method::PATCH,
            &format!("/api/users/{}", ids[0]),
            Some(json!({"is_superadmin":false})),
            true
        )
        .await
        .0,
        S::BAD_REQUEST
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[0]),
            Method::PATCH,
            &format!("/api/users/{}", ids[4]),
            Some(json!({"password":"reset-password-456"})),
            true
        )
        .await
        .0,
        S::OK
    );
    assert_eq!(
        call(&app, Some(&sessions[4]), Method::GET, "/api/me", None, true)
            .await
            .0,
        S::UNAUTHORIZED
    );
    assert_eq!(
        call(
            &app,
            Some(&sessions[0]),
            Method::PATCH,
            &format!("/api/users/{}", ids[3]),
            Some(json!({"disabled":true})),
            true
        )
        .await
        .0,
        S::OK
    );
    assert_eq!(
        call(&app, Some(&sessions[3]), Method::GET, "/api/me", None, true)
            .await
            .0,
        S::UNAUTHORIZED
    );

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
