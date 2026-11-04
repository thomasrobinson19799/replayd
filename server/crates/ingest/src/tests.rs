use super::*;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::Request as HttpRequest;
use replayd_db::ProjectRow;
use serde_json::json;
use tower::ServiceExt;

fn row(id: i32, slug: &str, origins: &[&str], rc: serde_json::Value) -> ProjectRow {
    ProjectRow {
        id,
        slug: slug.into(),
        name: slug.into(),
        public_key: format!("pk_{slug}"),
        allowed_origins: origins.iter().map(|s| s.to_string()).collect(),
        remote_config: rc,
        retention_days: 14,
        fingerprint_rules: json!([]),
        telegram: None,
        asset_base_url: None,
        asset_rewrite_from: vec![],
    }
}

struct Setup {
    app: Router,
    rx: mpsc::Receiver<EventJob>,
}

fn setup(queue: usize, cfg: IngestConfig) -> Setup {
    setup_with_sdk(queue, cfg, std::env::temp_dir())
}

fn setup_with_sdk(queue: usize, cfg: IngestConfig, sdk_dir: std::path::PathBuf) -> Setup {
    let cache = Arc::new(ProjectCache::default());
    cache.replace(vec![
        row(
            1,
            "fx",
            &["https://terminal.fxglory.com", "https://localhost"],
            json!({}),
        ),
        row(2, "off", &[], json!({"disabled": true})),
    ]);
    let (tx, rx) = mpsc::channel(queue);
    let st = Arc::new(IngestState::new(
        cache,
        cfg,
        vec!["10.0.0.1".parse().unwrap()],
        tx,
        None,
    ));
    let app = router(st, sdk_dir).layer(MockConnectInfo(SocketAddr::from(([203, 0, 113, 7], 5555))));
    Setup { app, rx }
}

fn post(uri: &str, origin: Option<&str>, body: &'static [u8]) -> HttpRequest<Body> {
    let mut b = HttpRequest::post(uri).header("content-type", "text/plain");
    if let Some(o) = origin {
        b = b.header("origin", o);
    }
    b.body(Body::from(body)).unwrap()
}

const GZ: &[u8] = &[0x1f, 0x8b, 8, 0, 0, 0, 0, 0];

#[tokio::test]
async fn events_happy_path_enqueues_and_sets_cors() {
    let mut s = setup(8, IngestConfig::default());
    let r = s
        .app
        .clone()
        .oneshot(post(
            "/ingest/fx/events?key=pk_fx",
            Some("https://terminal.fxglory.com"),
            GZ,
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    assert_eq!(
        r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://terminal.fxglory.com"
    );
    let job = s.rx.try_recv().unwrap();
    assert_eq!(job.project_id, 1);
    assert_eq!(&job.body[..], GZ);
    // numeric id works too, plain JSON accepted
    let r = s
        .app
        .oneshot(post(
            "/ingest/1/events?key=pk_fx",
            Some("https://localhost"),
            b" [{}]",
        ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
}

#[tokio::test]
async fn rejects_bad_key_origin_payload() {
    let s = setup(8, IngestConfig::default());
    let o = Some("https://terminal.fxglory.com");
    for (uri, origin, body, code) in [
        ("/ingest/fx/events?key=nope", o, GZ, StatusCode::FORBIDDEN),
        ("/ingest/fx/events", o, GZ, StatusCode::FORBIDDEN),
        ("/ingest/nope/events?key=pk_fx", o, GZ, StatusCode::FORBIDDEN),
        (
            "/ingest/fx/events?key=pk_fx",
            Some("https://evil.example"),
            GZ,
            StatusCode::FORBIDDEN,
        ),
        ("/ingest/fx/events?key=pk_fx", None, GZ, StatusCode::FORBIDDEN),
        (
            "/ingest/fx/events?key=pk_fx",
            o,
            b"hello",
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let r = s.app.clone().oneshot(post(uri, origin, body)).await.unwrap();
        assert_eq!(r.status(), code, "{uri} {origin:?}");
    }
}

#[tokio::test]
async fn body_cap_413() {
    let cfg = IngestConfig {
        max_events_body: 4,
        ..Default::default()
    };
    let s = setup(8, cfg);
    let r = s
        .app
        .oneshot(post("/ingest/fx/events?key=pk_fx", Some("https://localhost"), GZ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn full_queue_is_503_with_retry_after() {
    let s = setup(1, IngestConfig::default());
    let o = Some("https://localhost");
    let r1 = s
        .app
        .clone()
        .oneshot(post("/ingest/fx/events?key=pk_fx", o, GZ))
        .await
        .unwrap();
    assert_eq!(r1.status(), StatusCode::ACCEPTED);
    let r2 = s
        .app
        .oneshot(post("/ingest/fx/events?key=pk_fx", o, GZ))
        .await
        .unwrap();
    assert_eq!(r2.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(r2.headers()[header::RETRY_AFTER], "5");
    assert_eq!(
        r2.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN],
        "https://localhost"
    );
    drop(s.rx);
}

#[tokio::test]
async fn ip_rate_limit_429() {
    let cfg = IngestConfig {
        ip_rps: 0.001,
        ip_burst: 2.0,
        ..Default::default()
    };
    let s = setup(64, cfg);
    let o = Some("https://localhost");
    let mut codes = vec![];
    for _ in 0..3 {
        codes.push(
            s.app
                .clone()
                .oneshot(post("/ingest/fx/events?key=pk_fx", o, GZ))
                .await
                .unwrap()
                .status(),
        );
    }
    assert_eq!(
        codes,
        [
            StatusCode::ACCEPTED,
            StatusCode::ACCEPTED,
            StatusCode::TOO_MANY_REQUESTS
        ]
    );
}

#[tokio::test]
async fn disabled_project_sends_kill_switch() {
    let mut s = setup(8, IngestConfig::default());
    let r = s
        .app
        .oneshot(post("/ingest/off/events?key=pk_off", None, GZ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::ACCEPTED);
    assert_eq!(r.headers()[DISABLE_HEADER], "3600");
    assert!(s.rx.try_recv().is_err());
}

#[tokio::test]
async fn config_etag_and_cache() {
    let s = setup(8, IngestConfig::default());
    let req = |etag: Option<&str>| {
        let mut b = HttpRequest::get("/ingest/fx/config?key=pk_fx").header("origin", "https://localhost");
        if let Some(e) = etag {
            b = b.header("if-none-match", e);
        }
        b.body(Body::empty()).unwrap()
    };
    let r = s.app.clone().oneshot(req(None)).await.unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()[header::CACHE_CONTROL], "max-age=300");
    let etag = r.headers()[header::ETAG].to_str().unwrap().to_string();
    let body = axum::body::to_bytes(r.into_body(), 1 << 20).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["replay"]["sampleRate"], 1.0);
    assert_eq!(v["ttl"], 600);
    let r = s.app.oneshot(req(Some(&etag))).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_MODIFIED);
}

#[tokio::test]
async fn sdk_files_versioned_immutable_latest_revalidated() {
    let dir = std::env::temp_dir().join(format!("rp-sdk-{}", std::process::id()));
    for v in ["0.1.0", "latest"] {
        std::fs::create_dir_all(dir.join(v)).unwrap();
        std::fs::write(dir.join(v).join("replayd.min.js"), "/*sdk*/").unwrap();
    }
    let s = setup_with_sdk(8, IngestConfig::default(), dir.clone());
    let get = |uri: &str| HttpRequest::get(uri).body(Body::empty()).unwrap();
    let r = s
        .app
        .clone()
        .oneshot(get("/ingest/sdk/0.1.0/replayd.min.js"))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(
        r.headers()[header::CACHE_CONTROL],
        "public, max-age=31536000, immutable"
    );
    assert_eq!(r.headers()[header::ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    let r = s
        .app
        .clone()
        .oneshot(get("/ingest/sdk/latest/replayd.min.js"))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::OK);
    assert_eq!(r.headers()[header::CACHE_CONTROL], "public, max-age=300");
    let r = s.app.oneshot(get("/ingest/sdk/0.1.0/missing.js")).await.unwrap();
    assert_eq!(r.status(), StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(dir).ok();
}

#[tokio::test]
async fn preflight_and_replay_not_wired_yet() {
    let s = setup(8, IngestConfig::default());
    let r = s
        .app
        .clone()
        .oneshot(
            HttpRequest::options("/ingest/fx/events?key=pk_fx")
                .header("origin", "https://localhost")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NO_CONTENT);
    assert_eq!(r.headers()[header::ACCESS_CONTROL_MAX_AGE], "86400");
    let r = s
        .app
        .oneshot(post("/ingest/fx/replay?key=pk_fx", Some("https://localhost"), GZ))
        .await
        .unwrap();
    assert_eq!(r.status(), StatusCode::NOT_IMPLEMENTED);
}
