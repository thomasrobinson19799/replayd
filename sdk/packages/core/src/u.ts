/**
 * Shared internals. Size note: module-level bindings minify, object property names don't —
 * keep hot/shared state in `let`s here, mutate only through the setters below.
 */
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
let ok = false, rcOff = false, offT = 0, offTm: ReturnType<typeof setTimeout> | 0 = 0;
const hooks: (() => void)[] = [];
/** registers a callback run whenever capture state / config changes (bounded: modules only) */
export const onUpd = (f: () => void) => hooks.push(f);
export const upd = () => {
  en = ok && !rcOff && now() >= offT;
  for (const f of hooks) f();
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
  clearTimeout(offTm);
  offTm = setTimeout(upd, Math.min(s * 1e3, 2 ** 31 - 1));
  upd();
};
/** reads the persisted disable-until timestamp (ms) */
export const offUntil = (): number => (offT = Math.max(offT, +(sget(1, OFF_KEY) ?? 0) || 0));

/** storage: 1 = localStorage, 0 = sessionStorage. Never throws (blocked storage, quota, bad JSON). */
export const sget = (l: 0 | 1, k: string) => {
  try {
    return JSON.parse(W[l ? 'localStorage' : 'sessionStorage'].getItem(k));
  } catch {
    return null;
  }
};
export const sset = (l: 0 | 1, k: string, v: unknown) => {
  try {
    W[l ? 'localStorage' : 'sessionStorage'].setItem(k, JSON.stringify(v));
  } catch {
    /* storage unavailable */
  }
};

/** teardown list for close(): restores patches, removes listeners */
export const un: (() => void)[] = [];
type L = (e: never) => unknown;
/** addEventListener with a try/catch'd handler (never throws into the app); removed on close() */
export const on = (t: EventTarget, e: string, f: L, o: AddEventListenerOptions | boolean = { capture: true, passive: true }) => {
  const g = (x: Event) => {
    try {
      f(x as never);
    } catch {
      err();
    }
  };
  t.addEventListener(e, g, o);
  un.push(() => t.removeEventListener(e, g, o));
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
export const ctor = (k: string, f: (x: any) => void) =>
  patch(W, k, (N) => {
    const C = function (this: unknown) {
      // eslint-disable-next-line prefer-rest-params
      const x = Reflect.construct(N, arguments, new.target);
      if (en)
        try {
          f(x);
        } catch {
          err();
        }
      return x;
    };
    statics(C, N);
    return C;
  });
/** copies own statics (constants, length, name) of a native constructor onto its wrapper */
export const statics = (w: F, n: F) => {
  for (const k of Reflect.ownKeys(n))
    if (k != 'prototype')
      try {
        Object.defineProperty(w, k, Object.getOwnPropertyDescriptor(n, k)!);
      } catch {
        /* non-configurable */
      }
  w.prototype = n.prototype;
};

let lt = 0, lc = 0;
/** UUIDv7: 48-bit ms timestamp, 12-bit per-ms counter (monotonic within a page), 62 random bits */
export const uuid7 = (): string => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = now();
  if (t > lt) {
    lt = t;
    lc = ((b[6]! & 7) << 8) | b[7]!; // random start, leaves headroom for the counter
  } else if (++lc > 4095) {
    t = ++lt;
    lc = 0;
  } else t = lt;
  for (let i = 0; i < 6; i++) b[i] = (t / 2 ** (40 - 8 * i)) & 255;
  b[6] = 112 | (lc >> 8);
  b[7] = lc & 255;
  b[8] = (b[8]! & 63) | 128;
  let s = '';
  for (let i = 0; i < 16; i++) s += (i == 4 || i == 6 || i == 8 || i == 10 ? '-' : '') + (b[i]! + 256).toString(16).slice(1);
  return s;
};

/** string or RegExp matcher list test (strings: substring) */
export const match = (l: (string | RegExp)[] | undefined, s: string) =>
  !!l?.some((m) => (typeof m == 'string' ? s.includes(m) : m.test(s)));
