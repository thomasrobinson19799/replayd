# T-65 — Issue header

The header now presents first/last seen, first/latest release and platforms alongside the existing issue title and impact counts. Resolve remains the primary action. Resolve in next release is in Resolve options; all existing Ignore options, including custom date/count, remain available. Play replay and Copy stack sit in the action group. Copy link and Delete are in More. Existing role checks still govern mutation controls.

The event toolbar, stack, breadcrumb and sidebar layouts are preserved. T-63 adds only the requested field rows/section. All colors, typography and controls use UI-06 tokens; no new header tokens or dependencies.

Validation: `issue-status` covers next-release resolution and regression; `issue-header` covers custom ignore/reopen, current-event replay target, More keyboard opening/Escape, real clipboard behavior and dark/light views at 1440/1024/525 px. Screenshot review caught and corrected More's off-screen placement on narrow screens. Screenshots use a local database fixture, not hardcoded product records.
