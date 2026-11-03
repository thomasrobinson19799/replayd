-- T-31: issue workflow. "ignore until N more events" stores the times_seen threshold; regressed_at marks the
-- last regression (resolved issue seen again, or seen in a newer release than "resolved in next release").
ALTER TABLE issues ADD COLUMN ignore_until_count bigint;
ALTER TABLE issues ADD COLUMN regressed_at timestamptz;
