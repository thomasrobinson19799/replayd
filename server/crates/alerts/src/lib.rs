//! replayd-alerts: Telegram alerts per project (PRD §5.7).
//!
//! Consumes the pipeline's bounded [`IssueSignal`] channel. Alerts: **new issue** (warnings only with the
//! `warnings` toggle), **regression**, **spike** (default ≥ 50 events in 5 min). One alert per issue per kind
//! per 30 min (also persisted in `alerts_sent`, reloaded on start), ≤ 20 messages/min per chat (over → dropped
//! and counted), 3 retries (Telegram `retry_after` honoured). The bot token is never logged: request errors are
//! logged `without_url()`.
//!
//! Project config (`projects.telegram`, edited in the dashboard):
//! `{ "bot_token", "chat_id", "enabled": true, "new_issue": true, "regression": true, "spike": true,
//!    "warnings": false, "spike_threshold": 50, "spike_minutes": 5 }`

use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use replayd_db::Pool;
use replayd_ingest::ProjectCache;
use replayd_pipeline::IssueSignal;
use serde_json::{Value, json};
use tokio::sync::{Semaphore, mpsc};

pub const DEDUP_MS: u64 = 30 * 60_000;
pub const CHAT_PER_MIN: f64 = 20.0;
const RETRIES: u32 = 3;

#[derive(Debug, Clone, PartialEq)]
pub struct TgConfig {
    pub bot_token: String,
    pub chat_id: String,
    pub new_issue: bool,
    pub regression: bool,
    pub spike: bool,
    pub warnings: bool,
    pub spike_threshold: i64,
    pub spike_minutes: u64,
}

impl TgConfig {
    /// `None` when not configured or disabled.
    pub fn from_json(v: Option<&Value>) -> Option<Self> {
        let v = v?;
        if v.get("enabled").and_then(Value::as_bool) == Some(false) {
            return None;
        }
        let s = |k: &str| match v.get(k) {
            Some(Value::String(s)) => Some(s.trim().to_string()),
            Some(Value::Number(n)) => Some(n.to_string()),
            _ => None,
        };
        let b = |k: &str, d: bool| v.get(k).and_then(Value::as_bool).unwrap_or(d);
        let bot_token = s("bot_token").filter(|t| !t.is_empty())?;
        let chat_id = s("chat_id").filter(|t| !t.is_empty())?;
        Some(Self {
            bot_token,
            chat_id,
            new_issue: b("new_issue", true),
            regression: b("regression", true),
            spike: b("spike", true),
            warnings: b("warnings", false),
            spike_threshold: v
                .get("spike_threshold")
                .and_then(Value::as_i64)
                .unwrap_or(50)
                .max(1),
            spike_minutes: v
                .get("spike_minutes")
                .and_then(Value::as_u64)
                .unwrap_or(5)
                .clamp(1, 60),
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    New,
    Regression,
    Spike,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::New => "new",
            Kind::Regression => "regression",
            Kind::Spike => "spike",
        }
    }
}

/// Pure alert policy (time injected in ms): spike windows, dedup, per-chat rate limit. Bounded maps.
#[derive(Default)]
pub struct Policy {
    sent: HashMap<(i64, Kind), u64>,
    chats: HashMap<String, (f64, u64)>,
    windows: HashMap<i64, VecDeque<(u64, i64)>>,
}

const MAX_KEYS: usize = 50_000;

impl Policy {
    /// Adds `count` events at `now` and returns true when the issue's events within `minutes` reach `threshold`.
    pub fn spike(&mut self, issue: i64, count: i64, now: u64, threshold: i64, minutes: u64) -> bool {
        if self.windows.len() > MAX_KEYS {
            let cut = now.saturating_sub(minutes * 60_000);
            self.windows
                .retain(|_, w| w.back().is_some_and(|b| b.0 * 60_000 >= cut));
        }
        let m = now / 60_000;
        let w = self.windows.entry(issue).or_default();
        match w.back_mut() {
            Some(b) if b.0 == m => b.1 += count,
            _ => w.push_back((m, count)),
        }
        while w.front().is_some_and(|f| f.0 + minutes <= m) {
            w.pop_front();
        }
        w.iter().map(|x| x.1).sum::<i64>() >= threshold
    }

    /// True if no alert of this kind went out for the issue within 30 min (spikes also wait 30 min after a
    /// new-issue / regression alert of the same issue). Does not record.
    pub fn fresh(&self, issue: i64, kind: Kind, now: u64) -> bool {
        let ok = |k: Kind| {
            self.sent
                .get(&(issue, k))
                .is_none_or(|t| now.saturating_sub(*t) >= DEDUP_MS)
        };
        ok(kind) && (kind != Kind::Spike || (ok(Kind::New) && ok(Kind::Regression)))
    }

    pub fn record(&mut self, issue: i64, kind: Kind, now: u64) {
        if self.sent.len() > MAX_KEYS {
            self.sent.retain(|_, t| now.saturating_sub(*t) < DEDUP_MS);
        }
        self.sent.insert((issue, kind), now);
    }

    /// Token bucket per chat: 20 / min, burst 20.
    pub fn take_chat(&mut self, chat: &str, now: u64) -> bool {
        if self.chats.len() > MAX_KEYS {
            self.chats.clear();
        }
        let e = self.chats.entry(chat.to_string()).or_insert((CHAT_PER_MIN, now));
        e.0 = (e.0 + now.saturating_sub(e.1) as f64 * CHAT_PER_MIN / 60_000.0).min(CHAT_PER_MIN);
        e.1 = now;
        if e.0 >= 1.0 {
            e.0 -= 1.0;
            true
        } else {
            false
        }
    }
}

pub fn html(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Alert text (Telegram HTML).
#[derive(Debug, Default, Clone)]
pub struct IssueInfo {
    pub project: String,
    pub id: i64,
    pub level: String,
    pub title: String,
    pub culprit: Option<String>,
    pub platforms: Vec<String>,
    pub release: Option<String>,
    pub times_seen: i64,
    pub users_seen: i32,
    pub session: Option<(String, i64)>,
}

pub fn message(kind: Kind, i: &IssueInfo, base: &str, spike: Option<(i64, u64)>) -> String {
    let head = match kind {
        Kind::New => "🆕 New issue".to_string(),
        Kind::Regression => "🔁 Regression".to_string(),
        Kind::Spike => match spike {
            Some((n, m)) => format!("📈 Spike: {n}+ events in {m} min"),
            None => "📈 Spike".into(),
        },
    };
    let plat: Vec<&str> = i
        .platforms
        .iter()
        .map(|p| {
            if p == "capacitor-android" {
                "APK"
            } else {
                p.as_str()
            }
        })
        .collect();
    let base = base.trim_end_matches('/');
    let mut s = format!(
        "{} · <b>{}</b>\n{} <b>{}</b>\n",
        head,
        html(&i.project),
        if i.level == "error" { "🔴" } else { "🟠" },
        html(&i.title)
    );
    if let Some(c) = i.culprit.as_deref().filter(|c| !c.is_empty()) {
        s.push_str(&format!("<code>{}</code>\n", html(c)));
    }
    s.push_str(&format!(
        "{} · {} · release {}\nevents {} · users {}\n",
        i.level,
        if plat.is_empty() {
            "web".into()
        } else {
            plat.join(" + ")
        },
        html(i.release.as_deref().unwrap_or("–")),
        i.times_seen,
        i.users_seen
    ));
    s.push_str(&format!(
        "<a href=\"{base}/projects/{}/issues/{}\">Issue</a>",
        html(&i.project),
        i.id
    ));
    if let Some((sid, ts)) = &i.session {
        s.push_str(&format!(
            " · <a href=\"{base}/replay/{}?t={}\">Replay</a>",
            html(sid),
            ts - 2000
        ));
    }
    s
}

/// Sends one message with 3 retries (backoff 1/2/4 s, or Telegram's `retry_after`). Never exposes the token.
pub async fn send(http: &reqwest::Client, api_base: &str, cfg: &TgConfig, text: &str) -> Result<(), String> {
    let url = format!(
        "{}/bot{}/sendMessage",
        api_base.trim_end_matches('/'),
        cfg.bot_token
    );
    let body = json!({ "chat_id": cfg.chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": true });
    let mut last = String::new();
    for attempt in 0..=RETRIES {
        match http.post(&url).json(&body).send().await {
            Ok(r) if r.status().is_success() => return Ok(()),
            Ok(r) => {
                let st = r.status();
                let v: Value = r.json().await.unwrap_or(Value::Null);
                last = format!(
                    "telegram {}: {}",
                    st.as_u16(),
                    v["description"].as_str().unwrap_or("")
                );
                if st.as_u16() != 429 && st.is_client_error() {
                    return Err(last);
                }
                if attempt < RETRIES {
                    let ra = v["parameters"]["retry_after"]
                        .as_u64()
                        .unwrap_or(1 << attempt)
                        .min(60);
                    tokio::time::sleep(Duration::from_secs(ra)).await;
                }
            }
            Err(e) => {
                last = e.without_url().to_string();
                if attempt < RETRIES {
                    tokio::time::sleep(Duration::from_secs(1 << attempt)).await;
                }
            }
        }
    }
    Err(last)
}

pub struct Alerts {
    pool: Pool,
    projects: Arc<ProjectCache>,
    public_url: String,
    api_base: String,
    http: reqwest::Client,
    policy: Mutex<Policy>,
    inflight: Semaphore,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

impl Alerts {
    pub fn new(pool: Pool, projects: Arc<ProjectCache>, public_url: String, api_base: String) -> Arc<Self> {
        Arc::new(Self {
            pool,
            projects,
            public_url,
            api_base,
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(10))
                .build()
                .unwrap_or_default(),
            policy: Mutex::new(Policy::default()),
            inflight: Semaphore::new(4),
        })
    }

    pub fn http(&self) -> &reqwest::Client {
        &self.http
    }
    pub fn api_base(&self) -> &str {
        &self.api_base
    }

    /// Reloads the last 30 min of `alerts_sent` into the dedup map (restart-safe dedup).
    pub async fn load_sent(&self) {
        let Ok(c) = self.pool.get().await else { return };
        let Ok(rows) = c
            .query(
                "SELECT issue_id, kind, (extract(epoch from sent_at) * 1000)::bigint FROM alerts_sent \
                 WHERE sent_at > now() - interval '30 minutes'",
                &[],
            )
            .await
        else {
            return;
        };
        let mut p = self.policy.lock();
        for r in rows {
            let k = match r.get::<_, String>(1).as_str() {
                "new" => Kind::New,
                "regression" => Kind::Regression,
                _ => Kind::Spike,
            };
            p.record(r.get(0), k, r.get::<_, i64>(2) as u64);
        }
    }

    /// Decides (sync, cheap) whether a signal becomes an alert; sending happens in a task.
    pub fn handle(self: &Arc<Self>, s: IssueSignal) {
        let (pid, issue, kind, spike) = match s {
            IssueSignal::New {
                project_id,
                issue_id,
                level,
            } => {
                let Some(cfg) = self.cfg(project_id) else { return };
                if !cfg.new_issue || (level != "error" && !cfg.warnings) {
                    return;
                }
                (project_id, issue_id, Kind::New, None)
            }
            IssueSignal::Regression {
                project_id, issue_id, ..
            } => {
                let Some(cfg) = self.cfg(project_id) else { return };
                if !cfg.regression {
                    return;
                }
                (project_id, issue_id, Kind::Regression, None)
            }
            IssueSignal::Seen {
                project_id,
                issue_id,
                count,
            } => {
                let Some(cfg) = self.cfg(project_id) else { return };
                if !cfg.spike {
                    return;
                }
                let hit = self.policy.lock().spike(
                    issue_id,
                    count,
                    now_ms(),
                    cfg.spike_threshold,
                    cfg.spike_minutes,
                );
                if !hit {
                    return;
                }
                (
                    project_id,
                    issue_id,
                    Kind::Spike,
                    Some((cfg.spike_threshold, cfg.spike_minutes)),
                )
            }
        };
        let Some(cfg) = self.cfg(pid) else { return };
        let now = now_ms();
        {
            let mut p = self.policy.lock();
            if !p.fresh(issue, kind, now) {
                metrics::counter!("replayd_alerts_suppressed_total", "reason" => "dedup").increment(1);
                return;
            }
            if !p.take_chat(&cfg.chat_id, now) {
                metrics::counter!("replayd_alerts_suppressed_total", "reason" => "rate").increment(1);
                return;
            }
            p.record(issue, kind, now);
        }
        let me = self.clone();
        tokio::spawn(async move {
            let Ok(_permit) = me.inflight.acquire().await else {
                return;
            };
            let text = match me.info(pid, issue).await {
                Some(i) => message(kind, &i, &me.public_url, spike),
                None => return,
            };
            match send(&me.http, &me.api_base, &cfg, &text).await {
                Ok(()) => {
                    metrics::counter!("replayd_alerts_sent_total", "kind" => kind.as_str()).increment(1);
                    if let Ok(c) = me.pool.get().await {
                        let _ = c
                            .execute(
                                "INSERT INTO alerts_sent (project_id, issue_id, kind, sent_at) VALUES ($1, $2, $3, now()) \
                                 ON CONFLICT DO NOTHING",
                                &[&pid, &issue, &kind.as_str()],
                            )
                            .await;
                    }
                }
                Err(e) => {
                    metrics::counter!("replayd_alerts_failed_total").increment(1);
                    tracing::warn!(project_id = pid, issue_id = issue, kind = kind.as_str(), error = %e, "telegram alert failed");
                }
            }
        });
    }

    fn cfg(&self, project_id: i32) -> Option<TgConfig> {
        let p = self.projects.get(&project_id.to_string())?;
        TgConfig::from_json(p.row.telegram.as_ref())
    }

    async fn info(&self, pid: i32, issue: i64) -> Option<IssueInfo> {
        let c = self.pool.get().await.ok()?;
        let r = c
            .query_opt(
                "SELECT p.slug, i.level, i.title, i.culprit, i.platforms, i.last_release, i.times_seen, i.users_seen, \
                   (SELECT session_id::text || ' ' || (extract(epoch from ts) * 1000)::bigint FROM events \
                     WHERE issue_id = i.id AND session_id IS NOT NULL ORDER BY ts DESC LIMIT 1) \
                 FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.id = $1 AND i.project_id = $2",
                &[&issue, &pid],
            )
            .await
            .ok()??;
        let sess: Option<String> = r.get(8);
        Some(IssueInfo {
            project: r.get(0),
            id: issue,
            level: r.get(1),
            title: r.get(2),
            culprit: r.get(3),
            platforms: r.get(4),
            release: r.get(5),
            times_seen: r.get(6),
            users_seen: r.get(7),
            session: sess.and_then(|s| {
                let (a, b) = s.split_once(' ')?;
                Some((a.to_string(), b.parse().ok()?))
            }),
        })
    }
}

/// Runs the alert loop until the channel closes.
pub fn spawn(alerts: Arc<Alerts>, mut rx: mpsc::Receiver<IssueSignal>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        alerts.load_sent().await;
        while let Some(s) = rx.recv().await {
            alerts.handle(s);
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_defaults_and_disabled() {
        let c = TgConfig::from_json(Some(&json!({"bot_token": "1:abc", "chat_id": -100123}))).unwrap();
        assert_eq!(c.chat_id, "-100123");
        assert!(c.new_issue && c.regression && c.spike && !c.warnings);
        assert_eq!((c.spike_threshold, c.spike_minutes), (50, 5));
        assert!(
            TgConfig::from_json(Some(
                &json!({"bot_token": "1:abc", "chat_id": "1", "enabled": false})
            ))
            .is_none()
        );
        assert!(TgConfig::from_json(Some(&json!({"chat_id": "1"}))).is_none());
        assert!(TgConfig::from_json(None).is_none());
    }

    #[test]
    fn dedup_30_min_per_issue_and_kind() {
        let mut p = Policy::default();
        assert!(p.fresh(1, Kind::New, 0));
        p.record(1, Kind::New, 0);
        assert!(!p.fresh(1, Kind::New, DEDUP_MS - 1));
        assert!(p.fresh(1, Kind::New, DEDUP_MS));
        assert!(p.fresh(1, Kind::Regression, 1), "other kind is independent");
        assert!(p.fresh(2, Kind::New, 1), "other issue is independent");
        // a spike right after the new-issue alert of the same issue is suppressed
        assert!(!p.fresh(1, Kind::Spike, 60_000));
        assert!(p.fresh(1, Kind::Spike, DEDUP_MS));
    }

    #[test]
    fn rate_limit_20_per_minute_per_chat() {
        let mut p = Policy::default();
        let sent = (0..30).filter(|_| p.take_chat("c1", 1000)).count();
        assert_eq!(sent, 20);
        assert!(p.take_chat("c2", 1000), "other chats have their own bucket");
        assert!(!p.take_chat("c1", 1000 + 2_000), "refills at 1 per 3 s");
        assert!(p.take_chat("c1", 1000 + 3_100));
        assert!(p.take_chat("c1", 1000 + 3_100 + 60_000));
    }

    #[test]
    fn spike_window() {
        let mut p = Policy::default();
        let t = 10 * 60_000;
        assert!(!p.spike(7, 20, t, 50, 5));
        assert!(!p.spike(7, 20, t + 60_000, 50, 5));
        assert!(p.spike(7, 10, t + 120_000, 50, 5));
        // the first bucket ages out after 5 minutes
        assert!(!p.spike(7, 1, t + 5 * 60_000, 50, 5));
        assert!(!p.spike(8, 49, t, 50, 5));
    }

    #[test]
    fn message_escapes_and_links() {
        let i = IssueInfo {
            project: "fxglory-terminal".into(),
            id: 42,
            level: "error".into(),
            title: "TypeError: a < b && <script>".into(),
            culprit: Some("placeOrder (src/order.ts)".into()),
            platforms: vec!["capacitor-android".into(), "web".into()],
            release: Some("1.42.0".into()),
            times_seen: 12,
            users_seen: 3,
            session: Some(("0192f0c4-7a3e".into(), 1_730_620_001_234)),
        };
        let m = message(Kind::Regression, &i, "https://replay.example.com/", None);
        assert!(m.starts_with(
            "🔁 Regression · <b>fxglory-terminal</b>\n🔴 <b>TypeError: a &lt; b &amp;&amp; &lt;script&gt;</b>"
        ));
        assert!(m.contains("<code>placeOrder (src/order.ts)</code>"));
        assert!(m.contains("error · APK + web · release 1.42.0\nevents 12 · users 3"));
        assert!(m.contains(
            "<a href=\"https://replay.example.com/projects/fxglory-terminal/issues/42\">Issue</a>"
        ));
        assert!(m.contains(
            "<a href=\"https://replay.example.com/replay/0192f0c4-7a3e?t=1730619999234\">Replay</a>"
        ));
        let s = message(Kind::Spike, &i, "https://r", Some((50, 5)));
        assert!(s.starts_with("📈 Spike: 50+ events in 5 min"));
    }

    #[tokio::test]
    async fn send_retries_honours_retry_after_and_never_leaks_the_token() {
        use axum::extract::Path;
        use axum::{Json, Router, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let hits = Arc::new(AtomicUsize::new(0));
        let h = hits.clone();
        let app = Router::new().route(
            "/{bot}/sendMessage",
            post(move |Path(bot): Path<String>, Json(b): Json<Value>| {
                let h = h.clone();
                async move {
                    if bot == "botbad" {
                        return (
                            axum::http::StatusCode::UNAUTHORIZED,
                            Json(json!({"ok": false, "description": "Unauthorized"})),
                        );
                    }
                    let n = h.fetch_add(1, Ordering::SeqCst);
                    assert_eq!(b["parse_mode"], "HTML");
                    if n == 0 {
                        (
                            axum::http::StatusCode::TOO_MANY_REQUESTS,
                            Json(json!({"ok": false, "parameters": {"retry_after": 1}})),
                        )
                    } else if n == 1 {
                        (axum::http::StatusCode::BAD_GATEWAY, Json(json!({"ok": false})))
                    } else {
                        (axum::http::StatusCode::OK, Json(json!({"ok": true})))
                    }
                }
            }),
        );
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        let cfg = TgConfig::from_json(Some(&json!({"bot_token": "123:SECRET", "chat_id": "9"}))).unwrap();
        let http = reqwest::Client::new();
        send(&http, &format!("http://{addr}"), &cfg, "hi").await.unwrap();
        assert_eq!(hits.load(Ordering::SeqCst), 3);
        // 4xx (bad token): no retry
        let bad = TgConfig {
            bot_token: "bad".into(),
            ..cfg.clone()
        };
        let e = send(&http, &format!("http://{addr}"), &bad, "hi")
            .await
            .unwrap_err();
        assert_eq!(e, "telegram 401: Unauthorized");
        assert_eq!(hits.load(Ordering::SeqCst), 3, "no retry on 401");
        // network error: message without the URL (the token is in the path)
        let e = send(&http, "http://127.0.0.1:1", &cfg, "hi").await.unwrap_err();
        assert!(!e.contains("SECRET"), "{e}");
    }
}
