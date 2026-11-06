CREATE TABLE ignore_rules (
    id bigserial PRIMARY KEY,
    project_id int NOT NULL REFERENCES projects ON DELETE CASCADE,
    kind text NOT NULL CHECK (kind IN ('error','console','network')),
    match_type text NOT NULL CHECK (match_type IN ('contains','regex')),
    pattern text NOT NULL CHECK (length(pattern) BETWEEN 1 AND 1024),
    dropped_count bigint NOT NULL DEFAULT 0,
    last_matched_at timestamptz
);
CREATE INDEX ON ignore_rules (project_id, id);
