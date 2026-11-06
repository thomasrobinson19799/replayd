//! Incoming error event (PRD §4.11) → processed row ready for grouping and COPY.

use serde::Deserialize;
use serde_json::{Map, Value};
use uuid::Uuid;

use crate::fingerprint::{self, ErrorInput, Rule};
use crate::normalize;
use crate::stack::{self, Frame};
use crate::symbolicate::SourceMaps;

#[derive(Debug, Deserialize, Default)]
pub struct InUser {
    #[serde(default)]
    pub id: Option<Value>,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Deserialize, Default)]
pub struct InEvent {
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub ts: Option<f64>,
    #[serde(default)]
    pub sid: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default, rename = "type")]
    pub ty: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
    #[serde(default)]
    pub stack: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub release: Option<String>,
    #[serde(default)]
    pub env: Option<String>,
    #[serde(default)]
    pub platform: Option<String>,
    #[serde(default)]
    pub user: Option<InUser>,
    #[serde(default)]
    pub tags: Option<Map<String, Value>>,
    #[serde(default)]
    pub ctx: Option<Map<String, Value>>,
    #[serde(default)]
    pub breadcrumbs: Option<Vec<Value>>,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub app_version: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub local_time: Option<String>,
    #[serde(default)]
    pub custom_fields: Option<Value>,
}

const SOURCES: &[&str] = &[
    "onerror",
    "unhandledrejection",
    "console",
    "http",
    "ws",
    "vue",
    "react",
    "manual",
];
const MAX_BREADCRUMBS: usize = 100;
const MAX_TAGS: usize = 50;
/// Accept client timestamps within ±24 h of receipt; otherwise use the receive time (keeps rows inside
/// existing daily partitions and protects against skewed device clocks).
const MAX_SKEW_MS: i64 = 24 * 3600 * 1000;

#[derive(Debug, Clone)]
pub struct Processed {
    pub id: Uuid,
    pub project_id: i32,
    pub ts_ms: i64,
    pub session_id: Option<Uuid>,
    pub level: &'static str,
    pub source: String,
    pub ty: Option<String>,
    pub release: Option<String>,
    pub environment: Option<String>,
    pub platform: String,
    pub url: Option<String>,
    pub user_id: Option<String>,
    pub user_email: Option<String>,
    pub user_name: Option<String>,
    pub client_ip: Option<std::net::IpAddr>,
    pub browser: Option<String>,
    pub os: Option<String>,
    pub app_version: Option<String>,
    pub count: i64,
    pub fingerprint: [u8; 20],
    pub title: String,
    pub culprit: Option<String>,
    /// at least one frame was mapped to original source (T-30)
    pub symbolicated: bool,
    pub payload: Value,
}

fn clip(s: Option<String>, n: usize) -> Option<String> {
    s.map(|s| {
        if s.len() > n {
            s.chars().take(n).collect()
        } else {
            s
        }
    })
    .filter(|s| !s.is_empty())
}

fn str_at<'a>(m: &'a Option<Map<String, Value>>, a: &str, b: &str) -> Option<&'a Value> {
    m.as_ref()?.get(a)?.get(b)
}

/// Parsed user agent (computed once per job, all events of a batch share it).
#[derive(Debug, Clone, Default)]
pub struct Ua {
    pub browser: Option<String>,
    pub browser_ver: Option<String>,
    pub os: Option<String>,
}

pub fn parse_ua(ua: Option<&str>) -> Ua {
    let Some(ua) = ua else { return Ua::default() };
    match woothee::parser::Parser::new().parse(ua) {
        Some(r) => Ua {
            browser: (r.name != "UNKNOWN").then(|| r.name.to_string()),
            browser_ver: (!r.version.is_empty() && r.version != "UNKNOWN").then(|| r.version.to_string()),
            os: (r.os != "UNKNOWN").then(|| {
                if r.os_version.is_empty() || r.os_version == "UNKNOWN" {
                    r.os.to_string()
                } else {
                    format!("{} {}", r.os, r.os_version)
                }
            }),
        },
        None => Ua::default(),
    }
}

pub fn process(e: InEvent, project_id: i32, received_ms: i64, ua: &Ua, rules: &[Rule]) -> Processed {
    process_with(e, project_id, received_ms, ua, rules, None)
}

/// [`process`] with source-map symbolication (by `release`) before fingerprinting (§5.5 steps 3–4).
pub fn process_with(
    e: InEvent,
    project_id: i32,
    received_ms: i64,
    ua: &Ua,
    rules: &[Rule],
    maps: Option<&SourceMaps>,
) -> Processed {
    let id =
        e.id.as_deref()
            .and_then(|s| Uuid::try_parse(s).ok())
            .unwrap_or_else(Uuid::now_v7);
    let ts_ms = match e.ts {
        Some(t) if t.is_finite() && ((t as i64) - received_ms).abs() <= MAX_SKEW_MS => t as i64,
        _ => received_ms,
    };
    let level = match e.level.as_deref() {
        Some("warning") | Some("warn") => "warning",
        _ => "error",
    };
    let source = e
        .source
        .as_deref()
        .filter(|s| SOURCES.contains(s))
        .unwrap_or("manual")
        .to_string();
    let message = clip(e.message.clone(), 8192).unwrap_or_default();
    let stack_raw = clip(e.stack.clone(), 16 * 1024);
    let url = clip(e.url.clone(), 2048);
    let mut frames: Vec<Frame> = stack_raw.as_deref().map(stack::parse).unwrap_or_default();
    normalize::annotate(&mut frames, url.as_deref());
    let symbolicated = match (maps, e.release.as_deref()) {
        (Some(m), Some(r)) if !frames.is_empty() => m.symbolicate(project_id, r, &mut frames),
        _ => false,
    };

    let http = str_at(&e.ctx, "http", "method")
        .and_then(Value::as_str)
        .and_then(|m| {
            let status = str_at(&e.ctx, "http", "status")?.as_u64()? as u16;
            let u = str_at(&e.ctx, "http", "url")?.as_str()?;
            Some((m, status, u))
        });
    let ws = str_at(&e.ctx, "ws", "url").and_then(Value::as_str).map(|u| {
        let code = str_at(&e.ctx, "ws", "code").and_then(Value::as_u64).unwrap_or(0) as u16;
        (u, code)
    });
    let g = fingerprint::group(
        &ErrorInput {
            project_id,
            source: &source,
            ty: e.ty.as_deref(),
            message: &message,
            frames: &frames,
            http,
            ws,
        },
        rules,
    );
    let user_id = e.user.as_ref().and_then(|u| match &u.id {
        Some(Value::String(s)) => Some(s.clone()),
        Some(Value::Number(n)) => Some(n.to_string()),
        _ => None,
    });
    let app_version = clip(
        e.app_version.clone().or_else(|| {
            str_at(&e.ctx, "app", "version")
                .and_then(Value::as_str)
                .map(str::to_string)
        }),
        256,
    );
    let platform = match e.platform.as_deref() {
        Some("capacitor-android") => "capacitor-android",
        _ => "web",
    }
    .to_string();

    let mut tags = e.tags.unwrap_or_default();
    if tags.len() > MAX_TAGS {
        tags = tags.into_iter().take(MAX_TAGS).collect();
    }
    let mut breadcrumbs = e.breadcrumbs.unwrap_or_default();
    let n = breadcrumbs.len();
    if n > MAX_BREADCRUMBS {
        breadcrumbs.drain(..n - MAX_BREADCRUMBS);
    }
    let mut payload = Map::new();
    payload.insert("received_at".into(), Value::from(received_ms));
    if let Some(zone) = clip(e.timezone, 128) {
        payload.insert("timezone".into(), Value::String(zone));
    }
    if let Some(local) = clip(e.local_time, 64) {
        payload.insert("local_time".into(), Value::String(local));
    }
    if let Some(custom) = e.custom_fields.filter(replayd_common::fields::valid_custom) {
        payload.insert("custom_fields".into(), custom);
    }
    payload.insert("message".into(), Value::String(message));
    if let Some(t) = &e.ty {
        payload.insert("type".into(), Value::String(t.clone()));
    }
    if let Some(s) = stack_raw {
        payload.insert("stack".into(), Value::String(s));
    }
    payload.insert(
        "frames".into(),
        serde_json::to_value(&frames).unwrap_or(Value::Null),
    );
    payload.insert("tags".into(), Value::Object(tags));
    if let Some(ctx) = e.ctx {
        payload.insert("ctx".into(), Value::Object(ctx));
    }
    payload.insert("breadcrumbs".into(), Value::Array(breadcrumbs));
    if let Some(u) = &e.user {
        let mut um = Map::new();
        if let Some(id) = &user_id {
            um.insert("id".into(), Value::String(id.clone()));
        }
        if let Some(em) = &u.email {
            um.insert("email".into(), Value::String(em.clone()));
        }
        if let Some(name) = &u.name {
            um.insert("name".into(), Value::String(name.clone()));
        }
        payload.insert("user".into(), Value::Object(um));
    }
    if let Some(v) = &ua.browser_ver {
        payload.insert("browser_ver".into(), Value::String(v.clone()));
    }

    Processed {
        id,
        project_id,
        user_email: clip(e.user.as_ref().and_then(|u| u.email.clone()), 512),
        user_name: clip(e.user.as_ref().and_then(|u| u.name.clone()), 512),
        client_ip: None,
        ts_ms,
        session_id: e.sid.as_deref().and_then(|s| Uuid::try_parse(s).ok()),
        level,
        source,
        ty: clip(e.ty, 200),
        release: clip(e.release, 200),
        environment: clip(e.env, 100),
        platform,
        url,
        user_id: clip(user_id, 200),
        browser: ua.browser.clone(),
        os: ua.os.clone(),
        app_version: clip(app_version, 100),
        count: e.count.unwrap_or(1).clamp(1, 10_000) as i64,
        fingerprint: g.fingerprint,
        title: g.title,
        culprit: g.culprit,
        symbolicated,
        payload: Value::Object(payload),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn processes_full_event() {
        let ev: InEvent = serde_json::from_value(json!({
            "id": "0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d", "ts": 1_730_620_001_234_i64,
            "sid": "0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8e", "level": "error", "source": "onerror",
            "type": "TypeError", "message": "x is undefined",
            "stack": "TypeError: x is undefined\n    at submit (https://localhost/_nuxt/OrderPanel.js:1:2)",
            "url": "https://localhost/trade", "release": "1.42.0", "env": "production",
            "platform": "capacitor-android", "user": {"id": 10023451},
            "tags": {"brand": "fxglory"}, "ctx": {"app": {"version": "1.42.0 (142)"}},
            "breadcrumbs": [{"ts": 0, "cat": "click", "msg": "button#buy"}], "count": 3
        }))
        .unwrap();
        let ua = parse_ua(Some(
            "Mozilla/5.0 (Linux; Android 14; SM-A525F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.6723.58 Mobile Safari/537.36",
        ));
        assert_eq!(ua.browser.as_deref(), Some("Chrome"));
        assert!(ua.os.as_deref().unwrap().starts_with("Android"));
        let p = process(ev, 1, 1_730_620_002_000, &ua, &[]);
        assert_eq!(p.ts_ms, 1_730_620_001_234);
        assert_eq!(p.user_id.as_deref(), Some("10023451"));
        assert_eq!(p.platform, "capacitor-android");
        assert_eq!(p.app_version.as_deref(), Some("1.42.0 (142)"));
        assert_eq!(p.count, 3);
        assert_eq!(p.payload["frames"][0]["path"], "~/_nuxt/OrderPanel.js");
        assert_eq!(p.payload["frames"][0]["in_app"], true);
        assert_eq!(p.title, "TypeError: x is undefined");
    }

    #[test]
    fn identity_clock_and_custom_fields_survive_processing() {
        let input = json!({"user":{"id":"customer-1","email":"person@example.test","name":"Jane"},
            "app_version":"explicit-2", "ctx":{"app":{"version":"native-1"}},
            "timezone":"Asia/Tehran", "local_time":"2026-11-06 14:03:21 +03:30",
            "custom_fields":{"plan":"pro","nested":{"password":"[Filtered]"}}});
        let p = process(
            serde_json::from_value(input).unwrap(),
            1,
            1730620002000,
            &Ua::default(),
            &[],
        );
        assert_eq!(p.user_email.as_deref(), Some("person@example.test"));
        assert_eq!(p.user_name.as_deref(), Some("Jane"));
        assert_eq!(p.app_version.as_deref(), Some("explicit-2"));
        assert_eq!(p.payload["user"]["name"], "Jane");
        assert_eq!(p.payload["timezone"], "Asia/Tehran");
        assert_eq!(p.payload["local_time"], "2026-11-06 14:03:21 +03:30");
        assert_eq!(p.payload["received_at"], 1730620002000_i64);
        assert_eq!(p.payload["custom_fields"]["plan"], "pro");
        let oversized = json!({"custom_fields":{"value":"x".repeat(16384)}});
        let p = process(
            serde_json::from_value(oversized).unwrap(),
            1,
            1730620002000,
            &Ua::default(),
            &[],
        );
        assert!(p.payload.get("custom_fields").is_none());
    }

    #[test]
    fn defaults_and_clamps() {
        let p = process(
            InEvent {
                ts: Some(0.0),
                level: Some("bogus".into()),
                source: Some("evil".into()),
                ..Default::default()
            },
            1,
            1_730_620_002_000,
            &Ua::default(),
            &[],
        );
        assert_eq!(p.ts_ms, 1_730_620_002_000);
        assert_eq!(p.level, "error");
        assert_eq!(p.source, "manual");
        assert_eq!(p.platform, "web");
        assert_eq!(p.id.get_version_num(), 7);
    }
}
