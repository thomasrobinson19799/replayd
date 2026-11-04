// @vitest-environment node
// (a worker has no DOM; Node's own Response/Blob/CompressionStream are used, like the browser's in a worker)
// Replay worker (T-20): redaction, Centrifugo per-channel sampling, segment encoding, upload retry, gaps.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDb, gunzip, res } from './h';
import { splitSegment } from '../src/wire';

// the worker build aliases redact.ts's `./config` to worker/cfg.ts (build.json); mirror that here
vi.mock('../src/config', () => import('../src/worker/cfg'));

const RED = {
  headers: ['authorization', 'cookie'],
  bodyKeys: ['password', 'token', 'access_token'],
  queryParams: ['token', 'key', 'signature'],
};
const URL0 = 'https://replay.example.com/ingest/p/replay?key=pk';
const T = 1_730_620_000_000;

type Msg = unknown[];
async function setup(impl: (url: string, init?: RequestInit) => Promise<Response> = () => Promise.resolve(res(202)), outbox = 0) {
  vi.resetModules();
  const out: Msg[] = [];
  const f = vi.fn(impl);
  (globalThis as { fetch: unknown }).fetch = f;
  (globalThis as { self?: unknown }).self = globalThis;
  const g = globalThis as unknown as { postMessage: (m: unknown) => void; onmessage: ((e: { data: unknown }) => void) | null };
  g.postMessage = (m) => out.push(m as Msg);
  await import('../src/worker/index');
  const send = (m: unknown[]) => g.onmessage!({ data: m });
  send([0, URL0, RED, 1, 1, outbox]);
  return { f, out, send };
}
/** waits for gzip + fetch (real streams, so real timers have to tick) */
/** polls (real event-loop turns + 1 ms fake-timer steps) until `ok()` or ~2 s of real time */
const until = async (ok: () => boolean) => {
  const end = performance.now() + 2000;
  while (!ok() && performance.now() < end) {
    await vi.advanceTimersByTimeAsync(1);
    await new Promise((r) => setImmediate(r));
  }
};
/** real-time wait (setTimeout is faked) */
const sleep = async (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) await new Promise((r) => setImmediate(r));
};
const settle = async (n = 20) => {
  for (let i = 0; i < n; i++) {
    await vi.advanceTimersByTimeAsync(1);
    await new Promise((r) => setImmediate(r));
  }
  await sleep(60); // gzip / IndexedDB run on real time (slower when test files run in parallel)
  await vi.advanceTimersByTimeAsync(0);
};
async function decode(body: unknown) {
  const { meta, body: rest } = splitSegment(body as Uint8Array);
  const dv = new DataView(rest.buffer, rest.byteOffset, rest.byteLength);
  const len = dv.getUint32(0, true);
  const events = JSON.parse(await gunzip(rest.slice(4, 4 + len)));
  return { meta: JSON.parse(meta), events, assets: dv.getUint16(4 + len, true) };
}
const meta0 = (seq = 0) => ({ sid: 's1', seq, ws_disc: 0, ie: 0 });

describe('replay worker', () => {
  beforeEach(() => vi.useFakeTimers({ now: T, toFake: ['setTimeout', 'clearTimeout', 'Date'] }));
  afterEach(() => vi.useRealTimers());

  it('encodes a segment: meta counters, redacted URLs and WS frames, gzip events, no assets', async () => {
    const { f, send } = await setup();
    send([1, [
      { type: 4, timestamp: T, data: { href: 'https://t.example/trade?token=abc&x=1', width: 10, height: 10 } },
      { type: 2, timestamp: T + 1, data: { node: {} } },
      { type: 3, timestamp: T + 2, data: { source: 2, type: 2, id: 5 } },
      { type: 5, timestamp: T + 3, data: { tag: 'error', payload: { level: 'error', message: 'x' } } },
      { type: 5, timestamp: T + 4, data: { tag: 'error', payload: { level: 'warning', message: 'w' } } },
      { type: 5, timestamp: T + 5, data: { tag: 'nav', payload: { from: 'a', to: 'https://t.example/history' } } },
      { type: 5, timestamp: T + 6, data: { tag: 'ws', payload: { k: 'frame', id: 1, dir: 'out', raw: '{"id":1,"connect":{"token":"SECRET","name":"js"}}' } } },
    ]]);
    send([3, { ...meta0(), init: { url: 'https://t.example/?access_token=zz', ref: '', ua: 'UA' } }, RED, false]);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(URL0);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'text/plain' } });
    const { meta, events, assets } = await decode(init!.body);
    expect(meta).toMatchObject({ sid: 's1', seq: 0, t0: T, t1: T + 6, enc: 'gzip', n: 7, clicks: 1, errs: 1, warns: 1, has_error: true, gap: false, canvas_bytes: 0 });
    expect(meta.urls).toEqual(['https://t.example/trade?token=[Filtered]&x=1', 'https://t.example/history']);
    expect(meta.init.url).toBe('https://t.example/?access_token=[Filtered]');
    expect(assets).toBe(0);
    expect(events).toHaveLength(7);
    expect(events[0].data.href).toContain('token=[Filtered]');
    expect(events[6].data.payload.raw).not.toContain('SECRET');
    expect(JSON.parse(events[6].data.payload.raw).connect.token).toBe('[Filtered]');
  });

  it('samples incoming Centrifugo pushes per channel (1/s) and keeps replies', async () => {
    const { f, send } = await setup();
    const push = (ch: string, v: number) => JSON.stringify({ push: { channel: ch, pub: { data: { v } } } });
    send([1, [
      { type: 5, timestamp: T, data: { tag: 'ws', payload: { k: 'frame', id: 1, dir: 'in', raw: [push('q:EURUSD', 1), push('q:XAUUSD', 1)].join('\n') } } },
      { type: 5, timestamp: T + 100, data: { tag: 'ws', payload: { k: 'frame', id: 1, dir: 'in', raw: push('q:EURUSD', 2) } } },
      { type: 5, timestamp: T + 200, data: { tag: 'ws', payload: { k: 'frame', id: 1, dir: 'in', raw: [push('q:EURUSD', 3), '{"id":2,"subscribe":{}}'].join('\n') } } },
      { type: 5, timestamp: T + 1100, data: { tag: 'ws', payload: { k: 'frame', id: 1, dir: 'in', raw: push('q:EURUSD', 4) } } },
    ]]);
    send([3, meta0(), RED, false]);
    await settle();
    const { events, meta } = await decode(f.mock.calls[0]![1]!.body);
    expect(meta.n).toBe(3); // the 2nd frame had only a sampled-out push → dropped entirely
    expect(events.map((e: { data: { payload: { raw: string } } }) => e.data.payload.raw.split('\n').length)).toEqual([2, 1, 1]);
    expect(events[1].data.payload.raw).toBe('{"id":2,"subscribe":{}}');
    expect(JSON.parse(events[2].data.payload.raw).push.pub.data.v).toBe(4);
  });

  it('rebuilds coalesced text mutations from ids + \\0-joined values', async () => {
    const { f, send } = await setup();
    send([2, new Int32Array([7, 9]), '1.0850\u00001.0852', T]);
    send([3, meta0(), RED, false]);
    await settle();
    const { events } = await decode(f.mock.calls[0]![1]!.body);
    expect(events).toEqual([{ type: 3, timestamp: T, data: { source: 0, texts: [{ id: 7, value: '1.0850' }, { id: 9, value: '1.0852' }], attributes: [], removes: [], adds: [] } }]);
  });

  it('asks the main thread for a cut at 256 KB raw, once per segment', async () => {
    const { out, send } = await setup();
    const big = 'x'.repeat(100_000);
    for (let i = 0; i < 4; i++) send([1, [{ type: 5, timestamp: T + i, data: { tag: 'console', payload: { level: 'log', args: [big] } } }]]);
    expect(out).toEqual([[0]]);
  });

  it('retries 503 with Retry-After, drops a 400 and marks the next segment with a gap', async () => {
    const st = [503, 202, 400, 202];
    const { f, send } = await setup(() => Promise.resolve(res(st.shift()!, { 'retry-after': '2' })));
    send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
    send([3, meta0(0), RED, false]);
    await settle();
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1900);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(f).toHaveBeenCalledTimes(2); // retried after Retry-After
    send([1, [{ type: 3, timestamp: T + 10, data: { source: 1, positions: [] } }]]);
    send([3, meta0(1), RED, false]);
    await settle();
    expect(f).toHaveBeenCalledTimes(3); // 400: dropped, not retried
    send([1, [{ type: 3, timestamp: T + 20, data: { source: 1, positions: [] } }]]);
    send([3, meta0(2), RED, false]);
    await settle();
    expect(f).toHaveBeenCalledTimes(4);
    const { meta, events } = await decode(f.mock.calls[3]![1]!.body);
    expect(meta.gap).toBe(true);
    expect(events[0]).toMatchObject({ type: 5, data: { tag: 'gap', payload: { reason: 'dropped', segments: 1 } } });
  });

  it('gives up after 5 attempts with exponential backoff', async () => {
    const { f, send } = await setup(() => Promise.reject(new TypeError('offline')));
    send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
    send([3, meta0(), RED, false]);
    await settle();
    for (const ms of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(ms + 10);
    expect(f).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it('caps the queue at 5 MB (drop oldest → gap) and relays X-Replayd-Disable', async () => {
    let release: (r: Response) => void = () => {};
    const { f, out, send } = await setup(() => new Promise<Response>((r) => (release = r)));
    // ~0.8 MB gzip each: 8 segments exceed the 5 MB cap
    const rnd = () => Array.from({ length: 160_000 }, () => Math.random().toString(36).slice(2, 10)).join('');
    for (let i = 0; i < 8; i++) {
      send([1, [{ type: 5, timestamp: T + i, data: { tag: 'console', payload: { level: 'log', args: [rnd()] } } }]]);
      send([3, meta0(i), RED, false]);
      if (i === 0) await until(() => f.mock.calls.length === 1);
      else await sleep(150); // gzip of ~1.3 MB
    }
    expect(f).toHaveBeenCalledTimes(1); // one in flight; the rest queued (≤ 5 MB)
    release(res(202, { 'x-replayd-disable': '600' }));
    await until(() => f.mock.calls.length > 1);
    expect(out).toContainEqual([1, 600]);
    const later = f.mock.calls.slice(1).map((c) => c[1]!.body as Uint8Array);
    const metas = await Promise.all(later.map(async (b) => (await decode(b)).meta.seq));
    expect(metas[0]).toBeGreaterThan(1); // seq 1 (oldest queued) was dropped for the cap
  }, 30_000);

  it('on hide sends queued segments in parallel, keepalive only within 60 KB', async () => {
    const { f, send } = await setup(() => new Promise<Response>(() => {}));
    send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
    send([3, meta0(0), RED, false]);
    await until(() => f.mock.calls.length === 1);
    send([1, [{ type: 3, timestamp: T + 1, data: { source: 1, positions: [] } }]]);
    send([3, meta0(1), RED, true]);
    await until(() => f.mock.calls.length === 2);
    expect(f).toHaveBeenCalledTimes(2);
    expect(f.mock.calls[1]![1]).toMatchObject({ keepalive: true });
  });

  describe('IndexedDB outbox (Capacitor / offlineQueue)', () => {
    beforeEach(async () => {
      await clearDb();
    });
    const stored = async () => (await (await import('../src/idb')).load('q'))[0].length;

    it('stores each segment before sending and deletes it once the server answered', async () => {
      const { f, send } = await setup(undefined, 1);
      send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
      send([3, meta0(), RED, false]);
      await until(() => f.mock.calls.length === 1);
      await sleep(50);
      expect(await stored()).toBe(0);
    });

    it('keeps segments through network failures and sends them when drained (online / resume)', async () => {
      let up = false;
      const { f, send } = await setup(() => (up ? Promise.resolve(res(202)) : Promise.reject(new TypeError('offline'))), 1);
      send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
      send([3, meta0(0), RED, false]);
      await until(() => f.mock.calls.length === 1);
      for (const ms of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(ms + 10);
      await settle();
      expect(f).toHaveBeenCalledTimes(5);
      expect(await stored()).toBe(1);
      up = true;
      send([4]);
      await until(() => f.mock.calls.length === 6);
      await sleep(50);
      expect(await stored()).toBe(0);
      const { meta } = await decode(f.mock.calls[5]![1]!.body);
      expect(meta).toMatchObject({ sid: 's1', seq: 0, gap: false });
    });

    it('online / resume during a network backoff retries at once; a server Retry-After still holds', async () => {
      // real-time waits only: the fake clock stands still, so a pending backoff timer can never fire by itself
      const wait = async (ok: () => boolean) => {
        const end = performance.now() + 2000;
        while (!ok() && performance.now() < end) await new Promise((r) => setImmediate(r));
      };
      let up = false;
      const { f, send } = await setup(() => (up ? Promise.resolve(res(202)) : Promise.reject(new TypeError('offline'))), 1);
      send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
      send([3, meta0(0), RED, false]);
      await wait(() => f.mock.calls.length === 1);
      await sleep(50);
      expect(f).toHaveBeenCalledTimes(1); // failed, now in a 1 s backoff
      up = true;
      send([4]);
      await wait(() => f.mock.calls.length === 2);
      expect(f).toHaveBeenCalledTimes(2);
      await sleep(50);
      expect(await stored()).toBe(0);

      const st = [503, 202];
      const g = await setup(() => Promise.resolve(res(st.shift()!, { 'retry-after': '30' })), 1);
      g.send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
      g.send([3, meta0(0), RED, false]);
      await wait(() => g.f.mock.calls.length === 1);
      await sleep(50);
      g.send([4]);
      await sleep(100);
      expect(g.f).toHaveBeenCalledTimes(1); // the server asked for 30 s
      await vi.advanceTimersByTimeAsync(30_010);
      await wait(() => g.f.mock.calls.length === 2);
      expect(g.f).toHaveBeenCalledTimes(2);
    });

    it('drains leftovers of a previous run at start; expired ones become a gap', async () => {
      const idb = await import('../src/idb');
      const { encodeSegment } = await import('../src/wire');
      const gz = new Uint8Array(await new Response(new Blob(['[]']).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
      await idb.put('q', { t: T - 25 * 3600e3, b: encodeSegment(JSON.stringify({ sid: 'old', seq: 0 }), gz) });
      await idb.put('q', { t: T - 60e3, b: encodeSegment(JSON.stringify({ sid: 'old', seq: 1 }), gz) });
      const { f, send } = await setup(undefined, 1);
      await until(() => f.mock.calls.length === 1);
      expect(JSON.parse(splitSegment(f.mock.calls[0]![1]!.body as Uint8Array).meta)).toEqual({ sid: 'old', seq: 1 });
      send([1, [{ type: 3, timestamp: T, data: { source: 1, positions: [] } }]]);
      send([3, meta0(0), RED, false]);
      await until(() => f.mock.calls.length === 2);
      expect((await decode(f.mock.calls[1]![1]!.body)).meta.gap).toBe(true);
    });
  });
});
