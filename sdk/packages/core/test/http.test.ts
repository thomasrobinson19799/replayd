import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplaydEvent, ReplaydOptions, RingEvent } from '../src/types';
import { DSN, gunzip, load, mockFetch, res, type Core } from './h';

const G = globalThis as Record<string, unknown>;
let core: Core | undefined;
let f: ReturnType<typeof mockFetch>;
const origXHR = G.XMLHttpRequest;

const routes = (u: string): { status: number; headers: Record<string, string>; body: string } | 'net' => {
  const p = new URL(u, location.href).pathname;
  if (p.endsWith('/config')) return { status: 200, headers: {}, body: '{}' };
  if (p.includes('/ingest/') || p.startsWith('/_rp/')) return { status: 202, headers: {}, body: '' };
  if (p === '/api/ok') return { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 's=1', 'x-req': 'r1' }, body: '{"access_token":"t","v":1}' };
  if (p === '/api/fail') return { status: 500, headers: { 'content-type': 'application/json' }, body: '{"error":"margin"}' };
  if (p === '/api/missing') return { status: 404, headers: { 'content-type': 'text/plain' }, body: 'nope' };
  if (p === '/api/sse') return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: 'data: 1\n\n' };
  if (p === '/api/bin') return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: 'xx' };
  if (p === '/api/big') return { status: 200, headers: { 'content-type': 'application/json', 'content-length': '100000' }, body: '{}' };
  if (p === '/api/huge') return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'z'.repeat(80_000) };
  if (p === '/api/down') return 'net';
  return { status: 200, headers: { 'content-type': 'text/plain' }, body: 'ok' };
};

async function start(o: Partial<ReplaydOptions> = {}) {
  f = mockFetch((u) => {
    const r = routes(String(u));
    return r === 'net' ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve(res(r.status, r.headers, r.body));
  });
  core = await load();
  core.init({ dsn: DSN, replay: { networkDetailAllowUrls: ['self'] }, ...o });
  return core;
}
const drain = async () => (await import('../src/ring')).drain();
const nets = async (): Promise<RingEvent['data'][]> => (await drain()).filter((e) => e.type === 'network').map((e) => e.data);
async function events(): Promise<ReplaydEvent[]> {
  await core!.flush();
  await new Promise((r) => setTimeout(r, 30));
  const out: ReplaydEvent[] = [];
  for (const [u, i] of f.mock.calls) if (String(u).includes('/events')) out.push(...JSON.parse(await gunzip(i!.body)));
  return out;
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  G.XMLHttpRequest = origXHR;
  delete G.CapacitorWebXMLHttpRequest;
});

describe('fetch', () => {
  it('records method, redacted URL, status, timing, sizes; app still reads the body', async () => {
    await start({ replay: { networkDetailAllowUrls: [] } });
    const r = await fetch('https://api.example/api/ok?token=abc&s=1', { method: 'post', body: 'hello' });
    expect(await r.json()).toEqual({ access_token: 't', v: 1 });
    await vi.waitFor(async () => expect((await import('../src/ring')).crumbs.some((c) => c.cat === 'http')).toBe(true));
    const [n] = await nets();
    expect(n).toMatchObject({ method: 'POST', url: 'https://api.example/api/ok?token=[Filtered]&s=1', status: 200, reqSize: 5 });
    expect(typeof n!.start).toBe('number');
    expect(typeof n!.duration).toBe('number');
    expect(n).not.toHaveProperty('reqHeaders');
    expect(n).not.toHaveProperty('resBody');
  });

  it('captures headers (denylist stripped) and bodies (redacted) for allowlisted URLs only', async () => {
    await start();
    const r = await fetch('/api/ok', { method: 'POST', headers: { Authorization: 'Bearer x', 'Content-Type': 'application/json' }, body: '{"password":"p","q":1}' });
    const body = await r.text();
    expect(body).toBe('{"access_token":"t","v":1}');
    let n: RingEvent['data'] | undefined;
    await vi.waitFor(async () => {
      n = (await nets())[0];
      expect(n).toBeDefined();
    });
    expect(n!.reqHeaders).toEqual({ 'content-type': 'application/json' });
    expect(n!.resHeaders).toEqual({ 'content-type': 'application/json', 'x-req': 'r1' });
    expect(JSON.parse(n!.reqBody as string)).toEqual({ password: '[Filtered]', q: 1 });
    expect(JSON.parse(n!.resBody as string)).toEqual({ access_token: '[Filtered]', v: 1 });
  });

  it('accepts Request objects and RegExp allowlist entries', async () => {
    await start({ replay: { networkDetailAllowUrls: [/api\.example/] } });
    await (await fetch(new Request('https://api.example/api/ok', { method: 'PUT' }))).text();
    await vi.waitFor(async () => expect((await import('../src/ring')).crumbs.some((c) => c.cat === 'http')).toBe(true));
    const [n] = await nets();
    expect(n).toMatchObject({ method: 'PUT', status: 200 });
    expect(n!.resBody).toBeDefined();
  });

  it('skips bodies for event-stream, octet-stream, large known length; caps unknown length at 50 KB', async () => {
    await start();
    for (const p of ['/api/sse', '/api/bin', '/api/big', '/api/huge']) await (await fetch(p)).text();
    await vi.waitFor(async () => expect((await import('../src/ring')).crumbs.filter((c) => c.cat === 'http')).toHaveLength(4));
    const ns = await nets();
    const by = Object.fromEntries(ns.map((n) => [new URL(n.url as string).pathname, n]));
    expect(by['/api/sse']!.resBody).toBeUndefined();
    expect(by['/api/bin']!.resBody).toBeUndefined();
    expect(by['/api/big']!.resBody).toBeUndefined();
    expect(by['/api/big']!.resSize).toBe(100000);
    expect((by['/api/huge']!.resBody as string).length).toBe(50_000);
  });

  it('failed status → http error event with ctx.http; network errors → status 0, no event', async () => {
    await start();
    await (await fetch('/api/fail?key=k', { method: 'POST' })).text();
    await (await fetch('/api/missing')).text();
    await expect(fetch('/api/down')).rejects.toThrow('Failed to fetch');
    await vi.waitFor(async () => expect((await import('../src/ring')).crumbs.filter((c) => c.cat === 'http')).toHaveLength(3));
    const evs = await events();
    expect(evs.map((e) => [e.level, e.source, e.type, e.message])).toEqual([
      ['error', 'http', 'HTTPError', `POST ${location.origin}/api/fail 500`],
      ['error', 'http', 'HTTPError', `GET ${location.origin}/api/missing 404`],
    ]);
    expect(evs[0]!.ctx!.http).toMatchObject({ method: 'POST', url: `${location.origin}/api/fail?key=[Filtered]`, status: 500 });
    const down = (await nets()).find((n) => String(n.url).endsWith('/api/down'));
    expect(down?.status).toBe(0);
  });

  it('failedRequestStatusCodes is configurable (numbers and ranges)', async () => {
    await start({ errors: { failedRequestStatusCodes: [404, [502, 504]] } });
    await (await fetch('/api/fail')).text();
    await (await fetch('/api/missing')).text();
    await vi.waitFor(async () => expect((await import('../src/ring')).crumbs.filter((c) => c.cat === 'http')).toHaveLength(2));
    expect((await events()).map((e) => e.message)).toEqual([`GET ${location.origin}/api/missing 404`]);
  });

  it("never records the SDK's own ingest requests", async () => {
    await start({ tunnel: '/_rp' });
    core!.captureMessage('x');
    await core!.flush();
    await new Promise((r) => setTimeout(r, 30));
    expect(f.mock.calls.some(([u]) => String(u).startsWith('/_rp/fxglory-terminal/events'))).toBe(true);
    // the app can also hit the ingest URL itself — still not recorded
    await (await fetch('/_rp/fxglory-terminal/config?key=pk123')).text();
    await new Promise((r) => setTimeout(r, 10));
    expect(await nets()).toEqual([]);
    expect((await import('../src/ring')).crumbs.filter((c) => c.cat === 'http')).toEqual([]);
  });
});

/** minimal XHR fake: async loadend after send, routed like fetch */
class FakeXHR extends EventTarget {
  static readonly DONE = 4;
  status = 0;
  responseText = '';
  responseType: XMLHttpRequestResponseType = '';
  response: unknown = '';
  u = '';
  rh: Record<string, string> = {};
  open(_m: string, u: string) {
    this.u = u;
  }
  setRequestHeader(_k: string, _v: string) {}
  send(_b?: unknown) {
    setTimeout(() => {
      const r = routes(this.u);
      if (r !== 'net') {
        this.status = r.status;
        this.responseText = r.body;
        this.response = this.responseType === 'json' ? JSON.parse(r.body) : r.body;
        this.rh = r.headers;
      }
      this.dispatchEvent(new Event('loadend'));
    }, 1);
  }
  getAllResponseHeaders() {
    return Object.entries(this.rh).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  }
  getResponseHeader(n: string) {
    return this.rh[n.toLowerCase()] ?? null;
  }
}
const xhr = (X: unknown, m: string, u: string, body?: string, h?: [string, string]) =>
  new Promise<XMLHttpRequest>((ok) => {
    const x = new (X as typeof XMLHttpRequest)();
    x.open(m, u);
    if (h) x.setRequestHeader(h[0], h[1]);
    x.addEventListener('loadend', () => ok(x));
    x.send(body);
  });

describe('XHR (prototype patch, CapacitorHttp off / web)', () => {
  it('captures requests incl. allowlisted headers/bodies and failed status events', async () => {
    class X extends FakeXHR {}
    G.XMLHttpRequest = X;
    await start();
    const P = X.prototype as unknown as Record<string, unknown>;
    expect(P.open).not.toBe(FakeXHR.prototype.open);
    await xhr(X, 'post', '/api/ok', '{"otp":"1","a":2}', ['Authorization', 'Bearer z']);
    await xhr(X, 'GET', '/api/fail');
    await xhr(X, 'GET', 'https://other.example/x?signature=s');
    const ns = await nets();
    expect(ns.map((n) => [n.method, n.status])).toEqual([
      ['POST', 200],
      ['GET', 500],
      ['GET', 200],
    ]);
    expect(ns[0]).toMatchObject({ reqHeaders: {}, resHeaders: { 'content-type': 'application/json', 'x-req': 'r1' } });
    expect(JSON.parse(ns[0]!.reqBody as string)).toEqual({ otp: '[Filtered]', a: 2 });
    expect(JSON.parse(ns[0]!.resBody as string)).toEqual({ access_token: '[Filtered]', v: 1 });
    expect(ns[2]!.url).toBe('https://other.example/x?signature=[Filtered]');
    expect(ns[2]).not.toHaveProperty('resBody');
    expect((await events()).map((e) => e.message)).toEqual([`GET ${location.origin}/api/fail 500`]);
  });
});

describe('XHR under the CapacitorHttp bridge (constructor wrapper, D-07)', () => {
  it('keeps capturing although the bridge re-assigns prototype methods on every construction', async () => {
    class Native extends FakeXHR {}
    const proto = Native.prototype as unknown as Record<string, unknown>;
    const nat = { open: proto.open, send: proto.send, setRequestHeader: proto.setRequestHeader };
    const nb = () => G.CapacitorWebXMLHttpRequest as Record<string, (...a: unknown[]) => unknown>;
    G.CapacitorWebXMLHttpRequest = { fullObject: Native, prototype: proto, constructor: Native, ...nat };
    // like native-bridge.js: a plain function that re-assigns the shared prototype each time
    const Bridge = function () {
      const x = new Native();
      proto.open = function (this: unknown, ...a: unknown[]) {
        return nb().open!.apply(this, a);
      };
      proto.send = function (this: unknown, ...a: unknown[]) {
        return nb().send!.apply(this, a);
      };
      proto.setRequestHeader = function (this: unknown, ...a: unknown[]) {
        return nb().setRequestHeader!.apply(this, a);
      };
      Object.setPrototypeOf(x, proto);
      return x;
    } as unknown as typeof XMLHttpRequest;
    Object.defineProperty(Native, 'DONE', { value: 4, enumerable: true });
    Object.assign(Bridge, Native);
    G.XMLHttpRequest = Bridge;
    await start();
    expect(G.XMLHttpRequest).not.toBe(Bridge); // constructor wrapper installed
    const XW = G.XMLHttpRequest;
    expect((XW as { DONE?: number }).DONE).toBe(4); // statics preserved
    await xhr(XW, 'GET', '/api/ok');
    await xhr(XW, 'GET', '/api/missing');
    await xhr(XW, 'POST', '/api/fail', '{}');
    const ns = await nets();
    expect(ns.map((n) => [n.method, new URL(n.url as string).pathname, n.status])).toEqual([
      ['GET', '/api/ok', 200],
      ['GET', '/api/missing', 404],
      ['POST', '/api/fail', 500],
    ]);
    await core!.close();
    core = undefined;
    expect(G.XMLHttpRequest).toBe(Bridge);
  });
});
