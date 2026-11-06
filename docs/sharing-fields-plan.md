# Implementation plan: replayd replay sharing, MP4 download, ignore rules, SDK fields and dashboard fixes

## 1. Task and execution instructions

Implement eight owner-requested changes in the replayd repository, exactly as specified here.

Rules for the implementing AI:
- At the start, read `PRD.md` (including the Decisions log at its end), `CLAUDE.md`, `AGENTS.md` and `PROGRESS.md`.
- Preserve every confirmed decision and exclusion in this plan. This plan is the owner's instruction for the PRD deviations listed in section 3.8.
- Do not add unrequested features, redesigns, dependencies or changes.
- If this plan leaves a consequential choice open, ask one focused question before making it.
- If this plan, the code and the PRD conflict in a way section 3.8 doesn't settle, stop and ask.
- Follow the owner's newer instructions and the environment's permission rules.
- Do not push or deploy.
- Verify against section 6 and report actual outcomes. Do not mark unperformed checks as passed.

## 2. Context and starting point

replayd is a self-hosted session replay and frontend error tracker:
- `server/`: Rust workspace (`common`, `ingest`, `storage`, `pipeline`, `alerts`, `api`, `db`, `bin/replayd`), with Atlas SQL migrations in `server/migrations/`.
- `sdk/`: pnpm workspace (`core`, `vue`, `nuxt`, `react`, `vite-plugin`, `cli`).
- `dashboard/`: Nuxt 4 SPA.
- `deploy/`: Compose, nginx and observability configuration.

Verified current state:

| Area | Current state |
|---|---|
| Git | Branch `codex/ui-06-compact-theme` has uncommitted UI-06 work (dashboard pages and CSS, `DESIGN.md`, `.impeccable/design.json`, `PRD.md`, `PROGRESS.md`, `docs/bench.md`, screenshots, new `docs/ui-06-restyle.md`) |
| SDK size | Core 6.90 KB and IIFE 6.96 KB against a 7 KB limit; replay chunk 25.57 of 45 KB; worker 2.76 of 4 KB |
| SDK user data | `setUser`, `setTag(s)` and `setContext` exist. The `init` replay meta goes only with the first segment of a page or session (`sdk/packages/core/src/replay/index.ts`) |
| Session aggregation | `server/crates/storage/src/aggregator.rs` keeps the first `init` and upserts sessions from it |
| Network capture | `sdk/packages/core/src/http.ts` records `method`, `url`, `status`, `start` and `duration`, with no fetch/XHR type |
| Client IP | PRD §4.3 and §8 say it is never stored. `server/crates/ingest/src/client_ip.rs` already resolves the client IP for rate limiting |
| Viewer filter | `server/crates/api/src/redact_rpl.rs` removes network headers/bodies and WebSocket frame contents for viewers |
| Replay page | `dashboard/app/pages/replay/[sid].vue`. `fit()` caps height at 60% of the window and scale at 1. Fullscreen targets the whole page. The decode worker downloads the recording once |
| Issue page | `dashboard/app/pages/projects/[pid]/issues/[id].vue`, `components/IssueStatusBar.vue`, `components/StackTrace.vue`. The in-app toggle state is local to `StackTrace.vue` |
| Settings | `dashboard/app/pages/projects/[pid]/settings.vue` and `dashboard/app/components/settings/*` |
| Local tools | `scripts/local-stack.ps1`, `node e2e/run-local.mjs` |

Must remain unchanged unless this plan says otherwise:
- The ingest path never decompresses replay payloads.
- Redaction defaults stay as strong as they are. Passwords remain masked.
- Canvas snapshots remain out of scope.
- All budgets stay in force except the core and IIFE size limits.
- The existing authenticated viewer-role recording filter stays as it is for logged-in viewers.
- Issue page stack trace, breadcrumbs and sidebar layout stay as they are, apart from the new data rows required by item 3 and the toggle wiring required by item 4.

No external screenshots or attachments are required.

## 3. Confirmed choices and boundaries

### 3.1 Public share links (item 1)

| ID | Decision |
|---|---|
| S1 | Access uses a secret per-session link. Anyone with the link can watch without logging in, and nothing else is exposed |
| S2 | The creator picks the expiry: 1 hour, 24 hours, 7 days, or until retention. Links can also be revoked early. A link never outlives its recording |
| S3 | All project roles, including viewers, can create and revoke links |
| S4 | Share links always expose full data, including network headers/bodies and WebSocket frame contents. This applies even when a viewer-role user creates the link, so that user can expose data they can't see themselves. The owner chose this knowingly |
| S5 | The token is stored hashed and shown only at creation. A session can have many active links. A lost URL means creating a new link |
| S6 | Links are managed only in a Share dialog on the replay page, which creates links, copies the new URL, and lists each link's creator and expiry for revoking. There is no project-wide list |
| S7 | The public page is the player with no shell: replay, timeline, controls, all tabs and Download. No sidebar, no links to projects or issues, no Share or Delete buttons, no branding header |
| S8 | Sessions still recording can be shared. New data follows live (see V9) |
| S9 | Link creation and revocation go in the audit log. Public page visits, downloads and renders do not |

### 3.2 MP4 download (items 1 and 6)

| ID | Decision |
|---|---|
| V1 | Download produces an MP4 (H.264) file |
| V2 | A new separate Compose service renders with headless Chromium and ffmpeg. The replayd binary and distroless image do not gain these |
| V3 | Video covers the full session in real time, including idle time |
| V4 | Video uses the recorded viewport size and shows only the replayed page and mouse cursor, with no burned-in overlays. A viewport resize mid-session is letterboxed inside the first size |
| V5 | The button shows progress on the replay page and becomes Download when ready. A finished video is reused until it expires. The person returns to the replay page to collect it |
| V6 | At most 2 renders run and 10 wait. Over that, the request is refused with a "try later" message |
| V7 | A finished MP4 is kept for 24 hours, then deleted |
| V8 | Public visitors can start a render. New renders are limited to 10 per hour per IP across all links. A session with a finished or running render reuses it, and that doesn't count |
| V9 | For sessions still recording: downloads are allowed, and the video covers what was recorded when the render started. Both the logged-in and public players poll and append new data while the session records |
| V10 | If more data arrived after a finished render, the video stays available with a note that it covers only part of the session, plus an action to render the latest. A re-render counts against the limits |
| V11 | The Download button appears only on the replay page and the public share page, not in the sessions list |

### 3.3 Ignore rules (item 2)

| ID | Decision |
|---|---|
| I1 | A matching event is dropped on the server, before issues, counts and alerts. Replays still show it |
| I2 | A rule has a kind (error, console, network) and one pattern. No release, environment, platform, page or level scoping |
| I3 | Error and console rules test the message. Network rules test the URL |
| I4 | WebSocket abnormal-close warnings are covered by network rules, which test their URL. There is no separate WebSocket kind |
| I5 | Each rule chooses a case-insensitive "contains" match or a regex |
| I6 | Rules are managed in a new Ignore rules tab in project settings, by superadmins and project admins only. No issue-page action |
| I7 | A new rule affects new events only. Existing issues and events stay unchanged |
| I8 | Session error and warning counts and the has-error filter stay as they are, so counts can exceed visible issues. No SDK change for this |
| I9 | Each rule shows how many events it dropped and when it last matched. Counters are kept in memory and flushed periodically |
| I10 | Maximum 50 rules per project |
| I11 | Ignore-rule changes go in the audit log |
| I12 | No enable/disable switch, note field or test-pattern tool |

### 3.4 New SDK fields (item 3)

| ID | Decision |
|---|---|
| F1 | Fields: email, name, IP, user ID, app version, client timezone, client date/time and custom fields |
| F2 | `setUser` gains `name`. `init` gains `appVersion`. A new `setCustomFields` method handles custom fields, separate from tags |
| F3 | Timezone and client date/time are captured automatically |
| F4 | Each session start and error event carries the device's local date/time with UTC offset (for example `2026-11-06 14:03:21 +03:30`) and the timezone name. Server time remains separate. No clock-skew feature |
| F5 | The server records the real client IP on every session and event: the connection IP, or trusted-proxy `X-Forwarded-For`. No GeoIP |
| F6 | Custom fields accept any JSON, nested to depth 8, up to 16 KB total per session or event |
| F7 | `setCustomFields` merges keys, and null removes a key. If the result exceeds 16 KB, the whole update is dropped and the previous values stay |
| F8 | On Capacitor, an explicit `appVersion` wins. The auto-detected native version is the fallback |
| F9 | Every change to user or custom fields is kept with its time |
| F10 | History appears as a time-stamped Field changes list in the replay Device tab. Clicking an entry seeks the replay. No timeline marker |
| F11 | The session shows the latest values, and search matches only the latest values |
| F12 | Fields appear on the issue page and in the replay Device tab |
| F13 | Sessions and issues lists are searchable by email, name, IP, user ID and app version. Custom fields are display-only and not searchable |
| F14 | All project roles see email, name, IP and custom fields |
| F15 | Core and IIFE size limits rise to 9 KB. All other size limits stay |

Custom fields must pass through the SDK's existing recursive key redaction. This is required by the rule against weakening redaction.

### 3.5 Copy stack trace (item 4)

| ID | Decision |
|---|---|
| C1 | A Copy stack action on the issue page copies text for pasting into Claude Code or Codex CLI |
| C2 | Content: error type, message, frames (symbolicated when available, raw stack as fallback), source context lines, release, environment, platform, browser/device, URL, recent breadcrumbs, plus existing HTTP, WebSocket or component context when present |
| C3 | Copied frames follow the current in-app toggle, so they match what is visible |
| C4 | Exclude email, name, IP, user ID and custom fields |
| C5 | No agent-instruction wrapper and no multiple-format dropdown |

Tags are not listed in C2, so do not include them. Use a bounded number of recent breadcrumbs and report the number chosen.

### 3.6 Issue header redesign (item 5)

| ID | Decision |
|---|---|
| H1 | Redesign only the header area and the status/actions row. The event toolbar, stack trace, breadcrumbs and sidebar keep their layout |
| H2 | Fix weak hierarchy, messy actions, missing information, unfinished polish and narrow-screen behaviour |
| H3 | Add to the header: first and last seen, first and latest release, platforms, and a Play replay shortcut for the current event's recording at that moment |
| H4 | Resolve is the primary button. Resolve in next release and Ignore are in dropdowns. Play replay and Copy stack sit beside them. Copy link and Delete go in a More menu |
| H5 | Stay within the UI-06 tokens, type and controls in `DESIGN.md`. Only layout and hierarchy change. Dark and light themes must both work |

The existing Play replay block in the event section stays, because the event section is outside the redesign. All existing Ignore options remain available, including the custom date or count. Existing role-based hiding remains.

### 3.7 Network filter and fullscreen (items 7 and 8)

| ID | Decision |
|---|---|
| N1 | The Network tab gains single-choice dropdowns: Method, Status, Type, and Slower than |
| N2 | Method covers GET, POST, PUT, PATCH, DELETE and other methods found. Status covers 2xx, 3xx, 4xx, 5xx and failed with no response. Type covers fetch and XHR. Slower than covers 500 ms, 1 s, 3 s and 5 s |
| N3 | Filters combine with AND, plus a Clear filters button. Text search and Failed only stay |
| N4 | The SDK records the request type (fetch or XHR). Older recordings have no type, so their requests appear only when Type is set to all |
| FS1 | Fullscreen shows only the replay and playback controls. Side panels are hidden |
| FS2 | Replay scales up to fit the screen, keeping its aspect ratio with bars where needed |
| FS3 | Fix these observed problems: replay small or cut off; controls missing or broken; layout or button state wrong after Esc; failure on desktop Chrome or Edge |

### 3.8 PRD deviations to record

Add each to the Decisions log in `PRD.md`, continuing from the highest existing D-number, and update the affected PRD sections:

| Deviation | PRD sections affected |
|---|---|
| Client IP is now stored on sessions and events | §0.2 user identity if needed, §4.3, §8 |
| A separate render service with Chromium and ffmpeg | §0.1, §3, §5.1, §9 |
| Public unauthenticated access to full replay data, including links created by viewers | §5.10, §5.11, §8, §6 |
| Core and IIFE limit raised from 7 KB to 9 KB, explicitly approved by the owner | §2.1, §4 |
| New fields, field history, ignore rules and live follow | §4.1, §4.10, §4.11, §5.9, §5.11, §6.1, §6.2 |

Also add the new tasks to §12.2 and `PROGRESS.md`. The dashboard may be IP-allowlisted in nginx (§8), so share pages and their APIs must stay reachable from outside any such allowlist.

### 3.9 Delivery rules

| ID | Decision |
|---|---|
| D1 | First commit the existing UI-06 work on `codex/ui-06-compact-theme` as its own commit |
| D2 | Then create one new local cumulative branch from that commit, with one commit series per task ID |
| D3 | Work follows the owner's list order, moved only where dependencies require |
| D4 | No push and no deployment |

### 3.10 Explicit exclusions

- Password-protected links, project-wide public mode, and a project-wide link list.
- Decoded JSON, `.rpl`, standalone HTML and WebM downloads.
- Video speed options, clip ranges and timestamp overlays.
- A dashboard downloads page and a sessions-list download action.
- SDK-side ignore filtering, marking events hidden, retroactive deletion or ignoring.
- Custom-field search, and search over earlier values in field history.
- Header-specific design tokens and redesign of the rest of the issue page.
- Canvas snapshots.

## 4. Ordered implementation steps

Task IDs below are the implementation's working IDs. Check that they are unused before starting.

### Step 0: Prepare the baseline (D1, D2)
1. Review the uncommitted diff, then run the dashboard checks.
2. Commit the existing UI-06 work on the current branch.
3. Create a new local branch named with the first task ID, such as `t-60-sharing-rules-fields`.
4. Add the tasks to `PROGRESS.md` and §12.2.

### Step 1: T-60 Public share links (item 1, S1–S9)
1. Add a migration for share links: session, hashed token, creator, expiry and revocation.
2. Add authenticated APIs for all project roles to create, list and revoke links.
3. Add public APIs that resolve a token into that session's metadata and unfiltered recording. They must not bypass the filter for ordinary logged-in viewers.
4. Delete or invalidate links when their session is deleted or retention removes it.
5. Reuse the player through a shared component so the logged-in page and public page don't diverge.
6. Add the shell-free public page and make it pass the auth middleware.
7. Add the Share dialog to the replay page.
8. Write audit entries for create and revoke.
9. Keep tokens out of logs, including API request logs, nginx access logs and referrers. Add `noindex` handling and `Referrer-Policy: no-referrer` to public responses.
10. Update nginx so the routes work with IP allowlisting.

Public Download is completed in Step 2.

### Step 2: T-61 MP4 rendering and Download (item 6 moved up because item 1 depends on it; V1–V11)
1. Add the render service and Compose wiring. Keep Chromium and ffmpeg out of the replayd image.
2. Implement a bounded render queue (2 running, 10 waiting) and refuse with "try later" above that.
3. Ensure only one active render exists per session, and reuse it.
4. Render in real time from the full recording at the recorded viewport size, keeping the cursor and no overlays.
5. Keep untrusted recorded page content sandboxed. It must not reach internal services or secrets.
6. Store finished files under a bounded disk area, delete them after 24 hours, and also remove them with their session.
7. Expose job status and file download to all project roles and to valid share links.
8. Enforce 10 new renders per hour per IP for public requests, using a bounded structure. Do not store visitor IPs.
9. Add the Download control to the logged-in and public players, with queued, rendering, ready and failed states. A failed render can be tried again within the limits.
10. Implement the partial-video note and render-latest action (V10).
11. Implement live follow in both players: while the session isn't ended, poll with a bounded interval, fetch only new bytes through the existing Range support, decode them and append them through the existing path. Stop on session end or page unload. Report the interval chosen.
12. Keep the 60-minute first-frame requirement and `e2e/player.e2e.mjs` passing.
13. Report the H.264 encoder licensing situation of the chosen ffmpeg build to the owner.
14. Add metrics or logs only where existing conventions already require them, never with tokens or payloads.

### Step 3: T-62 Ignore rules (item 2, I1–I12)
1. Add storage for rules, with a limit of 50 per project.
2. Add admin-only CRUD APIs with validation. Reject invalid regexes on save, and write audit entries.
3. Apply rules in the event pipeline before fingerprinting and issue upsert, so matching events create no issue, count or alert.
4. Map sources this way: `onerror`, `unhandledrejection`, `vue`, `react` and `manual` are error; `console` is console; `http` and `ws` are network.
5. Test the message for error and console rules, and the URL for network rules.
6. Do not touch replay ingest or `.rpl` data, and leave session counts unchanged.
7. Compile and cache rules in memory and refresh on change. Do not query the database per event.
8. Keep dropped counts and last match in memory and flush periodically through a bounded path.
9. Add the Ignore rules settings tab showing kind, pattern, match type, dropped count and last match.

### Step 4: T-63 SDK and server fields (item 3, F1–F15)
1. Raise the core and IIFE limits to 9 KB in the size configuration and PRD. Leave all other limits unchanged.
2. Implement F2–F4 and F6–F8 in the SDK. Check size at call time only, and add no hot-path work.
3. Send changed user and custom fields with later segments, and record each change with its time in the recording so the Device tab can list it.
4. Include all fields on error events.
5. Update the Vue, Nuxt, React and IIFE surfaces only as needed to pass the new `appVersion` and methods through. Keep adapters within 1 KB.
6. Store the real client IP on sessions and events in the ingest and pipeline paths. Parse meta only, and never decompress on ingest. Never log IPs with payloads, and follow existing log rules.
7. Add migrations and update the aggregator so the session stores the latest values (F11).
8. Make sure the viewer filter keeps the field-history events.
9. Add the new fields to the session and event API responses for all project roles.
10. Show the fields on the issue page and replay Device tab, plus the Field changes list.
11. Add search by email, name, IP, user ID and app version to sessions and issues lists. An issue matches when a retained event has that value. Add suitable indexes, keeping within §2.2. Remember the issue list polls every 2 seconds (D-16). If the budget can't be met, stop and ask.
12. Update README and setup documentation for the new SDK API.

### Step 5: T-64 Copy stack (item 4, C1–C5)
1. Lift or expose the in-app toggle state from `StackTrace.vue` so the page knows the visible frames.
2. Add a tested formatter for the C2 content, excluding C4 data.
3. Add the Copy stack action, placed in the header arrangement from Step 6.

### Step 6: T-65 Issue header redesign (item 5, H1–H5)
1. Redesign the header and actions row in the issue page, `IssueStatusBar.vue` and existing CSS.
2. Implement the H3 details and H4 actions, using existing issue data and existing UI components.
3. Keep existing test IDs working or update tests with equal coverage.
4. Check keyboard access and both themes at 1440, 1024 and 525 px. Update `docs/screenshots/` where the repository already keeps these screens.

### Step 7: T-66 Network filters (item 7, N1–N4)
1. Add the fetch or XHR type to the SDK's network events in `http.ts`.
2. Parse it into `NetworkItem` in `dashboard/app/utils/replay.ts`.
3. Add tested pure filter logic and the dropdown row, and keep the synced virtualized list working.
4. Confirm the viewer filter keeps the type, as it is metadata.

### Step 8: T-67 Fullscreen fix (item 8, FS1–FS3)
1. Reproduce each FS3 problem on desktop Chrome or Edge before changing code.
2. Make fullscreen target only the replay and controls, and hide side panels.
3. Change `fit()` so fullscreen uses all available space and scales up, while normal view keeps its current behaviour.
4. React to `fullscreenchange` so Esc, button state and layout stay in sync.
5. Make sure modal and control layers remain usable in fullscreen.
6. Apply the same fix to the public player through the shared component.

### Per-task completion
For each task: implement, add tests, run the required checks in section 6, commit as `T-xx: <title>`, tick `PROGRESS.md`, and record decisions in the Decisions log.

## 5. Security and performance constraints

- Never log tokens, keys or payloads. Use bounded channels and queues only.
- No new runtime dependency in `sdk/packages/core`. Any new SDK dependency requires `pnpm size`.
- Never parse, stringify or allocate per WebSocket message or mutation on the main thread beyond what's specified.
- Never decompress replay payloads in the ingest path.
- Measure performance changes, and record them in `docs/bench.md`. Apart from the owner-approved 9 KB limits, never fix a budget by loosening it.

## 6. Acceptance and verification

Required checks before each commit:
- Server: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`, `cargo test`
- SDK: `pnpm lint`, `pnpm test`, `pnpm size`
- Dashboard: `pnpm lint`, `pnpm typecheck`, `pnpm build`, and its tests

At the end, run `node e2e/run-local.mjs` on a rebuilt local stack (`scripts/local-stack.ps1`), adding e2e coverage for new flows where the suite's patterns fit.

Observable checks:

**Sharing**
- A logged-out browser can open a valid link and see the replay, every tab and full network and WebSocket data, with no shell, Share or Delete.
- A viewer can create and revoke a link, and that link exposes full data, while the same viewer's logged-in page stays filtered.
- The token is shown only at creation and stored hashed.
- Expired, revoked, malformed and deleted-session links fail without revealing data.
- A token gives access to no other session or API.
- The dialog lists multiple links with creator and expiry.
- Create and revoke appear in the audit log, while visits and public renders don't.
- A token doesn't appear in logs.

**Video**
- Download produces a playable H.264 MP4 at the recorded viewport size, with duration matching the full session including idle time, and no overlays.
- The replayd image contains no Chromium or ffmpeg.
- With 2 running and 10 waiting, the next request gets "try later".
- Starting twice for one session reuses the render.
- The 11th new public render in an hour from one IP is refused, while reuse isn't counted.
- The file is deleted after 24 hours.
- A session still recording gets a video covering data up to the render start, then the partial note and render-latest action after new data.
- Progress survives leaving and returning to the replay page.
- Both players append new data live, stop at session end, and the 60-minute first-frame benchmark still passes.

**Ignore rules**
- Each kind, with contains and regex, drops new matching events before issues, counts and Telegram alerts.
- WebSocket warnings are matched by network rules on URL.
- Existing issues don't change.
- The replay still shows ignored events, and session counts stay unchanged.
- Member and viewer roles can't manage rules.
- The 51st rule and invalid regexes are rejected.
- Dropped count and last match update.
- Audit entries exist.

**Fields**
- An app sending every field shows them on the issue page and Device tab for all roles, with real IP via direct and trusted-proxy paths.
- Local date/time, offset and timezone appear on session start and every error event.
- `setCustomFields` merges, null removes, nested JSON to depth 8 works, oversized updates are dropped with previous values retained, and denylisted keys are redacted.
- A mid-session login updates the session to the latest values, and the Field changes list shows each change and seeks on click.
- Search finds the latest email, name, IP, user ID and app version, and doesn't find replaced values.
- An explicit `appVersion` beats the native value.
- `pnpm size` shows core and IIFE at or under 9 KB, with other limits unchanged.
- List budgets stay within §2.2, and results are recorded in `docs/bench.md`.

**Copy stack**
- Copied text contains C2 content and follows the in-app toggle.
- A test proves it never contains email, name, IP, user ID, custom fields or tags.

**Header**
- First and last seen, releases, platforms and Play replay appear.
- Resolve is primary, Resolve in next release and Ignore are in dropdowns, and Copy link and Delete are in More.
- Every previous action still works, including custom ignore.
- Viewers still can't change status.
- It works in both themes, by keyboard, and at 1440, 1024 and 525 px.
- Stack trace, breadcrumbs and sidebar layout are unchanged.

**Network filters**
- Method, Status, Type and Slower than work individually and combined with AND, alongside search and Failed only.
- Clear filters resets the dropdowns.
- Older recordings without a type appear only under all types.

**Fullscreen**
- On desktop Chrome or Edge, only the replay and controls show.
- A 412×915 session scales up to fit a 1920×1080 screen with its aspect ratio kept.
- Controls and timeline work.
- Esc and the button both restore the normal layout and correct state.
- Normal-view sizing is unchanged.

**Unchanged behaviour**
- Replay ingest never decompresses.
- Redaction defaults stay intact, and password inputs stay masked.
- Canvas stays excluded.
- Existing e2e suites keep passing.
- Nothing is pushed or deployed.

## 7. Final delivery and deferred decisions

Deliver:
- The UI-06 commit, plus one local cumulative branch with `T-xx: <title>` commit series for T-60 through T-67.
- Updated `PRD.md` (sections and Decisions log), `PROGRESS.md`, `README.md`, Compose and nginx configuration, `docs/bench.md` and relevant screenshots.
- A report of actual check results, the chosen breadcrumb count and poll interval, the ffmpeg H.264 licensing note, and any checks not performed.

No product decisions were intentionally deferred. If new consequential questions arise during implementation, such as a list budget that can't be met, stop and ask the owner instead of guessing.