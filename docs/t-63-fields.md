# T-63 — identity, custom fields and history

The SDK accepts `setUser({ id, email, name })`, `init({ appVersion })` and
`setCustomFields({ ... })`. Updates merge top-level keys; null removes a key.
Custom values must be finite JSON within eight levels and 16 KiB after recursive
denylist redaction. Invalid or oversized updates leave the previous values intact.
No runtime dependency was added to core. Core and IIFE use the owner-approved 9 KB
gzip limits; every other bundle and performance limit stays unchanged.

Session starts and error events include device timezone and local date/time with
UTC offset. Explicit app version wins over Capacitor detection. The server records
connection/trusted-proxy IP separately from client fields and records event receive
time separately from the client clock. No GeoIP or clock-skew feature was added.

## Persistence and compatibility

The owner approved increasing only the replay metadata envelope from 16 KiB to
32 KiB so the complete 16 KiB custom snapshot fits (D-49). Compressed replay and
queue limits are unchanged. Deploy the migration/server before the new SDK.

The SDK emits timestamped user/custom change events and sends a complete metadata
snapshot on first upload and subsequent changes. The worker performs metadata JSON
serialization and redaction. Unchanged segments omit the snapshot. The server parses
metadata only and never decompresses replay ingest. `fields_seq` makes the highest
sequence win across batches, out-of-order delivery and process restarts. Explicit
null user and empty custom fields clear stored values. Legacy first-segment identity
continues to work. Client IP uses latest server receive time instead of client time.

Sessions display and search only the latest identity/app version. Issue search matches
retained events, so an earlier event can still match an earlier identity. Trigram
indexes cover ID/email/name/IP/app version; custom JSON is display-only. Issue search
deduplicates matching issue IDs before membership testing to bound repeated matches.
For the first page, it probes the first 128 ordered issues and, when matches are
dense, up to 2048. A complete 51-result page can return immediately; otherwise the
full indexed query runs. Filters, ordering, pagination and sparse matches are preserved.
The benchmark compares the first two pages against an independent complete SQL query.

## Acceptance evidence

- SDK tests cover nested JSON, byte/depth limits, null removal, atomic rejection,
  key redaction, explicit/native version selection and first/changed/unchanged snapshots.
- Rust tests cover the 32 KiB envelope, full 16 KiB fields, IP trust boundaries,
  event processing, highest-sequence persistence/restart/clear semantics, all-role APIs,
  latest session vs retained event search and viewer history preservation.
- `e2e/fields.e2e.mjs` records a real browser, changes login/custom values, clicks
  history to seek, verifies every role's display, searches all five identity fields,
  sends an exact 16 KiB snapshot, rejects an oversized update and clears on logout.
- Device history uses the existing virtualized list and adds no timeline marker.
  Issue sidebar rows preserve its existing layout. Dark/light screenshots cover
  1440, 1024 and 525 px; existing copy-stack exclusions remain in force.
- Search measurements: `e2e/fields-bench.mjs` and `fields-search-benchmark.json`;
  the script uses a temporary local project and deletes its generated records.
  Final measurements and suite outcomes are recorded in `bench.md` and
  `sharing-fields-verification.md`.

No production rollout or physical-device acceptance is asserted.
