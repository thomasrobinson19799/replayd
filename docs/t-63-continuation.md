# T-63 continuation — not complete

Owner choices already settled: MP4 odd dimensions get at most one pixel of padding per dimension; renderer stays offline, so external images may be absent. Do not ask these again.

One required decision remains unanswered: the plan promises 16 KB of custom JSON fields, while `common::wire::MAX_META_LEN` limits the entire metadata block to 16 KB. The async question offers raising only the metadata cap to 32 KB, or preserving 16 KB by splitting field updates. Do not infer permission to raise a performance/wire limit. The accepted plan and AGENTS require asking about this conflict. The cap is still unchanged.

Prepared, uncommitted work:

- SDK `name`, explicit `appVersion`, `setCustomFields`, local clock/timezone, redacted snapshots and timestamped history; 147 unit tests and four performance-gate tests pass. Core/IIFE are 7.48/7.54 KB with the approved 9 KB limits; replay 25.57 KB, worker 2.78 KB and adapters remain within their unchanged limits. The worker redacts history at its snapshot root to preserve eight-level JSON. No new core dependency.
- Real IP flows from trusted-proxy/connection resolution through event/replay queues. New database fields and trigram indexes are in migration `20261106000005_fields.sql`, already applied to the local Docker database. Event payloads expose timezone/local time/received time/custom fields. APIs and latest-identity search are prepared; role/search fixtures and trusted/untrusted proxy tests pass in native Rust database tests.
- Device field rows/history list, issue context/custom fields and search labels are prepared; field-history parser tests pass.

Still required after the decision:

1. Implement later-segment complete user/custom snapshots or the approved split transport; automatic session-start timezone/date/time; explicit app version over native fallback. Keep heavy serialization/redaction in the worker.
2. Update `SegmentInit`/metadata decoding and session aggregation to persist latest user/custom values by segment sequence across out-of-order arrival and restarts, including clear/removal semantics. Bound/validate custom snapshots; never decompress replay ingest.
3. Add worker/aggregator tests and real SDK mid-session login/history/seek acceptance; all-role display and latest session vs retained-event issue search.
4. Measure list budgets with representative data and remeasure affected SDK performance after transport is complete. Prepared API cold-init already passes: 0.770 ms median / 0.865 ms p90 at 1×, 4.455/5.065 ms at 4× (15 samples each), recorded in docs/bench.md. README/setup API instructions have a pending-work note to remove after completion. Record the PRD metadata decision.
5. Rebuild server/dashboard locally, run all required checks and the complete integration suite, then commit T-63 and mark it complete. No push/deployment.

Independent T-64 through T-67 have local commits and passed targeted browser checks while this decision was pending. They do not depend on the uncommitted T-63 fields. Full integration results are written by `e2e/run-local.mjs`; do not claim final T-63 acceptance from those existing suites. The currently running Docker binary is the committed T-62 implementation, while the dashboard includes the prepared T-63 display rows; rebuild the binary when testing the new field APIs.

Ignored `data/t63-player.vue`, `data/t63-replay.ts`, `data/t64-issue.vue`, `data/t66-player.vue` and `data/prepare-task-index.py` were used only to keep task commits separate. T-64–T-67 are now committed; do not rerun the staging helper. Remaining source differences from HEAD belong to T-63.
