//! In-memory project cache for the ingest hot path (refreshed from Postgres, invalidated by the API).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use parking_lot::RwLock;
use replayd_common::remote_config;
use replayd_db::{Pool, ProjectRow};

#[derive(Debug)]
pub struct Project {
    pub row: ProjectRow,
    /// Lower-cased, trailing-slash-free origins. Empty = any origin allowed.
    pub origins: Vec<String>,
    /// Effective remote config JSON and its ETag.
    pub config_json: Bytes,
    pub config_etag: String,
    pub disabled: bool,
}

impl Project {
    pub fn new(row: ProjectRow) -> Self {
        let eff = remote_config::effective(&row.remote_config);
        let disabled = eff["disabled"].as_bool().unwrap_or(false);
        let json = serde_json::to_vec(&eff).unwrap_or_default();
        let etag = format!("\"{:016x}\"", fnv1a(&json));
        let origins = row
            .allowed_origins
            .iter()
            .map(|o| o.trim().trim_end_matches('/').to_ascii_lowercase())
            .filter(|o| !o.is_empty())
            .collect();
        Self {
            origins,
            config_json: Bytes::from(json),
            config_etag: etag,
            disabled,
            row,
        }
    }

    /// Origin check (§5.2). Returns false for a present but not allowed origin.
    pub fn origin_allowed(&self, origin: Option<&str>) -> bool {
        if self.origins.is_empty() {
            return true;
        }
        match origin {
            Some(o) => {
                let o = o.trim_end_matches('/');
                self.origins.iter().any(|a| a.eq_ignore_ascii_case(o))
            }
            None => false,
        }
    }
}

fn fnv1a(b: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for x in b {
        h ^= *x as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[derive(Default)]
pub struct ProjectCache {
    pub ignores: crate::ignore::IgnoreCache,
    /// Keyed by numeric id (as text) and by slug.
    map: RwLock<Arc<HashMap<String, Arc<Project>>>>,
}

impl ProjectCache {
    pub fn get(&self, key: &str) -> Option<Arc<Project>> {
        self.map.read().get(key).cloned()
    }

    pub fn replace(&self, rows: Vec<ProjectRow>) {
        let mut m = HashMap::with_capacity(rows.len() * 2);
        for r in rows {
            let p = Arc::new(Project::new(r));
            m.insert(p.row.id.to_string(), p.clone());
            m.insert(p.row.slug.clone(), p);
        }
        *self.map.write() = Arc::new(m);
    }

    pub fn all(&self) -> Vec<Arc<Project>> {
        let m = self.map.read().clone();
        let mut v: Vec<_> = m
            .values()
            .filter(|p| m.get(&p.row.slug).is_some())
            .cloned()
            .collect();
        v.sort_by_key(|p| p.row.id);
        v.dedup_by_key(|p| p.row.id);
        v
    }

    pub async fn reload(&self, pool: &Pool) -> Result<usize, replayd_db::DbError> {
        self.ignores.reload(pool).await?;
        let c = pool.get().await?;
        let rows = replayd_db::load_projects(&c).await?;
        let n = rows.len();
        self.replace(rows);
        Ok(n)
    }

    /// Background refresh loop.
    pub fn spawn_refresh(self: &Arc<Self>, pool: Pool, every: Duration) {
        let me = self.clone();
        tokio::spawn(async move {
            let mut t = tokio::time::interval(every);
            t.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                t.tick().await;
                if let Err(e) = me.reload(&pool).await {
                    tracing::warn!(error = %e, "project cache refresh failed");
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    pub(crate) fn row(id: i32, slug: &str, origins: &[&str]) -> ProjectRow {
        ProjectRow {
            id,
            slug: slug.into(),
            name: slug.into(),
            public_key: format!("pk_{slug}"),
            allowed_origins: origins.iter().map(|s| s.to_string()).collect(),
            remote_config: json!({}),
            retention_days: 14,
            fingerprint_rules: json!([]),
            telegram: None,
            asset_base_url: None,
            asset_rewrite_from: vec![],
        }
    }

    #[test]
    fn lookup_by_id_and_slug_and_origins() {
        let c = ProjectCache::default();
        c.replace(vec![row(
            1,
            "fxglory-terminal",
            &["https://terminal.fxglory.com/", "https://localhost"],
        )]);
        let p = c.get("1").unwrap();
        assert_eq!(c.get("fxglory-terminal").unwrap().row.id, 1);
        assert!(p.origin_allowed(Some("https://Terminal.fxglory.com")));
        assert!(p.origin_allowed(Some("https://localhost")));
        assert!(!p.origin_allowed(Some("https://evil.com")));
        assert!(!p.origin_allowed(None));
        assert_eq!(c.all().len(), 1);
        c.replace(vec![row(2, "open", &[])]);
        assert!(c.get("1").is_none());
        assert!(c.get("open").unwrap().origin_allowed(None));
    }
}
