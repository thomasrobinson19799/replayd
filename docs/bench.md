# Benchmarks

All numbers are measured, never estimated. Environment unless stated otherwise: 4 vCPU / 16 GB cloud VM (shared,
noisy), Linux 6.18, Rust 1.97 release build (`lto = "thin"`, mimalloc), Postgres 17 in Docker, Chromium via
Playwright 1.63. The load generator runs **on the same 4 vCPUs** as the server, so server numbers are pessimistic
compared with the PRD's dedicated 4 vCPU Hetzner box.

How to reproduce: `make bench` (SDK perf suite + `scripts/bench-server.sh`), or the individual scripts referenced
per section.

## Server (PRD §2.2)

### Ingest latency and throughput — T-15
`scripts/bench-server.sh <duration> <rate> <kind>` — `oha` at a fixed request rate, 64 connections, realistic
bodies (events: gzip batch of 3 error events with 10 breadcrumbs each, 1 KB), `Origin` set, full validation
chain active (key, origin allowlist, token buckets, gzip check, bounded queue).

| Date | Endpoint | Rate | Duration | Requests | Status | p50 | p95 | p99 | p99.9 | Max | RSS idle → peak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | `POST /ingest/:pid/events` | 2,000/s | 60 s | 120,000 | 100% 202 | 0.20 ms | 0.38 ms | **0.69 ms** | 3.29 ms | 31.5 ms | 13.3 → 19.3 MB |
| 2026-11-03 | `GET /ingest/:pid/config` | 2,000/s | 20 s | 40,000 | 100% 200 | 0.20 ms | 0.39 ms | **0.88 ms** | 4.24 ms | 8.1 ms | 13.3 → 19.3 MB |
| 2026-11-03 | `POST /ingest/:pid/events` (headroom) | 10,000/s | 20 s | 199,990 | 100% 202 | 0.21 ms | 0.45 ms | **0.92 ms** | 5.30 ms | 75.7 ms | 15.2 → 19.2 MB |

Budgets: ingest p99 < 5 ms ✔, ≥ 2,000 req/s sustained ✔, RSS idle < 60 MB ✔ / load < 250 MB ✔.
Note: at this stage the events queue consumer only drains (pipeline lands in T-16); the 10-minute 2k req/s run
with the full pipeline and replay writers is part of T-21/T-51.

## SDK (PRD §2.1)

Spike numbers for rrweb on the terminal mock are in [spikes/T-01.md](spikes/T-01.md). The full comparison
(no SDK vs replayd vs current Sentry config) is produced by T-20/T-51.
