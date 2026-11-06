# Sharing and fields plan — final verification

All eight tasks are implemented locally on `codex/t-60-sharing-rules-fields`.
Nothing was pushed or deployed to production. UI-06 baseline: `c8a4e7a`, with
screenshot follow-up `e17ec9f`.

| Task | Local commit / evidence | Result |
|---|---|---|
| T-60 public sharing | `584db23`, [acceptance](t-60-sharing.md) | Complete |
| T-61 MP4/live follow | `90b2c47`, [acceptance](mp4-exports.md) | Complete |
| T-62 ignore rules | `b8fef72`, [acceptance](t-62-ignore-rules.md) | Complete |
| T-63 fields/history/search | This task commit, [acceptance](t-63-fields.md) | Complete |
| T-64 Copy stack | `ae580a9`, [acceptance](t-64-copy-stack.md) | Complete |
| T-65 issue header | `169c455`, [acceptance](t-65-issue-header.md) | Complete |
| T-66 network filters | `b644baa`, [acceptance](t-66-network-filters.md) | Complete |
| T-67 fullscreen | `19c16f3`, [acceptance](t-67-fullscreen.md) | Complete |

## Actual checks

- Rust formatting, Clippy with warnings denied and full workspace tests pass,
  including PostgreSQL integration, all-role access, IP trust boundaries, metadata
  limits and latest-value persistence across out-of-order delivery and restarts.
  Native Windows checks used one build job after parallel linking hit a PDB limit.
- SDK lint, **149 unit tests + four benchmark-gate tests** and size checks pass.
  Core **7.48 KB**, IIFE **7.54 KB**, replay **25.68 KB**, worker **2.82 KB**;
  every bundle is within its approved limit. Cold-init median **0.740 ms** at 1×.
- Dashboard lint/typecheck, **32 tests** and production build pass. Dark/light
  desktop, intermediate and mobile views were checked at 1440/1024/525 px.
  Native pointer/keyboard tests cover clipboard, menus, custom ignore, filters,
  inspection, field-history seeking, fullscreen controls and Escape.
- All **20 integration suites** pass on rebuilt local images, including real SDK
  identity changes, all-role display, exact 16 KiB fields, atomic oversize rejection,
  logout clearing, public sharing/live append, H.264 export, WordPress with actual
  WP Rocket and local MinIO outage/recovery. [Results](e2e-results.json).
- Identity lists on 140k sessions/events: worst p95 **56.69 ms sessions / 65.33 ms
  issues**, under the unchanged 100 ms gate. Ordered pagination matches full SQL.
  [Measurements and method](bench.md), [per-query data](fields-search-benchmark.json).
- Chrome and Edge pass authenticated/public fullscreen, aspect ratio, working
  playback/timeline and restoration through both Escape and the exit button.
  MP4 acceptance produces H.264, 412×916, exactly six seconds including idle.
- Final 60-minute replay at 20 Mbps: first-frame **626 / 689 / 731 ms**, median
  **689 ms**, below **1000 ms**; progressive playback and 75% seeking pass.

## Confirmed choices and remaining owner checks

Live follow polls every **5 seconds**. Copy stack includes at most **30 recent
breadcrumbs**, excludes identity/custom fields/tags and follows the in-app toggle.

Replay metadata now allows **32 KiB**, as explicitly approved, to carry the full
**16 KiB** custom-field snapshot. Deploy the server/migration before the updated SDK.
Compressed replay limits and all other performance gates remain unchanged.

Odd MP4 dimensions get at most **one pixel of padding per dimension**. The renderer
is offline, so uncaptured external images/assets may be missing. The FFmpeg build
enables GPL/libx264; distribution carries corresponding source/license obligations,
with codec patents a separate consideration. [Build and license evidence](mp4-exports.md).

The optional 15-day retention benchmark was not rerun, and no real external bucket,
physical-device, live-site rollout or remote CI execution is claimed. Existing
owner-validation gates remain in `PROGRESS.md` under D-34.
