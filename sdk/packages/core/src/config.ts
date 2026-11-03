/** Options resolution, DSN/ingest URLs, remote config merge + cache (PRD §4.2, §4.12, D-09). */
import type { RedactOptions, ReplaydOptions, Resolved } from './types';
import { W, now, offUntil, setRcOff, sget, sset } from './u';

export let O: Resolved;

/** Built-in redaction defaults (PRD §0.2). Lists only ever grow (user options and remote config extend). */
const RD: Required<RedactOptions> = {
  headers: 'authorization cookie set-cookie x-api-key'.split(' '),
  bodyKeys: 'password token access_token refresh_token secret otp pin cvv card_number'.split(' '),
  queryParams: 'token key signature'.split(' '),
};

let rv = 0;
/** bumps whenever redaction lists change (redaction caches compiled regexes against it) */
export const redactVer = () => rv;

/** extends redaction lists (lower-cased, deduped); never removes */
export const extend = (r?: RedactOptions) => {
  const d = O.redact as Record<string, string[]>;
  for (const k in d)
    for (const v of (r as Record<string, unknown[]>)?.[k] ?? []) {
      const l = String(v).toLowerCase();
      if (!d[k]!.includes(l)) rv = d[k]!.push(l) + rv;
    }
};

export const resolve = (o: ReplaydOptions) => {
  const w = o.websocket ?? {};
  O = {
    ...o,
    replay: { sampleRate: 1, networkDetailAllowUrls: [], ...o.replay },
    websocket: {
      enabled: true,
      urls: [/centrifugo/, /\/connection\/websocket/],
      ...w,
      sample: { perChannelPerSec: 1, maxFramesPerSec: 20, maxFrameBytes: 2048, ...w.sample },
    },
    errors: { sampleRate: 1, console: ['error', 'warn'], failedRequestStatusCodes: [[400, 599]], ignoreErrors: [], denyUrls: [], ...o.errors },
    redact: { headers: [...RD.headers], bodyKeys: [...RD.bodyKeys], queryParams: [...RD.queryParams] },
  };
  extend(o.redact);
};

/** ingest endpoint base (D-09): tunnel (web only) or `<dsn origin>/ingest/<pid>/` */
let base = '', abs = '', key = '';
// plain string slicing: a cold `new URL()` costs ~0.1–0.2 ms on the init() path
export const dsn = (d: string, tunnel: string | undefined, cap: boolean) => {
  const s = d.indexOf('//') + 2, at = d.indexOf('@', s), p = d.indexOf('/', at), i = d.lastIndexOf('/');
  const pid = d.slice(i + 1);
  if (s < 3 || at < s + 1 || p < at + 2 || !pid) throw 0;
  key = d.slice(s, at);
  base = tunnel && !cap ? `${tunnel.endsWith('/') ? tunnel.slice(0, -1) : tunnel}/${pid}/` : `${d.slice(0, s)}${d.slice(at + 1, i)}/ingest/${pid}/`;
  abs = '';
};
export const iurl = (kind: string) => `${base}${kind}?key=${key}`;
/** absolute URL (relative to the page; under Capacitor that is https://localhost) */
export const absu = (u: string) => new URL(u, W.location.href).href;
/** true for the SDK's own ingest URLs (never captured) */
export const own = (u: string) => absu(u).startsWith((abs ||= absu(base)));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;
/** remote wins for numbers/booleans listed in `ks` */
const take = (t: A, s: A, ks: string[]) => {
  if (s) for (const k of ks) if (typeof s[k] == 'number' || typeof s[k] == 'boolean') t[k] = s[k];
};

/** merges a remote config (PRD §4.12) over the local options */
export const applyRc = (c: A) => {
  if (!c || typeof c != 'object') return;
  take(O.replay, c.replay, ['sampleRate']);
  take(O.websocket, c.ws, ['enabled']);
  take(O.websocket.sample, c.ws, ['perChannelPerSec', 'maxFramesPerSec']);
  take(O.errors, c.errors, ['sampleRate']);
  extend(c.redact);
  setRcOff(c.disabled === true);
};

const CK = 'rp_cfg';
/** cached remote config `{t, c}` (localStorage, 10 min or `ttl`) */
export const cachedRc = (): { t: number; c: A } | null => sget(1, CK);
let cc0: { t: number; c: A } | null | undefined;
/**
 * First localStorage access (~0.5 ms cold in Chromium), deliberately kept off the init() path: applies the
 * persisted X-Replayd-Disable and the cached remote config. Runs before the first upload and at load+idle.
 */
export const ready = () => {
  if (cc0 === undefined) {
    offUntil();
    applyRc((cc0 = cachedRc())?.c);
  }
  return cc0;
};
export const stale = (cc: { t: number; c: A } | null) => !cc || now() - cc.t > (+cc.c?.ttl || 600) * 1e3;

/** fetches remote config, caches + applies it. Network failures are ignored (local config stays). */
export const fetchRc = (f: typeof fetch, hdr: (r: Response) => void) =>
  f
    // no-cache: revalidate (ETag → 304) so the HTTP max-age can't add to the TTL (pick-up stays ≤ ttl)
    .call(W, iurl('config'), { credentials: 'omit', cache: 'no-cache' })
    .then((r) => (hdr(r), r.ok ? r.json() : null))
    .then((c) => {
      if (c && typeof c == 'object') {
        sset(1, CK, { t: now(), c });
        applyRc(c);
      }
    })
    .catch(() => {});
