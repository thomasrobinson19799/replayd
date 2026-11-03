/** @replayd/core — public API (PRD §4.1). `init()` is synchronous, < 1 ms, and never throws. */
import type { Breadcrumb, Internal, ReplaydOptions, User } from './types';
import { O, applyRc, cachedRc, dsn, fetchRc, iurl, resolve, stale } from './config';
import { crumb, drain, rec, resetRing, setSink } from './ring';
import { act, nextSeq, sInit, sSave, sampled, sess } from './session';
import { flushEv, hdr, pump, reset, send, setTf, tf } from './transport';
import { W, en, ie, offUntil, on, setOk, un } from './u';

export type * from './types';
export const SDK_VERSION: string = __RP_VERSION__;

/** scope (user / tags / contexts) attached to every event */
export let user: User | undefined;
export const tags: Record<string, string> = {};
export const ctx: Record<string, unknown> = {};
export let platform: Internal['platform'] = 'web';
let started = false, onErr = () => {};
/** force-segment-flush hook (replay chunk), called for every captured error */
export const forceFlush = () => onErr();
export const counters = { ws_disc: 0 };

const I: Internal = {
  o: () => O,
  sess: () => sess(),
  seq: nextSeq,
  drain,
  sink: setSink,
  onError: (f) => {
    onErr = f;
  },
  en: () => en,
  url: iurl,
  fetch: (...a) => tf.apply(W, a),
  send,
  ie: () => ie,
  c: counters,
  get platform() {
    return platform;
  },
};

/** lazy chunk loaders; replaceable by the IIFE build (T-40) to load from the script's base URL */
export const loaders = {
  replay: () => import('./replay/index'),
  capacitor: () => import('./capacitor/index'),
};

/** PRD §4.4 step 2: after load → idle: remote config, sample check, lazy chunks */
const start = async () => {
  try {
    const cc = cachedRc();
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
    if (started || !W.document || offUntil() > Date.now()) return;
    const cap = !!W.Capacitor?.isNativePlatform?.();
    platform = cap ? 'capacitor-android' : 'web';
    resolve(options);
    dsn(options.dsn, options.tunnel, cap);
    started = true;
    // D-07: our uploads bypass CapacitorHttp and our own fetch patch
    setTf(W.CapacitorWebFetch ?? W.fetch);
    sInit(cap, resetRing);
    setOk(true);
    const cc = cachedRc();
    if (cc) applyRc(cc.c);
    for (const e of ['pointerdown', 'keydown', 'scroll']) on(W, e, act);
    on(W, 'pagehide', hide);
    on(W.document, 'visibilitychange', () => W.document.visibilityState == 'hidden' && hide());
    const go = () => (W.requestIdleCallback ?? ((f: () => void) => setTimeout(f, 1)))(start, { timeout: 2e3 });
    if (W.document.readyState == 'complete') go();
    else on(W, 'load', go, { once: true });
  } catch {
    /* invalid DSN etc. — SDK stays off, app unaffected */
  }
}

export function captureException(_error: unknown, _ctx?: Record<string, unknown>): void {}
export function captureMessage(_message: string, _level: 'error' | 'warning' = 'error'): void {}

export function setUser(u: User | null): void {
  user = u ?? undefined;
}
export function setTag(k: string, v: string): void {
  tags[k] = String(v);
}
export function setTags(t: Record<string, string>): void {
  for (const k in t) setTag(k, t[k]!);
}
export function setContext(name: string, c: Record<string, unknown> | null): void {
  if (c) ctx[name] = c;
  else delete ctx[name];
}
export function addBreadcrumb(b: Partial<Breadcrumb> & { msg: string }): void {
  const ts = b.ts ?? Date.now();
  crumb(b.cat ?? 'custom', b.msg, b.data, ts);
  rec('breadcrumb', { cat: b.cat ?? 'custom', msg: b.msg, data: b.data }, ts);
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
