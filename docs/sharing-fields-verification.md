# Sharing and fields plan — verification status

Local branch: `codex/t-60-sharing-rules-fields`. No push or production deployment.
Baseline UI-06: `c8a4e7a`, screenshot follow-up `e17ec9f` (already committed before this work).

| Task | Local commit | Status |
|---|---|---|
| T-60 public sharing | `584db23` | Complete |
| T-61 MP4 exports/live follow | `90b2c47` | Complete; live append first landed with T-60 |
| T-62 ignore rules | `b8fef72` | Complete |
| T-63 fields | — | Prepared code remains uncommitted; metadata-limit decision and final implementation/acceptance remain |
| T-64 Copy stack | `ae580a9` | Complete |
| T-65 issue header | `169c455` | Complete |
| T-66 network filters | `b644baa` | Complete |
| T-67 fullscreen | `19c16f3` | Complete |

The independent dashboard tasks were committed while T-63 awaited an owner decision. Details and remaining work: [T-63 continuation](t-63-continuation.md). The plan's 16 KB custom-field allowance cannot fit inside the existing 16 KB *total* metadata cap. The unanswered choice is a metadata-only increase to 32 KB or split updates under the existing cap. No cap has been changed.

## Actual checks

- Rust formatting, Clippy with warnings denied and all workspace tests passed, including local PostgreSQL integration tests, role checks, share/render limits, ignore suppression and trusted-proxy IP flow. The optional 15-day retention benchmark remains ignored; an external S3 live test is not claimed as run. The local MinIO integration below did run.
- SDK lint, **147 unit tests + four benchmark-gate tests**, and size checks pass. Current prepared fields code: core 7.48 KB, IIFE 7.54 KB, replay 25.57 KB, worker 2.78 KB; all within their approved limits. Cold-init median 0.770 ms at 1×, below 1 ms. T-63 transport and list budgets remain unverified.
- Dashboard lint/typecheck, **32 tests** and production build pass. Header/menu/network screenshots were visually inspected at 1440, 1024 and 525 px in both themes. Native pointer and keyboard actions exercised clipboard, dropdowns, custom ignore, filters, request inspection, fullscreen controls and Escape.
- The rebuilt local dashboard/committed server stack ran all **19 integration suites**. Eighteen passed initially. Monitoring exposed an obsolete six-rule expectation after the earlier bucket alert made seven; its test now checks all seven rule names and the rerun passes. `e2e-results.json` preserves both monitoring attempts. These suites do not establish completion of the unfinished T-63 transport.
- The 60-minute replay first-frame samples were 660/749/752 ms; progressive playback and seeking passed. MP4 was H.264, 412×916, exactly 6 seconds including idle. Chrome and Edge passed fullscreen in public/authenticated views, preserving aspect ratio and restoring normal geometry after both exit paths.

## Confirmed operational choices

Live follow polls every **5 seconds**. Copy stack includes at most **30 recent breadcrumbs**.
Odd MP4 dimensions get at most **one pixel of padding per dimension**. The renderer is offline;
external images or other uncaptured assets can be missing. The selected FFmpeg build enables
GPL/libx264; distributing that image entails the corresponding GPL source/license obligations,
and codec patent questions are separate. See [encoder build/license evidence](mp4-exports.md).

No production rollout, physical-device or owner live-site acceptance is asserted. Existing
owner-validation gates remain in `PROGRESS.md`.
