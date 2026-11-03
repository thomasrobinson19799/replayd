-- Runs once on first start of the dedicated replayd Postgres container (PRD §5.9).
ALTER ROLE replayd SET synchronous_commit = off;
