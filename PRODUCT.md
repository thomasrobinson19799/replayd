# replayd

Internal, self-hosted frontend error tracking and session replay for developers supporting web applications and Capacitor Android terminals. PRD.md is the product source of truth.

The daily workflow is project → issue → event/stack → replay at the error → resolution. Operators also manage capture settings and access. Fast scanning, actual recorded evidence, preserved privacy and low latency take priority over decoration.

The dashboard is an English Nuxt 4 SPA with Tailwind 4 and Pinia. It uses the existing Rust API and PostgreSQL. No frontend business fixtures or added runtime UI framework. Light/dark modes accommodate daytime and nighttime debugging; compact controls must remain readable and usable by keyboard at tablet width.

The owner explicitly requests sidebar navigation, project cards with measured activity, shared form/table/dialog primitives, and polished developer-tool conventions. On 2026-11-06 the owner selected a familiar Sentry-like workspace and delegated the remaining design choices: plum navigation, violet actions, compact evidence panels, progressive disclosure, and a separate issue-context rail. Use real recorded data and replayd's existing permissions; do not imply unsupported Sentry features.

Repository implementation is complete. Under D-34, the owner performs live staging, deployment and physical-device acceptance; those checks are recorded in docs/owner-acceptance.md. Distinguish local verification from live acceptance and do not mark unperformed checks passed. No production deployment or push.
