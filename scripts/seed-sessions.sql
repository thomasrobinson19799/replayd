-- Seeds 140,000 sessions (14 days × 10,000/day) for project slug 'seed' (T-22 benchmark).
-- psql "$PG_URL" -v ON_ERROR_STOP=1 -f scripts/seed-sessions.sql
SELECT replayd_ensure_partitions((now() AT TIME ZONE 'UTC')::date - 15, (now() AT TIME ZONE 'UTC')::date + 7);

INSERT INTO projects (slug, name, public_key, upload_token_hash, allowed_origins)
VALUES ('seed', 'Seed (bench)', 'pk_seed', '\x00', '{}') ON CONFLICT (slug) DO NOTHING;

DELETE FROM sessions WHERE project_id = (SELECT id FROM projects WHERE slug = 'seed');

INSERT INTO sessions (id, project_id, started_at, last_at, ended, duration_ms, entry_url, urls, user_id, release,
  environment, platform, app_version, device_model, os_version, browser, browser_ver, os, vw, vh, lang,
  error_count, warn_count, click_count, ws_disconnects, segments, bytes, file_day)
SELECT
  gen_random_uuid(),
  p.id,
  ts,
  ts + make_interval(secs => dur / 1000),
  true,
  dur,
  'https://terminal.fxglory.com/' || page,
  'https://terminal.fxglory.com/' || page || E'\nhttps://terminal.fxglory.com/' || (ARRAY['history','positions','deposit','profile'])[1 + (g % 4)],
  CASE WHEN g % 5 = 0 THEN NULL ELSE (10000000 + (g * 7919) % 20000)::text END,
  (ARRAY['1.41.0','1.41.1','1.42.0'])[1 + (g % 3)],
  'production',
  CASE WHEN g % 5 < 2 THEN 'capacitor-android' ELSE 'web' END,
  CASE WHEN g % 5 < 2 THEN (ARRAY['1.41.0 (141)','1.42.0 (142)'])[1 + (g % 2)] END,
  CASE WHEN g % 5 < 2 THEN (ARRAY['SM-A525F','SM-A325F','Redmi Note 11'])[1 + (g % 3)] END,
  CASE WHEN g % 5 < 2 THEN '14' END,
  (ARRAY['Chrome','Chrome','Safari','Firefox','Edge'])[1 + (g % 5)],
  '130.0',
  (ARRAY['Android 14','Windows 10','Mac OSX 14','iOS 17','Linux'])[1 + (g % 5)],
  412, 915, 'fa-IR',
  CASE WHEN g % 10 = 0 THEN 1 + (g % 4) ELSE 0 END,
  g % 3,
  g % 40,
  CASE WHEN g % 25 = 0 THEN 1 ELSE 0 END,
  1 + dur / 5000,
  20000 + (g % 900000),
  (ts AT TIME ZONE 'UTC')::date
FROM projects p,
  LATERAL generate_series(0, 139999) AS g,
  LATERAL (SELECT now() - make_interval(secs => (g::float8 / 140000) * 14 * 86400) AS ts,
                  ((g * 37) % 3600) * 1000 + 30000 AS dur,
                  (ARRAY['trade','trade','trade','markets','wallet'])[1 + (g % 5)] AS page) x
WHERE p.slug = 'seed';

ANALYZE sessions;
SELECT count(*) AS seeded FROM sessions WHERE project_id = (SELECT id FROM projects WHERE slug = 'seed');
