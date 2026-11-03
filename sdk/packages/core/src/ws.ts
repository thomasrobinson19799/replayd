/**
 * WebSocket + EventSource capture (PRD §4.8). Only sockets whose URL matches `websocket.urls` are touched;
 * all others get zero listeners and no own properties.
 *
 * Incoming hot path: ONE 'message' listener per socket doing a timestamp check against the per-socket
 * last-sample time — no parsing, no string copy, no allocation. Frames that pass the gate are pushed raw
 * (sliced to maxFrameBytes); redaction happens later, off the hot path (ring drain now, worker in T-20).
 */
import { O } from './config';
import { capture } from './errors';
import { crumb, rec } from './ring';
import { rUrl } from './redact';
import { ctor, en, err, match, now, on, wrapf } from './u';

/** min ms between sampled incoming frames per socket; Infinity = frames off (disabled / kill switch) */
let gap = Infinity;
export const wsCfg = () => {
  const w = O?.websocket;
  gap = en && w.enabled ? 1e3 / w.sample.maxFramesPerSec : Infinity;
};

/** session counters for segment meta */
export const wsc = { ws_disc: 0 };
let n = 0;
/** host+path → [connection attempts, ...recent attempt timestamps (≤ 8)] ; host+path+code → last warning */
let att = new Map<string, number[]>(), lim = new Map<string, number>();
export const resetWs = () => {
  wsc.ws_disc = 0;
  att = new Map();
  lim = new Map();
};

type D = Record<string, unknown>;
const life = (id: number, k: string, url: string, x: D = {}) => {
  rec('ws', { k, id, url, ...x });
  crumb('ws', `${k} ${url}`, x);
};
const frame = (id: number, dir: string, d: unknown, ts = now()) =>
  rec(
    'ws',
    { k: 'frame', id, dir, ...(typeof d == 'string' ? { raw: d.slice(0, O.websocket.sample.maxFrameBytes) } : { binary: true, size: (d as Blob).size ?? (d as ArrayBuffer).byteLength }) },
    ts,
  );
/** lifecycle listener (try/catch'd; not registered for close() — it dies with its socket) */
const lis = (s: EventTarget, t: string, f: (e: never) => void) => on(s, t, f, false, 1);

const hook = (s: WebSocket, a: IArguments) => {
  const w = O.websocket;
  if (!w.enabled || !match(w.urls, s.url)) return;
  const id = ++n, u = rUrl(s.url), k = u.split('?')[0]!, t0 = now();
  if (att.size > 50) att.clear();
  const r = att.get(k) ?? [0];
  r[0]!++;
  r.push(t0);
  if (r.length > 9) r.splice(1, 1);
  att.set(k, r);
  let last = 0;
  // HOT PATH — keep it exactly this: one subtraction + compare, then return
  s.addEventListener('message', (e) => {
    const t = e.timeStamp;
    if (t - last < gap) return;
    last = t;
    try {
      frame(id, 'in', e.data, Math.round(performance.timeOrigin + t));
    } catch {
      err();
    }
  });
  // outgoing: instance-level own `send` (only matching sockets pay; the prototype and every other
  // socket stay untouched). Outgoing volume is low, all frames are kept (PRD §4.8).
  if (w.sample.outgoing != 'none') s.send = wrapf(s.send, (_r, x: IArguments) => O.websocket.enabled && frame(id, 'out', x[0]));
  lis(s, 'open', () => life(id, 'open', u, { protocols: a[1] ?? [], protocol: s.protocol }));
  lis(s, 'error', () => life(id, 'error', u));
  lis(s, 'close', (e: CloseEvent) => {
    const t = now(), code = e.code, re = r[0]! - 1, recent = r.filter((x, i) => i && t - x < 6e4).length;
    life(id, 'close', u, { code, reason: e.reason, wasClean: e.wasClean, duration: t - t0, reconnects: re });
    const ab = code != 1000 && code != 1001;
    if (ab) wsc.ws_disc++;
    // abnormal close, or > 3 reconnects within 60 s → warning, 1/min/session per host+path+code
    const lk = k + code;
    if ((ab || recent > 4) && !(t - (lim.get(lk) ?? -6e4) < 6e4)) {
      lim.set(lk, t);
      capture('warning', 'ws', 'WebSocketClose', `WebSocket closed abnormally (code ${code})`, undefined, { ws: { url: u, code, reconnects: re } }, s.url);
    }
  });
};

export const wsHooks = () => {
  ctor('WebSocket', hook);
  ctor('EventSource', (s: EventSource) => {
    if (!O.websocket.enabled) return;
    const id = ++n, u = rUrl(s.url);
    lis(s, 'open', () => life(id, 'open', u, { sse: true }));
    lis(s, 'error', () => life(id, 'error', u, { sse: true }));
  });
  wsCfg();
};

