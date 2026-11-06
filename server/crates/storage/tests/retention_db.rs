//! T-33 integration: a 16-day seed is cut to the 14-day window by dropping partitions (O(days)), per-project
//! shorter retention deletes rows, old issues and day directories go, source maps 30 days after the last event.

use std::time::Instant;

use replayd_storage::retention::{self, day_str, today_utc};

#[tokio::test]
async fn retention_drops_old_days() {
    let Some(pool) = replayd_db::test_pool() else {
        eprintln!("skipped: REPLAYD_TEST_DATABASE_URL not set");
        return;
    };
    let c = pool.get().await.unwrap();
    let today = today_utc();
    c.query_one(
        "SELECT replayd_ensure_partitions($1::text::date, $2::text::date)",
        &[&day_str(today - 16), &day_str(today + 1)],
    )
    .await
    .unwrap();
    let tag = format!("{}-{}", std::process::id(), Instant::now().elapsed().as_nanos());
    let mk = |slug: String, days: i32| {
        let c = &c;
        async move {
            c.query_one(
                "INSERT INTO projects (slug, name, public_key, upload_token_hash, retention_days) VALUES ($1, 'R', 'pk', '\\x00', $2) RETURNING id",
                &[&slug, &days],
            )
            .await
            .unwrap()
            .get::<_, i32>(0)
        }
    };
    let p14 = mk(format!("it-ret14-{tag}"), 14).await;
    let p7 = mk(format!("it-ret7-{tag}"), 7).await;
    // 16 days × 200 sessions + 1 issue per day per project, plus day directories with a file
    let tmp = tempfile::tempdir().unwrap();
    for pid in [p14, p7] {
        for back in 0..16i64 {
            let day = day_str(today - back);
            c.execute(
                "INSERT INTO sessions (id, project_id, started_at, last_at, file_day) \
                 SELECT gen_random_uuid(), $1, $2::text::date + interval '1 hour', $2::text::date + interval '2 hours', $2::text::date FROM generate_series(1, 200)",
                &[&pid, &day],
            )
            .await
            .unwrap();
            c.execute(
                "INSERT INTO issues (project_id, fingerprint, level, source, title, first_seen, last_seen) \
                 VALUES ($1, decode(md5($2), 'hex'), 'error', 'onerror', 'x', $2::text::date, $2::text::date + interval '1 hour')",
                &[&pid, &day],
            )
            .await
            .unwrap();
            let d = tmp.path().join(pid.to_string()).join(&day);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join("s.rpl"), b"RPL2").unwrap();
        }
    }
    // a deleted project's directory and a stale source-map release
    std::fs::create_dir_all(tmp.path().join("999999").join(day_str(today))).unwrap();
    c.execute(
        "INSERT INTO releases (project_id, version, created_at, last_event_at) VALUES ($1, 'old', now() - interval '40 days', now() - interval '31 days'), ($1, 'new', now() - interval '40 days', now() - interval '1 day')",
        &[&p14],
    )
    .await
    .unwrap();
    for rel in ["old", "new"] {
        let d = tmp.path().join("_sourcemaps").join(p14.to_string()).join(rel);
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("a.map"), b"{}").unwrap();
    }

    let r = retention::run_once(&pool, tmp.path(), today, None).await.unwrap();
    eprintln!("retention report: {r:?}");
    // global window = 14 days (largest project retention): days 14 and 15 back are dropped as partitions
    assert!(
        r.partitions_dropped >= 4,
        "sessions + events partitions of 2 days: {r:?}"
    );
    let days = |pid: i32| {
        let c = &c;
        async move {
            c.query_one(
                "SELECT count(DISTINCT file_day) FROM sessions WHERE project_id = $1",
                &[&pid],
            )
            .await
            .unwrap()
            .get::<_, i64>(0)
        }
    };
    assert_eq!(days(p14).await, 14);
    assert_eq!(days(p7).await, 7);
    let issues = |pid: i32| {
        let c = &c;
        async move {
            c.query_one("SELECT count(*) FROM issues WHERE project_id = $1", &[&pid])
                .await
                .unwrap()
                .get::<_, i64>(0)
        }
    };
    assert_eq!(issues(p14).await, 14);
    assert_eq!(issues(p7).await, 7);
    let dirs = |pid: i32| {
        std::fs::read_dir(tmp.path().join(pid.to_string()))
            .unwrap()
            .count()
    };
    assert_eq!(dirs(p14), 14);
    assert_eq!(dirs(p7), 7);
    assert!(!tmp.path().join("999999").exists());
    assert!(
        !tmp.path()
            .join("_sourcemaps")
            .join(p14.to_string())
            .join("old")
            .exists()
    );
    assert!(
        tmp.path()
            .join("_sourcemaps")
            .join(p14.to_string())
            .join("new")
            .exists()
    );
    // idempotent
    let r2 = retention::run_once(&pool, tmp.path(), today, None).await.unwrap();
    assert_eq!(
        (r2.partitions_dropped, r2.rows_deleted, r2.day_dirs_removed),
        (0, 0, 0)
    );
    c.execute("DELETE FROM projects WHERE id = ANY($1)", &[&vec![p14, p7]])
        .await
        .unwrap();
}

/// `cargo test -p replayd-storage --test retention_db -- --ignored --nocapture`: 15 days × N sessions (env
/// RETENTION_BENCH_PER_DAY, default 10,000 = PRD scale) + events → one retention pass to the 14-day window.
#[tokio::test]
#[ignore]
async fn retention_bench_15_days() {
    let Some(pool) = replayd_db::test_pool() else {
        return;
    };
    let per_day: i64 = std::env::var("RETENTION_BENCH_PER_DAY")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10_000);
    let c = pool.get().await.unwrap();
    let today = today_utc();
    c.query_one(
        "SELECT replayd_ensure_partitions($1::text::date, $2::text::date)",
        &[&day_str(today - 15), &day_str(today + 1)],
    )
    .await
    .unwrap();
    let slug = format!("it-retbench-{}", std::process::id());
    let pid: i32 = c
        .query_one("INSERT INTO projects (slug, name, public_key, upload_token_hash) VALUES ($1, 'B', 'pk', '\\x00') RETURNING id", &[&slug])
        .await
        .unwrap()
        .get(0);
    let iid: i64 = c
        .query_one("INSERT INTO issues (project_id, fingerprint, level, source, title, first_seen, last_seen) VALUES ($1, '\\x02', 'error', 'onerror', 'x', now(), now()) RETURNING id", &[&pid])
        .await
        .unwrap()
        .get(0);
    let t = Instant::now();
    for back in 0..15i64 {
        let day = day_str(today - back);
        c.execute(
            "INSERT INTO sessions (id, project_id, started_at, last_at, file_day) SELECT gen_random_uuid(), $1, \
             $2::text::date + (g % 86000) * interval '1 second', $2::text::date + (g % 86000) * interval '1 second', $2::text::date \
             FROM generate_series(1, $3::bigint) g",
            &[&pid, &day, &per_day],
        )
        .await
        .unwrap();
        c.execute(
            "INSERT INTO events (id, issue_id, project_id, ts, payload) SELECT gen_random_uuid(), $4, $1, \
             $2::text::date + (g % 86000) * interval '1 second', '{}'::jsonb FROM generate_series(1, $3::bigint / 5) g",
            &[&pid, &day, &per_day, &iid],
        )
        .await
        .unwrap();
    }
    let seeded = t.elapsed();
    let before: i64 = c
        .query_one("SELECT count(*) FROM sessions WHERE project_id = $1", &[&pid])
        .await
        .unwrap()
        .get(0);
    let tmp = tempfile::tempdir().unwrap();
    let r = retention::run_once(&pool, tmp.path(), today, None).await.unwrap();
    let after: i64 = c
        .query_one("SELECT count(*) FROM sessions WHERE project_id = $1", &[&pid])
        .await
        .unwrap()
        .get(0);
    let days: i64 = c
        .query_one(
            "SELECT count(DISTINCT file_day) FROM sessions WHERE project_id = $1",
            &[&pid],
        )
        .await
        .unwrap()
        .get(0);
    eprintln!(
        "{{\"bench\":\"retention\",\"per_day\":{per_day},\"seed_ms\":{},\"sessions_before\":{before},\"sessions_after\":{after},\"days_after\":{days},\"partitions_dropped\":{},\"rows_deleted\":{},\"run_ms\":{}}}",
        seeded.as_millis(),
        r.partitions_dropped,
        r.rows_deleted,
        r.ms
    );
    assert_eq!(days, 14);
    c.execute("DELETE FROM projects WHERE id = $1", &[&pid])
        .await
        .unwrap();
}
