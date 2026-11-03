# PRD — `replayd`: Self-hosted Session Replay & Frontend Error Tracker

> Working name: **replayd** (server) / **@replayd/\*** (SDK). Rename freely.
> Status: Draft v2 · Owner: Joe · Date: 2026-11-03
> Built for: FXGlory / UnitedPips / CapitalCore terminals (web + Capacitor Android), WordPress broker sites, internal admin panels and Mega Trader deployments.
> Implementation: AI agents (Claude Code / Copilot) following §11–§12.

---

## 0. Decisions

### 0.1 Confirmed
| Area | Decision |
|---|---|
| Purpose | Replace Sentry for **frontend only**: session replay + errors/warnings. No tracing, no backend SDKs |
| Client SDK | Own lightweight SDK on `@rrweb/record`, **performance is the #1 requirement** |
| Targets | Vanilla JS (incl. WordPress via script tag), Vue 3 / Nuxt 4, React 18/19, **Capacitor Android (first-class)** |
| Browsers | **Evergreen only**: last 2 versions of Chrome, Edge, Firefox, Safari; Android System WebView 100+. Build target ES2022, no polyfills |
| Server | **Rust**, single binary |
| Recording | **Every session recorded and uploaded** (sample rate configurable, default 1.0) |
| Storage | **Local disk** (replay files) + **dedicated PostgreSQL container** (isolated from trading DBs) |
| Scale | < 10k sessions/day; architecture must handle 100× unchanged |
| Retention | **14 days** |
| Errors | Uncaught errors, unhandled rejections, `console.error/warn`, failed HTTP 4xx/5xx, Vue/React handlers, WebSocket abnormal closes |
| Error features | Source maps, issue grouping, breadcrumbs, issue status (resolve / ignore / regression) |
| TradingView charts | **Low-FPS canvas snapshots** (WebP, default 1 frame / 5 s, remotely tunable) |
| WebSocket / Centrifugo | **Lifecycle + sampled frames** |
| Dashboard | Nuxt 4 / Vue 3 SPA, **English only** |
| Access | **Per-project roles** (superadmin, project admin, member, viewer) |
| White-label | **Internal only** — Mega Trader brokers never get dashboard access |
| Alerts | **Telegram, one chat per project** |
| Ops | **Prometheus metrics + Grafana dashboard JSON + alert rules**, **Loki-friendly JSON logs** (picked up by your Alloy) |
| Proxy | nginx (not Traefik) |

### 0.2 Defaults chosen by me (change if wrong)
| Area | Default |
|---|---|
| Privacy | Record everything **except** secrets: password inputs always masked; `Authorization`, `Cookie`, `Set-Cookie`, `X-Api-Key` stripped; JSON keys `password, token, access_token, refresh_token, secret, otp, pin, cvv, card_number` redacted in HTTP bodies **and WebSocket frames** (Centrifugo connect commands carry a `token`) |
| User identity | Optional `setUser({ id, email })`, searchable; set it to the MT4/MT5 login or CRM user id |
| Transport | Web: same-origin tunnel path `/_rp/` via nginx. Capacitor: **direct** to ingest domain (relative paths resolve to `https://localhost` inside the APK) |
| Migrations | **Atlas** versioned SQL migrations, same as your other services |
| Remote config | SDK fetches per-project config from the server, so sampling / canvas / WS / kill switch can change **without shipping a new APK** |

### 0.3 Non-goals (v1)
Performance tracing, Sentry "Logs" product, Sentry protocol compatibility, backend/Go SDK, iOS, cross-origin iframe recording (third-party payment/KYC iframes stay blank), WebGL recording, GeoIP, SSO, external broker access, Persian dashboard UI.

---

## 1. Projects (initial setup)

One project per app. Web and APK builds of the same terminal share **one project** (issues group together; filter by `platform`).

| Project slug | App | Platform(s) | SDK entry |
|---|---|---|---|
| `fxglory-terminal` | FXGlory trading terminal | web, capacitor-android | `@replayd/nuxt` |
| `unitedpips-terminal` | UnitedPips trading terminal | web, capacitor-android | `@replayd/nuxt` |
| `capitalcore-terminal` | CapitalCore trading terminal | web, capacitor-android | `@replayd/nuxt` |
| `fxglory-site` | fxglory.com (WordPress) | web | IIFE script / WP plugin |
| `capitalcore-site` | CapitalCore site (WordPress / headless Nuxt) | web | IIFE or `@replayd/nuxt` |
| `admin-*` | Internal admin panels (e.g. Behkameh catering admin) | web | `@replayd/nuxt` / `@replayd/vue` |
| `megatrader-<client>` | Each Mega Trader white-label deployment | web, capacitor-android | `@replayd/nuxt` |

Per-project settings: allowed origins (incl. `https://localhost` for APKs), canvas/WS capture toggles, Telegram chat, retention, **asset base URL** (see §5.3).

---

## 2. Performance budgets (hard requirements, enforced in CI)

### 2.1 SDK
| Metric | Budget |
|---|---|
| `@replayd/core` (errors, breadcrumbs, console, HTTP, WS, transport, remote config) | **≤ 7 KB** min+gz |
| Replay chunk (rrweb record + glue), lazy | **≤ 45 KB** min+gz |
| Canvas snapshot module, lazy, loaded only if canvas enabled **and** a canvas exists | **≤ 3 KB** min+gz |
| Worker script | **≤ 4 KB** min+gz |
| Each framework adapter | **≤ 1 KB** min+gz |
| LCP / FCP impact | **0** — nothing replay-related before `load` + idle |
| Main-thread time per 500 ms batch | **< 2 ms p95** at 4× CPU throttle |
| Per WebSocket message (not sampled) | **< 5 µs** (timestamp gate only, no parsing) |
| Per canvas snapshot (main thread) | **< 3 ms** (`createImageBitmap` + transfer; encoding in worker) |
| Long tasks from SDK after initial snapshot | **none > 50 ms** |
| Initial full snapshot (3k-node DOM, e.g. terminal with order panel + watchlist) | < 50 ms desktop, < 150 ms at 4× throttle |
| In-memory queue | ≤ 5 MB (web), ≤ 20 MB IndexedDB (Capacitor) |
| Uplink (terminal session, canvas on) | target **≤ 5 KB/s avg** |

Reference low-end device for benchmarks: **mid-range Android phone running the APK** (≈ Snapdragon 6xx class) — your terminal users are on these, not desktops.

### 2.2 Server
| Metric | Budget |
|---|---|
| Ingest p99 | **< 5 ms** (respond after enqueue, not after fsync) |
| Sustained ingest | ≥ 2,000 req/s on 4 vCPU Hetzner box |
| RSS idle / load | < 60 MB / < 250 MB |
| Recording download TTFB | < 50 ms |
| Session list query (14 days, filters) | < 100 ms p95 |
| Hot path rule | **Never decompress or re-encode replay payloads on ingest** |

### 2.3 Capacity
- Segments: 10k sessions × ~8 min × 1 / 5 s ≈ **1M requests/day** (~12/s avg, ~150 peak).
- Storage per session: non-terminal ≈ 0.3–1 MB; terminal with canvas at 0.2 fps, 960 px, WebP q 0.35 (~15 KB/frame) ≈ **+1.8 MB per 10 min**.
- Assume ~60% of sessions are terminals → **~10–20 GB/day → 150–300 GB for 14 days**. Provision **≥ 500 GB NVMe** (dedicated Hetzner box or volume), alert at 75% full.

---

## 3. Architecture

```
Browser / Capacitor WebView                Server (single Rust binary)                     Storage
┌────────────────────────────┐             ┌──────────────────────────────────┐
│ @replayd/core (sync, 7KB)  │─events────▶ │ POST /ingest/:pid/events          │─batch─▶ Postgres (events, issues)
│  errors, console, HTTP, WS │             │   └─ mpsc ─▶ event workers         │
│  breadcrumbs, session      │             │       parse · symbolicate ·       │─────▶ Telegram (per project)
│  remote config             │◀─config──── │ GET  /ingest/:pid/config          │
│       │ lazy import        │             │                                  │
│ replay chunk (rrweb)       │             │ POST /ingest/:pid/replay          │
│ canvas module (lazy)       │             │   └─ sharded writers ─────────────│─append─▶ disk data/<pid>/<day>/<sid>.rpl
│       │ postMessage/transfer│            │   └─ session aggregator ──────────│─batch──▶ Postgres (sessions)
│ Worker: JSON+gzip+WebP+POST│─segments──▶ │                                  │
│ IndexedDB queue (Capacitor)│             │ /api/* (dashboard, RBAC)         │
└────────────────────────────┘             │ /metrics (Prometheus) · JSON logs│──▶ Alloy → Loki
Dashboard (Nuxt SPA) ◀──── /api ───────────│ retention job · source maps      │
                                           └──────────────────────────────────┘
```

Single process, bounded in-process channels, no Kafka/Redis/ClickHouse.

---

## 4. Client SDK

### 4.1 Packages
| Package | Contents |
|---|---|
| `@replayd/core` | `init`, `captureException`, `captureMessage`, `setUser`, `setTag(s)`, `setContext`, `addBreadcrumb`, `flush`, `close`; global handlers; console, fetch/XHR, **WebSocket** and history patching; session manager; transport; remote config; platform detection (web / capacitor-android) |
| `@replayd/core/replay` | Lazy chunk: `@rrweb/record`, batching, worker bridge |
| `@replayd/core/canvas` | Lazy chunk: low-FPS canvas snapshotter |
| `@replayd/core/capacitor` | Lazy chunk loaded only when `window.Capacitor` exists: app lifecycle hooks, device/app info, IndexedDB queue |
| `@replayd/vue` | `app.use(ReplaydVue)` → chains `app.config.errorHandler`, adds component name + lifecycle hook |
| `@replayd/nuxt` | Nuxt module: client-only plugin, `runtimeConfig.public.replayd`, release from `useAppConfig().app_version`, auto-switches to direct ingest under Capacitor |
| `@replayd/react` | `<ErrorBoundary>`, `reactErrorHandler()` for React 19 root options |
| `@replayd/vite-plugin` | Upload source maps after build, then delete `.map` from output |
| `@replayd/cli` | `replayd sourcemaps upload`, `replayd releases new` (used in GitLab CI) |
| `replayd.min.js` (IIFE) | `window.Replayd` for WordPress / plain HTML; lazy chunks loaded from same base URL |
| `replayd-wp` | Tiny WordPress plugin: settings page (DSN, release), enqueues script **marked to be excluded from WP Rocket "Delay JS" / combine / minify** |

Rules: zero runtime deps in core, `sideEffects: false`, ESM + IIFE, `@rrweb/record` pinned exactly. Routers need no integration (history patch).

### 4.2 Nuxt usage (replaces your current plugin)
```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['@replayd/nuxt'],
  runtimeConfig: { public: { replayd: {
    dsn: 'https://<publicKey>@replay.example.com/<projectId>',
    tunnel: '/_rp',                        // ignored under Capacitor
    environment: 'production',
    networkDetailAllowUrls: ['self', 'apiHost'], // 'apiHost' → runtimeConfig.public.apiHost
  } } },
})
```
Equivalent core API:
```ts
init({
  dsn, tunnel: '/_rp', release, environment,
  replay: {
    sampleRate: 1.0, start: 'idle',
    networkDetailAllowUrls: [location.origin, apiHost],
    networkCaptureBodies: true,
    maskAllText: false, maskAllInputs: false,      // password inputs always masked
    blockSelector: '[data-rp-block]', maskSelector: '[data-rp-mask]',
    canvas: { enabled: true, fps: 0.2, maxWidth: 960, quality: 0.35, selector: 'canvas' },
  },
  websocket: {
    enabled: true,
    urls: [/centrifugo/, /\/connection\/websocket/],
    sample: { perChannelPerSec: 1, maxFramesPerSec: 20, maxFrameBytes: 2048, outgoing: 'all' },
    channelOf: 'centrifugo-json',                   // or (raw: string) => string | null
  },
  errors: {
    sampleRate: 1.0, console: ['error', 'warn'],
    failedRequestStatusCodes: [[400, 599]],
    ignoreErrors: [/ResizeObserver loop/, 'Script error.'],
    denyUrls: [/extensions\//, /^chrome:\/\//],
  },
  redact: { headers: [...], bodyKeys: [...], queryParams: ['token', 'key', 'signature'] },
  beforeSend: (event) => event,
})
```

### 4.3 Mapping from your current Sentry config
| Current | replayd |
|---|---|
| `replaysSessionSampleRate: 1.0` | `replay.sampleRate: 1.0` |
| `replaysOnErrorSampleRate` | n/a (all sessions recorded) |
| `sampleRate` | `errors.sampleRate` |
| `tunnel: "/sentry"` | `tunnel: "/_rp"` |
| `tracesSampleRate`, `browserTracingIntegration` | dropped |
| `captureConsoleIntegration({levels})` | `errors.console` |
| `httpClientIntegration({failedRequestStatusCodes})` | `errors.failedRequestStatusCodes` |
| `replayIntegration({...})` | `replay.{...}` (same option names) |
| `networkDetailAllowUrls: [origin, apiHost]` | same, or `['self','apiHost']` in Nuxt module |
| `enableLogs` | dropped; console tab covers it |
| `sendDefaultPii: false` | IP never stored |
| `release: useAppConfig().app_version` | automatic in Nuxt module |

### 4.4 Startup sequence
1. `init()` synchronous (< 1 ms): error/rejection listeners, console/fetch/XHR/WebSocket/history patches. Pre-replay activity goes to a 100-entry ring buffer.
2. After `load` → `requestIdleCallback` (2 s timeout): fetch remote config (cached 10 min in `localStorage`, non-blocking; stale config used immediately), sample check, `import('./replay')`.
3. Replay chunk starts Worker + rrweb, takes full snapshot, replays ring buffer as custom events with original timestamps.
4. Canvas module loads only if `canvas.enabled` and a matching canvas exists (checked on snapshot and on mutation, throttled).
5. Under Capacitor, `./capacitor` chunk loads in step 2.

### 4.5 Session management
- Session = one tab / one app process. `sid` (UUIDv7), `seq`, `startedAt`, `lastActivity` in `sessionStorage` (Capacitor: `localStorage`, since WebView process may be killed while backgrounded).
- New session: idle > 15 min, duration > 60 min, or storage missing. Capacitor: app resumed after > 15 min in background → new session.
- Sampling decided once per session.

### 4.6 Replay recording
```ts
record({
  emit,                                   // push into array only
  checkoutEveryNms: 10 * 60_000,
  sampling: { mousemove: 50, mouseInteraction: true, scroll: 150, media: 800, input: 'last' },
  maskInputOptions: { password: true },
  recordCanvas: false,                    // replaced by our own snapshotter (§4.7)
  collectFonts: false, inlineImages: false,
  inlineStylesheet: true, slimDOMOptions: 'all',
  recordCrossOriginIframes: false,        // same-origin TradingView iframe is still recorded
})
```
- **Mutation guard:** batch > 10,000 nodes → new full snapshot instead (order book / history tables).
- Custom events via `record.addCustomEvent`: `console`, `network`, `ws`, `error`, `nav`, `breadcrumb`, `app` (Capacitor lifecycle), `gap` (dropped data).
- High-frequency DOM updates (price cells ticking in watchlist/order book) are the biggest replay cost. Provide `data-rp-throttle="500"` attribute: text mutations inside it are coalesced to at most one per N ms (implemented as rrweb mutation filter in our glue). Recommend it on watchlist and order-book containers.

### 4.7 Canvas snapshots (TradingView)
TradingView Charting Library renders 2D canvases inside a **same-origin iframe** (self-hosted library), so we can reach them.
- Every `1/fps` seconds (default 5 s), for each matching **visible** canvas (main document + same-origin iframes, found via rrweb mirror):
  - Skip if tab hidden, canvas size 0, or previous encode still in flight.
  - `createImageBitmap(canvas)` → transfer to worker (zero-copy).
  - Worker: `OffscreenCanvas` downscale to `maxWidth`, `convertToBlob({type:'image/webp', quality})`.
  - Compare 64-bit perceptual hash (8×8 average hash) with previous frame for that canvas; **skip if unchanged** (weekend / idle chart costs nothing).
  - Emit `canvas` custom event `{ nodeId, w, h, assetId }`; bytes go into the segment's **asset section** (binary, not base64 JSON — §4.10).
- TradingView paints several stacked canvases (pane + crosshair layers): composite all canvases of one chart container into one bitmap in the worker when they share a parent (`canvas.selector` + `canvas.groupBy: '.chart-gui-wrapper'`, configurable).
- Device guard: `navigator.hardwareConcurrency <= 4` → fps halved. Remote config can disable per project instantly.
- Per-session canvas cap 30 MB; after that canvas capture stops and a `gap` event is emitted.
- **Spike required (T-02)**: confirm composite approach with the TV version in use (v27).

### 4.8 WebSocket capture (Centrifugo)
Patch `window.WebSocket` (constructor wrapper preserving prototype/statics; Centrifuge v5 uses native WebSocket).

**Lifecycle (always, for matching URLs):** open (url without query secrets, protocols), close (code, reason, wasClean, duration), error, reconnect count per URL. → `ws` custom events + breadcrumbs. Counters into session meta (`ws_disconnects`).

**Frames (sampled):**
- Hot path per incoming message: check `now - lastSampleAt[socket] >= 1000 / maxFramesPerSec`; if not, return. **No parsing, no string copy.**
- If gate passes: push `{dir, ts, raw: data.slice(0, maxFrameBytes)}` (strings only; binary/protobuf frames recorded as `{binary, size}`).
- Worker does the rest: split Centrifugo JSON batches (newline-delimited), extract `push.channel`, apply per-channel 1/s sampling, redact keys, store.
- Outgoing frames (subscribe, rpc, publish, connect) captured **all**, redacted (connect `token`, `data` keys from denylist) — low volume, high debugging value.
- **Errors:** abnormal close (code ≠ 1000/1001, or > 3 reconnects in 60 s) → `warning` event `WebSocket closed abnormally (code 1006)` fingerprinted by host + path + code, rate limited 1/min/session.
- Also patch `EventSource` lifecycle (open/error) for SSE endpoints.

### 4.9 Capacitor Android (first-class)
- Detect `window.Capacitor?.isNativePlatform()`; `platform = 'capacitor-android'`.
- App/device info via `Capacitor.Plugins.App.getInfo()` / `Device.getInfo()` **if present** (no hard dependency): app version + build, device model, Android version, WebView version → session meta and event tags.
- Lifecycle: `App` `pause` → flush everything (worker) and persist pending to IndexedDB; `resume` → resume uploads, new session if > 15 min. `appStateChange`, `backButton` as `app` breadcrumbs.
- **IndexedDB offline queue** (Capacitor only by default; `offlineQueue: true` enables on web): segments/events persisted when upload fails or app pauses; drained oldest-first on `online`/`resume`; cap 20 MB, max age 24 h, `gap` marker if dropped.
- Transport: always **direct** ingest URL (`tunnel` ignored); allowed origin `https://localhost`.
- **CapacitorHttp:** when enabled it replaces `fetch`/XHR with a native bridge. SDK must patch **after** the bridge is installed and handle bridge responses (no streaming body, clone semantics differ). **Spike required (T-03)** with CapacitorHttp on and off.
- Source maps: bundle URLs are `https://localhost/_nuxt/…`; server normalizes to `~/_nuxt/…` so the same uploaded maps serve web and APK builds of the same release.

### 4.10 Batching, worker, wire format
- Main thread: push events into array. Every 500 ms or 300 events → `postMessage` (array swapped, not copied); canvas bitmaps transferred.
- Worker flushes a segment on: 5 s, raw events ≥ 256 KB, page hidden / app pause, error captured.
- Flush: `JSON.stringify` → `CompressionStream('gzip')` → build body → `fetch(keepalive: size < 60 KB)`. On hide/pause, if body > 60 KB: send events-only segment via keepalive, defer assets to IndexedDB (Capacitor) or drop with `gap` (web).
- Retry: exp. backoff 1 s → 60 s, max 5 attempts; honor `429/503 Retry-After`; queue cap 5 MB (web) drop-oldest.

**Body (`POST /ingest/:pid/replay`), little-endian:**
```
u16 meta_len | meta JSON
u32 events_len | events (gzip JSON array of rrweb events)
u16 asset_count | { u32 asset_id | u8 type (1=webp) | u32 len | bytes } × asset_count
```
`meta`:
```json
{
  "sid":"…","seq":17,"t0":1730620000123,"t1":1730620005120,"enc":"gzip","n":412,
  "urls":["https://terminal.fxglory.com/trade"],"clicks":3,"errs":0,"warns":1,"has_error":false,
  "ws_disc":0,"canvas_bytes":28311,"gap":false,
  "init":{"url":"…","ref":"…","ua":"…","vw":412,"vh":915,"lang":"fa-IR","release":"1.42.0","env":"production",
          "platform":"capacitor-android","app_ver":"1.42.0 (142)","device":"SM-A525F","os_ver":"14","wv_ver":"130.0",
          "user":{"id":"10023451"},"tags":{"brand":"fxglory"}}
}
```

### 4.11 Errors, network, console
- **Errors:** sources per §0.1. Raw `stack` string sent; **parsing on server**. Client flood control: signature = type + message + first stack line; first sent, then ≤ 1 per 10 s with `count`; caps 100/session, 20/min. Each event carries `sid` + `ts`, is mirrored into the replay as an `error` event and forces a segment flush. Batched every 2 s / 10 events to `POST /ingest/:pid/events` (gzip JSON).
- **Network:** fetch/XHR patched; method, redacted URL, status, timings, sizes. Headers/bodies only for allowlisted URLs; text types only; caps 10 KB req / 50 KB res; body read async via `clone().text()` after the app gets the response; **skip** `text/event-stream`, octet-stream, unknown-length large bodies. JSON redaction recursive (depth 8). Ingest URL never recorded.
- **Console:** all levels to replay console tab; safe stringify depth 3, 1 KB/arg, 5 args, circular-safe; originals called first.
- SDK never throws into the app; internal error counter in `meta`; `X-Replayd-Disable: <seconds>` response header or remote config kill switch stops capture.

Error event schema:
```json
{
  "id":"uuidv7","ts":1730620001234,"sid":"…","level":"error|warning",
  "source":"onerror|unhandledrejection|console|http|ws|vue|react",
  "type":"TypeError","message":"…","stack":"raw",
  "url":"…","release":"1.42.0","env":"production","platform":"web|capacitor-android",
  "user":{"id":"10023451"},"tags":{"brand":"fxglory"},
  "ctx":{"component":"OrderPanel","info":"mounted hook",
         "http":{"method":"POST","url":"…","status":500,"ms":231},
         "ws":{"url":"wss://…/connection/websocket","code":1006,"reconnects":4},
         "app":{"version":"1.42.0 (142)","device":"SM-A525F","os":"14","webview":"130.0"}},
  "breadcrumbs":[{"ts":0,"cat":"click|nav|console|http|ws|app|custom","msg":"…","data":{}}],
  "count":1
}
```

### 4.12 Remote config (`GET /ingest/:pid/config?key=…`)
```json
{ "v":3, "disabled":false, "replay":{"sampleRate":1.0},
  "canvas":{"enabled":true,"fps":0.2,"maxWidth":960,"quality":0.35},
  "ws":{"enabled":true,"perChannelPerSec":1,"maxFramesPerSec":20},
  "errors":{"sampleRate":1.0}, "ttl":600 }
```
Merged over local config (remote wins for rates/toggles, never for redaction lists — those can only be **extended** remotely). Edited per project in the dashboard.

### 4.13 WordPress
- `replayd-wp` plugin or manual `<script src="/_rp/sdk/replayd.min.js" data-dsn="…" data-release="…" defer>` (SDK files served by replayd through the same tunnel → same-origin, no ad-block, cacheable 1 year with versioned paths).
- Must be excluded from WP Rocket **Delay JavaScript execution**, combine and minify, otherwise errors before first interaction are lost. Plugin adds the exclusion via WP Rocket filters automatically.
- Default for marketing sites: canvas off, WS off.

---

## 5. Server (Rust)

### 5.1 Stack
| Concern | Choice |
|---|---|
| Runtime / HTTP | `tokio`, `axum`, `hyper`, `tower-http` |
| Allocator | `mimalloc` |
| Postgres | `tokio-postgres` + `deadpool-postgres`, binary `COPY` for batches |
| Migrations | **Atlas** (`migrations/*.sql`), applied in deploy step |
| JSON | `serde`, `serde_json` |
| Source maps | `sourcemap` crate, LRU of parsed maps |
| UA | `woothee` (once per session) |
| Auth | `argon2id`, 256-bit random session tokens |
| Telegram | `reqwest` (rustls) |
| Concurrency maps | `dashmap` |
| Logs | `tracing` + `tracing-subscriber` JSON to stdout |
| Metrics | `metrics` + `metrics-exporter-prometheus` at `/metrics` |
| Config | TOML + env overrides |
| Image | static musl binary, distroless image in GitLab registry |

### 5.2 Ingest
| Method | Path | Notes |
|---|---|---|
| POST | `/ingest/:pid/replay?key=` | ≤ 2 MB (assets). Parse meta, enqueue `Bytes` to shard writer, `202` |
| POST | `/ingest/:pid/events?key=` | ≤ 512 KB gzip JSON. Enqueue, `202` |
| GET | `/ingest/:pid/config?key=` | Remote config, `Cache-Control: max-age=300`, ETag |
| GET | `/ingest/sdk/:version/*` | Serves SDK IIFE + lazy chunks (immutable cache) |
| OPTIONS | all | CORS, `Max-Age: 86400` |

Validation (in-memory only): project + public key → Origin allowlist (or trusted-proxy IP + `X-Forwarded-For` for tunnel) → token bucket per project and per IP → gzip magic check → bounded `try_send`; full → `503 Retry-After: 5`.

### 5.3 Replay storage
```
data/<project_id>/<YYYY-MM-DD of session start>/<sid>.rpl
```
`.rpl`: header `"RPL2" | u16 version | 16-byte sid`, then frames
`u32 len | u32 seq | u64 t0 | u64 t1 | u32 received_at | u8 flags | body-without-meta`.
- **Sharded single writer** per `hash(sid) % cores`, `O_APPEND`, per-shard LRU of 2,000 open fds (60 s idle close).
- Group `fdatasync` every 1 s (≤ 1 s loss on crash).
- Dedup by seq (in-memory bitset per active session; reader dedups too). Out-of-order allowed.
- Immutable after session ends → long cache.
- **Asset base URL per project:** viewer rewrites `https://localhost/` (APK) and other build-time origins to e.g. `https://terminal.fxglory.com/` so images/fonts (Persian fonts like Vazirmatn/IRANSans) resolve during playback. Stored in project settings, applied client-side in the viewer.

### 5.4 Session aggregator
In-memory `HashMap<sid, SessionAgg>` from segment meta; flushed every 3 s via multi-row upsert; session `ended` after 15 min silence (sweep 60 s). UA parsed once.

### 5.5 Error pipeline
1. Bounded mpsc → 2–4 workers.
2. Parse stacks (V8, SpiderMonkey, JSC). Normalize URLs: strip origin → `~/path` (makes `https://localhost/_nuxt/x.js` == `https://terminal.fxglory.com/_nuxt/x.js`).
3. Symbolicate via `(project, release, ~/path)` → cached map → original frame + 5 lines context; `in_app` unless `node_modules` / third-party (TradingView library paths marked not in-app).
4. Fingerprint = `sha1(project, type, normalized message, top 5 in-app frames)`. HTTP: `method + status + path template`. WS: `host + path + close code`. Message normalization strips numbers, UUIDs, hex, quoted strings, **MT login ids and symbols** (`EURUSD`, `XAUUSD.m`) via configurable regex list.
5. Upsert issue; detect new / regression; batch insert events via `COPY` (1 s or 500 rows).
6. Alerts (§5.7). Reprocess on source map upload for unsymbolicated issues of that release.

### 5.6 Source maps
- `POST /api/projects/:pid/releases/:release/sourcemaps` (multipart, per-project upload token).
- `@replayd/vite-plugin` / `@replayd/cli` from **GitLab CI** after `nuxt generate`/`build`:
  ```yaml
  upload_sourcemaps:
    stage: release
    script:
      - npx @replayd/cli sourcemaps upload --project fxglory-terminal --release "$APP_VERSION" --dir .output/public/_nuxt --url-prefix "~/_nuxt" --delete-after
    variables: { REPLAYD_URL: "https://replay.example.com", REPLAYD_TOKEN: "$REPLAYD_UPLOAD_TOKEN" }
  ```
- Same job runs for APK builds (same release string → same maps).
- Stored in `data/_sourcemaps/<pid>/<release>/`, deleted 30 days after the release's last event.

### 5.7 Telegram
One chat per project (bot token + chat id). Alerts: **new issue**, **regression**, **spike** (default 50 events / 5 min). Dedup one alert per issue per kind per 30 min; ≤ 20 msgs/min per chat; retries 3×. Message: project, level, platform, title, culprit, release, count, users, links to issue and to latest replay at the error moment. Warnings: new-issue alerts off by default (toggle).

### 5.8 Retention
Daily 03:00 (Asia/Tehran): drop `sessions`/`events` daily partitions older than retention (partitions pre-created 7 days ahead), `rm -r data/<pid>/<day>`, delete issues with `last_seen` beyond retention. Per-project retention ≤ 14 by default.

### 5.9 PostgreSQL schema (sketch, Atlas migration 0001)
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE users (
  id serial PRIMARY KEY, email text UNIQUE NOT NULL, name text,
  password_hash text NOT NULL, is_superadmin bool NOT NULL DEFAULT false,
  disabled bool NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE user_sessions (token_hash bytea PRIMARY KEY, user_id int NOT NULL REFERENCES users, expires_at timestamptz NOT NULL);

CREATE TABLE projects (
  id serial PRIMARY KEY, slug text UNIQUE NOT NULL, name text NOT NULL,
  public_key text NOT NULL, upload_token_hash bytea NOT NULL,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  asset_base_url text, asset_rewrite_from text[] NOT NULL DEFAULT '{https://localhost}',
  retention_days int NOT NULL DEFAULT 14,
  remote_config jsonb NOT NULL DEFAULT '{}',
  telegram jsonb,                 -- {bot_token, chat_id, new_issue, regression, spike:{n,minutes}, warnings}
  fingerprint_rules jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE project_role AS ENUM ('admin','member','viewer');
CREATE TABLE project_members (
  project_id int REFERENCES projects ON DELETE CASCADE,
  user_id int REFERENCES users ON DELETE CASCADE,
  role project_role NOT NULL, PRIMARY KEY (project_id, user_id)
);

CREATE TABLE sessions (
  id uuid NOT NULL, project_id int NOT NULL,
  started_at timestamptz NOT NULL, last_at timestamptz NOT NULL, ended bool NOT NULL DEFAULT false,
  duration_ms int NOT NULL DEFAULT 0, entry_url text, urls text NOT NULL DEFAULT '',
  user_id text, user_email text, release text, environment text,
  platform text NOT NULL DEFAULT 'web', app_version text, device_model text, os_version text, webview_version text,
  browser text, browser_ver text, os text, vw int, vh int, lang text, tags jsonb,
  error_count int NOT NULL DEFAULT 0, warn_count int NOT NULL DEFAULT 0, click_count int NOT NULL DEFAULT 0,
  ws_disconnects int NOT NULL DEFAULT 0, segments int NOT NULL DEFAULT 0,
  bytes bigint NOT NULL DEFAULT 0, canvas_bytes bigint NOT NULL DEFAULT 0, has_gap bool NOT NULL DEFAULT false,
  file_day date NOT NULL,
  PRIMARY KEY (id, started_at)
) PARTITION BY RANGE (started_at);
CREATE INDEX ON sessions (project_id, started_at DESC);
CREATE INDEX ON sessions (project_id, user_id) WHERE user_id IS NOT NULL;
CREATE INDEX ON sessions (project_id, started_at DESC) WHERE error_count > 0;
CREATE INDEX ON sessions (project_id, platform, started_at DESC);
CREATE INDEX ON sessions USING gin (urls gin_trgm_ops);

CREATE TABLE issues (
  id bigserial PRIMARY KEY, project_id int NOT NULL, fingerprint bytea NOT NULL,
  level text NOT NULL, source text NOT NULL, type text, title text NOT NULL, culprit text,
  status text NOT NULL DEFAULT 'unresolved', resolved_at timestamptz, resolved_in_release text,
  resolved_by int REFERENCES users, ignore_until timestamptz,
  first_seen timestamptz NOT NULL, last_seen timestamptz NOT NULL,
  first_release text, last_release text, platforms text[] NOT NULL DEFAULT '{}',
  times_seen bigint NOT NULL DEFAULT 0, users_seen int NOT NULL DEFAULT 0,
  symbolicated bool NOT NULL DEFAULT false,
  UNIQUE (project_id, fingerprint)
);
CREATE INDEX ON issues (project_id, status, last_seen DESC);

CREATE TABLE events (
  id uuid NOT NULL, issue_id bigint NOT NULL, project_id int NOT NULL, ts timestamptz NOT NULL,
  session_id uuid, level text, release text, environment text, platform text,
  url text, user_id text, browser text, os text, app_version text,
  payload jsonb NOT NULL,
  PRIMARY KEY (id, ts)
) PARTITION BY RANGE (ts);
CREATE INDEX ON events (issue_id, ts DESC);
CREATE INDEX ON events (session_id);

CREATE TABLE releases (project_id int, version text, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (project_id, version));
CREATE TABLE alerts_sent (project_id int, issue_id bigint, kind text, sent_at timestamptz, PRIMARY KEY (issue_id, kind, sent_at));
CREATE TABLE audit_log (id bigserial PRIMARY KEY, user_id int, action text, target text, data jsonb, at timestamptz DEFAULT now());
```
Postgres: dedicated container, `synchronous_commit = off` for app role, autovacuum tuned on `issues`.

### 5.10 RBAC
| Permission | superadmin | project admin | member | viewer |
|---|---|---|---|---|
| Create projects, manage users | ✔ | | | |
| Project settings, keys, Telegram, remote config, members | ✔ | ✔ | | |
| View issues, sessions, replays | ✔ | ✔ | ✔ | ✔ |
| View network headers/bodies & WS frame contents | ✔ | ✔ | ✔ | ✖ (redacted in API) |
| Change issue status | ✔ | ✔ | ✔ | ✖ |
| Delete sessions / issues | ✔ | ✔ | | |

Enforced in the API layer per request (`project_members` cached in memory, invalidated on change). All admin actions → `audit_log`.

### 5.11 Dashboard API (`/api/*`)
| Endpoint | Purpose |
|---|---|
| `POST /api/auth/login`, `/logout`, `GET /api/me` | Auth (login rate-limited, CSRF token) |
| `/api/users` CRUD | superadmin |
| `/api/projects` CRUD, `/api/projects/:pid/members` | Projects, keys, origins, asset base URL, Telegram, remote config |
| `GET /api/projects/:pid/sessions?from&to&user&url&release&platform&app_version&browser&os&has_error&has_ws_disconnect&min_duration&cursor` | Keyset pagination, 50/page |
| `GET /api/sessions/:sid` | Meta + error events |
| `GET /api/sessions/:sid/recording` | Raw `.rpl`, `Range`, `ETag`, immutable when ended (viewer role: server strips network bodies & WS payloads → requires decoding; implement as a filtered stream in a worker task, cached) |
| `GET /api/projects/:pid/issues?status&level&source&platform&release&q&sort` | Issue list |
| `GET /api/issues/:id`, `/events?cursor`, `PATCH /api/issues/:id`, bulk `PATCH /api/issues` | Detail, status |
| `GET /api/projects/:pid/stats?range=24h|7d|14d` | Events/sessions per hour, by platform |
| `POST /api/projects/:pid/releases/:rel/sourcemaps` | Upload token auth |
| `GET /metrics`, `GET /healthz` | Ops |

---

## 6. Dashboard (Nuxt 4 SPA, English)
`ssr: false`, Tailwind, Pinia, served by nginx. Reuse your DataTable component patterns for lists.

Pages: Login · Projects (+ settings tabs: General, Keys & DSN, Members, Telegram, Remote config, Fingerprint rules) · Issues · Issue detail · Sessions · Replay player · Users (superadmin).

### 6.1 Issue detail
Symbolicated stack (in-app toggle, context lines), breadcrumbs, tags (platform, app version, device, browser, release, brand), event navigation, **"Play replay at this moment"**, resolve / resolve in next release / ignore (until date, until N more events, forever), platform split (web vs APK counts).

### 6.2 Replay player
- `rrweb` Replayer, custom controls, skip inactivity, 1×–8×.
- **Decode worker:** streamed fetch of `.rpl`, sort/dedup seq, `DecompressionStream` per frame, assets → blob URLs, apply asset base URL rewrite, progressive playback from first full snapshot.
- Canvas: `canvas` events draw the WebP onto the replayed canvas node (rrweb replay plugin), so the TradingView chart updates every few seconds.
- RTL/Persian content renders as recorded (dir attributes preserved); fonts via asset rewrite.
- **Timeline markers:** errors, warnings, WS disconnects, navigations, app pause/resume, gaps.
- **Tabs** (virtualized, synced to playhead): **Console**, **Network** (headers, pretty JSON bodies, failed-only filter), **WebSocket** (connections list with lifecycle; frames by channel, direction filter, search), **Errors**, **Breadcrumbs**, **Device** (platform, app/WebView version, viewport).
- Deep link `/replay/:sid?t=<ms>`.

---

## 7. Observability (your Grafana / Loki / Prometheus)
**Metrics (`/metrics`):**
`replayd_ingest_requests_total{project,kind,status}`, `replayd_ingest_latency_seconds` (histogram), `replayd_ingest_bytes_total{project,kind}`, `replayd_queue_depth{queue}`, `replayd_queue_rejected_total{queue}`, `replayd_writer_fsync_seconds`, `replayd_open_files`, `replayd_sessions_active{project}`, `replayd_events_processed_total{project,level}`, `replayd_symbolication_failures_total{project}`, `replayd_issues_new_total{project}`, `replayd_telegram_sent_total{result}`, `replayd_disk_used_bytes`, `replayd_disk_free_bytes`, `replayd_pg_batch_seconds{table}`, `replayd_sdk_internal_errors_total{project}` (from meta).

**Deliverables in `deploy/observability/`:** Grafana dashboard JSON (ingest rate/latency, queue depth, disk, per-project volume, top projects by bytes, symbolication failures), Prometheus alert rules → your existing Alertmanager → Telegram: disk > 75%, queue rejections > 0 for 5 min, ingest p99 > 20 ms, no ingest from a project for 30 min (SDK broken after deploy), Postgres batch errors.

**Logs:** JSON to stdout, fields `ts, level, msg, target, project, sid, req_id, latency_ms`; never log payloads, keys or tokens. Loki labels kept low-cardinality (`app=replayd, level`).

---

## 8. Security & privacy
Public key + Origin allowlist + rate limits + size caps on ingest; upload tokens and passwords hashed; client IP never stored; all redaction in the SDK before data leaves the device; password inputs always masked; viewer role cannot see bodies/frames; replays play in rrweb's sandboxed iframe; dashboard cookie HttpOnly/Secure/SameSite=Lax + CSRF; audit log; TLS at nginx; dashboard optionally IP-allowlisted in nginx (office/VPN).

---

## 9. Deployment
- `deploy/docker-compose.yml`: `replayd`, `postgres:17` (dedicated, own volume), `nginx` (TLS, dashboard static, `/ingest` and `/api` proxy), `atlas` one-shot migrate job.
- Data volume on local NVMe ≥ 500 GB.
- Per-site nginx tunnel:
  ```nginx
  location /_rp/ {
    proxy_pass https://replay.example.com/ingest/;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_request_buffering off;
    client_max_body_size 2m;
  }
  ```
- Images built in GitLab CI, pushed to your GitLab registry.
- Backups: daily `pg_dump`; replay files not backed up.

---

## 10. Testing & benchmarks
**SDK:** `size-limit` gate (§2.1) · Vitest unit tests (redaction incl. Centrifugo connect token, flood control, session rollover, WS sampling gate, wire format, IndexedDB queue) · Playwright perf suite at 4× throttle on: simple form, terminal mock (3k nodes, ticking watchlist at 10 updates/s, TradingView iframe with canvases, Centrifugo WS at 200 msg/s), WordPress page with WP Rocket-style deferred scripts, SSE page · compare **no SDK vs replayd vs your current Sentry config**; replayd must beat Sentry on TBT, long tasks, INP, heap, bytes uploaded · Real-device run of the APK on a mid-range Android via Chrome remote debugging (manual checklist per release).

**Server:** stack parser fixtures per engine; URL normalization (`https://localhost` ⇄ web origin); symbolication; fingerprinting incl. symbol/login stripping; `.rpl` writer/reader; RBAC matrix tests; testcontainers Postgres integration; `oha`/`k6` 2k req/s 10 min (p99 < 5 ms, RSS < 250 MB); `kill -9` crash test (≤ 1 s loss, files readable).

---

## 11. Repository layout (GitLab monorepo)
```
replayd/
  AGENTS.md / CLAUDE.md          # agent rules (§12.1), links to this PRD
  .github/copilot-instructions.md
  PRD.md
  server/                        # Cargo workspace
    crates/
      common/                    # config, ids, wire format, errors
      ingest/                    # axum handlers, validation, rate limit
      storage/                   # .rpl writer/reader, shards, retention (disk)
      pipeline/                  # stack parsing, symbolication, fingerprint, issues
      alerts/                    # telegram
      api/                       # dashboard API, auth, RBAC
      db/                        # pg pool, COPY batches, partitions
    bin/replayd/
    migrations/                  # Atlas SQL
  sdk/                           # pnpm workspace
    packages/core  vue  nuxt  react  vite-plugin  cli
    wp-plugin/
    bench/                       # Playwright perf pages + scripts
  dashboard/                     # Nuxt 4 SPA
  deploy/  docker-compose.yml  nginx/  observability/
  .gitlab-ci.yml
```
CI: `sdk:lint-test`, `sdk:size`, `server:clippy-test`, `dashboard:build`, `bench:nightly`, `image:build-push`.

---

## 12. Implementation plan for AI agents

### 12.1 Agent rules (copy into AGENTS.md / CLAUDE.md)
1. This PRD is the source of truth; if code and PRD disagree, stop and ask.
2. One task per branch/MR; task ID in branch name (`t-14-ws-capture`).
3. **No new runtime dependency in `sdk/packages/core` ever.** Any new SDK dependency requires running `pnpm size` and staying within §2.1.
4. Never parse, stringify or allocate per WebSocket message / mutation on the main thread beyond what the task specifies; heavy work goes to the worker.
5. Never decompress replay payloads in the server ingest path.
6. Every task ends with: tests passing, `pnpm size` / `cargo clippy -D warnings` clean, acceptance criteria checked in the MR description.
7. Never log tokens, keys, payloads; never weaken redaction defaults.
8. Spikes (T-01…T-04) produce a short `docs/spikes/<id>.md` with findings before dependent tasks start.

### 12.2 Tasks
| ID | Task | Depends | Acceptance criteria |
|---|---|---|---|
| T-01 | Spike: rrweb record cost on terminal mock | – | Report snapshot time + per-batch cost at 4× throttle; confirm `data-rp-throttle` approach |
| T-02 | Spike: TradingView v27 canvas capture | – | Bitmap capture of composited chart from same-origin iframe in worker, WebP size per frame measured |
| T-03 | Spike: CapacitorHttp + fetch/XHR patch | – | Works with CapacitorHttp on/off; documented init order |
| T-04 | Spike: WP Rocket exclusion | – | SDK runs before interaction with Delay JS enabled |
| T-10 | Monorepo scaffold, CI, size-limit, Atlas, compose | – | All CI jobs green on empty packages |
| T-11 | Wire format + `.rpl` format in `common` (Rust) + TS encoder | T-10 | Round-trip tests Rust⇄TS fixtures |
| T-12 | Core SDK: init, session manager, transport, retry, ring buffer | T-10 | Unit tests; core ≤ 4 KB at this stage |
| T-13 | Core SDK: errors (onerror, rejection, console, HTTP), flood control, redaction | T-12 | Tests for each source + redaction |
| T-14 | Core SDK: WebSocket + EventSource patch, gate, outgoing capture | T-12 | < 5 µs per unsampled message in bench; Centrifugo token redacted |
| T-15 | Server: ingest events + remote config + project cache + rate limits | T-11 | p99 < 5 ms in load test |
| T-16 | Server: stack parsing, URL normalization, fingerprint, issues upsert, COPY batches | T-15 | Fixture tests per engine; localhost ⇄ web URLs group together |
| T-17 | Server: auth, users, projects, members, RBAC | T-10 | RBAC matrix tests |
| T-18 | Dashboard: login, projects, issues list/detail | T-16, T-17 | End-to-end: error in Nuxt test app visible within 5 s |
| T-20 | SDK replay chunk: lazy load, rrweb, worker, segments, page-hide flush | T-12, T-01 | Perf suite within §2.1 |
| T-21 | Server: replay ingest, shard writers, fsync, dedup, aggregator | T-11, T-15 | Crash test ≤ 1 s loss |
| T-22 | Dashboard: sessions list + filters | T-21 | Query < 100 ms on 140k sessions seed |
| T-23 | Dashboard: player, decode worker, timeline, console/network/errors tabs | T-21 | Plays 60-min session progressively, < 1 s to first frame |
| T-24 | Canvas snapshotter + asset section + player canvas plugin | T-20, T-02 | ≤ 3 ms main thread per snapshot; unchanged frames skipped |
| T-25 | WS tab in player | T-14, T-23 | Frames grouped by channel, synced |
| T-26 | Capacitor module: lifecycle, device info, IndexedDB queue, direct transport | T-20, T-03 | Offline → online drains queue on device |
| T-30 | Source maps: upload API, CLI, Vite plugin, symbolication, reprocess | T-16 | Original TS/Vue lines shown for web and APK builds |
| T-31 | Issue status: resolve / in next release / ignore / regression | T-16 | Regression reopens + alerts |
| T-32 | Telegram alerts per project | T-31 | Dedup + rate limit tests |
| T-33 | Retention: partitions + disk cleanup | T-21 | 15-day seed reduced to 14 days, O(days) |
| T-34 | Remote config editor in dashboard | T-15 | Change canvas fps, APK picks it up within 10 min |
| T-35 | Viewer-role redaction of bodies/frames | T-23, T-17 | Viewer API responses contain no bodies/frames |
| T-40 | `@replayd/nuxt`, `@replayd/vue`, `@replayd/react`, IIFE build | T-13, T-20 | Example apps for each; adapters ≤ 1 KB |
| T-41 | `replayd-wp` plugin | T-40, T-04 | Installed on staging fxglory.com, errors + replays arrive |
| T-50 | Observability: metrics, JSON logs, Grafana JSON, alert rules | T-21 | Dashboard imports cleanly into your Grafana |
| T-51 | Benchmarks vs current Sentry config, real-device APK checklist | T-24, T-26 | Report in `docs/bench.md`, all budgets met |
| T-52 | Migration: replace Sentry plugin in 3 terminals + sites | all | Sentry removed, `/sentry` tunnel removed |

### 12.3 Milestones
| M | Tasks | Outcome |
|---|---|---|
| M0 | T-01…T-04, T-10, T-11 | Risks retired, skeleton green |
| M1 | T-12…T-18 | Errors from terminals grouped in dashboard |
| M2 | T-20…T-23 | Full replays with console/network |
| M3 | T-24…T-26, T-30 | Charts, WebSocket, APK, source maps |
| M4 | T-31…T-35 | Issue workflow, alerts, retention, remote config, roles |
| M5 | T-40, T-41, T-50…T-52 | All apps migrated off Sentry |

---

## 13. Open questions / v2
- Stylesheet dedup across sessions (store inlined CSS once per project by hash) — likely large storage win for terminals.
- Debug IDs for source maps.
- iOS Capacitor builds.
- Go/Laravel backend error correlation via request id header.
- Daily digest message per project in Telegram.

---

## Decisions log
Decisions taken during implementation that refine or deviate from the PRD above. Newest last.

| # | Date | Decision | Reason |
|---|---|---|---|
| D-01 | 2026-11-03 | Canvas snapshots (T-02, T-24, `@replayd/core/canvas`) out of scope for v1. Wire format keeps the asset section; SDK always writes `asset_count = 0`; server/viewer still parse it. | Owner scope change. |
| D-02 | 2026-11-03 | All work lands on the single designated branch `claude/sweet-clarke-h5srzw` (one commit series `T-xx: <title>` per task) instead of one branch per task (§12.1 rule 2). | Owner instruction for this build. |
| D-03 | 2026-11-03 | Repository is hosted on GitHub; `.gitlab-ci.yml` is still provided per §11 (target CI), plus an equivalent GitHub Actions workflow so checks run where the code lives. | Hosting reality. |
| D-04 | 2026-11-03 | `data-rp-throttle` is implemented as a MutationRecord **prefilter** hook inside rrweb `processMutations` (pinned `@rrweb/record@2.2.0` + `pnpm` patch), not an `emit` filter. It coalesces `characterData` and single-text-child `childList` swaps to the latest value per node, at most once per N ms, staggered across 500 ms ticks. The mutation guard (§4.6) uses the same hook. | T-01: the emit filter cut bytes but not main-thread time (rrweb already processed every mutation). The hook cut per-batch time 4–9×. docs/spikes/T-01.md |
| D-05 | 2026-11-03 | The pinned rrweb patch also fixes rrweb's `Element` taint-check bug (`querySelector`/`querySelectorAll` listed as accessors → hidden iframe + cross-realm accessors on every page). | T-01: 3k-node snapshot at 4× went from 149 → 121 ms. |
| D-06 | 2026-11-03 | README recommends `data-rp-throttle="1000"` for order book / watchlist containers (500 elsewhere). Budgets unchanged. | T-01 measurements. |
| D-07 | 2026-11-03 | Capacitor: fetch is always wrapped (outermost, after the bridge). XHR uses a constructor wrapper with per-instance `open`/`send` own-properties when the CapacitorHttp bridge is active, and the usual prototype patch otherwise. The SDK's own main-thread transport uses `window.CapacitorWebFetch` when present. | T-03: the bridge re-assigns `XMLHttpRequest.prototype` methods on every construction, so a prototype patch loses XHR capture after the first request. See docs/spikes/T-03.md. |
| D-08 | 2026-11-03 | `replayd-wp` excludes the SDK via WP Rocket filters `rocket_delay_js_exclusions` (`/_rp/sdk/`, `replayd-js`), `rocket_exclude_js`, `rocket_exclude_defer_js`, `rocket_minify_excluded_external_js`. The SDK tag carries config in `data-*` attributes with no inline script. | T-04, verified with WP Rocket v3.24's real DelayJS code and runtime. docs/spikes/T-04.md |
| D-09 | 2026-11-03 | Ingest HTTP contract: SDK posts with `Content-Type: text/plain` and no custom headers (CORS-safelisted → no preflight); public key in `?key=`; server sniffs gzip magic (events: gzip or plain JSON accepted; replay: gzip required). URL: `${tunnel}/<pid>/<kind>?key=` with tunnel (nginx maps `/_rp/` → `/ingest/`), else `<dsn origin>/ingest/<pid>/<kind>?key=`. `<pid>` = project numeric id or slug. Responses: `202` accepted, `429`/`503` + `Retry-After`, `403` bad key/origin, `413` too large; `X-Replayd-Disable: <seconds>` on any response stops capture. | Avoid an extra preflight round-trip per upload (perf); slug DSNs are readable. |
| D-10 | 2026-11-03 | SDK build: `terser` (sdk-root devDependency) runs as a second minify pass on core ESM + IIFE (~0.3 KB gz saved); the IIFE loads lazy chunks by URL relative to `replayd.min.js` and assigns `window.Replayd` by hand. No runtime dependency added to core. | T-12/T-13: keep core ≤ 7 KB. |
| D-11 | 2026-11-03 | `init()` defers first storage reads, the persisted kill-switch and cached remote config to the first upload / load + idle; patches are always installed and become no-ops while disabled. | Measured init 3.1 ms → 0.94 ms (cold, 1×); budget < 1 ms. |
| D-12 | 2026-11-03 | Redaction lists only ever grow: user `redact` options and remote config extend the defaults; keys are matched case-insensitively; subtrees deeper than 8 levels become `[Depth]`; non-JSON text (truncated frames, form bodies) gets regex redaction. URL redaction covers query and fragment. | Never weaken redaction defaults (rule 7). |
| D-13 | 2026-11-03 | SDK errors: resource-load errors ignored; `beforeSend` that throws drops the event (fail closed); `source: 'manual'` for captureException/captureMessage; `captureException(err, {level, source, ctx})` is the adapter hook; flood signature uses the first `:line:col` frame. | Avoid noise; never send data the app meant to redact. |
| D-14 | 2026-11-03 | SDK WS: `send` wrapped per instance on matching sockets only; the hot path compares `e.timeStamp` with a gap (Infinity = off via kill switch / `ws.enabled`); EventSource lifecycle recorded for all SSE connections (gated by `websocket.enabled`). | < 5 µs per unsampled message (measured 1.64 µs at 4×). |
| D-15 | 2026-11-03 | Transport: `credentials: 'omit'`; on page hide pending events go synchronously as plain JSON and queued data with keepalive within a 60 KB total budget; any 4xx other than 429 is dropped. | Keepalive quota; server accepts plain or gzip (D-09). |
| D-16 | 2026-11-03 | Dashboard issue list polls every 2 s while the tab is visible (cheap indexed query). | T-18 acceptance (visible within 5 s): worst case = 2 s SDK batch + 1 s pipeline flush + poll. |
| D-17 | 2026-11-03 | `@rrweb/record@2.2.0` is a pinned **devDependency** of `@replayd/core`, patched through `pnpm.patchedDependencies` (`sdk/patches/@rrweb__record@2.2.0.patch`: `record.setMutationHook`, D-04; taint fix, D-05). It is bundled into the lazy `replay.js` chunk only. ESLint allows that import in `src/replay/**` and nowhere else; `check-core-deps` still enforces zero runtime dependencies. The worker is built as a classic IIFE script (`worker.js`), with redact.ts's `./config` aliased to `src/worker/cfg.ts`. The main thread sends it the current redaction lists with every segment cut. | PRD §4.1 bundles rrweb into the replay chunk; the published package keeps no runtime deps (rule 3). |
| D-18 | 2026-11-03 | Replay transport lives in the worker (D-09 contract, D-15 keepalive budget on hide). One request is in flight at a time, with backoff 1 s → 60 s, max 5 attempts and `Retry-After` on 429/503. Other 4xx responses are dropped. The queue is capped at 5 MB, dropping the oldest. A lost segment sets `gap: true` and adds a `gap` custom event to the next one. `X-Replayd-Disable` seen by the worker stops replay recording on that page; core learns it from its own next response. `seq` comes from the core session (persisted). On session rollover the buffered data closes the old session (old sid, next seq) and a full snapshot starts the new one. `init` meta is sent with the first segment of each page/session. The worker samples incoming Centrifugo frames per channel (`perChannelPerSec`) only for `channelOf: 'centrifugo-json'`; with a custom `channelOf` function every frame that passed the gate is kept. | Worker-side transport keeps JSON/gzip/upload off the main thread; seq persistence avoids dedup loss on reload. |
| D-19 | 2026-11-03 | The `data-rp-throttle` flush runs in the 500 ms batch tick and travels in the same `postMessage` as the event batch. It does not get its own offset timer, as item 3 of the T-01 plan proposed. Pending nodes keep a per-node state object, kept as a symbol property on the node, and are bucketed by stagger slot. | T-20 profiling: the budget is per 500 ms window, so a second timer only adds a postMessage. Per-node state removed the WeakMap/mirror lookups from the per-record path. |
| D-20 | 2026-11-03 | **Owner decision:** for the terminal mock (`sdk/bench/pages/terminal.html`: 200 WS msg/s, ~2,000 text mutations/s), the §2.1 budget "main-thread time per 500 ms batch < 2 ms p95 at 4×" is replaced by the **measured 4× figure** recorded in docs/bench.md (T-20). The < 2 ms figure still applies to non-terminal pages and is re-checked on real terminals and devices in T-51. | T-20: about 0.7 ms per window at 4× goes to receiving the MutationRecords alone, and ~4.5 µs at 4× to reading each changed text value. Both are inherent to rrweb's MutationObserver design, so < 2 ms p95 is not reachable on this mock. |
| D-21 | 2026-11-03 | Capacitor queues (T-26). Replay segments use an IndexedDB **outbox in the worker**: every segment is stored before it is sent and deleted once the server answers. Network/5xx failures stay stored and are drained oldest-first on `online`, App `resume` and the next start. Expired (> 24 h) and over-cap (> 20 MB) entries are dropped as a `gap` on the next segment. With the outbox the 5 MB memory cap no longer loses data. Error events: core's transport hands bodies it gave up on (network/5xx after retries) to the Capacitor chunk (`Internal.q`), which stores them in IndexedDB store `e` and gives them back to the transport on `online`/`resume`/start. `pause` → `replayd:flush` (replay cut, keepalive) + core hide flush. App/Device info goes into the shared error `ctx.app`, tags `app_version`/`device`, and the replay `init` meta. Lifecycle (`pause`, `resume`, `appStateChange`, `backButton`) → `app` custom events + breadcrumbs. Web uses the same outbox with `offlineQueue: true`. | Durable across app kills without main-thread IndexedDB work per segment. Core grew 6.81 → 6.86 KB (≤ 7 KB). |
| D-22 | 2026-11-03 | Source maps (T-30). Maps are stored as `data/_sourcemaps/<pid>/<release>/<sha1(~/path)>.map`, keyed by the minified file's `~/path`, which is the multipart part name the CLI/Vite plugin sends. Uploads authenticate with `Authorization: Bearer <upload token>`. Release directory names are percent-encoded. The pipeline symbolicates before fingerprinting, using a 32-entry LRU of parsed maps (misses cached; the release is invalidated on upload). Context: 5 lines before/after, 240 chars per line. Sources under `node_modules/` are not in-app. Reprocessing after an upload updates the stored frames and culprit of up to 5,000 recent events of that release whose issue is not symbolicated, then marks the issue symbolicated. It does **not** re-group events: an issue first seen unsymbolicated keeps its fingerprint. `--delete-after` also strips the `sourceMappingURL` comment. Frame function names come from the map's token name (no minified-source scope analysis). `POST /api/projects/:pid/releases` (`replayd releases new`) uses the same token. | Keeps the ingest path untouched and grouping stable. Later errors of a symbolicated release group by original frames. |
| D-23 | 2026-11-03 | Issue workflow (T-31). Regression = a `resolved` issue receives an event with a timestamp after `resolved_at`. "Resolve in next release" pins the issue's current `last_release`: only events of a different release reopen it, and events without a release never do. Without a release it behaves like a plain resolve. On regression: status → unresolved, the resolution is cleared, `regressed_at` is set and an `IssueSignal::Regression` is sent (alerts in T-32). Ignore: forever, until a time (`ignore_until`), or for N more events (`ignore_until_count = times_seen + N`). When the condition passes the issue goes back to unresolved **without** a regression signal. All of this is evaluated inside the existing issue upsert; no extra query on the pipeline path. API: `PATCH /api/issues/:id` and bulk `PATCH /api/issues {ids ≤ 500}`; member+ (`ChangeIssueStatus`), viewers 403, audit-logged. | Sentry-like semantics with zero added pipeline cost. |
| D-24 | 2026-11-03 | Telegram (T-32). Config lives in `projects.telegram`: `{bot_token, chat_id, enabled, new_issue, regression, spike, warnings, spike_threshold = 50, spike_minutes = 5}`. Kinds: new issue (level `warning` only with `warnings`), regression (D-23), spike (≥ threshold events of one issue within the window, per-minute buckets). Dedup is 30 min per issue and kind, kept in memory and in `alerts_sent` (reloaded at start). A spike is also suppressed for 30 min after a new/regression alert of the same issue. Per-chat token bucket: 20/min, burst 20; over → dropped and counted (`replayd_alerts_suppressed_total{reason}`). 3 retries honour `retry_after`; other 4xx are not retried. Errors are logged without the URL (the token is in the path). `POST /api/projects/:pid/telegram/test` (admin). `REPLAYD_TELEGRAM_API` overrides the Bot API base for tests. The project settings page gained General, Keys & DSN, Members, Telegram and Fingerprint-rules tabs. | PRD §5.7; restart-safe dedup; never log tokens (rule 7). |
| D-25 | 2026-11-03 | Retention (T-33). Runs daily at 03:00 Asia/Tehran = 23:30 UTC (Iran has no DST since 2022). Partitions are global per day, so whole `sessions`/`events` partitions are dropped only below the **largest** project retention. Projects with a shorter retention get row deletes for the days in between, and `issues` past each project's cut-off are deleted. Retention N keeps today (UTC) plus N − 1 days. Replay day directories older than the project's cut-off are removed, plus directories of deleted projects. Source-map releases are removed 30 days after `COALESCE(last_event_at, created_at)`; the pipeline refreshes `releases.last_event_at` at most hourly per release. | PRD §5.8/§5.6; O(days) for the common case. |
| D-26 | 2026-11-03 | Remote config editor (T-34). Settings → Remote config edits the kill switch, replay/error sample rates, WS toggle + frame gates, TTL and redaction **extensions**. Every save bumps `v`. The API returns `remote_config_effective` (defaults merged, unknown keys dropped, clamped) for the preview. Canvas stays disabled (D-01), so the acceptance check uses `ws.maxFramesPerSec` instead of canvas fps. The SDK now fetches config with `cache: 'no-cache'` (ETag revalidation): the endpoint's `max-age=300` could otherwise add up to 5 min to the SDK's 10-min TTL (worst case 15 min). Core 6.86 → 6.87 KB. | Pick-up ≤ TTL, as the acceptance requires. |
| D-27 | 2026-11-03 | Viewer redaction (T-35). Users without `ViewSensitive` (viewers) get `GET /api/sessions/:sid/recording` as a filtered `.rpl`. Each frame is decoded on the API path (never on ingest): `network` events lose `reqHeaders`/`resHeaders`/`reqBody`/`resBody`, `ws` events lose `raw` (`len` + `redacted: true` instead), assets are dropped, frames are deduped by seq and flagged `FLAG_REDACTED`. Undecodable frames become empty gap frames, never passed through. The copy is cached at `<day>/.redacted/<sid>.<source len>.rpl`, rebuilt when a live file grows, and removed with its day directory by retention. Error events never contain bodies (`ctx.http` = method/url/status/ms). The player tells viewers what was removed. | PRD §5.11; single decode per file version, Range/ETag work unchanged on the copy. |
