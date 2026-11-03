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

| 2026-11-03 | `POST /ingest/:pid/events` **+ full error pipeline (T-16)** | 2,000/s | 60 s | 120,001 | 100% 202 | 0.22 ms | 0.68 ms | **2.21 ms** | 5.05 ms | 36.4 ms | 20.1 → 65.1 MB |

The first three rows were measured with the events queue only drained (T-15). The last row has the real pipeline
behind ingest: 6,000 events/s parsed, grouped, upserted into `issues` and COPY'd into `events` by 3 workers, with
Postgres, the server and `oha` all sharing the same 4 vCPUs. Every accepted event was stored. A later 30 s run
after the graceful-drain fix counted rows: 179,997 events stored for 59,998 accepted requests, so zero loss.

Budgets: ingest p99 < 5 ms ✔, ≥ 2,000 req/s sustained ✔, RSS idle < 60 MB ✔ / load < 250 MB ✔.
The 10-minute 2k req/s run with replay writers included is part of T-51.

### Replay ingest — T-21
`node scripts/replay-load.mjs` sends valid segments (PRD §4.10 wire format, ~12.7 KB gzip each) for N concurrent
sessions with increasing `seq`. Latency is measured **client-side** (Node `http`, keep-alive), so it includes the
client's own overhead.

| Date | Rate | Duration | Sessions | Requests | Status | p50 | p95 | p99 | Max | Disk written | RSS peak |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | 2,000/s | 30 s | 2,000 | 60,008 | 100% 202 (0 × 503) | 0.74 ms | 1.59 ms | **3.01 ms** | 25.6 ms | 743 MB (~25 MB/s) | 63 MB |

The session aggregator recorded every segment in `sessions.segments`.

### Crash test — T-21
`scripts/crash-test.sh 300 8`: 300 segments/s across 300 sessions, `kill -9` after 8 s, then every `.rpl` is
indexed and compared with the client's ack log.

| Date | Acked | Lost | Oldest lost ack before kill | Unreadable files | Corrupt bodies | Result |
|---|---|---|---|---|---|---|
| 2026-11-03 | 2,371 | 2 | 3 ms | 0 / 300 | 0 | **PASS** (budget: nothing acked > 1 s before the crash lost) |

Note: data handed to the kernel survives a process `kill -9` (page cache). The group `fdatasync` every 1 s bounds
the loss on power failure. The only process-crash exposure is segments still queued in a shard channel, and
those are milliseconds old.

## SDK (PRD §2.1)

Spike numbers for rrweb on the terminal mock are in [spikes/T-01.md](spikes/T-01.md). The full comparison
(no SDK vs replayd vs current Sentry config) is produced by T-20/T-51.
