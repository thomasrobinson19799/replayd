//! Integration: project cache loads from Postgres (skipped without REPLAYD_TEST_DATABASE_URL).

use replayd_ingest::ProjectCache;

#[tokio::test]
async fn reloads_projects_from_db() {
    let Some(pool) = replayd_db::test_pool() else {
        eprintln!("skipped: REPLAYD_TEST_DATABASE_URL not set");
        return;
    };
    let c = pool.get().await.unwrap();
    let slug = format!("it-cache-{}", std::process::id());
    c.execute(
        "INSERT INTO projects (slug, name, public_key, upload_token_hash, allowed_origins, remote_config)
         VALUES ($1, 'IT', 'pk_it', '\\x00', '{https://a.example}', '{\"ws\":{\"enabled\":false}}')",
        &[&slug],
    )
    .await
    .unwrap();
    let cache = ProjectCache::default();
    cache.reload(&pool).await.unwrap();
    let p = cache.get(&slug).expect("project by slug");
    assert!(cache.get(&p.row.id.to_string()).is_some());
    assert!(p.origin_allowed(Some("https://a.example")));
    let cfg: serde_json::Value = serde_json::from_slice(&p.config_json).unwrap();
    assert_eq!(cfg["ws"]["enabled"], false);
    c.execute("DELETE FROM projects WHERE slug = $1", &[&slug])
        .await
        .unwrap();
    assert!(replayd_db::ensure_partitions(&c, 1, 7).await.unwrap() >= 0);
}
