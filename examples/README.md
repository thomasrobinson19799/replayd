# replayd example apps (T-40)

| App | SDK entry | Error the e2e triggers |
|---|---|---|
| `html/` | IIFE `replayd.min.js` with `data-dsn` / `data-release` (WordPress style, no inline script) | `onerror` |
| `vue/` | `app.use(ReplaydVue, { dsn })` | component handler error → `vue`, component `OrderPanel` |
| `react/` | `init()` + `<ErrorBoundary>` + React 19 `createRoot(…, { onCaughtError: reactErrorHandler() })` | render error → `react`, component stack, fallback |
| `nuxt/` | `modules: ['@replayd/nuxt']`, `runtimeConfig.public.replayd`, release from `app.config.ts` `app_version` | component handler error → `vue`, component `OrderPanel` |

Packages are linked from `../sdk/packages/*` (`pnpm -C sdk build` first). `pnpm -C examples install`, then with the
stack running: `node e2e/adapters.e2e.mjs` builds each app against a fresh project and checks that exactly one
issue with the adapter's context arrives.
