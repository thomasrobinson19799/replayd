//! Per-project remote config served to the SDK (PRD §4.12).
//!
//! Stored in `projects.remote_config` as a partial JSON object; merged over defaults here. Rates and toggles
//! are the server's to decide; redaction lists can only *extend* the SDK's built-in lists (enforced in the SDK).

use serde_json::{Map, Value, json};

/// Default remote config (canvas is out of scope for v1, D-01, so it is always disabled).
pub fn defaults() -> Value {
    json!({
        "v": 1,
        "disabled": false,
        "replay": { "sampleRate": 1.0 },
        "canvas": { "enabled": false, "fps": 0.2, "maxWidth": 960, "quality": 0.35 },
        "ws": { "enabled": true, "perChannelPerSec": 1, "maxFramesPerSec": 20 },
        "errors": { "sampleRate": 1.0 },
        "redact": { "headers": [], "bodyKeys": [], "queryParams": [] },
        "ttl": 600
    })
}

fn merge(base: &mut Value, over: &Value) {
    match (base, over) {
        (Value::Object(b), Value::Object(o)) => {
            for (k, v) in o {
                match b.get_mut(k) {
                    Some(slot) if slot.is_object() && v.is_object() => merge(slot, v),
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (b, o) => *b = o.clone(),
    }
}

/// Effective remote config for a project; `stored` is `projects.remote_config`. Unknown keys are dropped,
/// numbers clamped to sane ranges.
pub fn effective(stored: &Value) -> Value {
    let mut v = defaults();
    if stored.is_object() {
        merge(&mut v, stored);
    }
    let d = defaults();
    let Value::Object(map) = &mut v else {
        unreachable!()
    };
    map.retain(|k, _| d.get(k).is_some());
    clamp(map, &["replay", "sampleRate"], 0.0, 1.0);
    clamp(map, &["errors", "sampleRate"], 0.0, 1.0);
    clamp(map, &["ws", "perChannelPerSec"], 0.0, 100.0);
    clamp(map, &["ws", "maxFramesPerSec"], 0.0, 1000.0);
    clamp(map, &["ttl"], 60.0, 86_400.0);
    // canvas capture is not part of v1 (D-01)
    if let Some(Value::Object(c)) = map.get_mut("canvas") {
        c.insert("enabled".into(), Value::Bool(false));
    }
    v
}

fn clamp(map: &mut Map<String, Value>, path: &[&str], lo: f64, hi: f64) {
    let mut cur = map;
    for (i, key) in path.iter().enumerate() {
        if i + 1 == path.len() {
            if let Some(n) = cur.get(*key).and_then(Value::as_f64) {
                if !(lo..=hi).contains(&n) {
                    cur.insert((*key).into(), json!(n.clamp(lo, hi)));
                }
            } else if cur.contains_key(*key) {
                cur.insert((*key).into(), json!(lo.max(0.0)));
            }
            return;
        }
        match cur.get_mut(*key) {
            Some(Value::Object(m)) => cur = m,
            _ => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_and_clamps() {
        let v = effective(
            &json!({"v": 3, "replay": {"sampleRate": 7}, "ws": {"enabled": false}, "evil": 1, "canvas": {"enabled": true}}),
        );
        assert_eq!(v["v"], 3);
        assert_eq!(v["replay"]["sampleRate"], 1.0);
        assert_eq!(v["ws"]["enabled"], false);
        assert_eq!(v["ws"]["maxFramesPerSec"], 20);
        assert!(v.get("evil").is_none());
        assert_eq!(v["canvas"]["enabled"], false);
        assert_eq!(effective(&json!(null)), {
            let mut d = defaults();
            d["canvas"]["enabled"] = json!(false);
            d
        });
    }
}
