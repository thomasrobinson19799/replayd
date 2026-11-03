//! Integration: jobs → grouping → issues upsert + COPY events (skipped without REPLAYD_TEST_DATABASE_URL).

use std::io::Write;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use replayd_ingest::{EventJob, ProjectCache};
use replayd_pipeline::worker::{self, IssueSignal};
use serde_json::json;
use tokio::sync::mpsc;

fn gz(v: &serde_json::Value) -> Bytes {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(v.to_string().as_bytes()).unwrap();
    Bytes::from(e.finish().unwrap())
}

#[tokio::test]
async fn groups_web_and_apk_and_writes_events() {
    let Some(pool) = replayd_db::test_pool() else {
        eprintln!("skipped: REPLAYD_TEST_DATABASE_URL not set");
        return;
    };
    let c = pool.get().await.unwrap();
    replayd_db::ensure_partitions(&c, 1, 7).await.unwrap();
    let slug = format!("it-pipe-{}", std::process::id());
    let pid: i32 = c
        .query_one(
            "INSERT INTO projects (slug, name, public_key, upload_token_hash) VALUES ($1, 'IT', 'pk', '\\x00') RETURNING id",
            &[&slug],
        )
        .await
        .unwrap()
        .get(0);
    let projects = Arc::new(ProjectCache::default());
    projects.reload(&pool).await.unwrap();
    let (stx, mut srx) = mpsc::channel(64);
    let sh = worker::Shared::new(pool.clone(), projects, Some(stx));

    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64;
    let err = |host: &str, build: &str, platform: &str, user: &str, msg: &str| {
        json!({
            "id": uuid::Uuid::now_v7().to_string(), "ts": now, "sid": uuid::Uuid::now_v7().to_string(),
            "level": "error", "source": "onerror", "type": "TypeError", "message": msg,
            "stack": format!("TypeError: {msg}\n    at submit (https://{host}/_nuxt/OrderPanel.{build}.js:1:2345)\n    at https://{host}/_nuxt/entry.{build}.js:3:9"),
            "url": format!("https://{host}/trade"), "release": "1.42.0", "platform": platform,
            "user": {"id": user}, "breadcrumbs": [], "count": 1
        })
    };
    let jobs = [
        json!([
            err(
                "terminal.fxglory.com",
                "Cx1aB2",
                "web",
                "1001",
                "Cannot read 'price' of order 991"
            ),
            err(
                "terminal.fxglory.com",
                "Cx1aB2",
                "web",
                "1002",
                "Cannot read 'price' of order 12"
            ),
        ]),
        json!([
            err("localhost", "Zz9yX8", "capacitor-android", "1001", "Cannot read 'price' of order 5"),
            {"id": uuid::Uuid::now_v7().to_string(), "ts": now, "level": "error", "source": "http",
             "message": "POST /api/orders failed", "ctx": {"http": {"method": "POST", "url": "https://api.fxglory.com/api/orders/77", "status": 500, "ms": 231}}}
        ]),
    ];
    let mut batch = vec![];
    for j in &jobs {
        let job = EventJob { project_id: pid, received_ms: now, body: gz(j), user_agent: Some("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36".into()) };
        batch.extend(worker::process_job(&sh, &job));
    }
    // plain (non-gzip) JSON bodies are accepted too
    batch.extend(worker::process_job(
        &sh,
        &EventJob {
            project_id: pid,
            received_ms: now,
            body: Bytes::from(
                json!([err(
                    "localhost",
                    "Q1w2E3",
                    "capacitor-android",
                    "1003",
                    "Cannot read 'price' of order 1"
                )])
                .to_string(),
            ),
            user_agent: None,
        },
    ));
    assert_eq!(batch.len(), 5);
    let n = worker::flush(&sh, &mut batch).await.unwrap();
    assert_eq!(n, 5);

    let rows = c
        .query(
            "SELECT title, times_seen, users_seen, platforms, source, culprit FROM issues WHERE project_id = $1 ORDER BY times_seen DESC",
            &[&pid],
        )
        .await
        .unwrap();
    assert_eq!(
        rows.len(),
        2,
        "web + APK TypeErrors group into one issue, HTTP 500 is another"
    );
    let times: i64 = rows[0].get(1);
    let users: i32 = rows[0].get(2);
    let platforms: Vec<String> = rows[0].get(3);
    assert_eq!(times, 4);
    assert_eq!(users, 3);
    assert_eq!(
        platforms,
        vec!["capacitor-android".to_string(), "web".to_string()]
    );
    let http_title: String = rows[1].get(0);
    assert_eq!(http_title, "POST /api/orders/:id → 500");
    let ev: i64 = c
        .query_one(
            "SELECT count(*) FROM events WHERE project_id = $1 AND browser = 'Chrome'",
            &[&pid],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(ev, 4);

    // second batch for the same issue: no new-issue signal, counters add up
    batch.extend(worker::process_job(
        &sh,
        &EventJob {
            project_id: pid,
            received_ms: now,
            body: gz(&json!([err(
                "localhost",
                "Zz9yX8",
                "capacitor-android",
                "1001",
                "Cannot read 'price' of order 6"
            )])),
            user_agent: None,
        },
    ));
    worker::flush(&sh, &mut batch).await.unwrap();
    let times: i64 = c
        .query_one(
            "SELECT max(times_seen) FROM issues WHERE project_id = $1",
            &[&pid],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(times, 5);
    // retried request (same event ids): dropped in memory, counters unchanged
    let retry = gz(
        &json!([{"id": "0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c99", "ts": now, "level": "error",
        "source": "manual", "message": "retry me"}]),
    );
    let job = EventJob {
        project_id: pid,
        received_ms: now,
        body: retry,
        user_agent: None,
    };
    let first = worker::process_job(&sh, &job);
    assert_eq!(first.len(), 1);
    assert!(worker::process_job(&sh, &job).is_empty());
    // the same row reaching the DB twice (e.g. after a restart) is ignored, not a batch failure
    let mut dup = first.clone();
    dup.extend(first.clone());
    assert_eq!(worker::flush(&sh, &mut dup).await.unwrap(), 1);
    let mut again = first.clone();
    assert_eq!(worker::flush(&sh, &mut again).await.unwrap(), 0);

    let mut news = 0;
    while let Ok(s) = srx.try_recv() {
        if matches!(s, IssueSignal::New { .. }) {
            news += 1;
        }
    }
    assert_eq!(news, 3); // TypeError, HTTP 500, "retry me"

    c.execute("DELETE FROM events WHERE project_id = $1", &[&pid])
        .await
        .unwrap();
    c.execute("DELETE FROM projects WHERE id = $1", &[&pid])
        .await
        .unwrap();
}

#[test]
fn decode_rejects_bombs_and_garbage() {
    assert!(worker::decode_body(b"not json").is_none());
    assert!(worker::decode_body(&[0x1f, 0x8b, 0, 0]).is_none());
    // 50 MB of zeros compresses to ~50 KB; must be rejected by the inflate cap, not allocated
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
    e.write_all(b"[").unwrap();
    e.write_all(&vec![b' '; 50 * 1024 * 1024]).unwrap();
    e.write_all(b"]").unwrap();
    assert!(worker::decode_body(&e.finish().unwrap()).is_none());
}
