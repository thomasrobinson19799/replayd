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

### Core SDK — T-12…T-14 (2026-11-03)
| Metric | Measured | Budget | How |
|---|---|---|---|
| `@replayd/core` ESM / IIFE, min+gz | 6.81 kB / 6.81 kB | ≤ 7 KB | `pnpm size` |
| `init()` cold, 1× | median 0.94 ms (p90 1.14 ms) | < 1 ms | `pnpm --filter @replayd/bench run bench:init` (fresh page per sample) |
| `init()` cold, 4× | median 4.3 ms | – | same |
| Per unsampled WS message, 4× | median 1.64 µs (runs 1.25–2.75 µs) | < 5 µs | `bench:ws`, 200k × 300-char frames, 5 runs |
| Per unsampled WS message, 1× | 0.15 µs | – | same |

`init()` sits only just under budget on this noisy VM (see D-11). It will be re-measured in T-51.

## End-to-end
| Date | Test | Result |
|---|---|---|
| 2026-11-03 | `e2e/issues.e2e.mjs`: error thrown in test app → row visible in an open dashboard issues list | 3.89 s / 3.92 s / 3.89 s (budget 5 s) |
| 2026-11-03 | `e2e/player.e2e.mjs`: 60-min session, navigation → first replayed frame (`__rpFirstFrameMs`), 20 Mbit/s | 506 / 542 / 552 ms (budget 1 s) ✔ |
| 2026-11-03 | same, 5 Mbit/s | 718 / 718 / 706 ms ✔ |

### Replay player — T-23
Fixture: `e2e/gen-replay.mjs` records the terminal mock (`sdk/bench/pages/terminal.html?hist=60`: live 200 msg/s WS,
10 Hz repaint, scripted mouse/scroll/typing) with rrweb and the PRD §4.6 options for 30 s, coalesces text mutations to
1 per node per 1000 ms (the byte effect of `data-rp-throttle="1000"`), and repeats the incremental events with
shifted timestamps up to 60 min, with a Meta + FullSnapshot checkout every 10 min plus SDK custom events (network
every 10 s, console every 15 s, warning every 2 min, error every 10 min, nav every 5 min, WS frames and closes). It
cuts 5 s segments, gzips them and writes `.rpl` frames with `encodeSegment`/`splitSegment` from `@replayd/core/wire`.
`INSTALL=1` copies the file into the stack and inserts the sessions row.

| Fixture | Value |
|---|---|
| Duration / frames / events | 60 min / 704 frames / 25,998 events |
| `.rpl` size | 4.69 MB (1.27 KB/s; raw JSON 28.4 MB) |
| First frame (Meta + FullSnapshot of a 2.8k-node DOM) | 24.2 KB |

`e2e/player.e2e.mjs` (Chromium, CDP network throttling incl. 20 ms latency; time from navigation start, so it
includes SPA boot, `/api/me`, the session API call, the decode worker and the rrweb rebuild). 3 runs each:

| Link | First frame | Bytes downloaded at first frame | Full download | Playing while downloading | Seek to 45:00 |
|---|---|---|---|---|---|
| 20 Mbit/s | 506 / 542 / 552 ms | 82–115 KB of 4.69 MB | 3.0–3.6 s | yes (playhead +0.7 s in 0.7 s) | renders ✔ |
| 5 Mbit/s | 718 / 718 / 706 ms | 37–43 KB | 8.1 s | yes | renders ✔ |

Fixes found by this test: the first run at 5 Mbit/s took 1,179 ms. nginx served the 212 KB player chunk
uncompressed, and the recording download only started after the session API call returned. Now Nuxt precompresses
assets (`compressPublicAssets`, nginx `gzip_static`), API JSON is gzipped on the fly (`.rpl` is not: its frames are
already gzip), and the decode worker starts the download in parallel with the session API call. Asset-rewrite
settings come in a second message, and decoding waits for it.

### Session list query — T-22
`psql -f scripts/seed-sessions.sql` (140,000 sessions = 14 days × 10,000/day; 40% APK, 10% with errors,
20k users), then `E2E_BASE=… node e2e/bench-sessions.mjs`: p95 of 40 requests per filter combination, measured
end to end over HTTP (auth, SQL, JSON, 50 rows/page).

| Date | Filter | p50 | p95 |
|---|---|---|---|
| 2026-11-03 | default (14 days) | 5.5 ms | 7.4 ms |
| | has_error | 5.4 ms | 6.7 ms |
| | platform = APK | 4.9 ms | 6.3 ms |
| | user id (7 sessions) | 4.6 ms | 5.7 ms |
| | URL contains `/deposit` | 5.1 ms | 6.3 ms |
| | release + browser | 4.5 ms | 5.2 ms |
| | min duration 30 min | 4.7 ms | 6.9 ms |
| | ws disconnect + APK | 4.9 ms | 6.0 ms |
| | last 24 h | 3.4 ms | 3.8 ms |
| | **URL contains, no match (worst case)** | 62.4 ms | **77.1 ms** |

Budget: < 100 ms p95 ✔. The worst case is a "URL contains" search that matches nothing, so every daily partition
is scanned. The trigram GIN index doesn't help: no-match lookups cost ~5 ms per 10k-row partition, because common
trigrams such as `pag`/`age` occur in every row, and the planner picks a parallel seq scan, which is slightly
faster. Every other filter stops after 50 rows on the `(project_id, started_at DESC)` index.
