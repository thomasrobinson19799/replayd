//! T-55 against a real S3 server: multipart upload, download, listing and batch delete with the production client
//! configuration. Skipped unless `REPLAYD_TEST_S3_ENDPOINT`, `_BUCKET`, `_REGION`, `_ACCESS_KEY`, `_SECRET_KEY` are set.
//! Only touches `replays/<random project id>/` and removes it again.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use replayd_common::config::ObjectStorageConfig;
use replayd_common::rpl::{self, FrameHeader};
use replayd_objstore::{Error, ReplayStore};

fn config() -> Option<ObjectStorageConfig> {
    let var = |k: &str| std::env::var(format!("REPLAYD_TEST_S3_{k}")).ok();
    Some(ObjectStorageConfig {
        endpoint: var("ENDPOINT")?,
        bucket: var("BUCKET")?,
        region: var("REGION")?,
        access_key: var("ACCESS_KEY")?,
        secret_key: var("SECRET_KEY")?,
        upload_idle_secs: 0,
        cache_max_mb: 1024,
    })
}

#[tokio::test]
async fn multipart_round_trip_listing_and_batch_delete() {
    let Some(cfg) = config() else {
        eprintln!("skipped: REPLAYD_TEST_S3_* not set");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    let store = ReplayStore::from_config(&cfg, dir.path()).unwrap();
    store.probe().await.unwrap();

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or(Duration::ZERO);
    let pid = 1_000_000_000 + (now.subsec_nanos() % 1_000_000_000) as i32;
    let (day_a, day_b) = ("2026-01-01", "2026-01-02");
    let sid = "0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d";

    // larger than the 8 MB part size: goes through a real multipart upload
    let mut data = rpl::encode_header(&[7u8; 16]).to_vec();
    for seq in 0..10u32 {
        let body: Vec<u8> = (0..2 * 1024 * 1024u32).map(|i| (i ^ seq) as u8).collect();
        let header = FrameHeader {
            len: body.len() as u32,
            seq,
            t0: 1,
            t1: 2,
            received_at: 3,
            flags: 0,
        };
        data.extend_from_slice(&header.encode());
        data.extend_from_slice(&body);
    }
    let local = rpl::recording_path(dir.path(), pid, day_a, sid);
    std::fs::create_dir_all(local.parent().unwrap()).unwrap();
    std::fs::write(&local, &data).unwrap();
    let covered = store.upload(pid, day_a, sid, &local).await.unwrap();
    assert_eq!(covered, data.len() as u64);

    // a second day and a small object, for the listings
    let small = rpl::recording_path(dir.path(), pid, day_b, sid);
    std::fs::create_dir_all(small.parent().unwrap()).unwrap();
    std::fs::write(&small, rpl::encode_header(&[7u8; 16])).unwrap();
    store.upload(pid, day_b, sid, &small).await.unwrap();

    std::fs::remove_file(&local).unwrap();
    let cached = store.materialize(pid, day_a, sid).await.unwrap();
    assert_eq!(
        std::fs::read(&cached).unwrap(),
        data,
        "bytes survive the round trip"
    );

    assert!(store.list_projects().await.unwrap().contains(&pid));
    let mut days = store.list_days(pid).await.unwrap();
    days.sort();
    assert_eq!(days, [day_a, day_b]);

    assert_eq!(store.delete_prefix(pid, Some(day_a)).await.unwrap(), 1);
    std::fs::remove_file(&cached).unwrap();
    assert!(matches!(
        store.materialize(pid, day_a, sid).await,
        Err(Error::NotFound)
    ));
    std::fs::remove_file(&small).unwrap();
    assert_eq!(store.delete_prefix(pid, None).await.unwrap(), 1);
    // not `list_projects`: some servers keep listing an emptied folder, which retention handles as a no-op
    assert!(matches!(
        store.materialize(pid, day_b, sid).await,
        Err(Error::NotFound)
    ));
    assert_eq!(store.delete_prefix(pid, None).await.unwrap(), 0);
}
