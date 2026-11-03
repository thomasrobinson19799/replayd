-- replayd initial schema (PRD §5.9).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text,
  password_hash text NOT NULL, is_superadmin bool NOT NULL DEFAULT false,
  disabled bool NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_sessions (
  token_hash bytea PRIMARY KEY, user_id int NOT NULL REFERENCES users ON DELETE CASCADE,
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE INDEX user_sessions_user_idx ON user_sessions (user_id);

CREATE TABLE projects (
  id serial PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  public_key text NOT NULL, upload_token_hash bytea NOT NULL,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  asset_base_url text, asset_rewrite_from text[] NOT NULL DEFAULT '{https://localhost}',
  retention_days int NOT NULL DEFAULT 14 CHECK (retention_days BETWEEN 1 AND 14),
  remote_config jsonb NOT NULL DEFAULT '{}',
  telegram jsonb,
  fingerprint_rules jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE project_role AS ENUM ('admin', 'member', 'viewer');
CREATE TABLE project_members (
  project_id int REFERENCES projects ON DELETE CASCADE,
  user_id int REFERENCES users ON DELETE CASCADE,
  role project_role NOT NULL, PRIMARY KEY (project_id, user_id)
);

CREATE TABLE sessions (
  id uuid NOT NULL, project_id int NOT NULL,
  started_at timestamptz NOT NULL, last_at timestamptz NOT NULL, ended bool NOT NULL DEFAULT false,
  duration_ms int NOT NULL DEFAULT 0, entry_url text, urls text NOT NULL DEFAULT '',
  user_id text, user_email text, release text, environment text,
  platform text NOT NULL DEFAULT 'web', app_version text, device_model text, os_version text, webview_version text,
  browser text, browser_ver text, os text, vw int, vh int, lang text, tags jsonb,
  error_count int NOT NULL DEFAULT 0, warn_count int NOT NULL DEFAULT 0, click_count int NOT NULL DEFAULT 0,
  ws_disconnects int NOT NULL DEFAULT 0, segments int NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0, canvas_bytes bigint NOT NULL DEFAULT 0, has_gap bool NOT NULL DEFAULT false,
  file_day date NOT NULL,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX sessions_project_started_idx ON sessions (project_id, started_at DESC);
CREATE INDEX sessions_project_user_idx ON sessions (project_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX sessions_project_errors_idx ON sessions (project_id, started_at DESC) WHERE error_count > 0;
CREATE INDEX sessions_project_platform_idx ON sessions (project_id, platform, started_at DESC);
CREATE INDEX sessions_urls_trgm_idx ON sessions USING gin (urls gin_trgm_ops);

CREATE TABLE issues (
  id bigserial PRIMARY KEY, project_id int NOT NULL REFERENCES projects ON DELETE CASCADE, fingerprint bytea NOT NULL,
  level text NOT NULL, source text NOT NULL, type text, title text NOT NULL, culprit text,
  status text NOT NULL DEFAULT 'unresolved', resolved_at timestamptz, resolved_in_release text,
  resolved_by int REFERENCES users ON DELETE SET NULL, ignore_until timestamptz,
  first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
  first_release text, last_release text, platforms text[] NOT NULL DEFAULT '{}',
  times_seen bigint NOT NULL DEFAULT 0, users_seen int NOT NULL DEFAULT 0,
  symbolicated bool NOT NULL DEFAULT false,
  UNIQUE (project_id, fingerprint)
) WITH (autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.01);
CREATE INDEX issues_project_status_idx ON issues (project_id, status, last_seen DESC);

CREATE TABLE events (
  id uuid NOT NULL, issue_id bigint NOT NULL, project_id int NOT NULL, ts timestamptz NOT NULL,
  session_id uuid, level text, release text, environment text, platform text,
  url text, user_id text, browser text, os text, app_version text,
  payload jsonb NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX events_issue_ts_idx ON events (issue_id, ts DESC);
CREATE INDEX events_session_idx ON events (session_id);

CREATE TABLE releases (
  project_id int NOT NULL REFERENCES projects ON DELETE CASCADE, version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), last_event_at timestamptz,
  PRIMARY KEY (project_id, version)
);
CREATE TABLE alerts_sent (project_id int, issue_id bigint, kind text, sent_at timestamptz, PRIMARY KEY (issue_id, kind, sent_at));
CREATE TABLE audit_log (id bigserial PRIMARY KEY, user_id int, action text, target text, data jsonb, at timestamptz DEFAULT now());

-- Daily UTC partitions for sessions/events. Called by the server at startup and daily (§5.8).
CREATE FUNCTION replayd_ensure_partitions(p_from date, p_to date) RETURNS int
LANGUAGE plpgsql AS $$
DECLARE d date; n int := 0; s text;
BEGIN
  d := p_from;
  WHILE d <= p_to LOOP
    s := to_char(d, 'YYYYMMDD');
    IF to_regclass('sessions_' || s) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF sessions FOR VALUES FROM (%L) TO (%L)',
        'sessions_' || s, d::timestamp AT TIME ZONE 'UTC', (d + 1)::timestamp AT TIME ZONE 'UTC');
      n := n + 1;
    END IF;
    IF to_regclass('events_' || s) IS NULL THEN
      EXECUTE format('CREATE TABLE %I PARTITION OF events FOR VALUES FROM (%L) TO (%L)',
        'events_' || s, d::timestamp AT TIME ZONE 'UTC', (d + 1)::timestamp AT TIME ZONE 'UTC');
      n := n + 1;
    END IF;
    d := d + 1;
  END LOOP;
  RETURN n;
END $$;
