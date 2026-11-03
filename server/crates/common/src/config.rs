//! Server configuration: optional TOML file (`REPLAYD_CONFIG`) with `REPLAYD_*` environment overrides.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct Config {
    pub listen: SocketAddr,
    pub database_url: String,
    pub db_pool_size: usize,
    pub data_dir: PathBuf,
    /// Directory with built SDK files served at `/ingest/sdk/<version>/…`.
    pub sdk_dir: PathBuf,
    /// Public URL of the dashboard (links in Telegram alerts).
    pub public_url: String,
    /// Peers whose `X-Forwarded-For` is trusted (site nginx tunnels, our own nginx).
    pub trusted_proxies: Vec<IpAddr>,
    pub ingest: IngestConfig,
    pub bootstrap_admin_email: Option<String>,
    pub bootstrap_admin_password: Option<String>,
    /// Set `Secure` on the dashboard cookie (disable only for plain-HTTP local dev).
    pub secure_cookies: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct IngestConfig {
    pub max_events_body: usize,
    pub max_replay_body: usize,
    /// Capacity of the bounded error-event queue (jobs).
    pub events_queue: usize,
    /// Token bucket per project: sustained requests/s and burst.
    pub project_rps: f64,
    pub project_burst: f64,
    /// Token bucket per client IP.
    pub ip_rps: f64,
    pub ip_burst: f64,
    /// Max tracked IP buckets (bounded memory); idle buckets are swept every minute.
    pub ip_buckets_max: usize,
    /// How often the project cache reloads from Postgres (seconds).
    pub project_refresh_secs: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: "0.0.0.0:8080".parse().unwrap(),
            database_url: "postgres://replayd:replayd@127.0.0.1:55432/replayd?sslmode=disable".into(),
            db_pool_size: 16,
            data_dir: "data".into(),
            sdk_dir: "sdk".into(),
            public_url: "http://localhost:8088".into(),
            trusted_proxies: vec!["127.0.0.1".parse().unwrap()],
            ingest: IngestConfig::default(),
            bootstrap_admin_email: None,
            bootstrap_admin_password: None,
            secure_cookies: true,
        }
    }
}

impl Default for IngestConfig {
    fn default() -> Self {
        Self {
            max_events_body: 512 * 1024,
            max_replay_body: 2 * 1024 * 1024,
            events_queue: 10_000,
            project_rps: 500.0,
            project_burst: 1_000.0,
            ip_rps: 10.0,
            ip_burst: 40.0,
            ip_buckets_max: 200_000,
            project_refresh_secs: 10,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("reading config file: {0}")]
    Io(#[from] std::io::Error),
    #[error("parsing config file: {0}")]
    Toml(#[from] toml::de::Error),
    #[error("invalid value for {0}")]
    Env(&'static str),
}

impl Config {
    /// Loads `REPLAYD_CONFIG` (if set) then applies environment overrides.
    pub fn load() -> Result<Self, ConfigError> {
        let mut cfg = match std::env::var("REPLAYD_CONFIG") {
            Ok(path) => toml::from_str(&std::fs::read_to_string(path)?)?,
            Err(_) => Config::default(),
        };
        cfg.apply_env(|k| std::env::var(k).ok())?;
        Ok(cfg)
    }

    pub fn apply_env(&mut self, get: impl Fn(&str) -> Option<String>) -> Result<(), ConfigError> {
        fn parse<T: std::str::FromStr>(v: String, k: &'static str) -> Result<T, ConfigError> {
            v.parse().map_err(|_| ConfigError::Env(k))
        }
        if let Some(v) = get("REPLAYD_LISTEN") {
            self.listen = parse(v, "REPLAYD_LISTEN")?;
        }
        if let Some(v) = get("REPLAYD_DATABASE_URL") {
            self.database_url = v;
        }
        if let Some(v) = get("REPLAYD_DB_POOL_SIZE") {
            self.db_pool_size = parse(v, "REPLAYD_DB_POOL_SIZE")?;
        }
        if let Some(v) = get("REPLAYD_DATA_DIR") {
            self.data_dir = v.into();
        }
        if let Some(v) = get("REPLAYD_SDK_DIR") {
            self.sdk_dir = v.into();
        }
        if let Some(v) = get("REPLAYD_PUBLIC_URL") {
            self.public_url = v;
        }
        if let Some(v) = get("REPLAYD_TRUSTED_PROXIES") {
            self.trusted_proxies = v
                .split(',')
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| parse(s.to_string(), "REPLAYD_TRUSTED_PROXIES"))
                .collect::<Result<_, _>>()?;
        }
        if let Some(v) = get("REPLAYD_BOOTSTRAP_ADMIN_EMAIL") {
            self.bootstrap_admin_email = Some(v);
        }
        if let Some(v) = get("REPLAYD_BOOTSTRAP_ADMIN_PASSWORD") {
            self.bootstrap_admin_password = Some(v);
        }
        if let Some(v) = get("REPLAYD_SECURE_COOKIES") {
            self.secure_cookies = parse(v, "REPLAYD_SECURE_COOKIES")?;
        }
        if let Some(v) = get("REPLAYD_IP_RPS") {
            self.ingest.ip_rps = parse(v, "REPLAYD_IP_RPS")?;
        }
        if let Some(v) = get("REPLAYD_IP_BURST") {
            self.ingest.ip_burst = parse(v, "REPLAYD_IP_BURST")?;
        }
        if let Some(v) = get("REPLAYD_PROJECT_RPS") {
            self.ingest.project_rps = parse(v, "REPLAYD_PROJECT_RPS")?;
        }
        if let Some(v) = get("REPLAYD_PROJECT_BURST") {
            self.ingest.project_burst = parse(v, "REPLAYD_PROJECT_BURST")?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn env_overrides_and_toml() {
        let mut c: Config = toml::from_str("listen = \"127.0.0.1:9000\"\n[ingest]\nip_rps = 3.0\n").unwrap();
        assert_eq!(c.listen.port(), 9000);
        assert_eq!(c.ingest.ip_rps, 3.0);
        assert_eq!(c.ingest.events_queue, 10_000);
        let env: HashMap<&str, &str> = [
            ("REPLAYD_TRUSTED_PROXIES", "10.0.0.1, 10.0.0.2"),
            ("REPLAYD_PROJECT_RPS", "50"),
        ]
        .into();
        c.apply_env(|k| env.get(k).map(|s| s.to_string())).unwrap();
        assert_eq!(c.trusted_proxies.len(), 2);
        assert_eq!(c.ingest.project_rps, 50.0);
        assert!(
            c.apply_env(|k| (k == "REPLAYD_LISTEN").then(|| "nope".into()))
                .is_err()
        );
    }
}
