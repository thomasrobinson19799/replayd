/** @replayd/core — public API (PRD §4.1). `init()` is synchronous, < 1 ms, and never throws. */
import type { Breadcrumb, Internal, ReplaydEvent, ReplaydOptions, User } from './types';
import { loaders } from './chunks';
import { O, dsn, fetchRc, iurl, ready, resolve, stale } from './config';
import { consoleHooks, navHooks } from './console';
import { capture, ctx, errHandlers, fromErr, isErr, platform, resetFlood, ser, setOnErr, setPlatform, setUser as su, tags, user } from './errors';
import { httpHooks } from './http';
import { crumb, drain, rec, resetRing, setSink } from './ring';
import { act, nextSeq, sInit, sSave, sampled, sess } from './session';
import { flushEv, hdr, pump, reset, send, setLost, setTf, tf } from './transport';
import { W, en, ie, offT, on, setOk, un } from './u';
import { resetWs, wsHooks, wsc } from './ws';

export type * from './types';
export { loaders };
export const SDK_VERSION: string = __RP_VERSION__;

let started = false;

const I: Internal = {
  o: () => O,
  sess: () => sess(),
  seq: nextSeq,
  drain,
  sink: setSink,
  onError: setOnErr,
  en: () => en,
  url: iurl,
  fetch: (a, b) => tf.call(W, a, b),
  send,
  ie: () => ie,
  c: wsc,
  m: () => ({ user, tags, ctx }),
  r: rec,
  b: crumb,
  h: () => hide(),
  q: setLost,
  platform: 'web',
};

/** PRD §4.4 step 2: after load → idle: remote config, sample check, lazy chunks */
const start = async () => {
  try {
    const cc = ready();
    if (Date.now() < offT) return; // X-Replayd-Disable window: no requests at all
    if (stale(cc)) {
      const p = fetchRc(tf, hdr);
      if (!cc) await p;
    }
    if (!en) return;
    if (platform != 'web') loaders.capacitor().then((m) => m.startCapacitor(I), () => {});
    if (sampled(O.replay.sampleRate)) loaders.replay().then((m) => m.startReplay(I), () => {});
  } catch {
    /* never throw into the app */
  }
};

const hide = () => {
  sSave();
  flushEv(true);
  pump(true);
};

export function init(options: ReplaydOptions): void {
  try {
    if (started || !W.document) return;
    const cap = !!W.Capacitor?.isNativePlatform?.();
    setPlatform((I.platform = cap ? 'capacitor-android' : 'web'));
    resolve(options);
    dsn(options.dsn, options.tunnel, cap);
    started = true;
    // D-07: our uploads bypass CapacitorHttp and our own fetch patch
    setTf(W.CapacitorWebFetch ?? W.fetch);
    sInit(cap, () => {
      resetRing();
      resetFlood();
      resetWs();
    });
    setOk(true);
    errHandlers();
    consoleHooks();
    httpHooks();
    navHooks();
    wsHooks();
    for (const e of ['pointerdown', 'keydown', 'scroll']) on(W, e, act);
    on(W, 'pagehide', hide);
    on(W.document, 'visibilitychange', () => W.document.visibilityState == 'hidden' && hide());
    const go = () => (W.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1)))(start, { timeout: 2e3 });
    if (W.document.readyState == 'complete') setTimeout(go); // registering rIC costs ~0.1 ms cold: not inside init()
    else on(W, 'load', go, { once: true });
  } catch {
    /* invalid DSN etc. — SDK stays off, app unaffected */
  }
}

export interface CaptureHint {
  level?: ReplaydEvent['level'];
  /** event source; framework adapters pass 'vue' / 'react' */
  source?: ReplaydEvent['source'];
  /** merged into `ctx` (e.g. `{ component, info }`) */
  ctx?: Record<string, unknown>;
}

export function captureException(error: unknown, hint: CaptureHint = {}): void {
  try {
    const { level = 'error', source = 'manual', ctx: x } = hint;
    if (isErr(error)) fromErr(error, source, level, x);
    else capture(level, source, 'Error', ser(error), undefined, x);
  } catch {
    /* never throw */
  }
}
export function captureMessage(message: string, level: ReplaydEvent['level'] = 'error'): void {
  capture(level, 'manual', 'Message', String(message));
}

export function setUser(u: User | null): void {
  su(u ?? undefined);
}
export function setTag(k: string, v: string): void {
  tags[k] = String(v);
}
export function setTags(t: Record<string, string>): void {
  for (const k in t) setTag(k, t[k]!);
}
export function setContext(name: string, x: Record<string, unknown> | null): void {
  if (x) ctx[name] = x;
  else delete ctx[name];
}
export function addBreadcrumb(b: Partial<Breadcrumb> & { msg: string }): void {
  const ts = b.ts ?? Date.now(), cat = b.cat ?? 'custom';
  crumb(cat, b.msg, b.data, ts);
  rec('breadcrumb', { cat, msg: b.msg, data: b.data }, ts);
}

/** sends pending events now; resolves once queued (uploads continue in the background) */
export function flush(): Promise<void> {
  return flushEv().then(() => pump());
}

/** flushes, then removes every patch/listener and stops capture */
export function close(): Promise<void> {
  return flush().then(() => {
    while (un.length) un.pop()!();
    setOk(false);
    reset();
    started = false;
  });
}
