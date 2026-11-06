//! Retention (PRD §5.8), daily at 03:00 Asia/Tehran (= 23:30 UTC, no DST since 2022).
//!
//! * `sessions` / `events` daily partitions older than the **largest** project retention (≤ 14 days) are dropped:
//!   O(days), independent of row counts.
//! * Projects with a shorter retention: rows of the partitions between their cut-off and the global one are
//!   deleted per project, and so are issues whose `last_seen` is older than the cut-off.
//! * Replay files: `data/<pid>/<YYYY-MM-DD>/` older than the project's cut-off are removed (whole day
//!   directories, never single files), plus directories of deleted projects.
//! * Source maps: `data/_sourcemaps/<pid>/<release>/` 30 days after the release's last event (or its upload,
//!   if it never had events).
//! * Bucket (D-37): the same day and deleted-project rules under the store's `replays/` prefix. A failure is
//!   logged and the next run retries, because it works from a listing.
//!
//! Retention N days keeps today (UTC) and the N − 1 previous days.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use replayd_db::Pool;
use replayd_objstore::ReplayStore;

pub const MAX_DAYS: i32 = 14;
const MAPS_DAYS: i64 = 30;
/// 03:00 Asia/Tehran (UTC+03:30) as minutes after 00:00 UTC.
pub const RUN_AT_UTC_MIN: u64 = 23 * 60 + 30;

/// Days since 1970-01-01 → (y, m, d) (proleptic Gregorian; H. Hinnant's algorithm).
pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// (y, m, d) → days since 1970-01-01.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// `YYYYMMDD` / `YYYY-MM-DD` → days since epoch.
pub fn parse_day(s: &str) -> Option<i64> {
    let s: String = s.chars().filter(|c| *c != '-').collect();
    if s.len() != 8 || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    let (y, m, d) = (s[..4].parse().ok()?, s[4..6].parse().ok()?, s[6..].parse().ok()?);
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    Some(days_from_civil(y, m, d))
}

pub fn day_str(days: i64) -> String {
    let (y, m, d) = civil(days);
    format!("{y:04}-{m:02}-{d:02}")
}

pub fn today_utc() -> i64 {
    (SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        / 86_400) as i64
}

/// Seconds until the next daily run at `RUN_AT_UTC_MIN`.
pub fn secs_until_next(now_secs: u64) -> u64 {
    let at = RUN_AT_UTC_MIN * 60;
    let s = now_secs % 86_400;
    if s < at { at - s } else { 86_400 - s + at }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    pub partitions_dropped: usize,
    pub rows_deleted: u64,
    pub issues_deleted: u64,
    pub day_dirs_removed: usize,
    pub map_releases_removed: usize,
    pub objects_removed: u64,
    pub ms: u64,
}

/// Removes expired days and deleted projects from the bucket. `keep` maps project id → first day kept.
pub async fn purge_bucket(
    store: &ReplayStore,
    keep: &HashMap<i32, i64>,
) -> Result<u64, replayd_objstore::Error> {
    // No projects means a wrong or freshly restored database, not "delete every recording".
    if keep.is_empty() {
        return Ok(0);
    }
    let mut removed = 0;
    for pid in store.list_projects().await? {
        let Some(&first_kept) = keep.get(&pid) else {
            removed += store.delete_prefix(pid, None).await?;
            continue;
        };
        for day in store.list_days(pid).await? {
            if parse_day(&day).is_some_and(|d| d < first_kept) {
                removed += store.delete_prefix(pid, Some(&day)).await?;
            }
        }
    }
    Ok(removed)
}

/// One retention pass for "today" = `today` (days since epoch, UTC).
pub async fn run_once(
    pool: &Pool,
    data_dir: &Path,
    today: i64,
    store: Option<&ReplayStore>,
) -> Result<Report, replayd_db::DbError> {
    let started = Instant::now();
    let mut rep = Report::default();
    let c = pool.get().await?;
    // keep partitions ahead
    c.query_one(
        "SELECT replayd_ensure_partitions($1::text::date, $1::text::date + 7)",
        &[&day_str(today)],
    )
    .await?;
    let projects: Vec<(i32, i32)> = c
        .query("SELECT id, retention_days FROM projects", &[])
        .await?
        .iter()
        .map(|r| (r.get(0), r.get::<_, i32>(1).clamp(1, MAX_DAYS)))
        .collect();
    let global = projects.iter().map(|p| p.1).max().unwrap_or(MAX_DAYS);
    // first day kept for retention n
    let keep = move |n: i32| today - (n as i64 - 1);
    let gkeep = keep(global);

    // 1. drop whole partitions (O(days))
    let parts = c
        .query(
            "SELECT c.relname::text FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid \
             JOIN pg_class p ON p.oid = i.inhparent WHERE p.relname IN ('sessions', 'events')",
            &[],
        )
        .await?;
    for r in parts {
        let name: String = r.get(0);
        let Some(day) = name.rsplit('_').next().and_then(parse_day) else {
            continue;
        };
        if day < gkeep && (name.starts_with("sessions_") || name.starts_with("events_")) {
            // names come from the catalog and match ^(sessions|events)_\d{8}$
            c.batch_execute(&format!("DROP TABLE IF EXISTS \"{name}\""))
                .await?;
            rep.partitions_dropped += 1;
        }
    }
    // 2. shorter per-project retention: rows + issues
    for (pid, n) in &projects {
        let cut = day_str(keep(*n));
        if *n < global {
            rep.rows_deleted += c
                .execute(
                    "DELETE FROM sessions WHERE project_id = $1 AND started_at < $2::text::date",
                    &[pid, &cut],
                )
                .await?;
            rep.rows_deleted += c
                .execute(
                    "DELETE FROM events WHERE project_id = $1 AND ts < $2::text::date",
                    &[pid, &cut],
                )
                .await?;
        }
        rep.issues_deleted += c
            .execute(
                "DELETE FROM issues WHERE project_id = $1 AND last_seen < $2::text::date",
                &[pid, &cut],
            )
            .await?;
    }
    // Partition drops cannot cascade session FKs. Access checks already fail closed;
    // remove expired/orphaned capabilities as part of the same daily sweep.
    c.execute(
        "DELETE FROM replay_shares l WHERE l.expires_at <= now() OR NOT EXISTS \
        (SELECT 1 FROM sessions s WHERE s.id = l.session_id AND s.project_id = l.project_id)",
        &[],
    )
    .await?;
    // 3. source-map releases 30 days after their last event (or upload)
    let old = c
        .query(
            "DELETE FROM releases WHERE COALESCE(last_event_at, created_at) < now() - make_interval(days => $1::int) \
             RETURNING project_id, version",
            &[&(MAPS_DAYS as i32)],
        )
        .await?;
    let maps: Vec<(i32, String)> = old.iter().map(|r| (r.get(0), r.get(1))).collect();
    drop(c);

    // 4. disk (blocking fs work off the async threads)
    let dir = data_dir.to_path_buf();
    let known: HashMap<i32, i64> = projects.iter().map(|(p, d)| (*p, keep(*d))).collect();
    let local_known = known.clone();
    let (dirs, rels) = tokio::task::spawn_blocking(move || {
        let mut n = 0;
        let known = local_known;
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                let Ok(pid) = name.parse::<i32>() else { continue };
                let Some(&k) = known.get(&pid) else {
                    // project deleted
                    if std::fs::remove_dir_all(e.path()).is_ok() {
                        n += 1;
                    }
                    continue;
                };
                for d in std::fs::read_dir(e.path()).into_iter().flatten().flatten() {
                    let dn = d.file_name().to_string_lossy().to_string();
                    if parse_day(&dn).is_some_and(|day| day < k) && std::fs::remove_dir_all(d.path()).is_ok()
                    {
                        n += 1;
                    }
                }
            }
        }
        let mut r = 0;
        for (pid, rel) in maps {
            let p: PathBuf = dir
                .join("_sourcemaps")
                .join(pid.to_string())
                .join(replayd_pipeline::symbolicate::release_dir(&rel));
            if std::fs::remove_dir_all(p).is_ok() {
                r += 1;
            }
        }
        (n, r)
    })
    .await
    .unwrap_or((0, 0));
    rep.day_dirs_removed = dirs;
    rep.map_releases_removed = rels;
    if let Some(s) = store {
        match purge_bucket(s, &known).await {
            Ok(n) => rep.objects_removed = n,
            Err(e) => tracing::error!(error = %e, "bucket retention failed"),
        }
    }
    rep.ms = started.elapsed().as_millis() as u64;
    Ok(rep)
}

/// Daily at 03:00 Asia/Tehran.
pub fn spawn(pool: Pool, data_dir: PathBuf, store: Option<Arc<ReplayStore>>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_secs();
            tokio::time::sleep(Duration::from_secs(secs_until_next(now))).await;
            match run_once(&pool, &data_dir, today_utc(), store.as_deref()).await {
                Ok(r) => {
                    metrics::counter!("replayd_retention_runs_total").increment(1);
                    metrics::histogram!("replayd_retention_seconds").record(r.ms as f64 / 1000.0);
                    tracing::info!(
                        partitions = r.partitions_dropped,
                        rows = r.rows_deleted,
                        issues = r.issues_deleted,
                        dirs = r.day_dirs_removed,
                        map_releases = r.map_releases_removed,
                        objects = r.objects_removed,
                        ms = r.ms,
                        "retention done"
                    );
                }
                Err(e) => tracing::error!(error = %e, "retention failed"),
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calendar() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(days_from_civil(2026, 11, 3), 20_760);
        for d in [-1000, 0, 59, 60, 365, 20_000, 20_760, 50_000] {
            let (y, m, dd) = civil(d);
            assert_eq!(days_from_civil(y, m, dd), d);
        }
        assert_eq!(parse_day("20261103"), Some(20_760));
        assert_eq!(parse_day("2026-11-03"), Some(20_760));
        assert_eq!(parse_day("2026-13-03"), None);
        assert_eq!(parse_day("stage"), None);
        assert_eq!(day_str(20_760), "2026-11-03");
    }

    #[tokio::test]
    async fn bucket_purge_follows_project_retention_and_spares_other_keys() {
        use object_store::memory::InMemory;
        use object_store::path::Path as ObjPath;
        use object_store::{ObjectStore, PutPayload};

        let mem = Arc::new(InMemory::new());
        let dir = tempfile::tempdir().unwrap();
        let store = ReplayStore::new(mem.clone(), dir.path(), 1, Duration::from_secs(1));
        for k in [
            "replays/1/2026-11-01/old.rpl",
            "replays/1/2026-11-02/kept.rpl",
            "replays/1/stage/odd-folder.rpl",
            "replays/9/2026-11-02/deleted-project.rpl",
            "20/9/0123/0", // same shape as Sentry's replay keys: a shared bucket must not lose them
        ] {
            mem.put(&ObjPath::from(k), PutPayload::from_static(b"x"))
                .await
                .unwrap();
        }
        let keep = HashMap::from([(1, parse_day("2026-11-02").unwrap())]);

        assert_eq!(
            purge_bucket(&store, &HashMap::new()).await.unwrap(),
            0,
            "no projects: touch nothing"
        );
        assert_eq!(purge_bucket(&store, &keep).await.unwrap(), 2);

        let mut left = Vec::new();
        for k in [
            "replays/1/2026-11-01/old.rpl",
            "replays/1/2026-11-02/kept.rpl",
            "replays/1/stage/odd-folder.rpl",
            "replays/9/2026-11-02/deleted-project.rpl",
            "20/9/0123/0",
        ] {
            if mem.head(&ObjPath::from(k)).await.is_ok() {
                left.push(k);
            }
        }
        assert_eq!(
            left,
            [
                "replays/1/2026-11-02/kept.rpl",
                "replays/1/stage/odd-folder.rpl",
                "20/9/0123/0"
            ]
        );
    }

    #[test]
    fn schedule_is_tehran_3am() {
        let midnight = 20_760 * 86_400;
        assert_eq!(secs_until_next(midnight), 23 * 3600 + 1800);
        assert_eq!(secs_until_next(midnight + 23 * 3600 + 1800), 86_400);
        assert_eq!(secs_until_next(midnight + 23 * 3600 + 1799), 1);
    }
}
