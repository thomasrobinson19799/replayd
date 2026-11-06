-- Session tables are partitioned and retention drops partitions. Resolve through the
-- session row on every read rather than introducing a FK that prevents partition drops.
CREATE TABLE replay_shares (
    id uuid PRIMARY KEY,
    session_id uuid NOT NULL,
    project_id int NOT NULL REFERENCES projects ON DELETE CASCADE,
    token_hash bytea UNIQUE NOT NULL CHECK (octet_length(token_hash) = 32),
    creator_id int REFERENCES users ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz
);
CREATE INDEX ON replay_shares (session_id, created_at DESC);
CREATE INDEX ON replay_shares (expires_at);
