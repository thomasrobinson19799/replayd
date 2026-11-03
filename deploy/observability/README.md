# replayd observability (PRD §7)

- `grafana-dashboard.json`: import in Grafana (Dashboards → Import, pick your Prometheus data source). It covers
  ingest rate/latency/status, queue depth and rejections, disk, per-project volume, top projects by bytes, sessions,
  error events, new issues and regressions, symbolication failures, Telegram, Postgres batch time, writer fsync and
  open files, SDK internal errors and API latency. `$project` filter.
- `alerts.yml`: Prometheus rules for your Alertmanager → Telegram: disk > 75 %, queue rejections for 5 min, ingest
  p99 > 20 ms, project silent for 30 min (SDK broken after a deploy), Postgres batch errors, replayd down.
- `prometheus.yml`: example scrape job. Scrape `replayd:8080/metrics` on the internal network; nginx answers 404 for
  `/metrics`.
- Logs: JSON on stdout (`timestamp, level, message, target`, plus `project`, `req_id`, `latency_ms`, … per event);
  Loki labels `app=replayd, level` only. Tokens, keys and payloads are never logged.

Check: `node e2e/observability.e2e.mjs` (promtool, live scrape, every dashboard query against Prometheus, import
into Grafana 12.1).
