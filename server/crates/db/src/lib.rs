//! replayd-db: Postgres pool, project loading, partitions, COPY batches.

use std::str::FromStr;

use deadpool_postgres::{Manager, ManagerConfig, RecyclingMethod, Runtime};
pub use deadpool_postgres::{Object as Conn, Pool};
pub use tokio_postgres;
use tokio_postgres::NoTls;

pub mod copy;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error(transparent)]
    Pg(#[from] tokio_postgres::Error),
    #[error(transparent)]
    Pool(#[from] deadpool_postgres::PoolError),
    #[error("pool build: {0}")]
    Build(String),
}

/// Builds the connection pool. The app role uses `synchronous_commit = off` (set on the role, §5.9).
pub fn pool(database_url: &str, size: usize) -> Result<Pool, DbError> {
    let cfg = tokio_postgres::Config::from_str(database_url)?;
    let mgr = Manager::from_config(
        cfg,
        NoTls,
        ManagerConfig {
            recycling_method: RecyclingMethod::Fast,
        },
    );
    Pool::builder(mgr)
        .max_size(size)
        .runtime(Runtime::Tokio1)
        .build()
        .map_err(|e| DbError::Build(e.to_string()))
}

/// Project fields needed on the hot ingest path and by the pipeline.
#[derive(Debug, Clone)]
pub struct ProjectRow {
    pub id: i32,
    pub slug: String,
    pub name: String,
    pub public_key: String,
    pub allowed_origins: Vec<String>,
    pub remote_config: serde_json::Value,
    pub retention_days: i32,
    pub fingerprint_rules: serde_json::Value,
    pub telegram: Option<serde_json::Value>,
    pub asset_base_url: Option<String>,
    pub asset_rewrite_from: Vec<String>,
}

pub const PROJECT_COLUMNS: &str = "id, slug, name, public_key, allowed_origins, remote_config, retention_days, \
     fingerprint_rules, telegram, asset_base_url, asset_rewrite_from";

impl ProjectRow {
    pub fn from_row(r: &tokio_postgres::Row) -> Self {
        Self {
            id: r.get(0),
            slug: r.get(1),
            name: r.get(2),
            public_key: r.get(3),
            allowed_origins: r.get(4),
            remote_config: r.get(5),
            retention_days: r.get(6),
            fingerprint_rules: r.get(7),
            telegram: r.get(8),
            asset_base_url: r.get(9),
            asset_rewrite_from: r.get(10),
        }
    }
}

pub async fn load_projects(c: &tokio_postgres::Client) -> Result<Vec<ProjectRow>, DbError> {
    let rows = c
        .query(
            &format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY id"),
            &[],
        )
        .await?;
    Ok(rows.iter().map(ProjectRow::from_row).collect())
}

/// Ensures daily UTC partitions for `sessions`/`events` exist from `days_back` days ago to `days_ahead`
/// days ahead (§5.8: pre-created 7 days ahead). Returns the number of partitions created.
pub async fn ensure_partitions(
    c: &tokio_postgres::Client,
    days_back: i32,
    days_ahead: i32,
) -> Result<i32, DbError> {
    let row = c
        .query_one(
            "SELECT replayd_ensure_partitions((now() AT TIME ZONE 'UTC')::date - $1::int, \
             (now() AT TIME ZONE 'UTC')::date + $2::int)",
            &[&days_back, &days_ahead],
        )
        .await?;
    Ok(row.get(0))
}

/// Test helper: pool from `REPLAYD_TEST_DATABASE_URL`, or `None` (tests are skipped) when unset.
pub fn test_pool() -> Option<Pool> {
    let url = std::env::var("REPLAYD_TEST_DATABASE_URL").ok()?;
    Some(pool(&url, 8).expect("test pool"))
}
