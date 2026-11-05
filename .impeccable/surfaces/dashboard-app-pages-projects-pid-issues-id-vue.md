---
version: 1
slug: "dashboard-app-pages-projects-pid-issues-id-vue"
primary_target: "dashboard/app/pages/projects/[pid]/issues/[id].vue"
related_targets: ["dashboard/app/assets/css/main.css","dashboard/app/layouts/default.vue"]
---

# Issue inspection workspace

Mode: Operate. Developers identify an error's impact, resolve or ignore it, inspect event evidence and open the recording just before it happened.

The owner chose familiar Sentry conventions and delegated implementation choices. Keep the issue title and event/user counts above grouped workflow actions. Put the selected event, replay action, collapsible stack and searchable breadcrumbs in the main column, with first/last seen, platform distribution and recorded tags in a narrow context rail. Stack the rail below evidence on smaller screens; keep controls usable with pointer and keyboard.

Use recorded API data and existing role checks. Preserve worker decoding, payload redaction, playback performance and source-map context. Never invent assignment, priority, integrations or statistics. Event pagination must prevent concurrent fetches and stale responses after route changes; failures retain the current event and offer a retry.

Proof: populated responsive screenshots, dark theme, empty breadcrumb search, keyboard disclosure, replay-at-event, failed event loading, stale navigation and page-recovery checks. No unresolved design decisions; physical Android and site rollout acceptance remain separate project gates.
