// Replay chunk main thread (T-20): rrweb + batching, ring drain, data-rp-throttle coalescing (D-04) incl.
// masking, the 10k-node mutation guard, segment cuts (5 s / error / hide / rollover) and the kill switch.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Internal, RingEvent, Session } from '../src/types';

type Msg = [number, ...unknown[]];
let posted: Msg[] = [];
let terminated = 0;
let workers: FakeWorker[] = [];
class FakeWorker {
  constructor() {
    workers.push(this);
  }
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  postMessage(m: Msg) {
    posted.push(structuredClone(m));
  }
  terminate() {
    terminated++;
  }
}

interface Ctl {
  I: Internal;
  S: Session;
  sink: ((e: RingEvent) => void) | null;
  onErr: () => void;
  en: boolean;
  worker: () => FakeWorker;
}
function internal(ring: RingEvent[] = []): Ctl {
  const c = { S: { id: 'sid-1', seq: 0, st: Date.now(), la: Date.now() } as Session, sink: null, onErr: () => {}, en: true } as unknown as Ctl;
  c.I = {
    o: () => ({
      dsn: 'x', release: '1.0.0', environment: 'test',
      replay: { sampleRate: 1, networkDetailAllowUrls: [] },
      websocket: { enabled: true, urls: [], sample: { perChannelPerSec: 1, maxFramesPerSec: 20, maxFrameBytes: 2048 } },
      errors: {}, redact: { headers: ['authorization'], bodyKeys: ['token'], queryParams: ['token'] },
    }) as never,
    sess: () => c.S,
    seq: () => c.S.seq++,
    drain: () => ring.splice(0),
    sink: (f) => (c.sink = f),
    onError: (f) => (c.onErr = f),
    en: () => c.en,
    url: (k) => `/_rp/p/${k}?key=pk`,
    fetch: fetch,
    send: () => {},
    ie: () => 0,
    c: { ws_disc: 0 },
    m: () => ({ user: { id: 'u1' }, tags: { brand: 'fx' } }),
    platform: 'web',
  };
  return c;
}
const events = () => posted.filter((m) => m[0] === 1 || m[0] === 2).flatMap((m) => (m[0] === 1 ? (m[1] as { type: number }[]) : ((m[4] as { type: number }[]) ?? [])));
const texts = () => posted.filter((m) => m[0] === 2).map((m) => ({ ids: Array.from(m[1] as Int32Array), vals: (m[2] as string).split('\0') }));
const cuts = () => posted.filter((m) => m[0] === 3).map((m) => m[1] as Record<string, unknown>);
const micro = () => vi.advanceTimersByTimeAsync(0);

let live: Ctl[] = [];
async function start(ring?: RingEvent[]) {
  vi.resetModules();
  const c = internal(ring);
  live.push(c);
  const { startReplay } = await import('../src/replay/index');
  startReplay(c.I);
  return c;
}

describe('replay chunk (main thread)', () => {
  beforeEach(() => {
    posted = [];
    workers = [];
    terminated = 0;
    (globalThis as { Worker: unknown }).Worker = FakeWorker;
    // happy-dom has a `DOMTokenList` key whose value is undefined (rrweb's polyfill() reads its prototype)
    const w = window as unknown as { DOMTokenList?: unknown };
    if (!w.DOMTokenList) w.DOMTokenList = document.body.classList.constructor;
    vi.useFakeTimers({ now: 1_730_620_000_000 });
    document.body.innerHTML = `
      <div id="wl" data-rp-throttle="1000"><span id="a">1.0</span><span id="b">2.0</span><b id="c">x</b></div>
      <div id="ob" data-rp-throttle="500" data-rp-mask><span id="m">9.99</span></div>
      <div id="free"><span id="f">free</span></div>
      <input type="password" value="hunter2">`;
  });
  afterEach(async () => {
    // stop every instance (kill switch → end() at the next cut) so listeners don't leak into later tests
    for (const c of live) c.en = false;
    live = [];
    await vi.advanceTimersByTimeAsync(5000);
    vi.useRealTimers();
  });

  it('starts the worker with an absolute ingest URL, records a full snapshot and drains the ring', async () => {
    await start([{ type: 'console', ts: 1_730_619_999_000, data: { level: 'log', args: ['early'] } }]);
    const init = posted.find((m) => m[0] === 0)!;
    expect(String(init[1])).toMatch(/^http.*\/_rp\/p\/replay\?key=pk$/);
    await vi.advanceTimersByTimeAsync(500);
    const ev = events();
    expect(ev.map((e) => e.type).slice(0, 2)).toEqual([4, 2]);
    expect(ev).toContainEqual({ type: 5, timestamp: 1_730_619_999_000, data: { tag: 'console', payload: { level: 'log', args: ['early'] } } });
    expect(JSON.stringify(ev)).not.toContain('hunter2');
  });

  it('live custom events go through the sink; an error forces a segment cut', async () => {
    const c = await start();
    c.sink!({ type: 'error', ts: Date.now(), data: { level: 'error', message: 'boom' } });
    c.onErr();
    const m = cuts();
    expect(m).toHaveLength(1);
    expect(m[0]).toMatchObject({ sid: 'sid-1', seq: 0, ws_disc: 0, ie: 0, init: { release: '1.0.0', env: 'test', platform: 'web', user: { id: 'u1' }, tags: { brand: 'fx' } } });
    expect(events().some((e) => e.type === 5)).toBe(true);
  });

  it('coalesces throttled text changes to the latest value, masked where required; others go through rrweb', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(500);
    posted = [];
    const a = document.getElementById('a')!.firstChild as Text, m = document.getElementById('m')!.firstChild as Text;
    for (let i = 0; i < 5; i++) {
      a.nodeValue = `1.0${i}`;
      m.nodeValue = `9.9${i}`;
      await micro();
    }
    (document.getElementById('f')!.firstChild as Text).nodeValue = 'changed';
    await micro();
    await vi.advanceTimersByTimeAsync(1000);
    const t = texts();
    const all = t.flatMap((x) => x.vals);
    expect(all).toContain('1.04');
    expect(all).not.toContain('1.01');
    expect(all).toContain('****'); // masked container: 9.94 → ****
    expect(all.some((v) => v.startsWith('9.9'))).toBe(false);
    // throttled values never reach rrweb's own mutation events (the non-throttled path is rrweb's: checked in
    // the browser by bench/perf/replay.mjs, happy-dom's accessors make rrweb fall back to an iframe here)
    const muts = events().filter((e) => e.type === 3) as unknown as { data: { texts: { value: string }[] } }[];
    expect(muts.some((e) => e.data.texts?.some((x) => x.value.startsWith('1.0')))).toBe(false);
  });

  it('a 1000 ms container emits each node at most once per 1000 ms (staggered 500 ms ticks)', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(500);
    posted = [];
    const a = document.getElementById('a')!.firstChild as Text, b = document.getElementById('b')!.firstChild as Text;
    const seen = new Map<number, number[]>();
    for (let k = 0; k < 40; k++) {
      a.nodeValue = `a${k}`;
      b.nodeValue = `b${k}`;
      await micro();
      await vi.advanceTimersByTimeAsync(100);
      for (const m of posted.splice(0)) if (m[0] === 2) for (const id of m[1] as Int32Array) (seen.get(id) ?? seen.set(id, []).get(id)!).push(Date.now());
    }
    expect(seen.size).toBe(2);
    for (const ts of seen.values()) {
      expect(ts.length).toBeGreaterThanOrEqual(3);
      for (let i = 1; i < ts.length; i++) expect(ts[i]! - ts[i - 1]!).toBeGreaterThanOrEqual(1000);
    }
  });

  it('textContent swaps inside a throttled container are emitted against the original text node id', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(500);
    const full = events().find((e) => e.type === 2)!;
    const json = JSON.stringify(full);
    posted = [];
    const c = document.getElementById('c')!;
    for (let i = 0; i < 3; i++) {
      c.textContent = `y${i}`;
      await micro();
    }
    await vi.advanceTimersByTimeAsync(1000);
    const t = texts().flatMap((x) => x.ids.map((id, i) => [id, x.vals[i]]));
    expect(t.map((x) => x[1])).toContain('y2');
    const id = t.find((x) => x[1] === 'y2')![0] as number;
    // the id of the ORIGINAL text child of #c in the full snapshot
    expect(json).toMatch(new RegExp(`"attributes":\\{"id":"c"\\},"childNodes":\\[\\{"type":3,[^}]*"id":${id}\\}`));
    expect(events().filter((e) => e.type === 3)).toHaveLength(0); // no childList mutation reached rrweb
  });

  it('mutation guard: > 10,000 added nodes → a new full snapshot instead of the mutation', async () => {
    await start();
    await vi.advanceTimersByTimeAsync(500);
    posted = [];
    const box = document.createElement('div');
    for (let i = 0; i < 10_001; i++) box.appendChild(document.createElement('i'));
    document.getElementById('free')!.appendChild(box);
    await micro();
    await vi.advanceTimersByTimeAsync(500);
    const ev = events();
    expect(ev.some((e) => e.type === 2)).toBe(true);
    expect(ev.some((e) => e.type === 3 && (e as unknown as { data: { adds?: unknown[] } }).data.adds?.length)).toBe(false);
  });

  it('cuts every 5 s only when there is new data, on hide, and rolls a new session over with a full snapshot', async () => {
    const c = await start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cuts()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(cuts()).toHaveLength(1); // nothing new
    posted = [];
    c.sink!({ type: 'console', ts: Date.now(), data: { level: 'log', args: ['x'] } });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(cuts()).toHaveLength(0); // still visible
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    const h = posted.filter((m) => m[0] === 3);
    expect(h).toHaveLength(1);
    expect(h[0]![3]).toBe(true); // hide flag → worker uses keepalive
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    // rollover: the buffered data closes the old session (old sid, next seq), then a full snapshot starts the new one
    c.S = { id: 'sid-2', seq: 0, st: Date.now(), la: Date.now() };
    c.sink!({ type: 'console', ts: Date.now(), data: { level: 'log', args: ['y'] } });
    posted = [];
    await vi.advanceTimersByTimeAsync(5000);
    expect(cuts()[0]).toMatchObject({ sid: 'sid-1', seq: 2 });
    expect(cuts()[0]!.init).toBeUndefined();
    await vi.advanceTimersByTimeAsync(5000);
    expect(cuts()[1]).toMatchObject({ sid: 'sid-2', seq: 0, init: { release: '1.0.0' } });
    expect(events().some((e) => e.type === 2)).toBe(true);
  });

  it('stops (worker terminated, sink released) on the kill switch and on X-Replayd-Disable from the worker', async () => {
    const c = await start();
    c.en = false;
    await vi.advanceTimersByTimeAsync(5000);
    expect(terminated).toBe(1);
    expect(c.sink).toBeNull();
    const d = await start();
    workers.at(-1)!.onmessage!({ data: [1, 600] });
    expect(terminated).toBe(2);
    expect(d.sink).toBeNull();
  });
});
