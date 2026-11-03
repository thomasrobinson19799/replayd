import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ReplaydEvent, ReplaydOptions, RingEvent } from '../src/types';
import { DSN, gunzip, load, mockFetch, res, type Core } from './h';

const G = globalThis as Record<string, unknown>;
const origWS = G.WebSocket, origES = G.EventSource;

/** fake native WebSocket: records constructor args, listeners and sent data */
class FakeWS extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static last: FakeWS;
  args: unknown[];
  url: string;
  protocol = '';
  sent: unknown[] = [];
  listeners: string[] = [];
  constructor(...args: unknown[]) {
    super();
    this.args = args;
    this.url = new URL(String(args[0]), location.href).href.replace(/^http/, 'ws');
    FakeWS.last = this;
  }
  override addEventListener(t: string, l: EventListenerOrEventListenerObject | null, o?: AddEventListenerOptions | boolean) {
    this.listeners.push(t);
    super.addEventListener(t, l, o);
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  open() {
    this.dispatchEvent(new Event('open'));
  }
  msg(data: unknown, ts: number) {
    const e = new MessageEvent('message', { data });
    Object.defineProperty(e, 'timeStamp', { value: ts });
    this.dispatchEvent(e);
  }
  close(code: number, reason = '') {
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason, wasClean: code === 1000 }));
  }
}
class FakeES extends EventTarget {
  url: string;
  readyState = 0;
  constructor(u: string) {
    super();
    this.url = new URL(u, location.href).href;
  }
}

let core: Core | undefined;
let f: ReturnType<typeof mockFetch>;
async function start(o: Partial<ReplaydOptions> = {}) {
  f = mockFetch((u) => Promise.resolve(String(u).includes('/config') ? res(200, {}, '{}') : res(202)));
  core = await load();
  core.init({ dsn: DSN, ...o });
  return G.WebSocket as typeof FakeWS;
}
const drain = async () => (await import('../src/ring')).drain();
const wsEv = async (): Promise<RingEvent['data'][]> => (await drain()).filter((e) => e.type === 'ws').map((e) => e.data);
async function events(): Promise<ReplaydEvent[]> {
  await core!.flush();
  await new Promise((r) => setTimeout(r, 30));
  const out: ReplaydEvent[] = [];
  for (const [u, i] of f.mock.calls) if (String(u).includes('/events')) out.push(...JSON.parse(await gunzip(i!.body)));
  return out;
}
const CENT = 'wss://rt.example/connection/websocket?token=jwt.secret';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  G.WebSocket = FakeWS;
  G.EventSource = FakeES;
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  G.WebSocket = origWS;
  G.EventSource = origES;
});

describe('WebSocket constructor wrapper', () => {
  it('preserves instanceof, statics, constructor arguments and new-only semantics', async () => {
    const WS = await start();
    expect(WS).not.toBe(FakeWS);
    expect([WS.CONNECTING, WS.OPEN, WS.CLOSING, WS.CLOSED]).toEqual([0, 1, 2, 3]);
    const a = new WS(CENT);
    expect(a).toBeInstanceOf(WS);
    expect(a).toBeInstanceOf(FakeWS);
    expect(a.args).toEqual([CENT]); // no `undefined` protocols added
    const b = new WS(CENT, ['centrifuge-json']);
    expect(b.args).toEqual([CENT, ['centrifuge-json']]);
    expect(() => (WS as unknown as () => void)()).toThrow(TypeError);
    class Sub extends WS {
      hi() {
        return 'hi';
      }
    }
    const s = new Sub('wss://other.example/x');
    expect(s.hi()).toBe('hi');
    expect(s).toBeInstanceOf(WS);
    await core!.close();
    core = undefined;
    expect(G.WebSocket).toBe(FakeWS);
  });

  it('non-matching sockets get zero listeners and no own properties', async () => {
    const WS = await start();
    const s = new WS('wss://chat.example/socket');
    expect(s.listeners).toEqual([]);
    expect(Object.keys(s).sort()).toEqual(Object.keys(new FakeWS('wss://x')).sort());
    expect(Object.prototype.hasOwnProperty.call(s, 'send')).toBe(false);
    s.msg('x', 1000);
    expect(await wsEv()).toEqual([]);
  });

  it('matching sockets get exactly one message listener', async () => {
    const WS = await start();
    const s = new WS(CENT);
    expect(s.listeners.filter((t) => t === 'message')).toHaveLength(1);
    expect(s.listeners.sort()).toEqual(['close', 'error', 'message', 'open']);
  });
});

describe('incoming frame gate', () => {
  it('samples at most maxFramesPerSec per socket using the event timestamp', async () => {
    const WS = await start({ websocket: { sample: { maxFramesPerSec: 20 } } });
    const s = new WS(CENT), t = new WS('wss://rt.example/centrifugo/2');
    for (let i = 0; i < 100; i++) s.msg(`m${i}`, 1000 + i); // 100 frames over 100 ms
    t.msg('other socket', 1001);
    const fr = (await wsEv()).filter((e) => e.k === 'frame');
    expect(fr.map((e) => e.raw)).toEqual(['m0', 'm50', 'other socket']); // per-socket gates
    expect(fr[0]).toMatchObject({ dir: 'in', id: 1 });
  });

  it('slices strings to maxFrameBytes and records binary frames as {binary, size}', async () => {
    const WS = await start({ websocket: { sample: { maxFramesPerSec: 1000, maxFrameBytes: 16 } } });
    const s = new WS(CENT);
    s.msg('x'.repeat(5000), 1000);
    s.msg(new ArrayBuffer(10), 1010);
    s.msg(new Blob(['abc']), 1020);
    const fr = (await wsEv()).filter((e) => e.k === 'frame');
    expect(fr).toEqual([
      { k: 'frame', id: 1, dir: 'in', raw: 'x'.repeat(16) },
      { k: 'frame', id: 1, dir: 'in', binary: true, size: 10 },
      { k: 'frame', id: 1, dir: 'in', binary: true, size: 3 },
    ]);
  });

  it('remote config: maxFramesPerSec applies to live sockets; ws.enabled=false leaves new sockets untouched', async () => {
    const WS = await start();
    const s = new WS(CENT);
    const { applyRc } = await import('../src/config');
    applyRc({ ws: { maxFramesPerSec: 1 } });
    for (let i = 0; i < 10; i++) s.msg(`m${i}`, 1000 + i * 100);
    expect((await wsEv()).filter((e) => e.k === 'frame').map((e) => e.raw)).toEqual(['m0']);
    applyRc({ ws: { enabled: false } });
    s.msg('after disable', 5000);
    const n = new WS(CENT);
    expect(n.listeners).toEqual([]);
    expect((await wsEv()).filter((e) => e.k === 'frame')).toEqual([]);
  });

  it('kill switch closes the gate for existing sockets', async () => {
    const WS = await start();
    const s = new WS(CENT);
    const { off } = await import('../src/u');
    off(60);
    s.msg('dropped', 9000);
    expect(await wsEv()).toEqual([]);
  });
});

describe('outgoing frames', () => {
  it('captures all outgoing frames (app data untouched) and redacts the connect token when leaving the ring', async () => {
    const WS = await start({ websocket: { sample: { maxFramesPerSec: 1 } } });
    const s = new WS(CENT);
    const connect = '{"id":1,"connect":{"token":"eyJhbGciOiJIUzI1NiJ9.e30.sig","name":"js"}}';
    s.send(connect);
    s.send('{"id":2,"subscribe":{"channel":"quotes:EURUSD"}}');
    s.send(new Uint8Array(4));
    expect(s.sent[0]).toBe(connect); // the app's frame is sent unmodified
    const out = (await wsEv()).filter((e) => e.dir === 'out');
    expect(out).toHaveLength(3);
    expect(JSON.parse(out[0]!.raw as string)).toEqual({ id: 1, connect: { token: '[Filtered]', name: 'js' } });
    expect(out[1]!.raw).toBe('{"id":2,"subscribe":{"channel":"quotes:EURUSD"}}');
    expect(out[2]).toMatchObject({ binary: true, size: 4 });
  });

  it("outgoing: 'none' leaves send alone", async () => {
    const WS = await start({ websocket: { sample: { outgoing: 'none' } } });
    const s = new WS(CENT);
    expect(Object.prototype.hasOwnProperty.call(s, 'send')).toBe(false);
  });

  it('incoming frames are redacted too (lazily, on drain)', async () => {
    const WS = await start();
    const s = new WS(CENT);
    s.msg('{"id":1,"connect":{"client":"c1","token":"leak"}}', 5000);
    const [fr] = (await wsEv()).filter((e) => e.k === 'frame');
    expect(fr!.raw).not.toContain('leak');
  });
});

describe('lifecycle + abnormal close', () => {
  it('records open/error/close with redacted URL, protocols, duration; counts disconnects', async () => {
    const WS = await start();
    const s = new WS(CENT, 'centrifuge-json');
    s.open();
    s.dispatchEvent(new Event('error'));
    s.close(1006);
    const life = (await wsEv()).filter((e) => e.k !== 'frame');
    const url = 'wss://rt.example/connection/websocket?token=[Filtered]';
    expect(life.map((e) => e.k)).toEqual(['open', 'error', 'close']);
    expect(life[0]).toMatchObject({ id: 1, url, protocols: 'centrifuge-json' });
    expect(life[2]).toMatchObject({ code: 1006, wasClean: false, reconnects: 0 });
    expect(typeof life[2]!.duration).toBe('number');
    const { crumbs } = await import('../src/ring');
    expect(crumbs.filter((c) => c.cat === 'ws').map((c) => c.msg)).toEqual([`open ${url}`, `error ${url}`, `close ${url}`]);
    expect((await import('../src/ws')).wsc.ws_disc).toBe(1);
  });

  it('abnormal close → warning event, rate-limited 1/min per host+path+code; clean closes are fine', async () => {
    const WS = await start();
    new WS(CENT).close(1000);
    new WS(CENT).close(1001);
    new WS(CENT).close(1006);
    new WS(CENT).close(1006); // same host+path+code within 1 min → dropped
    new WS(CENT).close(4001);
    const evs = await events();
    expect(evs.map((e) => [e.level, e.source, e.message])).toEqual([
      ['warning', 'ws', 'WebSocket closed abnormally (code 1006)'],
      ['warning', 'ws', 'WebSocket closed abnormally (code 4001)'],
    ]);
    expect(evs[0]!.ctx!.ws).toEqual({ url: 'wss://rt.example/connection/websocket?token=[Filtered]', code: 1006, reconnects: 2 });
  });

  it('> 3 reconnects within 60 s → warning even with clean close codes', async () => {
    const WS = await start();
    for (let i = 0; i < 4; i++) new WS(CENT).close(1000);
    expect(await events()).toEqual([]);
    new WS(CENT).close(1000);
    const evs = await events();
    expect(evs.map((e) => e.message)).toEqual(['WebSocket closed abnormally (code 1000)']);
    expect(evs[0]!.ctx!.ws).toMatchObject({ reconnects: 4 });
  });
});

describe('EventSource', () => {
  it('records open/error lifecycle with redacted URL, keeps instanceof', async () => {
    await start();
    const ES = G.EventSource as typeof FakeES;
    expect(ES).not.toBe(FakeES);
    const e = new ES('/sse/quotes?token=abc');
    expect(e).toBeInstanceOf(ES);
    e.dispatchEvent(new Event('open'));
    e.dispatchEvent(new Event('error'));
    const life = await wsEv();
    expect(life.map((x) => [x.k, x.sse])).toEqual([
      ['open', true],
      ['error', true],
    ]);
    expect(life[0]!.url).toBe(`${location.origin}/sse/quotes?token=[Filtered]`);
  });
});
