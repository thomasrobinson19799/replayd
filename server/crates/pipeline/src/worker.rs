//! Error pipeline workers (§5.5): bounded queue → 2–4 workers → parse/group → issue upsert + COPY events,
//! flushed every 1 s or 500 rows.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use replayd_db::Pool;
use replayd_db::tokio_postgres::types::{ToSql, Type};
use replayd_ingest::{EventJob, ProjectCache};
use tokio::sync::{Mutex, mpsc};

use crate::event::{self, InEvent, Processed};
use crate::fingerprint::{Rule, compile_rules};
use crate::symbolicate::SourceMaps;

/// Max decompressed size of one events body (gzip-bomb guard).
const MAX_INFLATED: u64 = 8 * 1024 * 1024;
/// Max events taken from one request body.
const MAX_EVENTS_PER_JOB: usize = 200;
pub const FLUSH_ROWS: usize = 500;
pub const FLUSH_EVERY: Duration = Duration::from_secs(1);

/// Something alerting cares about (consumed by the Telegram alerter, T-32).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IssueSignal {
    New {
        project_id: i32,
        issue_id: i64,
        level: String,
    },
    Regression {
        project_id: i32,
        issue_id: i64,
        level: String,
    },
    Seen {
        project_id: i32,
        issue_id: i64,
        count: i64,
    },
}

pub fn decode_body(body: &[u8]) -> Option<Vec<InEvent>> {
    let raw: Vec<u8> = if body.starts_with(&[0x1f, 0x8b]) {
        let mut out = Vec::with_capacity(body.len() * 4);
        flate2::read::GzDecoder::new(body)
            .take(MAX_INFLATED)
            .read_to_end(&mut out)
            .ok()?;
        out
    } else {
        body.to_vec()
    };
    let values: Vec<serde_json::Value> = serde_json::from_slice(&raw).ok()?;
    Some(
        values
            .into_iter()
            .take(MAX_EVENTS_PER_JOB)
            .filter_map(|v| serde_json::from_value(v).ok())
            .collect(),
    )
}

/// Two-generation set: bounded memory, approximate "seen recently" membership (users per issue).
struct SeenSet {
    cur: HashSet<u64>,
    old: HashSet<u64>,
    cap: usize,
}

impl SeenSet {
    fn new(cap: usize) -> Self {
        Self {
            cur: HashSet::new(),
            old: HashSet::new(),
            cap,
        }
    }
    /// Returns true if newly inserted.
    fn insert(&mut self, k: u64) -> bool {
        if self.cur.contains(&k) || self.old.contains(&k) {
            return false;
        }
        if self.cur.len() >= self.cap {
            self.old = std::mem::take(&mut self.cur);
        }
        self.cur.insert(k)
    }
}

fn hash64(a: i64, b: &str) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325 ^ (a as u64);
    for x in b.as_bytes() {
        h ^= *x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

/// Compiled fingerprint rules per project, keyed by a hash of the rules JSON.
type RuleCache = HashMap<i32, (u64, Arc<Vec<Rule>>)>;

pub struct Shared {
    pool: Pool,
    projects: Arc<ProjectCache>,
    rules: parking_lot::Mutex<RuleCache>,
    users: parking_lot::Mutex<SeenSet>,
    /// Recently processed event ids: SDK retries of an already-accepted batch are dropped before they
    /// can inflate issue counters (the DB insert also ignores PK conflicts).
    event_ids: parking_lot::Mutex<SeenSet>,
    signals: Option<mpsc::Sender<IssueSignal>>,
    maps: Option<Arc<SourceMaps>>,
}

impl Shared {
    pub fn new(
        pool: Pool,
        projects: Arc<ProjectCache>,
        signals: Option<mpsc::Sender<IssueSignal>>,
    ) -> Arc<Self> {
        Self::with_maps(pool, projects, signals, None)
    }

    /// With source-map symbolication (T-30).
    pub fn with_maps(
        pool: Pool,
        projects: Arc<ProjectCache>,
        signals: Option<mpsc::Sender<IssueSignal>>,
        maps: Option<Arc<SourceMaps>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            pool,
            projects,
            rules: parking_lot::Mutex::new(HashMap::new()),
            users: parking_lot::Mutex::new(SeenSet::new(250_000)),
            event_ids: parking_lot::Mutex::new(SeenSet::new(500_000)),
            signals,
            maps,
        })
    }

    fn rules_for(&self, project_id: i32) -> Arc<Vec<Rule>> {
        let Some(p) = self.projects.get(&project_id.to_string()) else {
            return Arc::new(vec![]);
        };
        let key = hash64(0, &p.row.fingerprint_rules.to_string());
        let mut m = self.rules.lock();
        if let Some((k, r)) = m.get(&project_id)
            && *k == key
        {
            return r.clone();
        }
        let r = Arc::new(compile_rules(&p.row.fingerprint_rules));
        m.insert(project_id, (key, r.clone()));
        r
    }

    fn signal(&self, s: IssueSignal) {
        if let Some(tx) = &self.signals
            && tx.try_send(s).is_err()
        {
            metrics::counter!("replayd_queue_rejected_total", "queue" => "signals").increment(1);
        }
    }
}

/// Turns one ingest job into processed rows.
pub fn process_job(sh: &Shared, job: &EventJob) -> Vec<Processed> {
    let Some(events) = decode_body(&job.body) else {
        metrics::counter!("replayd_events_rejected_total", "reason" => "decode").increment(1);
        return vec![];
    };
    let ua = event::parse_ua(job.user_agent.as_deref());
    let rules = sh.rules_for(job.project_id);
    let out: Vec<Processed> = events
        .into_iter()
        .map(|e| {
            event::process_with(
                e,
                job.project_id,
                job.received_ms as i64,
                &ua,
                &rules,
                sh.maps.as_deref(),
            )
        })
        .collect();
    let mut ids = sh.event_ids.lock();
    let before = out.len();
    let out: Vec<Processed> = out
        .into_iter()
        .filter(|p| ids.insert(p.id.as_u64_pair().0 ^ p.id.as_u64_pair().1))
        .collect();
    if out.len() < before {
        metrics::counter!("replayd_events_rejected_total", "reason" => "duplicate")
            .increment((before - out.len()) as u64);
    }
    out
}

fn ts(ms: i64) -> SystemTime {
    UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64)
}

#[derive(Default)]
struct Group {
    level: &'static str,
    source: String,
    ty: Option<String>,
    title: String,
    culprit: Option<String>,
    first_ms: i64,
    last_ms: i64,
    first_release: Option<String>,
    last_release: Option<String>,
    platforms: Vec<String>,
    count: i64,
    users: Vec<String>,
    symbolicated: bool,
}

const UPSERT: &str = "INSERT INTO issues (project_id, fingerprint, level, source, type, title, culprit, first_seen, \
     last_seen, first_release, last_release, platforms, times_seen, symbolicated) \
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) \
     ON CONFLICT (project_id, fingerprint) DO UPDATE SET \
       last_seen = GREATEST(issues.last_seen, EXCLUDED.last_seen), \
       first_seen = LEAST(issues.first_seen, EXCLUDED.first_seen), \
       last_release = COALESCE(EXCLUDED.last_release, issues.last_release), \
       times_seen = issues.times_seen + EXCLUDED.times_seen, \
       symbolicated = issues.symbolicated OR EXCLUDED.symbolicated, \
       platforms = ARRAY(SELECT DISTINCT unnest(issues.platforms || EXCLUDED.platforms) ORDER BY 1), \
       level = CASE WHEN issues.level = 'error' OR EXCLUDED.level = 'error' THEN 'error' ELSE EXCLUDED.level END \
     RETURNING id, (xmax = 0) AS inserted";

const EVENT_COLUMNS: &[&str] = &[
    "id",
    "issue_id",
    "project_id",
    "ts",
    "session_id",
    "level",
    "release",
    "environment",
    "platform",
    "url",
    "user_id",
    "browser",
    "os",
    "app_version",
    "payload",
];
const EVENT_TYPES: &[Type] = &[
    Type::UUID,
    Type::INT8,
    Type::INT4,
    Type::TIMESTAMPTZ,
    Type::UUID,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::JSONB,
];

/// Writes a batch: one upsert per distinct issue (sorted → no deadlocks between workers), user counters,
/// then a single binary COPY for all events.
pub async fn flush(sh: &Shared, batch: &mut Vec<Processed>) -> Result<usize, replayd_db::DbError> {
    if batch.is_empty() {
        return Ok(0);
    }
    let started = Instant::now();
    let mut groups: BTreeMap<(i32, [u8; 20]), Group> = BTreeMap::new();
    for p in batch.iter() {
        let g = groups
            .entry((p.project_id, p.fingerprint))
            .or_insert_with(|| Group {
                level: p.level,
                source: p.source.clone(),
                ty: p.ty.clone(),
                title: p.title.clone(),
                culprit: p.culprit.clone(),
                first_ms: p.ts_ms,
                last_ms: p.ts_ms,
                first_release: p.release.clone(),
                ..Default::default()
            });
        if p.level == "error" {
            g.level = "error";
        }
        g.first_ms = g.first_ms.min(p.ts_ms);
        if p.ts_ms >= g.last_ms {
            g.last_ms = p.ts_ms;
            if p.release.is_some() {
                g.last_release = p.release.clone();
            }
        }
        if !g.platforms.contains(&p.platform) {
            g.platforms.push(p.platform.clone());
        }
        g.count += p.count;
        g.symbolicated |= p.symbolicated;
        if let Some(u) = &p.user_id {
            g.users.push(u.clone());
        }
    }
    for g in groups.values_mut() {
        g.platforms.sort();
    }
    let c = sh.pool.get().await?;
    let mut issue_ids: HashMap<(i32, [u8; 20]), i64> = HashMap::with_capacity(groups.len());
    let mut user_ids: Vec<i64> = vec![];
    let mut user_incs: Vec<i32> = vec![];
    let stmt = c.prepare_cached(UPSERT).await?;
    for ((pid, fp), g) in &groups {
        let row = c
            .query_one(
                &stmt,
                &[
                    pid,
                    &fp.as_slice(),
                    &g.level,
                    &g.source,
                    &g.ty,
                    &g.title,
                    &g.culprit,
                    &ts(g.first_ms),
                    &ts(g.last_ms),
                    &g.first_release,
                    &g.last_release.clone().or_else(|| g.first_release.clone()),
                    &g.platforms,
                    &g.count,
                    &g.symbolicated,
                ],
            )
            .await?;
        let id: i64 = row.get(0);
        let inserted: bool = row.get(1);
        issue_ids.insert((*pid, *fp), id);
        if inserted {
            metrics::counter!("replayd_issues_new_total", "project" => pid.to_string()).increment(1);
            sh.signal(IssueSignal::New {
                project_id: *pid,
                issue_id: id,
                level: g.level.to_string(),
            });
        }
        sh.signal(IssueSignal::Seen {
            project_id: *pid,
            issue_id: id,
            count: g.count,
        });
        let new_users = {
            let mut seen = sh.users.lock();
            g.users.iter().filter(|u| seen.insert(hash64(id, u))).count() as i32
        };
        if new_users > 0 {
            user_ids.push(id);
            user_incs.push(new_users);
        }
    }
    if !user_ids.is_empty() {
        c.execute(
            "UPDATE issues SET users_seen = users_seen + v.n \
             FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::int[]) AS n) v WHERE issues.id = v.id",
            &[&user_ids, &user_incs],
        )
        .await?;
    }
    metrics::histogram!("replayd_pg_batch_seconds", "table" => "issues")
        .record(started.elapsed().as_secs_f64());

    let copy_started = Instant::now();
    let rows_owned: Vec<(i64, SystemTime)> = batch
        .iter()
        .map(|p| (issue_ids[&(p.project_id, p.fingerprint)], ts(p.ts_ms)))
        .collect();
    let rows: Vec<Vec<&(dyn ToSql + Sync)>> = batch
        .iter()
        .zip(rows_owned.iter())
        .map(|(p, (iid, t))| {
            let v: Vec<&(dyn ToSql + Sync)> = vec![
                &p.id,
                iid,
                &p.project_id,
                t,
                &p.session_id,
                &p.level,
                &p.release,
                &p.environment,
                &p.platform,
                &p.url,
                &p.user_id,
                &p.browser,
                &p.os,
                &p.app_version,
                &p.payload,
            ];
            v
        })
        .collect();
    // COPY into a per-connection temp table, then insert ignoring duplicate (id, ts): one retried or
    // duplicated event must never make the whole batch fail.
    c.batch_execute(
        "CREATE TEMP TABLE IF NOT EXISTS events_stage (LIKE events INCLUDING DEFAULTS) ON COMMIT DELETE ROWS",
    )
    .await?;
    c.batch_execute("BEGIN").await?;
    let res = async {
        replayd_db::copy::copy_rows(&c, "events_stage", EVENT_COLUMNS, EVENT_TYPES, &rows).await?;
        let n = c
            .execute(
                "INSERT INTO events SELECT * FROM events_stage ON CONFLICT DO NOTHING",
                &[],
            )
            .await?;
        c.batch_execute("COMMIT").await?;
        Ok::<_, replayd_db::DbError>(n as usize)
    }
    .await;
    if res.is_err() {
        let _ = c.batch_execute("ROLLBACK").await;
    }
    let n = res?;
    metrics::histogram!("replayd_pg_batch_seconds", "table" => "events")
        .record(copy_started.elapsed().as_secs_f64());
    for p in batch.iter() {
        metrics::counter!("replayd_events_processed_total", "project" => p.project_id.to_string(), "level" => p.level)
            .increment(1);
    }
    batch.clear();
    Ok(n)
}

/// Spawns `workers` consumers sharing one bounded receiver. When `shutdown` flips to `true` each worker
/// drains whatever is still queued, flushes and returns (await the handles for a clean stop).
pub fn spawn(
    sh: Arc<Shared>,
    rx: mpsc::Receiver<EventJob>,
    workers: usize,
    shutdown: tokio::sync::watch::Receiver<bool>,
) -> Vec<tokio::task::JoinHandle<()>> {
    let rx = Arc::new(Mutex::new(rx));
    (0..workers.max(1))
        .map(|_| {
            let sh = sh.clone();
            let rx = rx.clone();
            let sd = shutdown.clone();
            tokio::spawn(async move { run(sh, rx, sd).await })
        })
        .collect()
}

async fn drain(sh: &Shared, rx: &Mutex<mpsc::Receiver<EventJob>>, batch: &mut Vec<Processed>) {
    loop {
        let job = rx.lock().await.try_recv();
        let Ok(job) = job else { break };
        batch.extend(process_job(sh, &job));
        if batch.len() >= FLUSH_ROWS {
            flush_logged(sh, batch).await;
        }
    }
    flush_logged(sh, batch).await;
}

async fn run(
    sh: Arc<Shared>,
    rx: Arc<Mutex<mpsc::Receiver<EventJob>>>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) {
    let mut batch: Vec<Processed> = Vec::with_capacity(FLUSH_ROWS);
    let mut tick = tokio::time::interval(FLUSH_EVERY);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        if *shutdown.borrow() {
            drain(&sh, &rx, &mut batch).await;
            return;
        }
        let job = tokio::select! {
            j = async { rx.lock().await.recv().await } => j,
            _ = tick.tick() => {
                flush_logged(&sh, &mut batch).await;
                continue;
            }
            _ = shutdown.changed() => continue,
        };
        let Some(job) = job else {
            flush_logged(&sh, &mut batch).await;
            return;
        };
        batch.extend(process_job(&sh, &job));
        if batch.len() >= FLUSH_ROWS {
            flush_logged(&sh, &mut batch).await;
        }
    }
}

async fn flush_logged(sh: &Shared, batch: &mut Vec<Processed>) {
    if batch.is_empty() {
        return;
    }
    if let Err(e) = flush(sh, batch).await {
        metrics::counter!("replayd_pg_batch_errors_total", "table" => "events").increment(1);
        tracing::error!(error = %e, rows = batch.len(), "error pipeline flush failed; batch dropped");
        batch.clear();
    }
}
