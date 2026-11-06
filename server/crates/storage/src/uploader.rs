//! Moves finished recordings to the bucket (D-37).
//!
//! The local folder is the queue: a recording untouched for `upload_idle` is uploaded and verified, then its shard
//! writer removes the local file if it has not grown. Nothing is tracked elsewhere, so a restart or a bucket outage
//! just means the file is picked up by a later pass, and recordings from before the bucket was configured move too.
//! Runs off the ingest path; only the seal goes through the shard's bounded queue.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use futures_util::{StreamExt, stream};
use replayd_objstore::{Error, ReplayStore};
use uuid::Uuid;

use crate::retention::parse_day;
use crate::writer::{SealOutcome, Writers};

const CYCLE: Duration = Duration::from_secs(60);
const CONCURRENT_UPLOADS: usize = 4;
const MAX_PER_CYCLE: usize = 1_000;
/// Consecutive pass failures that end a pass early (the bucket is probably down).
const MAX_ERRORS: usize = 3;

#[derive(Debug, Clone, PartialEq, Eq)]
struct Finished {
    project_id: i32,
    day: String,
    sid: Uuid,
    path: PathBuf,
}

/// Recordings untouched for `idle`, oldest folders first. Skips `_sourcemaps`, `_cache` and `.redacted`.
fn finished(data_dir: &Path, idle: Duration) -> (Vec<Finished>, usize) {
    let now = SystemTime::now();
    let mut out = Vec::new();
    let mut total = 0;
    let dirs = |p: &Path| {
        let mut v: Vec<_> = std::fs::read_dir(p)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| (e.file_name().to_string_lossy().to_string(), e.path()))
            .collect();
        v.sort();
        v
    };
    for (project, pdir) in dirs(data_dir) {
        let Ok(project_id) = project.parse::<i32>() else {
            continue;
        };
        for (day, ddir) in dirs(&pdir) {
            if parse_day(&day).is_none() {
                continue;
            }
            for (file, path) in dirs(&ddir) {
                let Some(sid) = file.strip_suffix(".rpl").and_then(|s| Uuid::try_parse(s).ok()) else {
                    continue;
                };
                let idle_enough = std::fs::metadata(&path)
                    .and_then(|m| m.modified())
                    .is_ok_and(|m| now.duration_since(m).is_ok_and(|age| age >= idle));
                if idle_enough {
                    total += 1;
                    if out.len() < MAX_PER_CYCLE {
                        out.push(Finished {
                            project_id,
                            day: day.clone(),
                            sid,
                            path,
                        });
                    }
                }
            }
        }
    }
    (out, total)
}

/// Viewer copies of a recording that is no longer local are rebuilt from the bucket on demand.
fn remove_local_redacted(f: &Finished) {
    let Some(day_dir) = f.path.parent() else { return };
    let prefix = format!("{}.", f.sid.as_hyphenated());
    for e in std::fs::read_dir(day_dir.join(".redacted"))
        .into_iter()
        .flatten()
        .flatten()
    {
        if e.file_name().to_string_lossy().starts_with(&prefix) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

async fn upload_one(store: &ReplayStore, writers: &Arc<Writers>, f: Finished) -> Result<(), Error> {
    let sid = f.sid.as_hyphenated().to_string();
    let len = match store.upload(f.project_id, &f.day, &sid, &f.path).await {
        Ok(len) => len,
        // deleted by a user or by retention since the scan
        Err(Error::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
            return store.delete_session(f.project_id, &f.day, &sid).await;
        }
        Err(e) => return Err(e),
    };
    let w = writers.clone();
    let (project_id, day, id) = (f.project_id, f.day.clone(), f.sid);
    let sealed = tokio::task::spawn_blocking(move || w.seal(project_id, &day, id, len))
        .await
        .map_err(std::io::Error::other)?;
    match sealed {
        Some(SealOutcome::Removed) => {
            metrics::counter!("replayd_objstore_upload_bytes_total").increment(len);
            tokio::task::spawn_blocking(move || remove_local_redacted(&f))
                .await
                .map_err(std::io::Error::other)?;
        }
        // a late segment arrived during the upload: a later pass merges it
        Some(SealOutcome::Changed) | None => {}
        // deleted during the upload: the object must not outlive the session
        Some(SealOutcome::Gone) => store.delete_session(f.project_id, &f.day, &sid).await?,
    }
    Ok(())
}

/// One pass over the local folder. Returns how many recordings were processed without an error.
pub async fn run_once(store: &Arc<ReplayStore>, writers: &Arc<Writers>, data_dir: &Path) -> usize {
    let (dir, idle) = (data_dir.to_path_buf(), store.upload_idle());
    let (batch, total) = tokio::task::spawn_blocking(move || finished(&dir, idle))
        .await
        .unwrap_or_default();
    metrics::gauge!("replayd_objstore_pending_files").set(total as f64);
    let mut results = stream::iter(batch)
        .map(|f| upload_one(store, writers, f))
        .buffer_unordered(CONCURRENT_UPLOADS);
    let (mut done, mut failed) = (0, 0);
    while let Some(r) = results.next().await {
        match r {
            Ok(()) => {
                done += 1;
                failed = 0;
                metrics::counter!("replayd_objstore_uploads_total", "result" => "ok").increment(1);
            }
            Err(e) => {
                failed += 1;
                metrics::counter!("replayd_objstore_uploads_total", "result" => "error").increment(1);
                tracing::warn!(error = %e, "replay upload failed; the local file stays");
                if failed >= MAX_ERRORS {
                    break;
                }
            }
        }
    }
    done
}

pub fn spawn(
    store: Arc<ReplayStore>,
    writers: Arc<Writers>,
    data_dir: PathBuf,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        match store.probe().await {
            Ok(()) => tracing::info!("object storage reachable"),
            // ingest must keep working: recordings wait on disk until the bucket is back
            Err(e) => tracing::error!(error = %e, "object storage not reachable"),
        }
        let every = CYCLE.min(store.upload_idle()).max(Duration::from_secs(1));
        let mut t = tokio::time::interval(every);
        t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            t.tick().await;
            run_once(&store, &writers, &data_dir).await;
            let s = store.clone();
            let _ = tokio::task::spawn_blocking(move || s.sweep_cache()).await;
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::writer::{Segment, WriterConfig};
    use bytes::Bytes;
    use object_store::ObjectStore;
    use object_store::memory::InMemory;
    use object_store::path::Path as ObjPath;
    use replayd_common::rpl::{self, FrameHeader};

    const DAY: &str = "2026-11-06";

    struct Fixture {
        dir: tempfile::TempDir,
        mem: Arc<InMemory>,
        store: Arc<ReplayStore>,
        writers: Arc<Writers>,
    }

    fn fixture(idle: Duration) -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let mem = Arc::new(InMemory::new());
        let store = Arc::new(ReplayStore::new(mem.clone(), dir.path(), 1 << 20, idle));
        let mut cfg = WriterConfig::new(dir.path().to_path_buf());
        cfg.shards = 2;
        let writers = Writers::start(cfg, None).unwrap();
        Fixture {
            dir,
            mem,
            store,
            writers,
        }
    }

    impl Fixture {
        fn write(&self, sid: Uuid, seq: u32, body: &'static [u8]) {
            self.writers
                .submit(Segment {
                    project_id: 7,
                    sid,
                    day: DAY.into(),
                    header: FrameHeader {
                        len: body.len() as u32,
                        seq,
                        t0: 1,
                        t1: 2,
                        received_at: 3,
                        flags: 0,
                    },
                    body: Bytes::from_static(body),
                })
                .unwrap();
            self.writers.sync_all();
        }

        fn local(&self, sid: Uuid) -> PathBuf {
            crate::session_path(self.dir.path(), 7, DAY, &sid)
        }

        async fn object(&self, sid: Uuid) -> Option<Vec<u32>> {
            let key = ObjPath::from(format!("replays/7/{DAY}/{}.rpl", sid.as_hyphenated()));
            let buf = self.mem.get(&key).await.ok()?.bytes().await.unwrap();
            let idx = rpl::index(&buf).unwrap();
            Some(idx.frames.iter().map(|f| f.header.seq).collect())
        }

        async fn pass(&self) -> usize {
            run_once(&self.store, &self.writers, self.dir.path()).await
        }
    }

    #[tokio::test]
    async fn moves_finished_recordings_and_late_segments_to_the_bucket() {
        let f = fixture(Duration::ZERO);
        let sid = Uuid::now_v7();
        f.write(sid, 0, b"zero");
        f.write(sid, 1, b"one");
        assert_eq!(f.pass().await, 1);
        assert_eq!(f.object(sid).await.unwrap(), [0, 1]);
        assert!(
            !f.local(sid).exists(),
            "local copy removed after a verified upload"
        );

        // the reopened file only holds the late frame: the object gets it, nothing is lost or duplicated
        f.write(sid, 2, b"two");
        assert!(f.local(sid).exists());
        assert_eq!(f.pass().await, 1);
        assert_eq!(f.object(sid).await.unwrap(), [0, 1, 2]);
        assert!(!f.local(sid).exists());
    }

    #[tokio::test]
    async fn active_recordings_stay_local() {
        let f = fixture(Duration::from_secs(3600));
        let sid = Uuid::now_v7();
        f.write(sid, 0, b"zero");
        assert_eq!(f.pass().await, 0);
        assert!(f.local(sid).exists());
        assert!(f.object(sid).await.is_none());
    }

    #[tokio::test]
    async fn bucket_failure_keeps_the_local_file() {
        let f = fixture(Duration::ZERO);
        let sid = Uuid::now_v7();
        f.write(sid, 0, b"zero");
        let cfg = replayd_common::config::ObjectStorageConfig {
            endpoint: "http://127.0.0.1:1".into(),
            bucket: "b".into(),
            region: "r".into(),
            access_key: "k".into(),
            secret_key: "s".into(),
            upload_idle_secs: 0,
            cache_max_mb: 1,
        };
        let down = Arc::new(ReplayStore::from_config(&cfg, f.dir.path()).unwrap());
        assert_eq!(run_once(&down, &f.writers, f.dir.path()).await, 0);
        assert!(f.local(sid).exists());
        // and the next pass, with the bucket back, moves it
        assert_eq!(f.pass().await, 1);
        assert_eq!(f.object(sid).await.unwrap(), [0]);
    }

    #[tokio::test]
    async fn scan_ignores_everything_but_recordings() {
        let f = fixture(Duration::ZERO);
        let sid = Uuid::now_v7();
        f.write(sid, 0, b"zero");
        let day = f.local(sid).parent().unwrap().to_path_buf();
        let redacted = day.join(".redacted");
        std::fs::create_dir_all(&redacted).unwrap();
        let copy = redacted.join(format!("{}.51.rpl", sid.as_hyphenated()));
        std::fs::write(&copy, b"x").unwrap();
        std::fs::write(day.join("notes.txt"), b"x").unwrap();
        let maps = f.dir.path().join("_sourcemaps/7/rel");
        std::fs::create_dir_all(&maps).unwrap();
        std::fs::write(maps.join("a.rpl"), b"x").unwrap();
        let (found, total) = finished(f.dir.path(), Duration::ZERO);
        assert_eq!(total, 1);
        assert_eq!(found[0].sid, sid);
        f.pass().await;
        assert!(
            !copy.exists(),
            "viewer copy of an uploaded recording is rebuilt on demand"
        );
        assert!(day.join("notes.txt").exists() && maps.join("a.rpl").exists());
    }
}
