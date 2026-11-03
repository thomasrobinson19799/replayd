/**
 * Main-thread transport (PRD §4.10/§4.11, D-09): bounded byte queue (drop-oldest), one request in
 * flight, retry with exp. backoff 1 s → 60 s (max 5 attempts), Retry-After on 429/503, 403/413/other
 * 4xx dropped, X-Replayd-Disable honoured on any response. Error events are batched every 2 s / 10.
 */
import type { ReplaydEvent } from './types';
import { iurl } from './config';
import { W, en, err, off } from './u';

interface Q {
  k: string;
  b: Uint8Array;
  n: number;
  f?: boolean;
}
const CAP = 5 << 20, KA = 6e4;
let q: Q[] = [], qb = 0, fl = 0, tm: ReturnType<typeof setTimeout> | 0 = 0;

/** transport fetch: `CapacitorWebFetch ?? original fetch`, captured at init before patching (D-07) */
export let tf: typeof fetch;
export const setTf = (f: typeof fetch) => {
  tf = f;
};

/** response headers that apply to every ingest response */
export const hdr = (r: Response) => {
  off(+(r.headers.get('x-replayd-disable') ?? 0));
};

const rm = (it: Q) => {
  const i = q.indexOf(it);
  if (i >= 0) qb -= q.splice(i, 1)[0]!.b.byteLength;
};

const go = (it: Q, ka: boolean) => {
  it.f = true;
  fl++;
  tf.call(W, iurl(it.k), { method: 'POST', body: it.b as BodyInit, keepalive: ka, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
    .then(
      (r) => {
        hdr(r);
        const s = r.status;
        // 0 = done (2xx/3xx, or a 4xx that retrying can't fix); > 0 = Retry-After s; -1 = backoff
        return s < 400 || (s < 500 && s != 429) ? 0 : +(r.headers.get('retry-after') ?? 0) || -1;
      },
      () => -1,
    )
    .then((ra) => {
      it.f = false;
      fl--;
      if (ra && ++it.n < 5) {
        clearTimeout(tm);
        tm = setTimeout(
          () => {
            tm = 0;
            pump();
          },
          ra > 0 ? Math.min(ra * 1e3, 36e5) : Math.min(6e4, 500 * 2 ** it.n),
        );
        return;
      }
      rm(it);
      pump();
    })
    .catch(err);
};

/** sends the queue head (sequential); on hide: everything not in flight, keepalive within 60 KB total */
export const pump = (hide?: boolean) => {
  if (!en || (!hide && (fl || tm))) return;
  let ka = KA;
  for (const it of q) {
    if (it.f) continue;
    const n = it.b.byteLength;
    if (!hide) return go(it, n < KA);
    const k = n < ka;
    if (k) ka -= n;
    go(it, k);
  }
};

/** queue a body for upload; drops oldest entries above 5 MB */
export const send = (k: string, b: Uint8Array) => {
  if (!en) return;
  q.push({ k, b, n: 0 });
  qb += b.byteLength;
  while (qb > CAP && q.length > 1) rm(q[0]!);
  pump();
};

export const gzip = (s: string) =>
  new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer().then((b) => new Uint8Array(b));

let ev: ReplaydEvent[] = [], et: ReturnType<typeof setTimeout> | 0 = 0;
/** queue an error event: flushed every 2 s or at 10 events (cap 100 pending, drop oldest) */
export const pushEv = (e: ReplaydEvent) => {
  if (ev.push(e) > 100) ev.shift();
  if (ev.length >= 10) flushEv();
  else et ||= setTimeout(flushEv, 2e3);
};

/** gzip + send pending events. `sync` (page hide): plain JSON, no await (server sniffs gzip magic). */
export const flushEv = (sync?: boolean) => {
  clearTimeout(et);
  et = 0;
  if (!ev.length) return Promise.resolve();
  const j = JSON.stringify(ev);
  ev = [];
  if (sync) return send('events', new TextEncoder().encode(j)), Promise.resolve();
  return gzip(j).then((b) => send('events', b), err);
};

/** drop everything (kill switch / close) */
export const reset = () => {
  q = [];
  qb = 0;
  ev = [];
  clearTimeout(tm);
  clearTimeout(et);
  tm = et = 0;
};
