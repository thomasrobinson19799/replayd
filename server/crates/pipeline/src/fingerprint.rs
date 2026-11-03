//! Issue grouping (§5.5 step 4).
//!
//! * errors: `sha1(project, type, normalized message, top 5 in-app frames)`
//! * HTTP:   `sha1(project, method, status, path template)`
//! * WS:     `sha1(project, host + path, close code)`
//!
//! Message normalization strips numbers (incl. MT login ids), UUIDs, hex, quoted strings and trading
//! symbols (`EURUSD`, `XAUUSD.m`), after applying the project's own regex rules.

use std::sync::LazyLock;

use regex::Regex;
use sha1::{Digest, Sha1};

use crate::normalize::{host, strip_build_hash, tilde_path};
use crate::stack::Frame;

static QUOTED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"'[^']*'|"[^"]*"|`[^`]*`"#).unwrap());
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b").unwrap()
});
static DIGITS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\b\d+\b").unwrap());
static HEX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b0x[0-9a-f]+\b|\b[0-9a-f]{8,}\b").unwrap());
static SYMBOL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\b[A-Z]{6}(?:\.[A-Za-z0-9]{1,4})?\b").unwrap());
static NUMBER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\d+(?:\.\d+)?").unwrap());
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s+").unwrap());

/// A project-level replacement rule from `projects.fingerprint_rules`:
/// `[{"pattern": "order #\\w+", "replace": "order #<id>"}]`.
#[derive(Debug, Clone)]
pub struct Rule {
    pub re: Regex,
    pub replace: String,
}

pub fn compile_rules(v: &serde_json::Value) -> Vec<Rule> {
    v.as_array()
        .map(|a| {
            a.iter()
                .filter_map(|r| {
                    let pat = r.get("pattern")?.as_str()?;
                    let re = regex::RegexBuilder::new(pat).size_limit(1 << 20).build().ok()?;
                    let replace = r
                        .get("replace")
                        .and_then(|s| s.as_str())
                        .unwrap_or("<x>")
                        .to_string();
                    Some(Rule { re, replace })
                })
                .take(50)
                .collect()
        })
        .unwrap_or_default()
}

pub fn normalize_message(msg: &str, rules: &[Rule]) -> String {
    let mut m: String = msg.chars().take(1024).collect();
    for r in rules {
        m = r.re.replace_all(&m, r.replace.as_str()).into_owned();
    }
    let m = QUOTED.replace_all(&m, "<str>");
    let m = UUID.replace_all(&m, "<uuid>");
    // pure digit runs (MT login ids, order numbers) are numbers, not hex
    let m = DIGITS.replace_all(&m, "<n>");
    let m = HEX.replace_all(&m, "<hex>");
    let m = SYMBOL.replace_all(&m, "<sym>");
    let m = NUMBER.replace_all(&m, "<n>");
    let m = SPACES.replace_all(&m, " ");
    m.trim().chars().take(512).collect()
}

/// `/api/orders/12345/cancel?x=1` → `/api/orders/:id/cancel`.
pub fn path_template(url: &str) -> String {
    let p = tilde_path(url);
    let p = p.strip_prefix('~').unwrap_or(&p);
    let segs: Vec<String> = p
        .split('/')
        .map(|s| {
            let id_like = !s.is_empty()
                && (s.chars().all(|c| c.is_ascii_digit())
                    || UUID.is_match(s)
                    || (s.len() >= 8 && s.chars().all(|c| c.is_ascii_hexdigit()))
                    || (s.len() >= 16 && s.chars().any(|c| c.is_ascii_digit())));
            if id_like { ":id".to_string() } else { s.to_string() }
        })
        .collect();
    segs.join("/")
}

fn frame_key(f: &Frame) -> String {
    match &f.orig {
        Some(o) => format!("{}|{}", o.file, o.function),
        None => format!("{}|{}", strip_build_hash(&f.path), f.function),
    }
}

pub struct Grouping {
    pub fingerprint: [u8; 20],
    pub title: String,
    pub culprit: Option<String>,
}

fn sha(parts: &[&str]) -> [u8; 20] {
    let mut h = Sha1::new();
    for p in parts {
        h.update((p.len() as u32).to_le_bytes());
        h.update(p.as_bytes());
    }
    h.finalize().into()
}

fn title_of(ty: Option<&str>, msg: &str) -> String {
    let t = match ty {
        Some(t) if !t.is_empty() => format!("{t}: {msg}"),
        _ => msg.to_string(),
    };
    t.chars().take(200).collect()
}

pub struct ErrorInput<'a> {
    pub project_id: i32,
    pub source: &'a str,
    pub ty: Option<&'a str>,
    pub message: &'a str,
    pub frames: &'a [Frame],
    pub http: Option<(&'a str, u16, &'a str)>,
    pub ws: Option<(&'a str, u16)>,
}

pub fn group(e: &ErrorInput, rules: &[Rule]) -> Grouping {
    let pid = e.project_id.to_string();
    if let (Some((method, status, url)), "http") = (e.http, e.source) {
        let tpl = path_template(url);
        let m = method.to_ascii_uppercase();
        return Grouping {
            fingerprint: sha(&["http", &pid, &m, &status.to_string(), &tpl]),
            title: format!("{m} {tpl} → {status}"),
            culprit: Some(tpl),
        };
    }
    if let (Some((url, code)), "ws") = (e.ws, e.source) {
        let hp = format!(
            "{}{}",
            host(
                &url.replacen("wss://", "https://", 1)
                    .replacen("ws://", "http://", 1)
            )
            .unwrap_or_default(),
            path_template(
                &url.replacen("wss://", "https://", 1)
                    .replacen("ws://", "http://", 1)
            )
        );
        return Grouping {
            fingerprint: sha(&["ws", &pid, &hp, &code.to_string()]),
            title: format!("WebSocket closed abnormally (code {code})"),
            culprit: Some(hp),
        };
    }
    let norm = normalize_message(e.message, rules);
    let in_app: Vec<&Frame> = e.frames.iter().filter(|f| f.in_app).take(5).collect();
    let keys: Vec<String> = if in_app.is_empty() {
        e.frames
            .iter()
            .filter(|f| !f.url.is_empty())
            .take(3)
            .map(frame_key)
            .collect()
    } else {
        in_app.iter().map(|f| frame_key(f)).collect()
    };
    let mut parts: Vec<&str> = vec!["err", &pid, e.ty.unwrap_or(""), &norm];
    parts.extend(keys.iter().map(String::as_str));
    let culprit = in_app
        .first()
        .copied()
        .or(e.frames.first())
        .filter(|f| !f.url.is_empty())
        .map(|f| match &f.orig {
            Some(o) if !o.function.is_empty() => format!("{} ({})", o.function, o.file),
            Some(o) => o.file.clone(),
            None if !f.function.is_empty() => format!("{} ({})", f.function, f.path),
            None => f.path.clone(),
        });
    Grouping {
        fingerprint: sha(&parts),
        title: title_of(e.ty, e.message),
        culprit,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{normalize, stack};

    #[test]
    fn message_normalization() {
        let m = normalize_message(
            "Order 12345 for EURUSD failed: login 10023451 'abc' id 0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d at 0xdeadbeef XAUUSD.m",
            &[],
        );
        assert_eq!(
            m,
            "Order <n> for <sym> failed: login <n> <str> id <uuid> at <hex> <sym>"
        );
        let rules =
            compile_rules(&serde_json::json!([{"pattern": "ticket T-\\w+", "replace": "ticket <t>"}]));
        assert_eq!(normalize_message("ticket T-ab boom", &rules), "ticket <t> boom");
        assert!(compile_rules(&serde_json::json!([{"pattern": "("}])).is_empty());
    }

    #[test]
    fn templates() {
        assert_eq!(
            path_template("https://api.x.com/v1/orders/12345/cancel?y=2"),
            "/v1/orders/:id/cancel"
        );
        assert_eq!(
            path_template("https://api.x.com/u/0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d"),
            "/u/:id"
        );
        assert_eq!(path_template("/api/deadbeef12/x"), "/api/:id/x");
    }

    fn frames(stack_str: &str, page: &str) -> Vec<Frame> {
        let mut f = stack::parse(stack_str);
        normalize::annotate(&mut f, Some(page));
        f
    }

    #[test]
    fn localhost_and_web_group_together_across_builds() {
        let web = frames(
            "TypeError: x is undefined\n    at submit (https://terminal.fxglory.com/_nuxt/OrderPanel.Cx1aB2.js:1:2345)\n    at https://terminal.fxglory.com/_nuxt/entry.Df9Kq1.js:3:9",
            "https://terminal.fxglory.com/trade",
        );
        let apk = frames(
            "TypeError: x is undefined\n    at submit (https://localhost/_nuxt/OrderPanel.Zz9yX8.js:1:2299)\n    at https://localhost/_nuxt/entry.Aa1Bb2.js:3:11",
            "https://localhost/trade",
        );
        let g = |fr: &[Frame], msg: &str| {
            group(
                &ErrorInput {
                    project_id: 1,
                    source: "onerror",
                    ty: Some("TypeError"),
                    message: msg,
                    frames: fr,
                    http: None,
                    ws: None,
                },
                &[],
            )
        };
        let a = g(&web, "x is undefined (order 991)");
        let b = g(&apk, "x is undefined (order 12)");
        assert_eq!(a.fingerprint, b.fingerprint);
        assert_eq!(
            a.culprit.as_deref(),
            Some("submit (~/_nuxt/OrderPanel.Cx1aB2.js)")
        );
        let other = frames(
            "TypeError: x\n    at cancel (https://localhost/_nuxt/Other.js:1:1)",
            "https://localhost/",
        );
        assert_ne!(g(&other, "x is undefined").fingerprint, a.fingerprint);
    }

    #[test]
    fn http_and_ws() {
        let h = |url: &str, status: u16| {
            group(
                &ErrorInput {
                    project_id: 1,
                    source: "http",
                    ty: None,
                    message: "",
                    frames: &[],
                    http: Some(("post", status, url)),
                    ws: None,
                },
                &[],
            )
        };
        assert_eq!(
            h("https://api.a.com/orders/1", 500).fingerprint,
            h("https://api.a.com/orders/2?x", 500).fingerprint
        );
        assert_ne!(
            h("https://api.a.com/orders/1", 500).fingerprint,
            h("https://api.a.com/orders/1", 502).fingerprint
        );
        assert_eq!(
            h("https://api.a.com/orders/1", 500).title,
            "POST /orders/:id → 500"
        );
        let w = |url: &str, code: u16| {
            group(
                &ErrorInput {
                    project_id: 1,
                    source: "ws",
                    ty: None,
                    message: "",
                    frames: &[],
                    http: None,
                    ws: Some((url, code)),
                },
                &[],
            )
        };
        let a = w("wss://rt.fxglory.com/connection/websocket?token=x", 1006);
        assert_eq!(
            a.fingerprint,
            w("wss://rt.fxglory.com/connection/websocket", 1006).fingerprint
        );
        assert_eq!(a.culprit.as_deref(), Some("rt.fxglory.com/connection/websocket"));
        assert_ne!(
            a.fingerprint,
            w("wss://rt.fxglory.com/connection/websocket", 1011).fingerprint
        );
    }
}
