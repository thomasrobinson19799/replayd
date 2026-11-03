/** Options resolution, DSN/ingest URLs, remote config merge + cache (PRD §4.2, §4.12, D-09). */
import type { RedactOptions, ReplaydOptions, Resolved } from './types';
import { W, now, setRcOff, sget, sset } from './u';

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
    replay: { sampleRate: 1, networkDetailAllowUrls: [], networkCaptureBodies: true, ...o.replay },
    websocket: {
      enabled: true,
      urls: [/centrifugo/, /\/connection\/websocket/],
      channelOf: 'centrifugo-json',
      ...w,
      sample: { perChannelPerSec: 1, maxFramesPerSec: 20, maxFrameBytes: 2048, outgoing: 'all', ...w.sample },
    },
    errors: { sampleRate: 1, console: ['error', 'warn'], failedRequestStatusCodes: [[400, 599]], ignoreErrors: [], denyUrls: [], ...o.errors },
    redact: { headers: [], bodyKeys: [], queryParams: [] },
  };
  extend(RD);
  extend(o.redact);
};

/** ingest endpoint base (D-09): tunnel (web only) or `<dsn origin>/ingest/<pid>/` */
let base = '', abs = '', key = '';
export const dsn = (d: string, tunnel: string | undefined, cap: boolean) => {
  const u = new URL(d);
  const p = u.pathname.replace(/\/+$/, '');
  const i = p.lastIndexOf('/');
  const pid = p.slice(i + 1);
  if (!pid || !u.username) throw 0;
  key = encodeURIComponent(decodeURIComponent(u.username));
  base = tunnel && !cap ? `${tunnel.replace(/\/+$/, '')}/${pid}/` : `${u.origin}${p.slice(0, i)}/ingest/${pid}/`;
  abs = absu(base);
};
export const iurl = (kind: string) => `${base}${kind}?key=${key}`;
/** absolute URL (relative to the page; under Capacitor that is https://localhost) */
export const absu = (u: string) => new URL(u, W.location.href).href;
/** true for the SDK's own ingest URLs (never captured) */
export const own = (u: string) => absu(u).startsWith(abs);

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
  take((O.replay.canvas ??= {}), c.canvas, ['enabled', 'fps', 'maxWidth', 'quality']);
  take(O.websocket, c.ws, ['enabled']);
  take(O.websocket.sample, c.ws, ['perChannelPerSec', 'maxFramesPerSec']);
  take(O.errors, c.errors, ['sampleRate']);
  extend(c.redact);
  setRcOff(c.disabled === true);
};

const CK = 'rp_cfg';
/** cached remote config `{t, c}` (localStorage, 10 min or `ttl`) */
export const cachedRc = (): { t: number; c: A } | null => sget(1, CK);
export const stale = (cc: { t: number; c: A } | null) => !cc || now() - cc.t > (+cc.c?.ttl || 600) * 1e3;

/** fetches remote config, caches + applies it. Network failures are ignored (local config stays). */
export const fetchRc = (f: typeof fetch, hdr: (r: Response) => void) =>
  f
    .call(W, iurl('config'), { credentials: 'omit' })
    .then((r) => (hdr(r), r.ok ? r.json() : null))
    .then((c) => {
      if (c && typeof c == 'object') {
        sset(1, CK, { t: now(), c });
        applyRc(c);
      }
    })
    .catch(() => {});
