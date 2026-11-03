/**
 * Replay worker (PRD §4.10, D-09/D-15): per-event redaction + bookkeeping, Centrifugo per-channel sampling,
 * JSON encoding, gzip (CompressionStream), segment wrapping (wire.ts) and upload with retry/backoff, a 5 MB
 * drop-oldest queue and gap markers. Built as a classic IIFE script (build.json) with `./config` aliased to
 * ./cfg so redact.ts runs here without the main-thread config module.
 *
 * Main → worker: [0, url, redact, centrifugo, perChannelPerSec, outbox] init · [4] drain the outbox (online/resume) · [1, events] batch ·
 *                [2, ids, values, ts, events] events, then coalesced texts (D-04) · [3, meta, redact, hide] cut a segment
 * Worker → main: [0] raw events ≥ 256 KB (please cut) · [1, seconds] X-Replayd-Disable
 */
import type { RedactOptions } from '../types';
import { encodeSegment } from '../wire';
import { rText, rUrl } from '../redact';
import { setRedact } from './cfg';
import { del, load, put } from '../idb';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;
interface Q {
  b: Uint8Array;
  n: number;
  f?: boolean;
  /** outbox key (IndexedDB), when the outbox is on */
  p?: Promise<IDBValidKey | undefined>;
}
const G = self as unknown as { postMessage(m: unknown): void; onmessage: ((e: MessageEvent) => void) | null };
const CAP = 5 << 20, KA = 6e4, FULL = 256 << 10;

let url = '', co = 0, cpc = 1, last = new Map<string, number>();
/** IndexedDB outbox (PRD §4.9: Capacitor always, web with `offlineQueue: true`): every segment is stored before
 *  it is sent and deleted once the server answered; network failures stay stored and are drained later */
let ob = 0, draining = 0;
// current segment
let P: string[] = [], raw = 0, n = 0, t0 = 0, t1 = 0, clicks = 0, errs = 0, warns = 0, urls: string[] = [], asked = 0;
// segments lost since the last one that went out (queue cap, retries exhausted, rejected)
let gap = 0;

const url1 = (u: unknown) => typeof u == 'string' && urls.length < 10 && !urls.includes(u) && urls.push(u);

/** Centrifugo JSON: keeps lines whose `push.channel` passed its 1/perChannelPerSec gate (others: replies etc.) */
const sample = (s: string, ts: number) => {
  const k: string[] = [];
  for (const l of s.split('\n')) {
    let ch: unknown;
    try {
      ch = JSON.parse(l).push?.channel;
    } catch {
      /* truncated / not JSON: keep */
    }
    if (typeof ch == 'string') {
      if (ts - (last.get(ch) ?? -1e15) < 1e3 / cpc) continue;
      if (last.size > 999) last = new Map();
      last.set(ch, ts);
    }
    k.push(l);
  }
  return k.join('\n');
};

const add = (e: A) => {
  const d = e.data, ts = e.timestamp;
  if (e.type == 4 && d.href) url1((d.href = rUrl(d.href)));
  else if (e.type == 3 && d.source == 2 && d.type == 2) clicks++;
  else if (e.type == 5) {
    const p = d.payload;
    if (d.tag == 'error') {
      if (p.level == 'warning') warns++;
      else errs++;
    }
    else if (d.tag == 'nav') url1(p.to);
    else if (d.tag == 'ws' && typeof p.raw == 'string') {
      if (co && p.dir == 'in' && !(p.raw = sample(p.raw, ts))) return;
      p.raw = rText(p.raw);
    }
  }
  if (!n++) t0 = ts;
  if (ts > t1) t1 = ts;
  const s = JSON.stringify(e);
  raw += s.length;
  P.push(s);
};

// ---- upload queue: one request in flight, exp. backoff 1 s → 60 s, max 5 attempts, Retry-After on 429/503
const q: Q[] = [];
let qb = 0, fl = 0, tm: ReturnType<typeof setTimeout> | 0 = 0;
const rm = (it: Q) => {
  const i = q.indexOf(it);
  if (i >= 0) qb -= q.splice(i, 1)[0]!.b.length;
};
const go = (it: Q, ka: boolean) => {
  it.f = true;
  fl++;
  fetch(url, { method: 'POST', body: it.b as BodyInit, keepalive: ka, credentials: 'omit', headers: { 'Content-Type': 'text/plain' } })
    .then(
      (r) => {
        const off = +(r.headers.get('x-replayd-disable') ?? 0);
        if (off > 0) G.postMessage([1, off]);
        const s = r.status;
        // 0 = done; -2 = rejected (4xx other than 429: retrying can't fix it); > 0 Retry-After s; -1 backoff
        return s < 400 ? 0 : s < 500 && s != 429 ? -2 : +(r.headers.get('retry-after') ?? 0) || -1;
      },
      () => -1,
    )
    .then((ra) => {
      it.f = false;
      fl--;
      if (ra > -2 && ra && ++it.n < 5) {
        clearTimeout(tm);
        tm = setTimeout(
          () => {
            tm = 0;
            pump();
          },
          ra > 0 ? ra * 1e3 : Math.min(6e4, 500 * 2 ** it.n),
        );
        return;
      }
      // stored segments survive network/5xx failures (drained on online/resume/next start); else: lost
      if (ob && ra == -1) {
        rm(it);
        return;
      }
      if (ra) gap++;
      done(it);
      pump();
    });
};
/** finished (sent or rejected): out of memory and out of the outbox */
const done = (it: Q) => {
  rm(it);
  it.p?.then((k) => k != null && del('q', k)).catch(() => {});
};
/** loads stored segments that are not in memory (oldest first, ≤ the memory cap); expired/over-cap → gap */
const drain = async () => {
  if (!ob || draining) return;
  draining = 1;
  try {
    const mine = new Set(await Promise.all(q.map((x) => x.p)));
    const [recs, lost] = await load('q');
    gap += lost;
    for (const [k, r] of recs) {
      if (mine.has(k) || qb + r.b.byteLength > CAP) continue;
      q.push({ b: r.b, n: 0, p: Promise.resolve(k) });
      qb += r.b.byteLength;
    }
  } catch {
    /* no IndexedDB (private mode, quota): memory queue only */
  }
  draining = 0;
  pump();
};
/** sends the head (sequential); on hide: everything not in flight, keepalive within a 60 KB total */
const pump = (hide?: boolean) => {
  if (!hide && (fl || tm)) return;
  let ka = KA;
  for (const it of q) {
    if (it.f) continue;
    const s = it.b.length;
    if (!hide) return go(it, s < KA);
    const k = s < ka;
    if (k) ka -= s;
    go(it, k);
  }
};

const cut = async (m: A, r: Required<RedactOptions>, hide: boolean) => {
  setRedact(r);
  if (!n) return;
  if (m.init) {
    m.init.url = rUrl(m.init.url);
    m.init.ref = rUrl(m.init.ref);
  }
  if (gap) P.unshift(JSON.stringify({ type: 5, timestamp: t0, data: { tag: 'gap', payload: { reason: 'dropped', segments: gap } } }));
  const meta = JSON.stringify({ ...m, t0, t1, enc: 'gzip', n, urls, clicks, errs, warns, has_error: errs > 0, canvas_bytes: 0, gap: gap > 0 });
  const json = `[${P.join(',')}]`;
  P = [];
  raw = n = t1 = clicks = errs = warns = asked = gap = 0;
  urls = [];
  const gz = new Uint8Array(await new Response(new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
  const b = encodeSegment(meta, gz), it: Q = { b, n: 0 };
  if (ob) it.p = put('q', { t: Date.now(), b }).catch(() => undefined);
  q.push(it);
  qb += b.length;
  // 5 MB memory cap: drop the oldest segments that are not in flight (with the outbox they stay stored)
  for (let i = 0; qb > CAP && i < q.length - 1; )
    if (q[i]!.f) i++;
    else {
      rm(q[i]!);
      if (!ob) gap++;
    }
  pump(hide);
};

G.onmessage = (e: MessageEvent) => {
  const m = e.data;
  try {
    if (m[0] == 1) for (const x of m[1]) add(x);
    else if (m[0] == 2) {
      for (const x of m[4] ?? []) add(x);
      const ids: Int32Array = m[1], v: string[] = m[2].split('\0'), texts = [];
      for (let i = 0; i < ids.length; i++) texts.push({ id: ids[i], value: v[i] });
      add({ type: 3, timestamp: m[3], data: { source: 0, texts, attributes: [], removes: [], adds: [] } });
    } else if (m[0] == 3) cut(m[1], m[2], m[3]).catch(() => {});
    else if (m[0] == 0) {
      url = m[1];
      setRedact(m[2]);
      co = m[3];
      cpc = m[4] || 1;
      ob = m[5] ? 1 : 0;
      void drain();
    } else if (m[0] == 4) void drain();
    if (raw >= FULL && !asked) {
      asked = 1;
      G.postMessage([0]);
    }
  } catch {
    /* a malformed event must not kill the worker */
  }
};
