# PROGRESS — replayd

Resume protocol: read PRD.md (incl. Decisions log), AGENTS.md, this file and `git log --oneline`; continue from the first task not marked `done`.
Status values: `todo` · `wip` · `done` · `blocked` · `skipped`.

## M0 — Risks retired, skeleton green
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-01 | Spike: rrweb record cost on terminal mock | done | docs/spikes/T-01.md. rrweb 2.2.0 ≈23 KB gz. throttle → mutation-prefilter hook (D-04), rrweb taint fix (D-05). **Open risk:** per-batch p95 ≈5 ms at 4× on mock (budget 2 ms) → T-20 must close. |
| T-02 | Spike: TradingView v27 canvas capture | skipped | Out of scope v1 (D-01) |
| T-03 | Spike: CapacitorHttp + fetch/XHR patch | done | docs/spikes/T-03.md. Real Capacitor 8.6.0 bridge emulated in Chromium. Bridge clobbers XHR prototype per construction → constructor wrapper (D-07); transport uses CapacitorWebFetch. Real-device check stays in T-26/T-51. |
| T-04 | Spike: WP Rocket exclusion | done | docs/spikes/T-04.md. WP Rocket v3.24 real DelayJS PHP + runtime: SDK runs at 18 ms with rocket_delay_js_exclusions '/_rp/sdk/' (D-08). Staging fxglory.com check is part of T-41 (needs access). |
| T-10 | Monorepo scaffold, CI, size-limit, Atlas, compose | done | server/ cargo workspace (7 crates + bin), sdk/ pnpm workspace (core/vue/nuxt/react/vite-plugin/cli + bench), dashboard/ Nuxt 4 SPA, Atlas migration 0001 (+ daily partition fn), deploy/ compose (pg17, atlas 1.3.6, replayd, nginx), Makefile dev/test/bench/up, .gitlab-ci.yml + GH Actions. `make test` and `make up` green. |
| T-11 | Wire format + `.rpl` format (Rust) + TS encoder | done | Rust `common::{wire,rpl,ids}` (zero-copy parse, gzip magic check, no decompression; .rpl index tolerates truncated tail, dedups by seq). TS `@replayd/core/wire` encoder + .rpl reader. Fixtures in /fixtures/wire: TS→Rust segment.bin, Rust→TS session.rpl, byte-exact both ways. |

## M1 — Errors from terminals grouped in dashboard
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-12 | Core SDK: init, session manager, transport, retry, ring buffer | done | init (cold 0.94 ms at 1×), UUIDv7 sessions (rollover idle/duration/storage), transport with bounded queue + retry/Retry-After/403/413/kill switch, keepalive < 60 KB, 100-entry ring buffer, remote config cache + merge. Core was 3.42 KB after T-12 (≤ 4 KB). |
| T-13 | Core SDK: errors, flood control, redaction | done | onerror/rejection/console/fetch/XHR (D-07 Capacitor path verified against real bridge), network capture with allowlist + caps, history/click breadcrumbs, flood control, recursive redaction (D-12), beforeSend/ignoreErrors/denyUrls/sampleRate. |
| T-14 | Core SDK: WebSocket + EventSource patch, gate, outgoing capture | done | WS constructor wrapper (instanceof/statics preserved, non-matching sockets untouched), timestamp gate 1.64 µs/msg median at 4× (budget 5 µs), outgoing capture redacted lazily (worker in T-20), abnormal-close warnings rate-limited, EventSource lifecycle. Core 6.81 KB gz (≤ 7 KB), 100 tests. |
| T-15 | Server: ingest events + remote config + project cache + rate limits | done | ingest crate: events/config/replay(stub 501 until T-21)/sdk files; key → origin → per-project + per-IP token buckets (bounded, swept) → size cap → gzip/JSON check → bounded try_send (503 Retry-After 5); kill switch header; CORS w/o preflight. Load test: 2k req/s p99 0.69 ms, 10k req/s p99 0.92 ms, RSS ≤ 19 MB (docs/bench.md). |
| T-16 | Server: stack parsing, URL normalization, fingerprint, issues upsert, COPY | done | pipeline crate: V8/SpiderMonkey/JSC stack parser, `~/path` normalization + in-app rules (TradingView/vendor not in-app), build-hash stripping, message normalization (numbers, MT logins, UUID, hex, quotes, symbols + project regex rules), error/HTTP/WS fingerprints, 3 workers, issue upsert (sorted, no deadlocks), approx users_seen, temp-table COPY + ON CONFLICT DO NOTHING, in-memory event-id dedupe, gzip-bomb cap, graceful SIGTERM drain. Load: 2k req/s (6k events/s to PG) p99 2.21 ms, zero loss. |
| T-17 | Server: auth, users, projects, members, RBAC | done | api crate: argon2id login (rate-limited per IP + per account, constant work for unknown users), 256-bit session tokens stored as SHA-256, HttpOnly/Secure/SameSite=Lax cookie + double-submit CSRF, /api/me, users CRUD (superadmin), projects CRUD + key rotation (upload token shown once, stored hashed), members, Telegram token masked, audit log, in-memory membership cache, bootstrap superadmin. Issue read endpoints for T-18. RBAC matrix tests: unit (§5.10 table) + HTTP integration (5 roles × 9 endpoints). |
| T-18 | Dashboard: login, projects, issues list/detail | done | Dashboard: login, session store + auth middleware, projects (create shows DSN + one-time upload token), issues list (filters in URL, sort, paging, 2 s polling), issue detail (stack with in-app toggle + context lines, breadcrumbs, tags, platform split, event navigation, replay deep link). e2e/issues.e2e.mjs: error visible in 3.9 s (×3 runs, budget 5 s). Test app = core IIFE page; re-run against examples/nuxt in T-40. |

## M2 — Full replays with console/network
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-20 | SDK replay chunk: lazy load, rrweb, worker, segments, page-hide flush | done | Pinned + patched @rrweb/record (D-04/D-05/D-17), throttle coalescing + 10k guard, worker (redact, Centrifugo per-channel sampling, gzip, wire, retry/5 MB cap/gaps, D-18), cuts 5 s/256 KB/hide/error, rollover, ring drain. Sizes core 6.86 / replay 25.6 / worker 2.7 KB. Perf (docs/bench.md): batch p95 1.29 ms at 1×, 7.58 ms at 4× on the terminal mock (owner accepted the measured 4× figure, D-20); snapshot 308 ms at 4× / 61 ms at 1× on this VM (2× slower than the T-01 VM; open item for T-51). |
| T-21 | Server: replay ingest, shard writers, fsync, dedup, aggregator | done | storage crate: replay ingest sink (meta parse only, never decompresses), sharded writer threads with bounded queues (503 when full), O_APPEND + writev, LRU 2k fds / 60 s idle close, group fdatasync 1 s, seq-bitset dedup, file day from UUIDv7 sid; session aggregator (delta upserts every 3 s via COPY staging, ended after 15 min, UA parsed once). Crash test PASS (2/2371 lost, acked 3 ms before kill). 2k segments/s p99 3.0 ms, RSS 63 MB. |
| T-22 | Dashboard: sessions list + filters | done | API: GET /api/projects/:pid/sessions (all §5.11 filters, 14-day partition window, keyset 50/page), GET /api/sessions/:sid (meta + error events), GET /api/sessions/:sid/recording (Range, ETag). Dashboard sessions page (filters in URL, load more). 140k seed: worst p95 77 ms (URL no-match), typical 4–7 ms. |
| T-23 | Dashboard: player, decode worker, timeline, tabs | done | Streaming .rpl parser + decode worker (download starts in parallel with the session API, gunzip per frame, seq dedup), rrweb Replayer with progressive addEvent, timeline markers, virtualized console/network/errors/breadcrumbs/device tabs, deep link `?t=`. `e2e/gen-replay.mjs` (60-min terminal session, 4.69 MB) + `e2e/player.e2e.mjs`: first frame 542 ms median at 20 Mbit/s, 718 ms at 5 Mbit/s (budget 1 s), plays while downloading, seek to 45:00 ok. nginx: gzip_static + gzip for JSON. |

## M3 — WebSocket, APK, source maps
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-24 | Canvas snapshotter + asset section + player plugin | skipped | Out of scope v1 (D-01) |
| T-25 | WS tab in player | done | WS tab: connections with lifecycle (open/close code, frames), Centrifugo channels parsed from pushes + commands (newline batches, truncated frames tolerated), channel / direction / search filters, rows synced to the playhead, pretty-printed frame detail, abnormal closes as timeline markers. Unit tests (dashboard/test/ws.test.ts); e2e/sdk-replay.e2e.mjs shows 17 WS items from a real recording. |
| T-26 | Capacitor module: lifecycle, device info, IndexedDB queue, direct transport | done | Capacitor chunk: App/Device info → ctx.app, tags, replay init; pause/resume/appStateChange/backButton → app events + breadcrumbs; pause flushes core + replay; worker IndexedDB outbox for segments + Capacitor IndexedDB queue for event bodies (20 MB / 24 h, gaps), drained on online/resume/start (D-21). Direct transport (tunnel ignored) as before. e2e/capacitor.e2e.mjs (emulated): offline → online drains both queues, issue visible 1.0 s after reconnect. Real device: T-51. |
| T-30 | Source maps: upload API, CLI, Vite plugin, symbolication, reprocess | done | `POST /api/projects/:pid/releases/:rel/sourcemaps` (upload token, multipart part name = `~/path`, validated, atomic write under data/_sourcemaps) + `POST /api/projects/:pid/releases`; pipeline symbolicates before fingerprinting (LRU 32, misses cached, invalidated on upload; 5 context lines); reprocess of unsymbolicated issues' events after upload (D-22). `@replayd/cli` (`sourcemaps upload`, `releases new`, --delete-after strips sourceMappingURL) + `@replayd/vite-plugin`. e2e/sourcemaps.e2e.mjs: one minified bundle on web + emulated APK → one issue, frames `src/order.ts:4` with context; upload-after-error reprocessed. |

## M4 — Issue workflow, alerts, retention, remote config, roles
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-31 | Issue status: resolve / next release / ignore / regression | todo | |
| T-32 | Telegram alerts per project | todo | |
| T-33 | Retention: partitions + disk cleanup | todo | |
| T-34 | Remote config editor in dashboard | todo | |
| T-35 | Viewer-role redaction of bodies/frames | todo | |

## M5 — Adapters, WordPress, observability, benchmarks, migration
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-40 | `@replayd/nuxt`, `@replayd/vue`, `@replayd/react`, IIFE build | todo | |
| T-41 | `replayd-wp` plugin | todo | |
| T-50 | Observability: metrics, JSON logs, Grafana JSON, alert rules | todo | |
| T-51 | Benchmarks vs Sentry config, real-device APK checklist | todo | |
| T-52 | Migration: replace Sentry in 3 terminals + sites | todo | |

## Continue in a new session (paste this prompt)
```
You are continuing the "replayd" project in this repo (branch claude/sweet-clarke-h5srzw).
Read PRD.md (including the Decisions log at the end), AGENTS.md and PROGRESS.md, then `git log --oneline | head -30`.
Continue from the first task in PROGRESS.md that is not `done`/`skipped`, milestone by milestone (M2 → M5) without
stopping between milestones. Follow AGENTS.md rules and the owner's working agreement in it (per task: implement →
tests → checks → commit "T-xx: <title>" → tick PROGRESS.md → push). Record deviations in the PRD Decisions log and
numbers in docs/bench.md. Environment notes: start Docker with `nohup dockerd >/tmp/dockerd.log 2>&1 &` if it is not
running; `make db` starts Postgres 17 + Atlas migrations on :55432; `make test`, `make up` (stack on :8088),
`scripts/bench-server.sh`, `scripts/crash-test.sh`, `node e2e/issues.e2e.mjs` (E2E_ADMIN_PASSWORD may need to match
the existing admin). Before stopping for any reason: commit, push, and update this section if the workflow changed.
```

## Session log
- 2026-11-03: M1 complete (T-12…T-18). M2: T-21 done early (server-only, no conflicts). GitHub push access fixed by owner.
- 2026-11-03: M0 complete (T-01, T-03, T-04, T-10, T-11). Push to GitHub blocked (403: Claude GitHub App has no write access to thomasrobinson19799/replayd); commits are local until access is fixed.
- 2026-11-03: repo bootstrapped (PRD.md, AGENTS.md, CLAUDE.md, PROGRESS.md). Env: Rust 1.97, Node 22, pnpm, Docker 29 (dockerd must be started manually in the cloud sandbox: `nohup dockerd &`), postgres:17 + arigaio/atlas images available.
