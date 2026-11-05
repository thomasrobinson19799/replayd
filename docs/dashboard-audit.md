# Dashboard completion audit — 2026-11-05

Scope: PRD §5.10–5.11, §6–6.2 and the owner's dashboard overhaul request. Existing capture, ingest, decoding, redaction and database connections remain authoritative.

| Area | Baseline finding | Work |
|---|---|---|
| Users | Placeholder page; CRUD/reset/disable API already exists | Full superadmin management with confirmation and validation |
| Account | Logout and identity API exist; own-password endpoint absent | Current-password verification, atomic update/revoke other sessions, account page |
| Stats | Documented endpoint absent | Bounded 24h/7d/14d hourly events/sessions by platform, real project cards/trends |
| RBAC | API guards exist; viewer sees unusable bulk controls; project admins cannot discover users to add | Role-aware controls; add existing member by exact email without exposing the user directory |
| Deletion | Permission exists but issue/session routes absent | Admin deletion; active recording deletion disallowed to avoid racing writers |
| Issues | Most detail behavior exists; no environment filter, URL restoration incomplete | Restore filters and page from URL, environment filter, accessible table, trend and loading states |
| Sessions | Filters exist; appending all pages grows DOM; browser history not restored | Bounded page display, history restoration and clear filters |
| Replay | Progressive worker and virtualization exist; network bodies only in truncated title; no failed filter, fullscreen, search or follow toggle | Inspectable network detail, filter/search/follow controls, accessible timeline/hover preview, fullscreen |
| Settings | Six tabs exist; no dirty guard; native confirms; inconsistent feedback/labels | Shared forms, confirmation, dirty guard, toasts, tab semantics |
| Shell/design system | Plain header, light-only utilities | Responsive sidebar, project switcher, account menu, OS theme + toggle, shortcuts, reusable controls |
| Login | Generic error and busy state already exist | Polished accessible layout and safe internal return URL |
| Onboarding | DSN/token shown once, no snippets/copy | Project cards + setup screen with actual DSN/token and installation snippets |

Not in scope: canvas (D-01), SSO, backend tracing, iOS, GeoIP and external broker access. Invitation means creating an account and securely sharing its initial password; no email delivery provider exists. T-41, T-51 and T-52 remain blocked on external resources. Local stack rebuilds are verification only, never production deployment. No push.

Validation results and acceptance are recorded below as work completes.
