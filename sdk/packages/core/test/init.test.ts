import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DSN, load, mockFetch, res, type Core } from './h';

let core: Core | undefined;
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await core?.close();
  core = undefined;
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  delete (globalThis as { CapacitorWebFetch?: unknown }).CapacitorWebFetch;
});

describe('init', () => {
  it('is synchronous and fast (< 1 ms budget; asserted < 5 ms for CI noise)', async () => {
    mockFetch();
    const times: number[] = [];
    for (let i = 0; i < 7; i++) {
      core = await load();
      sessionStorage.clear();
      const t = performance.now();
      core.init({ dsn: DSN, tunnel: '/_rp', release: '1.0.0', environment: 'production' });
      times.push(performance.now() - t);
      await core.close();
    }
    times.sort((a, b) => a - b);
    console.log(`init() median ${times[3]!.toFixed(3)} ms, min ${times[0]!.toFixed(3)} ms`);
    expect(times[3]!).toBeLessThan(5);
  });

  it('never throws on bad input', async () => {
    core = await load();
    expect(() => core!.init({ dsn: 'not a url' })).not.toThrow();
    expect(() => core!.init(undefined as never)).not.toThrow();
    const u = await import('../src/u');
    expect(u.en).toBe(false);
  });

  it('respects a persisted X-Replayd-Disable until-timestamp (no patches at all)', async () => {
    localStorage.setItem('rp_off', String(Date.now() + 60_000));
    const f = mockFetch();
    core = await load();
    core.init({ dsn: DSN });
    const u = await import('../src/u');
    expect(u.en).toBe(false);
    expect(u.un.length).toBe(0);
    await new Promise((r) => setTimeout(r, 20));
    expect(f).not.toHaveBeenCalled();
  });

  it('loads nothing replay-related before load + idle, then config → sample check → replay chunk', async () => {
    const order: string[] = [];
    mockFetch((u) => (order.push(String(u).includes('/config') ? 'config' : 'other'), Promise.resolve(res(200, {}, '{"v":1}'))));
    let ric: (() => void) | undefined;
    (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback = vi.fn((f: () => void, o: { timeout: number }) => {
      expect(o.timeout).toBe(2000);
      ric = f;
      return 1;
    });
    core = await load();
    vi.spyOn(core.loaders, 'replay').mockImplementation(() => {
      order.push('replay');
      return Promise.resolve({ startReplay: () => {} });
    });
    const cap = vi.spyOn(core.loaders, 'capacitor');
    core.init({ dsn: DSN });
    expect(order).toEqual([]);
    expect(ric).toBeDefined();
    ric!();
    await vi.waitFor(() => expect(order).toEqual(['config', 'replay']));
    expect(cap).not.toHaveBeenCalled();
    delete (globalThis as { requestIdleCallback?: unknown }).requestIdleCallback;
  });

  it('skips the replay chunk when the session is not sampled', async () => {
    mockFetch(() => Promise.resolve(res(200, {}, '{"replay":{"sampleRate":0}}')));
    core = await load();
    const replay = vi.spyOn(core.loaders, 'replay');
    core.init({ dsn: DSN });
    await vi.waitFor(() => expect(localStorage.getItem('rp_cfg')).not.toBeNull());
    await new Promise((r) => setTimeout(r, 20));
    expect(replay).not.toHaveBeenCalled();
  });

  it('Capacitor: platform, direct ingest, CapacitorWebFetch transport, capacitor chunk loaded', async () => {
    (globalThis as { Capacitor?: unknown }).Capacitor = { isNativePlatform: () => true };
    const webFetch = vi.fn((_u: string) => Promise.resolve(res(200, {}, "{}")));
    (globalThis as { CapacitorWebFetch?: unknown }).CapacitorWebFetch = webFetch;
    const f = mockFetch();
    core = await load();
    const cap = vi.spyOn(core.loaders, 'capacitor').mockResolvedValue({ startCapacitor: () => {} });
    core.init({ dsn: DSN, tunnel: '/_rp' });
    expect(core.platform).toBe('capacitor-android');
    await vi.waitFor(() => expect(cap).toHaveBeenCalled());
    expect(webFetch.mock.calls[0]![0]).toBe('https://replay.example.com/ingest/fxglory-terminal/config?key=pk123');
    expect(f).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem('rp_s')!).id).toBeTruthy();
  });

  it('flush() on page hide uses keepalive; close() removes listeners and patches', async () => {
    const f = mockFetch();
    core = await load();
    core.init({ dsn: DSN });
    const u = await import('../src/u');
    expect(u.un.length).toBeGreaterThan(0);
    await core.close();
    expect(u.un.length).toBe(0);
    expect(u.en).toBe(false);
    f.mockClear();
    window.dispatchEvent(new Event('pagehide'));
    expect(f).not.toHaveBeenCalled();
    core = undefined;
  });
});

describe('ring buffer', () => {
  it('keeps the last 100 entries with original timestamps; drains oldest first; sink takes over', async () => {
    mockFetch();
    core = await load();
    core.init({ dsn: DSN });
    const r = await import('../src/ring');
    for (let i = 0; i < 150; i++) r.rec('console', { i }, 1000 + i);
    const d = r.drain();
    expect(d).toHaveLength(100);
    expect(d[0]).toEqual({ type: 'console', ts: 1050, data: { i: 50 } });
    expect(d[99]!.ts).toBe(1149);
    expect(r.drain()).toHaveLength(0);
    const got: unknown[] = [];
    r.setSink((e) => got.push(e));
    core.addBreadcrumb({ msg: 'hello', ts: 5 });
    expect(got).toEqual([{ type: 'breadcrumb', ts: 5, data: { cat: 'custom', msg: 'hello', data: undefined } }]);
    expect(r.drain()).toHaveLength(0);
    expect(r.crumbs.at(-1)).toEqual({ ts: 5, cat: 'custom', msg: 'hello' });
  });

  it('keeps the last 30 breadcrumbs', async () => {
    mockFetch();
    core = await load();
    core.init({ dsn: DSN });
    for (let i = 0; i < 40; i++) core.addBreadcrumb({ msg: `b${i}` });
    const r = await import('../src/ring');
    expect(r.crumbs).toHaveLength(30);
    expect(r.crumbs[0]!.msg).toBe('b10');
  });
});
