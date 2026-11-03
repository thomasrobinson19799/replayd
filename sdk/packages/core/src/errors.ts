/** Error capture pipeline (PRD §4.11): filters, sampling, flood control, event building, global handlers. */
import type { ReplaydEvent, User } from './types';
import { O } from './config';
import { crumbs, rec } from './ring';
import { rUrl } from './redact';
import { sess } from './session';
import { pushEv } from './transport';
import { W, en, err, match, now, on, uuid7 } from './u';

export let user: User | undefined;
export const setUser = (u?: User) => {
  user = u;
};
export const tags: Record<string, string> = {};
export const ctx: Record<string, unknown> = {};
export let platform: ReplaydEvent['platform'] = 'web';
export const setPlatform = (p: typeof platform) => {
  platform = p;
};
let onErr = () => {};
/** "force segment flush" hook for the replay chunk */
export const setOnErr = (f: () => void) => {
  onErr = f;
};

/** flood control state (reset per session): signature → [last sent ts, suppressed count] */
let fl = new Map<string, [number, number]>(), sent = 0, mw = 0, mc = 0;
export const resetFlood = () => {
  fl = new Map();
  sent = 0;
};

type Lv = ReplaydEvent['level'];
type Src = ReplaydEvent['source'];
/** duck-typed (cross-realm safe): every engine we support gives Errors a string stack */
export const isErr = (x: unknown): x is Error => typeof (x as Error)?.stack == 'string';

/**
 * Captures one error/warning. `subj` = request / socket URL used for `denyUrls` when there's no stack.
 * Signature = type + message + first stack frame; first sent, then ≤ 1 per 10 s with `count`;
 * caps 100 / session and 20 / min.
 */
export const capture = (level: Lv, source: Src, type: string, message: string, stack?: string, c?: Record<string, unknown>, subj?: string) => {
  if (!en) return;
  try {
    const e = O.errors;
    // first frame line (ends with :line:col) and its URL
    const fr = stack?.split('\n').find((l) => /:\d+\)?$/.test(l));
    const fu = fr?.match(/(?:[a-z][\w+.-]*:\/\/|\/)[^\s()]*?(?=(?::\d+){1,2}\)?$)/i)?.[0] ?? subj ?? '';
    if (!(Math.random() < e.sampleRate) || match(e.ignoreErrors, message) || match(e.denyUrls, fu)) return;
    const t = now(), sig = type + message + fr, f = fl.get(sig);
    if (f && t - f[0] < 1e4) return void f[1]++;
    if (t - mw > 6e4) {
      mw = t;
      mc = 0;
    }
    if (sent >= 100 || mc >= 20) return;
    sent++;
    mc++;
    fl.set(sig, [t, 0]);
    let ev: ReplaydEvent | null | undefined | void = {
      id: uuid7(),
      ts: t,
      sid: sess(t).id,
      level,
      source,
      type,
      message,
      stack,
      url: rUrl(W.location.href),
      release: O.release,
      env: O.environment,
      platform,
      user,
      tags: { ...tags },
      ctx: { ...ctx, ...c },
      breadcrumbs: crumbs.slice(),
      count: f ? f[1] + 1 : 1,
    };
    if (O.beforeSend)
      try {
        ev = O.beforeSend(ev);
      } catch {
        // a throwing beforeSend may be the app's own redaction: drop rather than leak
        ev = null;
        err();
      }
    if (!ev) return;
    pushEv(ev);
    rec('error', { id: ev.id, level, source, type, message: ev.message }, t);
    onErr();
  } catch {
    err();
  }
};

/** Error objects already reported: a framework handler that also logs the error must not report it twice */
export const seen = new WeakSet<object>();
export const fromErr = (x: Error, source: Src, level: Lv = 'error', c?: Record<string, unknown>) => (
  seen.add(x), capture(level, source, x.name || 'Error', String(x.message), x.stack, c)
);

/**
 * Safe stringify for console args / non-Error values: depth 3, 1 KB, circular-safe, never throws.
 * Top-level strings are kept raw (like the console prints them).
 */
export const ser = (v: unknown): string => {
  let o = '';
  const seen = new Set();
  const w = (x: unknown, d: number) => {
    if (o.length > 1024) return;
    if (typeof x == 'string') o += d ? JSON.stringify(x) : x;
    else if (typeof x == 'function') o += '[Function]';
    else if (!x || typeof x != 'object') o += String(x);
    else if (isErr(x)) o += `${x.name}: ${x.message}`;
    else if (seen.has(x)) o += '[Circular]';
    else if (x instanceof W.Element) o += desc(x as Element);
    else if (d > 2) o += Array.isArray(x) ? '[Array]' : '[Object]';
    else {
      seen.add(x);
      const a = Array.isArray(x);
      let i = 0;
      o += a ? '[' : '{';
      for (const k in x) {
        if (o.length > 1024) break;
        if (i++) o += ',';
        if (!a) o += k + ':';
        try {
          w((x as Record<string, unknown>)[k], d + 1);
        } catch {
          o += '?';
        }
      }
      o += a ? ']' : '}';
    }
  };
  try {
    w(v, 0);
  } catch {
    o += '?';
  }
  return o.slice(0, 1024);
};

/** element descriptor like `button#buy.btn.primary` (never text content) */
export const desc = (el: Element) => {
  let s = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '');
  for (const c of [...el.classList].slice(0, 3)) s += '.' + c;
  return s;
};

/** window 'error' (uncaught only — bubble phase, so resource load errors never arrive) + 'unhandledrejection' */
export const errHandlers = () => {
  on(
    W,
    'error',
    (e: ErrorEvent) => {
      const x = e.error;
      if (isErr(x)) fromErr(x, 'onerror');
      else capture('error', 'onerror', 'Error', String(e.message), e.filename ? `    at ${e.filename}:${e.lineno}:${e.colno}` : undefined);
    },
    false,
  );
  on(
    W,
    'unhandledrejection',
    (e: PromiseRejectionEvent) => {
      const r = e.reason;
      if (isErr(r)) fromErr(r, 'unhandledrejection');
      else capture('error', 'unhandledrejection', 'UnhandledRejection', ser(r));
    },
    false,
  );
};
