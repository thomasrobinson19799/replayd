# T-62 — Ignore rules

Project admins and superadmins manage up to 50 rules in Settings → Ignore rules.
Each rule selects error, console or network and either case-insensitive contains
or a validated Rust regex. Error sources are onerror, unhandledrejection, Vue,
React and manual; console matches its message, HTTP/WebSocket match their URL.

Rules apply only to new issue events, before fingerprinting, issue upsert and
alert signals. Replay ingest and the session aggregator do not consult this cache,
so recordings and session error/warning totals stay unchanged. Existing issues
and events stay intact. Retried IDs do not inflate dropped counters.

The project row is locked while creating a rule to enforce the limit under
concurrent requests. Regex compilation has a 256 KiB size limit and patterns are
limited to 1024 bytes. The event path uses only cached compiled rules and atomic
counters. Cache reload flushes those counters and preserves increments racing
with a reload/edit. CRUD refreshes immediately; periodic project refresh also
flushes counters (default 10 seconds, `ingest.project_refresh_secs`). The UI refreshes statistics every 30 seconds. In-memory counts
since the last successful flush can be lost on a process crash.

Create, update and delete are transactional with audit entries containing only
rule/project IDs. No event payloads or pattern contents are logged. No enable
switch, notes, test tool, SDK filter or issue-page action was added.

Acceptance:

- Real PostgreSQL tests exercise every source, all three kinds, both match modes,
  invalid regex, retries, counter flush, immediate removal, preserved history,
  no issue/count/alert output, admin-only CRUD and concurrent 50-rule enforcement.
- Real Chrome checks create/edit/delete, invalid-regex feedback, Enter-to-save,
  server drop/counter display and no resulting issue; six theme/width screenshots
  cover 1440, 1024 and 525 px.
- Server format/Clippy/full database tests, SDK lint/140 tests/four benchmark
  gates/sizes, dashboard lint/types/27 tests/build pass. SDK unchanged.
- Cached matching measurement is recorded in bench.md. No push/deployment.
