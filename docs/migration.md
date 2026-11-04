# Migration: Sentry → replayd (T-52)

Applies to the three terminals (fxglory, unitedpips, capitalcore: Nuxt 4, web + Capacitor APK), the WordPress sites
and the admin panels. One project per app (PRD §1); web and APK builds of a terminal share a project.

## 1. replayd side (once per app)
1. Dashboard → Projects → New: slug (e.g. `fxglory-terminal`), allowed origins: the web origin(s) **and**
   `https://localhost` (APK). Copy the DSN and the one-time **upload token** (CI secret `REPLAYD_UPLOAD_TOKEN`).
2. Settings → Telegram: bot token + chat id, "Send test message".
3. Settings → General: asset base URL = the web origin (fonts/images in APK replays).
4. Settings → Remote config: terminals keep WS capture on; marketing sites: WS off.

## 2. nginx of each web app: tunnel `/sentry` → `/_rp`
```nginx
# replaces: location /sentry { … }
location /_rp/ {
    proxy_pass https://replay.example.com/ingest/;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_http_version 1.1;
    proxy_request_buffering off;
    client_max_body_size 2m;
    access_log off;
}
```
Add each site's nginx IP (the address replayd's nginx sees the tunnel request from) to `REPLAYD_SITE_PROXIES`
(comma-separated) in replayd's compose environment, so per-IP rate limits see the real client IP. replayd's own nginx is
trusted already (fixed address `REPLAYD_NGINX_IP`, default 172.30.53.10).

## 3. Terminals (Nuxt 4)
```diff
- // plugins/sentry.client.ts (whole file)
- import * as Sentry from '@sentry/nuxt' …
```
```diff
  // nuxt.config.ts
- modules: ['@sentry/nuxt/module'],
+ modules: ['@replayd/nuxt'],
  runtimeConfig: { public: {
-   sentry: { dsn: '…' },
+   replayd: {
+     dsn: 'https://<publicKey>@replay.example.com/fxglory-terminal',
+     tunnel: '/_rp',                      // ignored under Capacitor (direct ingest)
+     environment: 'production',
+     replay: { networkDetailAllowUrls: ['self', 'apiHost'] },
+   },
  } },
- sentry: { … }, sourcemap: { client: 'hidden' }
+ sourcemap: { client: 'hidden' },
```
Config mapping (PRD §4.3): `replaysSessionSampleRate` → `replay.sampleRate`; `sampleRate` → `errors.sampleRate`;
`captureConsoleIntegration({levels})` → `errors.console`; `httpClientIntegration({failedRequestStatusCodes})` →
`errors.failedRequestStatusCodes`; `tracesSampleRate`, `browserTracingIntegration`, `enableLogs` → dropped;
release comes from `useAppConfig().app_version` automatically.

Templates: add `data-rp-throttle="1000"` to the watchlist and order-book containers (D-06), `data-rp-mask` to
anything sensitive beyond password inputs (masked always), `data-rp-block` to third-party widgets.

Code: `Sentry.captureException(e)` → `captureException(e)` from `@replayd/core`; `Sentry.setUser({ id })` →
`setUser({ id: mtLogin })`; `Sentry.setTag` → `setTag`. Remove `@sentry/*` from `package.json`.

## 4. CI (GitLab)
```yaml
upload_sourcemaps:
  stage: release
  script:
    - npx @replayd/cli sourcemaps upload --project fxglory-terminal --release "$APP_VERSION" --dir .output/public/_nuxt --url-prefix "~/_nuxt" --delete-after
  variables: { REPLAYD_URL: "https://replay.example.com", REPLAYD_TOKEN: "$REPLAYD_UPLOAD_TOKEN" }
```
Run the same job for APK builds (same release string → same maps). Remove the `sentry-cli` job and its token.

## 5. APK
No Capacitor config change (CapacitorHttp may stay on or off, D-07). Build, then run docs/apk-checklist.md.

## 6. WordPress sites
Remove the Sentry plugin/snippet, install `wordpress/replayd-wp` (zip the directory), Settings → replayd: DSN +
release. The plugin adds the WP Rocket exclusions itself (D-08). Check with "Delay JavaScript execution" on: an error
thrown before the first interaction must still arrive.

## 7. Cut-over and clean-up
- [ ] Deploy with replayd; compare one day of issue counts against Sentry.
- [ ] Remove the `/sentry` nginx location and the Sentry DSN/secrets; remove `@sentry/*` packages; cancel the plan.
- [ ] `grep -ri sentry` in each repo is empty (except the CHANGELOG).
