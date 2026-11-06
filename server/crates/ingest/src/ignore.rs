//! Cached server-side issue suppression; replay ingest never consults these rules.
use parking_lot::RwLock;
use regex::Regex;
use replayd_db::Pool;
use std::{
    collections::HashMap,
    sync::{
        Arc,
        atomic::{AtomicI64, AtomicU64, Ordering},
    },
};

pub fn compile(kind: &str, mode: &str, pattern: &str) -> Result<Regex, &'static str> {
    if !["error", "console", "network"].contains(&kind) || pattern.trim().is_empty() || pattern.len() > 1024 {
        return Err("Invalid kind or pattern (1–1024 bytes required)");
    }
    let pattern = match mode {
        "contains" => format!("(?i){}", regex::escape(pattern)),
        "regex" => pattern.to_string(),
        _ => return Err("Invalid match type"),
    };
    regex::RegexBuilder::new(&pattern)
        .size_limit(256 * 1024)
        .build()
        .map_err(|_| "Invalid or overly complex regex")
}
struct Rule {
    id: i64,
    kind: String,
    pattern: String,
    mode: String,
    regex: Regex,
    count: Arc<AtomicU64>,
    last: Arc<AtomicI64>,
}
#[derive(Default)]
pub struct IgnoreCache {
    rules: RwLock<HashMap<i32, Vec<Arc<Rule>>>>,
    refresh: tokio::sync::Mutex<()>,
}
impl IgnoreCache {
    pub fn matches(&self, pid: i32, source: &str, message: &str, url: &str, ms: i64) -> bool {
        let kind = match source {
            "console" => "console",
            "http" | "ws" => "network",
            "onerror" | "unhandledrejection" | "vue" | "react" | "manual" => "error",
            _ => return false,
        };
        let rules = self.rules.read();
        let Some(rules) = rules.get(&pid) else {
            return false;
        };
        let text = if kind == "network" { url } else { message };
        let mut matched = false;
        for r in rules {
            if r.kind == kind && r.regex.is_match(text) {
                r.count.fetch_add(1, Ordering::Relaxed);
                r.last.fetch_max(ms, Ordering::Relaxed);
                matched = true;
            }
        }
        matched
    }
    pub async fn reload(&self, pool: &Pool) -> Result<(), replayd_db::DbError> {
        let _guard = self.refresh.lock().await;
        let c = pool.get().await?;
        let old: HashMap<i64, Arc<Rule>> = self
            .rules
            .read()
            .values()
            .flatten()
            .map(|r| (r.id, r.clone()))
            .collect();
        // At most 50 counters per project, no queue and no per-event database access.
        for r in old.values() {
            let n = r.count.swap(0, Ordering::Relaxed).min(i64::MAX as u64) as i64;
            if n == 0 {
                continue;
            }
            let ms = r.last.load(Ordering::Relaxed) as f64;
            if let Err(e)=c.execute("UPDATE ignore_rules SET dropped_count=dropped_count+$2, last_matched_at=GREATEST(last_matched_at,to_timestamp($3::float8/1000)) WHERE id=$1",&[&r.id,&n,&ms]).await {
                r.count.fetch_add(n as u64,Ordering::Relaxed); return Err(e.into());
            }
        }
        let rows = c
            .query(
                "SELECT id,project_id,kind,match_type,pattern FROM ignore_rules ORDER BY project_id,id",
                &[],
            )
            .await?;
        let mut next: HashMap<i32, Vec<Arc<Rule>>> = HashMap::new();
        for row in rows {
            let id: i64 = row.get(0);
            let pid: i32 = row.get(1);
            let kind: String = row.get(2);
            let mode: String = row.get(3);
            let pattern: String = row.get(4);
            let list = next.entry(pid).or_default();
            if list.len() >= 50 {
                continue;
            }
            let rule = old
                .get(&id)
                .filter(|r| r.kind == kind && r.mode == mode && r.pattern == pattern)
                .cloned();
            if let Some(r) = rule {
                list.push(r)
            } else if let Ok(regex) = compile(&kind, &mode, &pattern) {
                list.push(Arc::new(Rule {
                    id,
                    kind,
                    mode,
                    pattern,
                    regex,
                    count: old.get(&id).map(|r| r.count.clone()).unwrap_or_default(),
                    last: old.get(&id).map(|r| r.last.clone()).unwrap_or_default(),
                }));
            }
        }
        *self.rules.write() = next;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn matching_modes_and_sources() {
        let c = IgnoreCache::default();
        for (i, kind) in ["error", "console", "network"].iter().enumerate() {
            c.rules.write().entry(1).or_default().push(Arc::new(Rule {
                id: i as i64,
                kind: kind.to_string(),
                mode: "contains".into(),
                pattern: "Test".into(),
                regex: compile(kind, "contains", "Test").unwrap(),
                count: Arc::new(AtomicU64::new(0)),
                last: Arc::new(AtomicI64::new(0)),
            }));
        }
        for source in [
            "onerror",
            "unhandledrejection",
            "vue",
            "react",
            "manual",
            "console",
        ] {
            assert!(c.matches(1, source, "tEsT", "", 100));
        }
        assert!(c.matches(1, "ws", "unrelated", "wss://test/x", 100));
        assert!(c.matches(1, "http", "unrelated", "https://test/x", 100));
        assert!(!c.matches(1, "ws", "test", "wss://other", 100));
        assert!(!c.matches(2, "manual", "test", "", 100));
        assert!(compile("error", "regex", "[").is_err());
        assert!(
            compile("error", "regex", "^TypeError")
                .unwrap()
                .is_match("TypeError: bad")
        );
    }

    #[test]
    fn fifty_rule_matching_measurement() {
        let c = IgnoreCache::default();
        for i in 0..50 {
            let pattern = format!("noise-{i}-end");
            c.rules.write().entry(1).or_default().push(Arc::new(Rule {
                id: i,
                kind: "error".into(),
                mode: "contains".into(),
                regex: compile("error", "contains", &pattern).unwrap(),
                pattern,
                count: Arc::new(AtomicU64::new(0)),
                last: Arc::new(AtomicI64::new(0)),
            }));
        }
        let start = std::time::Instant::now();
        for _ in 0..10_000 {
            assert!(!c.matches(
                1,
                "manual",
                std::hint::black_box("TypeError: cannot read a property"),
                "",
                100
            ));
        }
        eprintln!(
            "ignore benchmark: 50 cached rules, 10000 events, {} microseconds",
            start.elapsed().as_micros()
        );
    }
}
