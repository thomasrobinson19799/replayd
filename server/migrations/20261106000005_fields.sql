-- Owner-approved identity, client IP and custom field metadata (D-38).
ALTER TABLE sessions
  ADD COLUMN user_name text,
  ADD COLUMN client_ip inet,
  ADD COLUMN timezone text,
  ADD COLUMN local_time text,
  ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN fields_seq bigint NOT NULL DEFAULT -1,
  ADD COLUMN ip_received_ms bigint NOT NULL DEFAULT 0;
ALTER TABLE events
  ADD COLUMN user_email text,
  ADD COLUMN user_name text,
  ADD COLUMN client_ip inet;
CREATE INDEX sessions_identity_trgm_idx ON sessions USING gin
  ((coalesce(user_id,'') || ' ' || coalesce(user_email,'') || ' ' || coalesce(user_name,'') || ' ' || coalesce(host(client_ip),'') || ' ' || coalesce(app_version,'')) gin_trgm_ops);
CREATE INDEX events_identity_trgm_idx ON events USING gin
  ((coalesce(user_id,'') || ' ' || coalesce(user_email,'') || ' ' || coalesce(user_name,'') || ' ' || coalesce(host(client_ip),'') || ' ' || coalesce(app_version,'')) gin_trgm_ops);
