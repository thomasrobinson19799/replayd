/**
 * Lazy Capacitor chunk (PRD §4.9), loaded at load+idle only when `Capacitor.isNativePlatform()`:
 * - app/device info via `Capacitor.Plugins.App.getInfo()` / `Device.getInfo()` when those plugins exist (no hard
 *   dependency) → error `ctx.app`, tags `app_version` / `device`, replay segment `init`;
 * - lifecycle: `pause` → flush core + replay now (the replay outbox already holds every segment); `resume` →
 *   session check (> 15 min idle → new session), drain queues; `appStateChange` / `backButton` → `app`
 *   breadcrumbs + replay custom events;
 * - IndexedDB queue for error-event bodies the transport gave up on (network / 5xx), drained oldest first on
 *   `online` / `resume` / start; 20 MB / 24 h (src/idb.ts). Segments use the worker's own outbox.
 * Transport is direct (DSN host; `tunnel` ignored) — handled by core `dsn()`.
 * Uses core only through `Internal`.
 */
import type { Internal } from '../types';
import { del, load, put } from '../idb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;
interface Plugin {
  getInfo?: () => Promise<A>;
  addListener?: (ev: string, f: (x: A) => void) => unknown;
}

export function startCapacitor(I: Internal): void {
  try {
    run(I);
  } catch {
    /* never throw into the app */
  }
}

function run(I: Internal) {
  const W = window as A, P = (W.Capacitor?.Plugins ?? {}) as Record<string, Plugin | undefined>, App = P.App, x = I.m();

  // ---- app / device info
  void Promise.all([App?.getInfo?.().catch(() => null), P.Device?.getInfo?.().catch(() => null)]).then(([a, d]) => {
    const app: Record<string, string> = {};
    if (a?.version) app.version = a.build ? `${a.version} (${a.build})` : String(a.version);
    if (d?.model) app.device = String(d.model);
    if (d?.osVersion) app.os = String(d.osVersion);
    if (d?.webViewVersion) app.webview = String(d.webViewVersion);
    x.ctx.app = app;
    if (app.version) x.tags.app_version = app.version;
    if (app.device) x.tags.device = app.device;
  });

  // ---- error-event queue
  let busy = 0;
  I.q((k, b) => void put('e', { t: Date.now(), k, b: new Uint8Array(b) }).catch(() => {}));
  const drain = async () => {
    if (busy || !I.en()) return;
    busy = 1;
    try {
      const [recs] = await load('e');
      // handed back to the transport (retry/backoff); if it gives up again it lands here again
      for (const [key, r] of recs) {
        await del('e', key);
        I.send(r.k ?? 'events', r.b);
      }
    } catch {
      /* no IndexedDB */
    }
    busy = 0;
  };

  // ---- lifecycle
  const app = (event: string, data?: Record<string, unknown>) => {
    I.r('app', { event, ...data });
    I.b('app', event, data);
  };
  const on = (ev: string, f: (e: A) => void) => {
    try {
      void App?.addListener?.(ev, (e: A) => {
        try {
          f(e);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* plugin missing */
    }
  };
  on('pause', () => {
    app('pause');
    W.dispatchEvent(new Event('replayd:flush'));
    I.h();
  });
  on('resume', () => {
    app('resume');
    I.sess(); // > 15 min since the last activity → new session (the replay chunk rolls over at its next cut)
    W.dispatchEvent(new Event('replayd:resume'));
    void drain();
  });
  on('appStateChange', (e) => app('appStateChange', { isActive: !!e?.isActive }));
  on('backButton', (e) => app('backButton', { canGoBack: !!e?.canGoBack }));
  W.addEventListener('online', drain);
  void drain();
}
