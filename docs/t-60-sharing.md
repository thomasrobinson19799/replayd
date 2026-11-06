# T-60: public replay sharing

The authenticated replay and shell-free public route use the same player. All roles can create/revoke capabilities; viewer-created capabilities intentionally grant full recorded data without changing authenticated viewer redaction. Creation/revocation are transactional with audit entries. Tokens are random 256-bit values, stored only as SHA-256 hashes, returned once. Active links list creator/expiry; retention caps/checks invalidate links immediately when retention changes or the session disappears.

Public routes suppress access logs (including malformed tokens), use no-store/noindex/no-referrer, and remain outside the optional dashboard IP allowlist. Static assets are reachable independently. Retention removes expired/orphaned links. No ingest decoding or SDK redaction changes.

Live follow was brought forward from T-61 because S8 requires it. Both players poll metadata every **5 seconds**, fetch only appended recording bytes, retain partial-frame/dedup state and stop after session end/unmount. The worker decodes serially with backpressure and at most one pending poll.

Verification:

- Rust formatting, all-target Clippy with warnings denied, full tests with local PostgreSQL: passed. The existing opt-in retention benchmark is ignored by the standard test command.
- SDK lint, 140 unit tests, 4 benchmark-gate tests, size: passed. Core 6.90 KB, IIFE 6.96 KB, replay 25.57 KB, worker 2.76 KB; unchanged limits at this task.
- Dashboard lint/typecheck/build and 27 tests: passed, including incremental worker Range/partial-frame coverage.
- Database HTTP tests verify all-role create/revoke, CSRF, outsider denial, hashed storage, expiry, malformed links, single-session scope, full public headers/bodies/frames, continued viewer filtering and audit-only create/revoke.
- Sharing browser flow: dialog create, keyboard Escape, logged-out playback, all six tabs, no shell/project links/Share/Delete, both themes at 1440/1024/525: passed. Live append is verified in both players, including the final bytes when the session ends.
- Six screenshots are in `docs/screenshots/share-*`; desktop and mobile screenshots visually inspected.

MP4 Download remains T-61. Nothing pushed or deployed; Docker changes are local verification only.
