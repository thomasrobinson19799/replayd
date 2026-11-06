# UI-06 — compact dashboard restyle

2026-11-06. Owner-supplied visual specification. Built on local branch `codex/ui-06-compact-theme` and committed after its production deployment.

## Scope and audit

Nuxt 4 / Vue 3 SPA, Tailwind 4 Vite integration, custom shared Vue controls. Global styles and theme live in `dashboard/app/assets/css/main.css`; older triage/replay components use Tailwind utilities. No external UI library or web font was present to replace.

Centralized the supplied dark/light palettes, system font stacks, spacing, radii and motion tokens. Mapped incumbent utility colors to those tokens. Restyled shared fields, buttons, badges, cards, navigation, tables, dialogs, dropdowns, tabs, toasts, settings and issue/replay panels. Removed old plum palette overrides. Preserved the existing system/light/dark preference and `data-theme` mechanism; CSS defaults to dark and also recognizes `.light`.

## Files changed

- `dashboard/app/assets/css/main.css`: tokens, global styles, components and responsive rules.
- `dashboard/app/components/ui/Icon.vue`: existing icons at 16px, 1.8 stroke.
- `dashboard/app/layouts/default.vue`: compact theme-control position.
- `dashboard/app/pages/account.vue`: compact card/form spacing.
- `dashboard/app/pages/index.vue`: compact spacing and monospace project identifiers.
- `dashboard/app/pages/login.vue`: compact heading spacing.
- `dashboard/app/pages/projects/[pid]/settings.vue`: compact section spacing.
- `dashboard/app/pages/projects/[pid]/issues/[id].vue`: monospace issue identifier and updated styling comment.
- `DESIGN.md`, `.impeccable/design.json`: current design contract.
- `PRD.md`, `PROGRESS.md`, `docs/bench.md`, this report: decision and verification record.

All seven modified Vue script blocks match HEAD. No routes, API calls, business logic, copy, test semantics, dependencies, fonts, SDK or server source changed. Existing modified files under `docs/screenshots` were not overwritten.

## Verification

- Baseline and final dashboard tests: 6 files, 26 tests passed.
- `pnpm lint`: passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed, including final changes.
- `git diff --check`: passed.
- Impeccable mechanical detector: no findings. Independent review identified and closed missing invalid-field borders and identifier typography.
- Chrome: 60 route/theme/viewport captures covering projects, issues, issue detail, sessions, replay, settings, users, account, login and not-found at 1440, 900 and 390px in both themes. No page overflow or browser errors. Additional settings, menu, dialog, empty-search, focus and validation captures are under ignored `data/ui-06/`.
- Real pointer/keyboard checks: mobile navigation toggle, account dropdown/Escape/focus restoration, modal, breadcrumb empty/reset, disclosure Enter, Ignore/Escape, settings tabs, replay inspection tabs, network inspector, pointer timeline, keyboard seeking, fullscreen, device search/reset.
- Saved themes and OS-following theme behavior verified. Reduced-motion transition duration and coarse-pointer control/list target sizes checked.
- Real client-side account validation verified destructive field borders in both themes. No password API call was needed.

The build emits a non-fatal Nuxt warning that `@nuxt/nitro-server/dist/runtime/utils/cache-driver.mjs` could not be resolved and is treated as external. Exit status is zero. It also reports the existing SPA setting (`ssr: false`); server rendering was not changed. SDK/server checks were not rerun because those sources were untouched.

## Intentional limits and extensions

- Native select triggers use the supplied styling, but popup sizing, option rendering and native arrow animation remain browser/OS-controlled. Replacing them would change component behavior.
- Virtualized replay rows retain their existing 24px geometry, including on touch devices. Their JavaScript offsets depend on that height; changing CSS alone would overlap rows. Other coarse-pointer controls are at least 40px and primary navigation/menu rows at least 44px.
- Recorded replay content and its white iframe canvas are preserved; only dashboard chrome is themed.
- Existing sidebar and evidence/context composition are retained. Page titles use 20px because the brief specifies panel headings but not page titles. Modal spacing follows the 20px overlay pattern. Existing WebSocket/navigation/app marker colors map to accent/primary/success.
- The supplied accent fill and white button text are used exactly, including the requested hover opacity.
- Deployed to production on 2026-11-06 by replacing the nginx image only; SDK files and nginx config were byte-identical to the previous image.
