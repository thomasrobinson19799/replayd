//! T-31 integration: regression and un-ignore transitions in the issue upsert (skipped without
//! REPLAYD_TEST_DATABASE_URL).

use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use replayd_ingest::{EventJob, ProjectCache};
use replayd_pipeline::worker::{self, IssueSignal};
use serde_json::json;
use tokio::sync::mpsc;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as u64
}

struct T {
    pid: i32,
    sh: Arc<worker::Shared>,
    rx: mpsc::Receiver<IssueSignal>,
    c: replayd_db::Conn,
}

impl T {
    /// one error event of `release`; returns the issue id
    async fn event(&mut self, msg: &str, release: Option<&str>) -> i64 {
        let ev = json!([{
            "id": uuid::Uuid::now_v7().to_string(), "ts": now_ms(), "level": "error", "source": "onerror",
            "type": "TypeError", "message": msg, "release": release,
            "stack": format!("TypeError: {msg}\n    at f (https://t.example/_nuxt/a.js:1:2)"),
            "url": "https://t.example/trade"
        }]);
        let job = EventJob {
            project_id: self.pid,
            received_ms: now_ms(),
            body: Bytes::from(ev.to_string()),
            user_agent: None,
            client_ip: Some("192.0.2.10".parse().unwrap()),
        };
        let mut b = worker::process_job(&self.sh, &job);
        worker::flush(&self.sh, &mut b).await.unwrap();
        self.c
            .query_one(
                "SELECT id FROM issues WHERE project_id = $1 AND title LIKE $2",
                &[&self.pid, &format!("%{msg}")],
            )
            .await
            .unwrap()
            .get(0)
    }
    async fn status(&self, id: i64) -> String {
        self.c
            .query_one("SELECT status FROM issues WHERE id = $1", &[&id])
            .await
            .unwrap()
            .get(0)
    }
    async fn set(&self, id: i64, sql: &str) {
        self.c
            .execute(&format!("UPDATE issues SET {sql} WHERE id = $1"), &[&id])
            .await
            .unwrap();
    }
    /// regression signals received since the last call
    fn regressions(&mut self) -> Vec<i64> {
        let mut out = vec![];
        while let Ok(s) = self.rx.try_recv() {
            if let IssueSignal::Regression { issue_id, .. } = s {
                out.push(issue_id);
            }
        }
        out
    }
}

#[tokio::test]
async fn regression_and_ignore_transitions() {
    let Some(pool) = replayd_db::test_pool() else {
        eprintln!("skipped: REPLAYD_TEST_DATABASE_URL not set");
        return;
    };
    let c = pool.get().await.unwrap();
    replayd_db::ensure_partitions(&c, 1, 7).await.unwrap();
    let slug = format!("it-status-{}-{}", std::process::id(), now_ms());
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
    let (tx, rx) = mpsc::channel(256);
    let sh = worker::Shared::new(pool.clone(), projects, Some(tx));
    let mut t = T { pid, sh, rx, c };

    // resolve → seen again → regression (reopened, resolution cleared, signal)
    let a = t.event("alpha", Some("1.0.0")).await;
    t.set(
        a,
        "status = 'resolved', resolved_at = now() - interval '1 second'",
    )
    .await;
    t.regressions();
    t.event("alpha", Some("1.0.0")).await;
    assert_eq!(t.status(a).await, "unresolved");
    assert_eq!(t.regressions(), vec![a]);
    let r: (Option<SystemTime>, Option<SystemTime>) = {
        let row =
            t.c.query_one(
                "SELECT resolved_at, regressed_at FROM issues WHERE id = $1",
                &[&a],
            )
            .await
            .unwrap();
        (row.get(0), row.get(1))
    };
    assert!(r.0.is_none() && r.1.is_some());
    // a further event is not a second regression
    t.event("alpha", Some("1.0.0")).await;
    assert!(t.regressions().is_empty());

    // resolved in next release: the same release keeps it resolved; a newer release reopens it; no release never does
    let b = t.event("beta", Some("1.0.0")).await;
    t.set(
        b,
        "status = 'resolved', resolved_at = now() - interval '1 second', resolved_in_release = '1.0.0'",
    )
    .await;
    t.regressions();
    t.event("beta", Some("1.0.0")).await;
    t.event("beta", None).await;
    assert_eq!(t.status(b).await, "resolved");
    assert!(t.regressions().is_empty());
    t.event("beta", Some("1.1.0")).await;
    assert_eq!(t.status(b).await, "unresolved");
    assert_eq!(t.regressions(), vec![b]);

    // ignored until N more events (times_seen threshold): back to unresolved, no regression alert
    let g = t.event("gamma", None).await;
    t.set(g, "status = 'ignored', ignore_until_count = times_seen + 2")
        .await;
    t.event("gamma", None).await;
    assert_eq!(t.status(g).await, "ignored");
    t.event("gamma", None).await;
    assert_eq!(t.status(g).await, "unresolved");
    // ignored until a date that passed
    t.set(
        g,
        "status = 'ignored', ignore_until = now() - interval '1 second', ignore_until_count = NULL",
    )
    .await;
    t.event("gamma", None).await;
    assert_eq!(t.status(g).await, "unresolved");
    // ignored until a future date / forever: stays ignored
    t.set(g, "status = 'ignored', ignore_until = now() + interval '1 day'")
        .await;
    t.event("gamma", None).await;
    assert_eq!(t.status(g).await, "ignored");
    t.set(g, "status = 'ignored', ignore_until = NULL").await;
    t.event("gamma", None).await;
    assert_eq!(t.status(g).await, "ignored");
    assert!(t.regressions().is_empty());
}
