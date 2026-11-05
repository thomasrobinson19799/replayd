# Dashboard completion audit — 2026-11-05

Scope: PRD §5.10–5.11, §6–6.2 and the owner's dashboard overhaul request. Existing capture, ingest, decoding, redaction and database connections remain authoritative.

| Area | Baseline finding | Work |
|---|---|---|
| Users | Placeholder page; CRUD/reset/disable API already exists | Full superadmin management with confirmation and validation |
| Account | Logout and identity API exist; own-password endpoint absent | Current-password verification, atomic update/revoke other sessions, account page |
| Stats | Documented endpoint absent | Bounded 24h/7d/14d hourly events/sessions by platform, real project cards/trends |
| RBAC | API guards exist; viewer sees unusable bulk controls; project admins cannot discover users to add | Role-aware controls; add existing member by exact email without exposing the user directory |
| Deletion | Permission exists but issue/session routes absent | Admin deletion; active recording deletion disallowed to avoid racing writers |
| Issues | Most detail behavior exists; no environment filter, URL restoration incomplete | Restore filters and page from URL, environment filter, accessible table, trend and loading states |
| Sessions | Filters exist; appending all pages grows DOM; browser history not restored | Bounded page display, history restoration and clear filters |
| Replay | Progressive worker and virtualization exist; network bodies only in truncated title; no failed filter, fullscreen, search or follow toggle | Inspectable network detail, filter/search/follow controls, accessible timeline/hover preview, fullscreen |
| Settings | Six tabs exist; no dirty guard; native confirms; inconsistent feedback/labels | Shared forms, confirmation, dirty guard, toasts, tab semantics |
| Shell/design system | Plain header, light-only utilities | Responsive sidebar, project switcher, account menu, OS theme + toggle, shortcuts, reusable controls |
| Login | Generic error and busy state already exist | Polished accessible layout and safe internal return URL |
| Onboarding | DSN/token shown once, no snippets/copy | Project cards + setup screen with actual DSN/token and installation snippets |

Not in scope: canvas (D-01), SSO, backend tracing, iOS, GeoIP and external broker access. Invitation means creating an account and securely sharing its initial password; no email delivery provider exists. T-41, T-51 and T-52 remain blocked on external resources. Local stack rebuilds are verification only, never production deployment. No push.

## Acceptance

- [x] Users: create an account with an initial password, edit name/global role, reset password, disable/enable and delete with confirmation. Project roles remain separate from the global superadmin flag.
- [x] Account: current-password validation, minimum/maximum length, mismatch feedback, current session retained and other sessions revoked. Logout errors leave the account recoverable.
- [x] API: hourly statistics, issue environment filtering, admin issue/ended-session deletion, and project-admin membership by exact email. PostgreSQL integration tests cover RBAC, CSRF and session invalidation.
- [x] Shell and shared controls: OS/light/dark theme, project switcher, breadcrumbs, account menu, responsive navigation, keyboard focus, `/`, `j/k` and `?`; semantic tables, dialogs and tabs.
- [x] Projects: actual 24h activity and sparklines; project creation ends with real DSN/token, copy controls and Nuxt/script/CI examples. CI variables are exported and releases match `APP_VERSION`.
- [x] Issues: URL-synced filters, history restoration, ordering, paging, role-aware bulk controls, activity, loading/empty states; detail retains stack context, event navigation and replay deep links.
- [x] Sessions/replay: at most 50 session rows per keyset page; virtualized inspector lists; bounded timeline marker bins; failed-network filter, JSON body details, Device search, follow toggle, keyboard seek and fullscreen. Decoding still happens in the worker.
- [x] Settings: six tabs, mobile-visible selected tab, shared feedback, dirty navigation/unload guard, validation, readable fingerprint inputs and explicit Telegram test feedback.
- [x] No SDK runtime dependencies, redaction defaults or ingest decoding changes. Viewer payload filtering and existing capture checks remain passing.
- [x] No push or production deployment. Local images rebuilt and local stack healthy. T-41/T-51/T-52 remain blocked.

## Page review and screenshots

Screenshots use local database fixtures through the real API. Desktop, intermediate and narrow widths are 1440, 1024 and 525 pixels. The extra settings screenshots inspect all six tabs at 525 pixels. These are evidence snapshots, not hardcoded frontend content.

| Page | Result | Screenshot |
|---|---|---|
| Projects | Real activity cards, search and clear creation/setup flow | [Desktop](screenshots/projects-1440.png), [narrow](screenshots/projects-525.png) |
| Issues | Scannable table, filters, activity and explicit empty/loading states | [Populated](screenshots/issues-populated-1440.png), [empty](screenshots/issues-525.png) |
| Issue detail | Status/count hierarchy, stack context, tag chips, spaced breadcrumb timeline and replay action | [Desktop](screenshots/issue-detail-1440.png), [narrow](screenshots/issue-detail-525.png) |
| Sessions | Bounded, filterable table with duration/platform/error context | [Desktop](screenshots/sessions-populated-1440.png), [narrow](screenshots/sessions-populated-525.png) |
| Replay | Recorded-aspect stage, timeline, compact controls and searchable inspector | [Desktop](screenshots/replay-1440.png), [narrow](screenshots/replay-525.png), [network details](screenshots/network-detail.png) |
| Settings | Six consistent forms; tabs wrap; rules stack on narrow screens | [Remote config](screenshots/settings-525.png), [Telegram](screenshots/settings-telegram-525.png), [rules](screenshots/settings-rules-525.png) |
| Users | Search, bounded table, explicit roles and confirmed mutations | [Desktop](screenshots/users-1440.png), [narrow](screenshots/users-525.png) |
| Account | Identity, password validation and session-revocation explanation | [Light](screenshots/account-1440.png), [dark](screenshots/account-dark.png) |
| Login | Focused form, generic authentication failures, loading state | [Narrow](screenshots/login-525.png) |

## Validation and reproduction

- Dashboard: `pnpm lint`, `pnpm typecheck`, `pnpm test` (22 tests in 5 files), `pnpm build` pass. Added dependencies are development-only test tooling; no UI framework or runtime package was added.
- Server: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test` pass, including real PostgreSQL integration tests. `scripts/check-server.ps1` enables those tests against the local database. The pre-existing ignored performance test remains ignored.
- Local acceptance: `node e2e/run-local.mjs` runs issues, SDK replay, issue status, Capacitor, source maps, remote config, framework adapters, 60-minute player, Telegram alerts, observability and dashboard flows. [Machine-readable results](e2e-results.json).
- The dashboard browser test exercises actual pointer clicks for creation/disable/enable, password/session revocation, URL back navigation, shortcuts, dialogs, dirty settings, fingerprint validation and themes. No browser errors or document overflow were found at the three widths.
- `node --import ./e2e/chrome-preload.mjs e2e/visual-dashboard.mjs` checks populated screens, real pointer timeline clicks, keyboard seeking, network detail, Device search and fullscreen. The preload selects installed Chrome for this Windows machine; the original suites remain usable with normal Playwright browsers.
- Local stack: `scripts/local-stack.ps1` sets the Docker Desktop site-proxy address and mock Telegram endpoint. It starts already-built images without touching production. nginx direct-page routing is fixed under decision D-32.
- [Bundle and performance measurements](bench.md) retain the original budgets.

## Remaining limits

No email invitation provider is configured; administrators securely share the initial password. Active session deletion is intentionally rejected while a writer is running. Canvas remains out of v1. WordPress staging, real-device Android measurements and other application repositories remain blocked under T-41/T-51/T-52; local browser tests do not replace those checks. The dashboard remains the PRD-required authenticated Nuxt SPA.

Nuxt's Windows build emits an existing cache-driver resolution warning but completes successfully; the Docker build and runtime checks pass. An early combined Telegram regression check failed under overlapping work; isolated and subsequent sequential full-suite runs passed all eight Telegram assertions without weakening the test or changing the server.

## Owner follow-up — 2026-11-06

The owner selected a familiar Sentry-style workspace and delegated the remaining decisions.
The earlier sections describe the first overhaul; this section supersedes its visual direction
and the outdated statement that terminal repositories are unavailable.

- [x] Consistent plum navigation, violet actions and neutral light/dark surfaces across the existing pages.
- [x] Issue detail groups impact and workflow above event evidence, with a separate first/last seen,
  platform and context rail. Stack and breadcrumbs disclose independently; breadcrumbs have search.
- [x] Initial load failures offer retry. Older-event failures keep the current event visible; duplicate
  requests and stale responses after navigation are prevented.
- [x] Nuxt setup snippet places the release in `appConfig.app_version`, matching the SDK reader.
- [x] Inner routes retain active navigation. A branded error page recovers to projects and restores
  saved or system theme on direct reload.
- [x] Independent design review completed. Its two findings—narrow Ignore popup overflow and standalone
  error-page theme initialization—were fixed and verified. The popup fits at 525/375px; Escape closes it
  and restores trigger focus. Foreground/background changes remain paired during theme switching.
- [x] Dashboard lint, typecheck, 26 tests and production build pass. Local images rebuilt; all twelve
  integration suites pass, now including WordPress and the actual WP Rocket delay-code compatibility run.
  SDK lint, 139 tests and all size checks pass. Server runtime code was unchanged in this follow-up;
  the prior full Rust check result remains applicable.
- [x] Final editable-field boundary adjustment verified against computed browser styles with
  `node --import ./e2e/chrome-preload.mjs e2e/contrast.e2e.mjs`: minimum border contrast
  3.83:1 light / 3.92:1 dark and field text at least 14.15:1. This targeted regression check is
  separate from the twelve integration suites and is not a claim of a full accessibility certification.

The final screenshot set includes desktop/tablet/mobile pages, all six settings tabs, populated evidence,
dark issue detail, open Ignore at 375/525px and light/dark page recovery. See
[issue detail](screenshots/issue-detail-1440.png), [dark detail](screenshots/issue-detail-dark.png),
[narrow Ignore](screenshots/issue-ignore-375.png), and [dark error page](screenshots/not-found-dark.png).
The [official Sentry issue-details reference](https://sentry.io/changelog/new-issue-details-ui-now-available/)
informed hierarchy and grouping; no unsupported Sentry capabilities or fabricated statistics were added.

### Rechecked external gates

| Gate | Newly completed | Still needed |
|---|---|---|
| T-41 | WordPress 6.8 plus real WP Rocket v3.24 DelayJS, negative control and capture before interaction | fxglory.com staging URL/access and site-specific cache/CDN verification |
| T-51 | Reproducible Windows benchmark runner, current three-run measurements, installed Android-tool detection | Physical Android device, lifecycle/heap/thermal run, reliable <150 ms snapshot acceptance |
| T-52 | Existing shared terminal migration verified across all nine brand/platform configs; source-map CI and Sentry removal | Website source/staging access and live rollout evidence |

These gates remain open; local source checks and emulation are not deployment or hardware proof.
Canvas stays excluded from v1. The latest working branch is `codex/ui-05-sentry-triage`; all changes
remain local, with no push or production deployment.
