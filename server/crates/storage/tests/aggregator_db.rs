//! Integration: session aggregator upserts deltas into `sessions` (skipped without REPLAYD_TEST_DATABASE_URL).

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use replayd_common::wire::{SegmentInit, SegmentMeta, SegmentUser};
use replayd_storage::aggregator::{Aggregator, SegmentInfo, utc_day};
use uuid::Uuid;

fn info(pid: i32, sid: Uuid, start: i64, seq: u32, errs: u32, url: &str, init: bool) -> SegmentInfo {
    SegmentInfo {
        project_id: pid,
        sid,
        started_ms: start,
        file_day: utc_day(start),
        bytes: 1000,
        meta: SegmentMeta {
            sid: sid.to_string(),
            seq,
            t0: (start + seq as i64 * 5000) as u64,
            t1: (start + seq as i64 * 5000 + 4999) as u64,
            urls: vec![url.into()],
            clicks: 2,
            errs,
            init: init.then(|| SegmentInit {
                url: Some(url.into()),
                ua: Some("Mozilla/5.0 (Linux; Android 14; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36".into()),
                platform: Some("capacitor-android".into()),
                release: Some("1.42.0".into()),
                device: Some("SM-A525F".into()),
                user: Some(SegmentUser { id: Some("10023451".into()), email: None }),
                ..Default::default()
            }),
            ..Default::default()
        },
    }
}

#[tokio::test]
async fn upserts_deltas_across_restarts() {
    let Some(pool) = replayd_db::test_pool() else {
        eprintln!("skipped: REPLAYD_TEST_DATABASE_URL not set");
        return;
    };
    let c = pool.get().await.unwrap();
    replayd_db::ensure_partitions(&c, 1, 7).await.unwrap();
    let pid = 900_000 + (std::process::id() % 1000) as i32;
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_millis() as i64;
    let sid = Uuid::now_v7();

    let mut a = Aggregator::new(pool.clone());
    a.apply(info(pid, sid, now, 0, 0, "https://t.example/trade", true));
    a.apply(info(pid, sid, now, 1, 1, "https://t.example/history", false));
    a.apply(info(pid, sid, now, 1, 1, "https://t.example/history", false)); // retry: ignored
    assert_eq!(a.flush().await.unwrap(), 1);
    assert_eq!(a.flush().await.unwrap(), 0, "nothing dirty");

    // "restart": a fresh aggregator continues the same session
    let mut b = Aggregator::new(pool.clone());
    b.apply(info(pid, sid, now, 2, 2, "https://t.example/trade", false));
    b.flush().await.unwrap();

    let r = c
        .query_one(
            "SELECT error_count, click_count, segments, bytes, urls, platform, device_model, user_id, browser, \
             duration_ms, ended, file_day::text FROM sessions WHERE id = $1",
            &[&sid],
        )
        .await
        .unwrap();
    assert_eq!(r.get::<_, i32>(0), 3);
    assert_eq!(r.get::<_, i32>(1), 6);
    assert_eq!(r.get::<_, i32>(2), 3);
    assert_eq!(r.get::<_, i64>(3), 3000);
    let urls: String = r.get(4);
    assert!(urls.contains("/trade") && urls.contains("/history"));
    assert_eq!(r.get::<_, String>(5), "capacitor-android");
    assert_eq!(r.get::<_, Option<String>>(6).as_deref(), Some("SM-A525F"));
    assert_eq!(r.get::<_, Option<String>>(7).as_deref(), Some("10023451"));
    assert_eq!(r.get::<_, Option<String>>(8).as_deref(), Some("Chrome"));
    assert_eq!(r.get::<_, i32>(9), 14_999);
    assert!(!r.get::<_, bool>(10));
    assert_eq!(r.get::<_, String>(11), utc_day(now));

    // idle → ended
    b.sweep(Duration::ZERO);
    b.flush().await.unwrap();
    let ended: bool = c
        .query_one("SELECT ended FROM sessions WHERE id = $1", &[&sid])
        .await
        .unwrap()
        .get(0);
    assert!(ended);
    c.execute("DELETE FROM sessions WHERE project_id = $1", &[&pid])
        .await
        .unwrap();
}
