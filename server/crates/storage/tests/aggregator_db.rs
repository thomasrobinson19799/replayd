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
        client_ip: Some("192.0.2.1".parse().unwrap()),
        received_ms: start + seq as i64 * 5000,
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
                timezone: Some("Asia/Tehran".into()),
                local_time: Some("2026-11-06 14:03:21 +03:30".into()),
                user: Some(SegmentUser { id: Some("10023451".into()), email: None, name: None }),
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

    // Complete snapshots are ordered by segment sequence, including across a restart.
    for (seq, name, custom) in [
        (4, Some("Latest"), serde_json::json!({"plan":"pro"})),
        (3, Some("Stale"), serde_json::json!({"plan":"old"})),
    ] {
        let mut s = info(pid, sid, now, seq, 0, "https://t.example/trade", false);
        s.meta.fields = Some(serde_json::from_value(serde_json::json!({"user":{"id":"login","name":name,"email":"new@example.test"},"custom_fields":custom,"app_ver":"2.0"})).unwrap());
        b.apply(s);
    }
    b.flush().await.unwrap();
    let r = c.query_one("SELECT user_name, custom_fields, fields_seq, timezone, local_time, host(client_ip), app_version FROM sessions WHERE id=$1", &[&sid]).await.unwrap();
    assert_eq!(r.get::<_, String>(0), "Latest");
    assert_eq!(
        r.get::<_, serde_json::Value>(1),
        serde_json::json!({"plan":"pro"})
    );
    assert_eq!(r.get::<_, i64>(2), 4);
    assert_eq!(r.get::<_, String>(3), "Asia/Tehran");
    assert_eq!(r.get::<_, String>(4), "2026-11-06 14:03:21 +03:30");
    assert_eq!(r.get::<_, String>(5), "192.0.2.1");
    assert_eq!(r.get::<_, String>(6), "2.0");
    for (seq, user, custom) in [
        (6, serde_json::Value::Null, serde_json::json!({})),
        (
            5,
            serde_json::json!({"id":"old"}),
            serde_json::json!({"stale":true}),
        ),
        (
            7,
            serde_json::json!({"id":"invalid"}),
            serde_json::json!({"x":"x".repeat(16384)}),
        ),
    ] {
        let mut restarted = Aggregator::new(pool.clone());
        let mut s = info(pid, sid, now, seq, 0, "https://t.example/trade", false);
        s.meta.fields =
            Some(serde_json::from_value(serde_json::json!({"user":user,"custom_fields":custom})).unwrap());
        restarted.apply(s);
        restarted.flush().await.unwrap();
        let r = c
            .query_one(
                "SELECT user_id, user_email, user_name, custom_fields, fields_seq FROM sessions WHERE id=$1",
                &[&sid],
            )
            .await
            .unwrap();
        for i in 0..3 {
            assert!(r.get::<_, Option<String>>(i).is_none());
        }
        assert_eq!(r.get::<_, serde_json::Value>(3), serde_json::json!({}));
        assert_eq!(r.get::<_, i64>(4), 6);
    }

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
