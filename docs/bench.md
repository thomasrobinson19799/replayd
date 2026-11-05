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

### SDK replay chunk — T-20
`node sdk/bench/perf/replay.mjs` (env `RATES`, `REPEAT`, `SECONDS`, `SCENARIOS`, `CATS`). The real SDK goes first in
`<head>` (IIFE `replayd.min.js`, which lazy-loads `replay.js` + `worker.js`) on the terminal mock
(`sdk/bench/pages/terminal.html?hist=60`: 2,785-node DOM, Centrifugo-like WS at 200 msg/s through the SDK's WS
wrapper, 10 Hz repaint ≈ 2,000 text mutations/s). Chromium, CDP CPU throttling, cross-origin isolated page.
Per-batch time is the sum of top-level JS entries into `replay.js` on the renderer main thread per 500 ms window
(devtools.timeline trace): MutationObserver callbacks, emit, the batch/flush tick, cuts and listeners. Windows start
1 s after the snapshot; the table shows medians of 3 runs × 20 s. Every run also decodes all uploaded segments and
checks them: seq 0 holds a full snapshot + init, the Centrifugo token is redacted, no throttled node is emitted
more often than once per N ms (min spacing 959–999 ms for N = 1000), and `n` matches.

| Date | Scenario | CPU | Batch p50 | Batch p95 | Max | Replay ms/s | Long tasks after snapshot | Uplink | Main heap Δ |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | terminal, `data-rp-throttle="1000"` (D-06) | 4× | 4.54 ms | **7.58 ms** | 7.95 ms | 9.5 | 0 | 1.52 KB/s | 1.37 MB |
| | watchlist only, 1000 | 4× | 3.67 ms | **5.33 ms** | 7.06 ms | 7.0 | 0 | 1.16 KB/s | 1.37 MB |
| | textContent swaps, 1000 | 4× | 5.95 ms | **10.09 ms** | 10.4 ms | 12.4 | 0 | 1.46 KB/s | 1.39 MB |
| | no `data-rp-throttle` (plain rrweb path) | 4× | 28.37 ms | 40.76 ms | 49.7 ms | 58.5 | 0 | 6.28 KB/s | 1.45 MB |
| | terminal, 1000 | 1× | 0.78 ms | **1.29 ms** | 1.51 ms | 1.7 | 0 | 2.48 KB/s | 1.37 MB |
| | watchlist only, 1000 | 1× | 0.66 ms | **0.97 ms** | 1.36 ms | 1.5 | 0 | 2.10 KB/s | 1.35 MB |

Budget "< 2 ms p95 per 500 ms batch at 4×": **met at 1× (desktop), not met at 4× on this mock.** The owner
accepted the measured 4× figure for the terminal mock (Decisions log D-20). It is re-checked on real terminals and
the reference phone in T-51. Where the 4× time goes (CPU profile, watchlist only): about 0.7 ms/window is the
floor of just receiving the MutationRecords (measured with a hook that drops everything without work); reading
each changed text value costs ~4.5 µs at 4× (string materialisation, `nodeValue`, measured in isolation); the
rest is the hook loop and one `postMessage` per tick. Under CDP throttling a short call that catches a throttle
slice reads ~1 ms longer, which inflates p95 over 40 windows. Optimisations kept (vs the T-01 prototype):
per-node state in a symbol property (no WeakMap/mirror lookups per record), pending nodes bucketed by stagger slot,
flush merged into the batch tick (D-19), a NodeList-free fast path for known `textContent` containers
(12.8 → 5.95 ms p50 for that scenario), and per-node last-emit times (exact "≤ 1 per N ms").

"batch p95 incl. core" (core `replayd.min.js` time added) reads 16–26 ms at 4×. It is dominated by the
throttle-slice artifact on core's WS `message` listener, which runs 200×/s as ~µs calls. The direct measurement of
that path is the T-14 gate bench: 1.64 µs/msg at 4×.

Initial snapshot (the main-thread task that evaluates `replay.js` and runs `startReplay`: worker start + rrweb
`record()` + full snapshot, page busy with WS + repaint), median of 5:

| Date | DOM | 4× | 1× | Same-session reference: T-01 spike `record()` alone, quiet page | Budget |
|---|---|---|---|---|---|
| 2026-11-03 | 2,785 nodes | 308 ms | 61 ms | 248 ms / 44 ms (recorded in T-01 on a faster VM: 121 / 30 ms) | < 150 / < 50 ms |

**Not met on this VM.** This sandbox runs the unchanged spike about 2× slower than the T-01 VM did. The SDK
task adds ~20–40% on top of bare `record()` (chunk evaluation, worker start, busy page). This is an open item for
T-51 on the reference device; the budget is unchanged. No long tasks after the snapshot in any steady-state run.

Sizes (`pnpm size`): core 6.86 KB, replay chunk 25.6 KB (≤ 45), worker 2.7 KB (≤ 4).

### Capacitor offline queue — T-26
`e2e/capacitor.e2e.mjs` (Chromium, fake Capacitor runtime with App + Device plugins, IIFE SDK against the stack;
Playwright `setOffline`). Real-device run: T-51 APK checklist.

| Date | Step | Result |
|---|---|---|
| 2026-11-03 | 20 s offline: error thrown, App `pause`, replay running | 6 segments in the worker outbox, 1 event body in the Capacitor queue (IndexedDB) |
| | online + App `resume` → issue visible in the API | 1.0 s |
| | queues after drain | 0 / 0 |
| | session | platform `capacitor-android`, app `1.42.0 (142)`, device `SM-A525F`, 8 segments, no gap |

### Source maps — T-30
`e2e/sourcemaps.e2e.mjs`: esbuild-minified TS bundle, maps uploaded with `@replayd/cli`.

| Date | Check | Result |
|---|---|---|
| 2026-11-03 | web (127.0.0.1) + APK (localhost origin, Capacitor stub) errors of release A → same issue | ✔ one issue, platforms web + capacitor-android |
| | frames | `src/order.ts:4:23`, context + 3 lines before / 1 after, culprit `src/order.ts` |
| | release B: error before upload → unsymbolicated; upload → reprocessed | ✔ frames updated, issue `symbolicated = true` (< 1 s) |

### Retention — T-33
`cargo test -p replayd-storage --test retention_db -- --ignored --nocapture` (`RETENTION_BENCH_PER_DAY`): 15 daily
partitions of sessions (+ 1 event per 5 sessions) for one project, then one `retention::run_once` to the 14-day window.

| Date | Seed | Before → after | Partitions dropped | Run |
|---|---|---|---|---|
| 2026-11-03 | 15 × 1,000 sessions | 15,000 → 14,000 (14 days) | 4 (sessions + events, 2 days) | 142 ms |
| | 15 × 10,000 sessions (PRD scale) | 150,000 → 140,000 (14 days) | 4 | 139 ms |

10× the rows, same time: the cut is partition drops (O(days)), not row deletes. Row deletes only happen for
projects whose retention is shorter than the largest one (bounded by those days).

### Remote config — T-34
`e2e/remote-config.e2e.mjs` (emulated APK; cached config aged in localStorage):

| Date | Check | Result |
|---|---|---|
| 2026-11-03 | change saved in the dashboard → served by `/ingest/:pid/config` | 4 ms (project cache reloaded on save), `v` 1 → 2 |
| | APK within the 10-min TTL | keeps cached config, no request |
| | APK after 10 min | 1 request (revalidated, `no-cache`), new `ws.maxFramesPerSec` applied |

### Adapters — T-40
`e2e/adapters.e2e.mjs`: each example app built against a fresh project, one click on Buy.

| Date | App | Result |
|---|---|---|
| 2026-11-03 | html (IIFE, data attributes) | 1 issue / 1 event, source onerror, release html-1.0.0 |
| | vue (`ReplaydVue`) | 1 / 1, source vue, component OrderPanel |
| | react (`ErrorBoundary` + `reactErrorHandler`) | 1 / 1, source react, component stack, fallback rendered |
| | nuxt (`@replayd/nuxt`) | 1 / 1, source vue, component OrderPanel, release from app_version |

Sizes (`pnpm size`): @replayd/vue 302 B, @replayd/react 436 B, @replayd/nuxt plugin 416 B (≤ 1 KB each), core IIFE 6.96 KB.

### WordPress plugin — T-41 (local)
`e2e/wordpress.e2e.mjs` (WordPress 6.8 + MySQL 8.4 in Docker, plugin configured with wp-cli, SDK served cross-origin):
tag first in `<head>` (`defer`, data-* config, no inline script) ✔, error thrown on `DOMContentLoaded` before any
interaction arrives ✔, click error arrives ✔, replay session recorded with release `wp-1.0.0` ✔. Staging fxglory.com
with WP Rocket: pending access.

### replayd vs the terminals' current Sentry setup — T-51
`node sdk/bench/perf/compare.mjs` (terminal mock `?hist=60&throttle=1000`, 200 WS msg/s, 10 Hz repaint; SDK first in
`<head>`; Sentry = `@sentry/browser` 11.10.0 with replay at sample rate 1, `browserTracingIntegration`,
`captureConsoleIntegration`, `httpClientIntegration`, `/sentry` tunnel — PRD §4.3). Main-thread SDK time = top-level
FunctionCalls into each SDK's own scripts per 500 ms window (includes core instrumentation for both); 20 s × 2 runs.

| Date | CPU | SDK | JS up front (gz) | Lazy (gz) | Batch p50 | Batch p95 | SDK ms/s | Long tasks | Uplink | Main heap Δ |
|---|---|---|---|---|---|---|---|---|---|---|
| 2026-11-03 | 4× | **replayd** | **6.96 KB** | 28.3 KB | **11.4 ms** | **17.5 ms** | **23.9** | 0 | **1.55 KB/s** | 1.37 MB |
| | 4× | Sentry | 98.5 KB | – | 60.1 ms | 90.6 ms | 123.3 | 1 | 6.83 KB/s | 2.65 MB |
| | 1× | **replayd** | 6.96 KB | 28.3 KB | **3.5 ms** | **5.7 ms** | **7.3** | 0 | **2.49 KB/s** | 1.35 MB |
| | 1× | Sentry | 98.5 KB | – | 10.2 ms | 14.6 ms | 20.5 | 0 | 7.88 KB/s | 2.55 MB |

replayd uses about 1/5 of Sentry's main-thread time at 4× and 1/3 at 1×, 1/14 of the up-front JS, and about 1/4 of
the uplink. Note that these per-window numbers include core's WS/console/fetch instrumentation (200 WS messages/s);
the replay-only figures are in the T-20 section.

### Server re-check after M3–M5 — T-51
`scripts/bench-server.sh 30s 2000 <kind>` (release build, Postgres in Docker, this VM):

| Date | Kind | Rate | p50 | p99 | p999 | Errors | RSS idle / peak |
|---|---|---|---|---|---|---|---|
| 2026-11-03 | events (pipeline + symbolication + alerts wired) | 2,000/s | 0.26 ms | **3.97 ms** | 52 ms | 0 / 60,000 | 25 / 58 MB |
| | replay | 2,000/s | 0.26 ms | **1.10 ms** | 8.7 ms | 2 of 60,000 not 202 (client timeouts) | 23 / 39 MB |

Ingest p99 < 5 ms ✔, RSS < 60 / 250 MB ✔. Events p99 rose from 0.69 ms (T-15, faster VM) to 3.97 ms on this VM;
that is within budget but close to it, so re-check on the 4 vCPU Hetzner box.

### Budget status (T-51)
| Budget | Status |
|---|---|
| Core ≤ 7 KB, replay chunk ≤ 45 KB, worker ≤ 4 KB, adapters ≤ 1 KB | ✔ 6.96 / 25.6 / 2.7 KB, 302–436 B |
| Per-batch < 2 ms p95 at 4× | ✖ 7.58 ms on the terminal mock; accepted by the owner (D-20); ✔ at 1× (1.29 ms) |
| Snapshot < 150 / < 50 ms | ✖ on this VM (308 / 61 ms); spike reference on the same VM 248 / 44 ms. Open: measure on the reference device |
| WS message < 5 µs, init < 1 ms | ✔ (T-14, T-12) |
| Long tasks after snapshot | ✔ none |
| Uplink ≤ 5 KB/s | ✔ 1.2–2.5 KB/s (canvas out of scope) |
| Server ingest p99 < 5 ms, ≥ 2k req/s, RSS | ✔ |
| Session list < 100 ms p95, player first frame < 1 s | ✔ (T-22, T-23) |
| Real-device APK checklist | ⏳ docs/apk-checklist.md, needs the device |

### Dashboard completion and UI overhaul — 2026-11-05

Windows 11, installed Chrome via Playwright, Docker Desktop local stack. Budgets are unchanged.

Bundle measurement: production `pnpm build`, then `node scripts/dashboard-size.mjs`.
Counts every emitted `_nuxt/*.js` and `*.css`, including lazy replay/rrweb and decode worker files;
each file is independently gzipped with Node's default gzip settings. This is aggregate emitted code,
not the initial route transfer. The baseline was measured before dashboard edits on the same machine.

| Build | Files | Raw bytes | Gzip bytes |
|---|---:|---:|---:|
| Before | 23 | 514,089 | 177,769 |
| After | 40 | 575,220 | 203,371 |
| Change | +17 | +61,131 | +25,602 (+14.4%) |

The increase adds account/user workflows, shared controls, settings/replay inspection and both themes.
No dashboard runtime dependency or SDK dependency was added; test tooling is development-only.

| Acceptance measurement | Result | Budget |
|---|---|---|
| Error visible in dashboard, final full-suite run | 3,936 ms | < 5,000 ms |
| 60-minute replay, 20 Mbit/s, 3 cold browser contexts | 607 / 688 / 620 ms; median 620 ms | first frame < 1,000 ms |
| Replay progressive playback and seek to minute 45 | 3/3 passed while download still active | preserve progressive playback |
| Session list, 140k local seed, 11 filter combinations | worst p95 10.0 ms; other combinations 6.5–9.1 ms | p95 < 100 ms |

Session-query p95 by case (milliseconds): default 10.0; error 8.6; APK 9.0; user 7.5;
URL no-match 8.3; combined 6.5; deposit URL 8.8; browser+release 9.1; duration 8.0;
APK+WS 8.5; last 24h 7.5. Measured with `e2e/bench-sessions.mjs` after the existing
`scripts/seed-sessions.sql` local fixture. Business fixtures are stored only in the local test database.

The final 60-minute fixture has 709 frames, 26,178 events and 4,839,438 compressed bytes.
Issue/session lists render one page of 50 rows; users are paged at 50; inspector lists stay virtualized.
Timeline markers are grouped into at most 1,200 bins. Body formatting happens only for the selected request.
The replay decoder and ingest paths retain their existing processing boundaries.

### Windows SDK requalification — 2026-11-06

The benchmark runners now use filesystem-safe URL conversion and support `PLAYWRIGHT_CHANNEL=chrome`.
`scripts/bench-local.ps1` runs the existing terminal-1000 scenario with 15 s steady state, three repetitions,
rates 1×/4×, and the tracing categories needed to measure the initial task. No runtime capture code changed.
SDK lint, all 139 tests and all size limits pass (core 6.90 KB; IIFE 6.96 KB; replay 25.57 KB; worker 2.76 KB).

| Metric (median of 3) | 1× | 4× | Interpretation |
|---|---:|---:|---|
| Initial replay task | 23.00 ms | 171.21 ms | Desktop <50 ms passes; 4× <150 ms is still not reliably met |
| Replay batch p95 | 0.79 ms | 3.26 ms | Existing D-20 exception applies; no budget was raised |
| Batch p95 including core | 1.71 ms | 8.86 ms | Reported separately, not hidden in the replay-only figure |
| Replay main-thread work | 0.99 ms/s | 4.11 ms/s | Informational |
| Upload | 2.73 KB/s | 1.57 KB/s | Both <5 KB/s |
| Heap above baseline | 1.31 MB | 1.30 MB | Informational |
| Observed long tasks after initial-task filter | 0 | 1 (172 ms) | Investigate with actual device evidence; do not mark the gate passed |

All uploaded-segment, redaction and throttling checks passed. A subsequent single diagnostic 4× run measured
147.39 ms initial task, batch p95 3.37 ms and no subsequent long tasks; this demonstrates variability, not a
replacement for the three-run result. The hard snapshot budget remains open. Android platform tools are
installed on this machine, but `adb devices -l` found no connected device on 2026-11-06. T-51 hardware,
30-minute heap/thermal and APK lifecycle acceptance cannot be certified from desktop emulation.
