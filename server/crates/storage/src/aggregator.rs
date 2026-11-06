//! Session aggregator (PRD §5.4): in-memory per-session totals from segment meta, flushed every 3 s as
//! one batched upsert; a session is `ended` after 15 min of silence (swept every 60 s).
//!
//! Upserts carry *deltas* (counts are added, URLs appended), so a restart mid-session never resets totals.
//! `started_at` (partition key) comes from the UUIDv7 sid, so it is stable across restarts too.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use replayd_common::wire::{SegmentFields, SegmentInit, SegmentMeta};
use replayd_db::Pool;
use replayd_db::tokio_postgres::types::{ToSql, Type};
use tokio::sync::mpsc;
use uuid::Uuid;

pub const FLUSH_EVERY: Duration = Duration::from_secs(3);
pub const SWEEP_EVERY: Duration = Duration::from_secs(60);
pub const IDLE_END: Duration = Duration::from_secs(15 * 60);
const MAX_URLS: usize = 50;
const MAX_SESSIONS: usize = 200_000;

/// Sent by the ingest sink for every accepted segment.
#[derive(Debug)]
pub struct SegmentInfo {
    pub project_id: i32,
    pub sid: Uuid,
    pub started_ms: i64,
    pub file_day: String,
    pub meta: SegmentMeta,
    pub bytes: u64,
    pub client_ip: Option<std::net::IpAddr>,
    pub received_ms: i64,
}

#[derive(Default)]
struct Agg {
    project_id: i32,
    started_ms: i64,
    file_day: String,
    last_ms: i64,
    last_activity: Option<Instant>,
    seqs: HashSet<u32>,
    urls_seen: Vec<String>,
    init: Option<SegmentInit>,
    fields: Option<(u32, SegmentFields)>,
    client_ip: Option<std::net::IpAddr>,
    ip_received_ms: i64,
    // pending deltas
    d_urls: Vec<String>,
    d_errs: i32,
    d_warns: i32,
    d_clicks: i32,
    d_ws: i32,
    d_segments: i32,
    d_bytes: i64,
    d_canvas: i64,
    gap: bool,
    dirty: bool,
    ended: bool,
}

pub struct Aggregator {
    pool: Pool,
    map: HashMap<Uuid, Agg>,
}

impl Aggregator {
    pub fn new(pool: Pool) -> Self {
        Self {
            pool,
            map: HashMap::new(),
        }
    }

    pub fn apply(&mut self, s: SegmentInfo) {
        if self.map.len() >= MAX_SESSIONS && !self.map.contains_key(&s.sid) {
            metrics::counter!("replayd_sessions_dropped_total").increment(1);
            return;
        }
        let a = self.map.entry(s.sid).or_insert_with(|| Agg {
            project_id: s.project_id,
            started_ms: s.started_ms,
            file_day: s.file_day.clone(),
            ..Default::default()
        });
        a.last_activity = Some(Instant::now());
        if a.ended {
            a.ended = false; // resumed (e.g. app came back) — reopen
        }
        if !a.seqs.insert(s.meta.seq) {
            return; // duplicate segment (retry)
        }
        if s.received_ms >= a.ip_received_ms {
            a.client_ip = s.client_ip;
            a.ip_received_ms = s.received_ms;
        }
        let m = s.meta;
        a.last_ms = a.last_ms.max(m.t1 as i64).max(m.t0 as i64);
        for u in m.urls {
            if a.urls_seen.len() < MAX_URLS && !a.urls_seen.contains(&u) {
                a.urls_seen.push(u.clone());
                a.d_urls.push(u);
            }
        }
        let fields = m.fields.or_else(|| {
            m.init.as_ref().map(|i| SegmentFields {
                user: i.user.clone(),
                custom_fields: serde_json::json!({}),
                app_ver: i.app_ver.clone(),
            })
        });
        if let Some(fields) = fields
            && replayd_common::fields::valid_custom(&fields.custom_fields)
            && a.fields.as_ref().is_none_or(|(seq, _)| m.seq > *seq)
        {
            a.fields = Some((m.seq, fields));
        }
        if let Some(init) = m.init
            && a.init.is_none()
        {
            a.init = Some(init);
        }
        a.d_errs += m.errs as i32;
        a.d_warns += m.warns as i32;
        a.d_clicks += m.clicks as i32;
        a.d_ws += m.ws_disc as i32;
        a.d_segments += 1;
        a.d_bytes += s.bytes as i64;
        a.d_canvas += m.canvas_bytes as i64;
        a.gap |= m.gap;
        a.dirty = true;
        if m.ie > 0 {
            metrics::counter!("replayd_sdk_internal_errors_total", "project" => s.project_id.to_string())
                .increment(m.ie as u64);
        }
    }

    /// Marks sessions idle for longer than `idle` as ended (they are flushed, then dropped).
    pub fn sweep(&mut self, idle: Duration) {
        for a in self.map.values_mut() {
            if !a.ended && a.last_activity.is_some_and(|t| t.elapsed() >= idle) {
                a.ended = true;
                a.dirty = true;
            }
        }
    }

    pub fn active_by_project(&self) -> HashMap<i32, usize> {
        let mut m = HashMap::new();
        for a in self.map.values().filter(|a| !a.ended) {
            *m.entry(a.project_id).or_insert(0) += 1;
        }
        m
    }

    pub async fn flush(&mut self) -> Result<usize, replayd_db::DbError> {
        let dirty: Vec<Uuid> = self
            .map
            .iter()
            .filter(|(_, a)| a.dirty)
            .map(|(k, _)| *k)
            .collect();
        if dirty.is_empty() {
            return Ok(0);
        }
        let started = Instant::now();
        struct Row {
            id: Uuid,
            project_id: i32,
            started_at: SystemTime,
            last_at: SystemTime,
            ended: bool,
            duration_ms: i32,
            entry_url: Option<String>,
            urls: String,
            user_id: Option<String>,
            user_email: Option<String>,
            release: Option<String>,
            environment: Option<String>,
            platform: String,
            app_version: Option<String>,
            device_model: Option<String>,
            os_version: Option<String>,
            webview_version: Option<String>,
            browser: Option<String>,
            browser_ver: Option<String>,
            os: Option<String>,
            vw: Option<i32>,
            vh: Option<i32>,
            lang: Option<String>,
            tags: Option<serde_json::Value>,
            errs: i32,
            warns: i32,
            clicks: i32,
            ws: i32,
            segments: i32,
            bytes: i64,
            canvas: i64,
            gap: bool,
            file_day: String,
            client_ip: Option<std::net::IpAddr>,
            ip_received_ms: i64,
            user_name: Option<String>,
            timezone: Option<String>,
            local_time: Option<String>,
            custom_fields: serde_json::Value,
            fields_seq: i64,
        }
        let ts = |ms: i64| UNIX_EPOCH + Duration::from_millis(ms.max(0) as u64);
        let mut rows = Vec::with_capacity(dirty.len());
        for sid in &dirty {
            let a = self.map.get(sid).expect("dirty key");
            let init = a.init.clone().unwrap_or_default();
            let ua = replayd_pipeline::event::parse_ua(init.ua.as_deref());
            let user = a
                .fields
                .as_ref()
                .and_then(|(_, f)| f.user.clone())
                .unwrap_or_default();
            rows.push(Row {
                id: *sid,
                project_id: a.project_id,
                started_at: ts(a.started_ms),
                last_at: ts(a.last_ms.max(a.started_ms)),
                ended: a.ended,
                duration_ms: (a.last_ms - a.started_ms).clamp(0, i32::MAX as i64) as i32,
                entry_url: init.url.clone().or_else(|| a.urls_seen.first().cloned()),
                urls: a.d_urls.join("\n"),
                user_id: user.id,
                user_email: user.email,
                release: init.release,
                environment: init.env,
                platform: match init.platform.as_deref() {
                    Some("capacitor-android") => "capacitor-android".into(),
                    _ => "web".into(),
                },
                app_version: a
                    .fields
                    .as_ref()
                    .and_then(|(_, f)| f.app_ver.clone())
                    .or(init.app_ver),
                device_model: init.device,
                os_version: init.os_ver,
                webview_version: init.wv_ver,
                browser: ua.browser,
                browser_ver: ua.browser_ver,
                os: ua.os,
                vw: init.vw,
                vh: init.vh,
                lang: init.lang,
                tags: init.tags.map(serde_json::Value::Object),
                errs: a.d_errs,
                warns: a.d_warns,
                clicks: a.d_clicks,
                ws: a.d_ws,
                segments: a.d_segments,
                bytes: a.d_bytes,
                canvas: a.d_canvas,
                gap: a.gap,
                file_day: a.file_day.clone(),
                client_ip: a.client_ip,
                ip_received_ms: a.ip_received_ms,
                user_name: user.name,
                timezone: init.timezone,
                local_time: init.local_time,
                custom_fields: a
                    .fields
                    .as_ref()
                    .map(|(_, f)| f.custom_fields.clone())
                    .unwrap_or_else(|| serde_json::json!({})),
                fields_seq: a.fields.as_ref().map_or(-1, |(seq, _)| i64::from(*seq)),
            });
        }
        let c = self.pool.get().await?;
        c.batch_execute(
            "CREATE TEMP TABLE IF NOT EXISTS sessions_stage (LIKE sessions INCLUDING DEFAULTS) ON COMMIT DELETE ROWS",
        )
        .await?;
        let days: Vec<chrono_day::Day> = rows.iter().map(|r| chrono_day::Day::parse(&r.file_day)).collect();
        let params: Vec<Vec<&(dyn ToSql + Sync)>> = rows
            .iter()
            .zip(days.iter())
            .map(|(r, day)| {
                let v: Vec<&(dyn ToSql + Sync)> = vec![
                    &r.id,
                    &r.project_id,
                    &r.started_at,
                    &r.last_at,
                    &r.ended,
                    &r.duration_ms,
                    &r.entry_url,
                    &r.urls,
                    &r.user_id,
                    &r.user_email,
                    &r.release,
                    &r.environment,
                    &r.platform,
                    &r.app_version,
                    &r.device_model,
                    &r.os_version,
                    &r.webview_version,
                    &r.browser,
                    &r.browser_ver,
                    &r.os,
                    &r.vw,
                    &r.vh,
                    &r.lang,
                    &r.tags,
                    &r.errs,
                    &r.warns,
                    &r.clicks,
                    &r.ws,
                    &r.segments,
                    &r.bytes,
                    &r.canvas,
                    &r.gap,
                    day,
                    &r.client_ip,
                    &r.ip_received_ms,
                    &r.user_name,
                    &r.timezone,
                    &r.local_time,
                    &r.custom_fields,
                    &r.fields_seq,
                ];
                v
            })
            .collect();
        c.batch_execute("BEGIN").await?;
        let res = async {
            replayd_db::copy::copy_rows(&c, "sessions_stage", SESSION_COLUMNS, SESSION_TYPES, &params)
                .await?;
            c.execute(UPSERT, &[]).await?;
            c.batch_execute("COMMIT").await?;
            Ok::<_, replayd_db::DbError>(())
        }
        .await;
        if let Err(e) = res {
            let _ = c.batch_execute("ROLLBACK").await;
            return Err(e);
        }
        // deltas are persisted: reset them; drop ended sessions
        for sid in &dirty {
            let a = self.map.get_mut(sid).expect("dirty key");
            if a.ended {
                self.map.remove(sid);
                continue;
            }
            a.d_urls.clear();
            (a.d_errs, a.d_warns, a.d_clicks, a.d_ws, a.d_segments) = (0, 0, 0, 0, 0);
            (a.d_bytes, a.d_canvas) = (0, 0);
            a.dirty = false;
        }
        metrics::histogram!("replayd_pg_batch_seconds", "table" => "sessions")
            .record(started.elapsed().as_secs_f64());
        Ok(dirty.len())
    }
}

const SESSION_COLUMNS: &[&str] = &[
    "id",
    "project_id",
    "started_at",
    "last_at",
    "ended",
    "duration_ms",
    "entry_url",
    "urls",
    "user_id",
    "user_email",
    "release",
    "environment",
    "platform",
    "app_version",
    "device_model",
    "os_version",
    "webview_version",
    "browser",
    "browser_ver",
    "os",
    "vw",
    "vh",
    "lang",
    "tags",
    "error_count",
    "warn_count",
    "click_count",
    "ws_disconnects",
    "segments",
    "bytes",
    "canvas_bytes",
    "has_gap",
    "file_day",
    "client_ip",
    "ip_received_ms",
    "user_name",
    "timezone",
    "local_time",
    "custom_fields",
    "fields_seq",
];
const SESSION_TYPES: &[Type] = &[
    Type::UUID,
    Type::INT4,
    Type::TIMESTAMPTZ,
    Type::TIMESTAMPTZ,
    Type::BOOL,
    Type::INT4,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::INT4,
    Type::INT4,
    Type::TEXT,
    Type::JSONB,
    Type::INT4,
    Type::INT4,
    Type::INT4,
    Type::INT4,
    Type::INT4,
    Type::INT8,
    Type::INT8,
    Type::BOOL,
    Type::DATE,
    Type::INET,
    Type::INT8,
    Type::TEXT,
    Type::TEXT,
    Type::TEXT,
    Type::JSONB,
    Type::INT8,
];

const UPSERT: &str = "INSERT INTO sessions SELECT * FROM sessions_stage ON CONFLICT (id, started_at) DO UPDATE SET \
    client_ip = CASE WHEN EXCLUDED.ip_received_ms >= sessions.ip_received_ms THEN COALESCE(EXCLUDED.client_ip,sessions.client_ip) ELSE sessions.client_ip END, \
    ip_received_ms = GREATEST(sessions.ip_received_ms,EXCLUDED.ip_received_ms), \
    last_at = GREATEST(sessions.last_at, EXCLUDED.last_at), \
    ended = EXCLUDED.ended, \
    duration_ms = GREATEST(sessions.duration_ms, EXCLUDED.duration_ms), \
    entry_url = COALESCE(sessions.entry_url, EXCLUDED.entry_url), \
    urls = left(CASE WHEN EXCLUDED.urls = '' THEN sessions.urls WHEN sessions.urls = '' THEN EXCLUDED.urls \
           ELSE sessions.urls || E'\\n' || EXCLUDED.urls END, 16000), \
    user_id = CASE WHEN EXCLUDED.fields_seq > sessions.fields_seq THEN EXCLUDED.user_id ELSE sessions.user_id END, \
    user_email = CASE WHEN EXCLUDED.fields_seq > sessions.fields_seq THEN EXCLUDED.user_email ELSE sessions.user_email END, \
    user_name = CASE WHEN EXCLUDED.fields_seq > sessions.fields_seq THEN EXCLUDED.user_name ELSE sessions.user_name END, \
    custom_fields = CASE WHEN EXCLUDED.fields_seq > sessions.fields_seq THEN EXCLUDED.custom_fields ELSE sessions.custom_fields END, \
    fields_seq = GREATEST(sessions.fields_seq, EXCLUDED.fields_seq), \
    timezone = COALESCE(sessions.timezone, EXCLUDED.timezone), \
    local_time = COALESCE(sessions.local_time, EXCLUDED.local_time), \
    release = COALESCE(sessions.release, EXCLUDED.release), \
    environment = COALESCE(sessions.environment, EXCLUDED.environment), \
    app_version = CASE WHEN EXCLUDED.fields_seq > sessions.fields_seq THEN COALESCE(EXCLUDED.app_version,sessions.app_version) ELSE COALESCE(sessions.app_version,EXCLUDED.app_version) END, \
    device_model = COALESCE(sessions.device_model, EXCLUDED.device_model), \
    os_version = COALESCE(sessions.os_version, EXCLUDED.os_version), \
    webview_version = COALESCE(sessions.webview_version, EXCLUDED.webview_version), \
    browser = COALESCE(sessions.browser, EXCLUDED.browser), \
    browser_ver = COALESCE(sessions.browser_ver, EXCLUDED.browser_ver), \
    os = COALESCE(sessions.os, EXCLUDED.os), \
    vw = COALESCE(sessions.vw, EXCLUDED.vw), vh = COALESCE(sessions.vh, EXCLUDED.vh), \
    lang = COALESCE(sessions.lang, EXCLUDED.lang), tags = COALESCE(sessions.tags, EXCLUDED.tags), \
    error_count = sessions.error_count + EXCLUDED.error_count, \
    warn_count = sessions.warn_count + EXCLUDED.warn_count, \
    click_count = sessions.click_count + EXCLUDED.click_count, \
    ws_disconnects = sessions.ws_disconnects + EXCLUDED.ws_disconnects, \
    segments = sessions.segments + EXCLUDED.segments, \
    bytes = sessions.bytes + EXCLUDED.bytes, \
    canvas_bytes = sessions.canvas_bytes + EXCLUDED.canvas_bytes, \
    has_gap = sessions.has_gap OR EXCLUDED.has_gap";

/// `date` ToSql without pulling chrono into this crate's API: days since 2000-01-01 (Postgres epoch).
mod chrono_day {
    use replayd_db::tokio_postgres::types::{IsNull, ToSql, Type, to_sql_checked};

    #[derive(Debug)]
    pub struct Day(pub i32);

    impl Day {
        /// Parses `YYYY-MM-DD`.
        pub fn parse(s: &str) -> Day {
            let mut it = s.split('-').map(|p| p.parse::<i64>().unwrap_or(1));
            let (y, m, d) = (
                it.next().unwrap_or(2000),
                it.next().unwrap_or(1),
                it.next().unwrap_or(1),
            );
            Day((days_from_civil(y, m, d) - days_from_civil(2000, 1, 1)) as i32)
        }
    }

    /// Howard Hinnant's algorithm.
    pub fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let mp = (m + 9) % 12;
        let doy = (153 * mp + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        era * 146097 + doe - 719468
    }

    impl ToSql for Day {
        fn to_sql(
            &self,
            _ty: &Type,
            out: &mut bytes::BytesMut,
        ) -> Result<IsNull, Box<dyn std::error::Error + Sync + Send>> {
            out.extend_from_slice(&self.0.to_be_bytes());
            Ok(IsNull::No)
        }
        fn accepts(ty: &Type) -> bool {
            *ty == Type::DATE
        }
        to_sql_checked!();
    }
}

/// UTC `YYYY-MM-DD` for a millisecond timestamp.
pub fn utc_day(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    // civil_from_days
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{y:04}-{m:02}-{d:02}")
}

/// Runs the aggregator: applies segment infos, flushes every 3 s, sweeps every 60 s, drains on shutdown.
pub fn spawn(
    pool: Pool,
    mut rx: mpsc::Receiver<SegmentInfo>,
    mut shutdown: tokio::sync::watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut agg = Aggregator::new(pool);
        let mut flush = tokio::time::interval(FLUSH_EVERY);
        let mut sweep = tokio::time::interval(SWEEP_EVERY);
        flush.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                m = rx.recv() => match m {
                    Some(s) => agg.apply(s),
                    None => break,
                },
                _ = flush.tick() => {
                    if let Err(e) = agg.flush().await {
                        metrics::counter!("replayd_pg_batch_errors_total", "table" => "sessions").increment(1);
                        tracing::error!(error = %e, "session flush failed (will retry)");
                    }
                    for (p, n) in agg.active_by_project() {
                        metrics::gauge!("replayd_sessions_active", "project" => p.to_string()).set(n as f64);
                    }
                }
                _ = sweep.tick() => agg.sweep(IDLE_END),
                _ = shutdown.changed() => break,
            }
        }
        while let Ok(s) = rx.try_recv() {
            agg.apply(s);
        }
        if let Err(e) = agg.flush().await {
            tracing::error!(error = %e, "final session flush failed");
        }
    })
}

/// Shared handle type.
pub type SegmentTx = Arc<mpsc::Sender<SegmentInfo>>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days() {
        assert_eq!(utc_day(0), "1970-01-01");
        assert_eq!(utc_day(1_730_620_000_123), "2024-11-03");
        assert_eq!(utc_day(1_793_750_400_000 - 1), "2026-11-03");
        assert_eq!(chrono_day::Day::parse("2000-01-02").0, 1);
        assert_eq!(chrono_day::Day::parse("2026-11-03").0, 9803);
    }
}
