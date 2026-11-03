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
| T-10 | Monorepo scaffold, CI, size-limit, Atlas, compose | todo | |
| T-11 | Wire format + `.rpl` format (Rust) + TS encoder | todo | |

## M1 — Errors from terminals grouped in dashboard
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-12 | Core SDK: init, session manager, transport, retry, ring buffer | todo | |
| T-13 | Core SDK: errors, flood control, redaction | todo | |
| T-14 | Core SDK: WebSocket + EventSource patch, gate, outgoing capture | todo | |
| T-15 | Server: ingest events + remote config + project cache + rate limits | todo | |
| T-16 | Server: stack parsing, URL normalization, fingerprint, issues upsert, COPY | todo | |
| T-17 | Server: auth, users, projects, members, RBAC | todo | |
| T-18 | Dashboard: login, projects, issues list/detail | todo | |

## M2 — Full replays with console/network
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-20 | SDK replay chunk: lazy load, rrweb, worker, segments, page-hide flush | todo | |
| T-21 | Server: replay ingest, shard writers, fsync, dedup, aggregator | todo | |
| T-22 | Dashboard: sessions list + filters | todo | |
| T-23 | Dashboard: player, decode worker, timeline, tabs | todo | |

## M3 — WebSocket, APK, source maps
| ID | Task | Status | Notes / blockers |
|---|---|---|---|
| T-24 | Canvas snapshotter + asset section + player plugin | skipped | Out of scope v1 (D-01) |
| T-25 | WS tab in player | todo | |
| T-26 | Capacitor module: lifecycle, device info, IndexedDB queue, direct transport | todo | |
| T-30 | Source maps: upload API, CLI, Vite plugin, symbolication, reprocess | todo | |

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

## Session log
- 2026-11-03: repo bootstrapped (PRD.md, AGENTS.md, CLAUDE.md, PROGRESS.md). Env: Rust 1.97, Node 22, pnpm, Docker 29 (dockerd must be started manually in the cloud sandbox: `nohup dockerd &`), postgres:17 + arigaio/atlas images available.
