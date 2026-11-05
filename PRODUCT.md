# replayd

Internal, self-hosted frontend error tracking and session replay for developers supporting web applications and Capacitor Android terminals. PRD.md is the product source of truth.

The daily workflow is project → issue → event/stack → replay at the error → resolution. Operators also manage capture settings and access. Fast scanning, actual recorded evidence, preserved privacy and low latency take priority over decoration.

The dashboard is an English Nuxt 4 SPA with Tailwind 4 and Pinia. It uses the existing Rust API and PostgreSQL. No frontend business fixtures or added runtime UI framework. Light/dark modes accommodate daytime and nighttime debugging; compact controls must remain readable and usable by keyboard at tablet width.

The owner explicitly requests sidebar navigation, project cards with measured activity, shared form/table/dialog primitives, and polished developer-tool conventions. Keep blocked external integration tasks blocked. No production deployment or push.
