/**
 * Shared internals. Size note: module-level bindings minify, object property names don't —
 * keep hot/shared state in `let`s here, mutate only through the setters below.
 */
import { wsCfg } from './ws';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const W: any = globalThis;
export const now = () => Date.now();

/** internal error counter (`ie` in segment meta) */
export let ie = 0;
export const err = () => {
  ie++;
};

/**
 * Capture switch. `ok` = initialised, `rcOff` = remote kill switch, `offT` = X-Replayd-Disable until.
 * Patched functions stay installed but become pass-through while `en` is false.
 */
export let en = false;
let ok = false, rcOff = false;
export let offT = 0;
/** recomputes `en` (and the WS gate, which folds `en` into its threshold) */
export const upd = () => {
  en = ok && !rcOff && now() >= offT;
  wsCfg();
};
export const setOk = (v: boolean) => {
  ok = v;
  upd();
};
export const setRcOff = (v: boolean) => {
  rcOff = v;
  upd();
};
export const OFF_KEY = 'rp_off';
/** X-Replayd-Disable: stop all capture for `s` seconds, persisted so reloads respect it. */
export const off = (s: number) => {
  if (!(s > 0)) return;
  offT = now() + s * 1e3;
  sset(1, OFF_KEY, offT);
  // upd() recomputes from offT, so an early fire (setTimeout overflow) is harmless
  setTimeout(upd, s * 1e3);
  upd();
};
/** applies the persisted disable-until timestamp (ms) */
export const offUntil = () => {
  offT = +sget(1, OFF_KEY) || 0;
  upd();
};

/** storage: 1 = localStorage, 0 = sessionStorage. Never throws (blocked storage, quota, bad JSON). */
const st = (l: 0 | 1): Storage => W[l ? 'localStorage' : 'sessionStorage'];
export const sget = (l: 0 | 1, k: string) => {
  try {
    return JSON.parse(st(l).getItem(k)!);
  } catch {
    return null;
  }
};
export const sset = (l: 0 | 1, k: string, v: unknown) => {
  try {
    st(l).setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};
export const pnow = () => performance.now();
/** whole ms since a performance.now() mark */
export const since = (t0: number) => Math.round(pnow() - t0);

/** teardown list for close(): restores patches, removes listeners */
export const un: (() => void)[] = [];
type L = (e: never) => unknown;
/**
 * addEventListener with a try/catch'd handler (never throws into the app); removed on close() unless
 * `keep` (per-socket listeners die with their socket — registering them would leak).
 */
export const on = (t: EventTarget, e: string, f: L, o: AddEventListenerOptions | boolean = { capture: true, passive: true }, keep?: 1) => {
  const g = (x: Event) => {
    try {
      f(x as never);
    } catch {
      err();
    }
  };
  t.addEventListener(e, g, o);
  if (!keep) un.push(() => t.removeEventListener(e, g, o));
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type F = (...a: any[]) => any;
/** replaces o[k] with mk(original); restored on close() unless someone wrapped us since */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const patch = (o: any, k: string, mk: (orig: F) => F) => {
  const orig = o?.[k];
  if (typeof orig != 'function') return;
  const w = mk(orig);
  o[k] = w;
  un.push(() => {
    if (o[k] === w) o[k] = orig;
  });
};
/** wraps g: the original runs FIRST (result/exception untouched), then f(result, args, this) if enabled */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const wrapf = (g: F, f: (r: any, a: IArguments, t: any) => void) =>
  function (this: unknown) {
    // eslint-disable-next-line prefer-rest-params
    const r = g.apply(this, arguments as never);
    if (en)
      try {
        // eslint-disable-next-line prefer-rest-params
        f(r, arguments, this);
      } catch {
        err();
      }
    return r;
  };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const after = (o: any, k: string, f: Parameters<typeof wrapf>[1]) => patch(o, k, (g) => wrapf(g, f));
/**
 * Replaces constructor W[k] by a wrapper that constructs the native (Reflect.construct keeps new.target,
 * so subclasses work and calling without `new` still throws), then runs f(instance) if enabled.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ctor = (k: string, f: (x: any, a: IArguments) => void) =>
  patch(W, k, (N) => {
    const C = function (this: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const x = Reflect.construct(N, arguments, new.target);
      if (en)
        try {
          // eslint-disable-next-line prefer-rest-params
          f(x, arguments);
        } catch {
          err();
        }
      return x;
    };
    statics(C, N);
    return C;
  });
/**
 * Wrapper inherits the native's statics (CONNECTING/OPEN/…, DONE, …) through its own prototype chain,
 * and shares its `prototype` so `instanceof` keeps working.
 */
export const statics = (w: F, n: F) => {
  Object.setPrototypeOf(w, n);
  w.prototype = n.prototype;
};

/** UUIDv7 (RFC 9562): 48-bit ms timestamp + version/variant + 74 random bits; sorts by ms */
export const uuid7 = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16)), t = now();
  let s = '';
  for (let i = 0; i < 6; i++) b[i] = (t / 2 ** (40 - 8 * i)) & 255;
  b[6] = 112 | (b[6]! & 15);
  b[8] = 128 | (b[8]! & 63);
  for (let i = 0; i < 16; i++) s += (i == 4 || i == 6 || i == 8 || i == 10 ? '-' : '') + (b[i]! + 256).toString(16).slice(1);
  return s;
};

/** string or RegExp matcher list test (strings: substring) */
export const match = (l: (string | RegExp)[] | undefined, s: string) =>
  !!l?.some((m) => (typeof m == 'string' ? s.includes(m) : m.test(s)));
