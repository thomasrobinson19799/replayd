import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DSN, load, mockFetch, res, tick } from './h';

const cfgMod = async () => {
  vi.resetModules();
  return import('../src/config');
};

describe('DSN → ingest URLs (D-09)', () => {
  it('direct: <dsn origin>/ingest/<pid>/<kind>?key=', async () => {
    const c = await cfgMod();
    c.dsn(DSN, undefined, false);
    expect(c.iurl('events')).toBe('https://replay.example.com/ingest/fxglory-terminal/events?key=pk123');
    expect(c.iurl('config')).toBe('https://replay.example.com/ingest/fxglory-terminal/config?key=pk123');
  });

  it('tunnel on web: ${tunnel}/<pid>/<kind>?key=', async () => {
    const c = await cfgMod();
    c.dsn('https://pk123@replay.example.com/42', '/_rp/', false);
    expect(c.iurl('events')).toBe('/_rp/42/events?key=pk123');
    expect(c.own(`${location.origin}/_rp/42/replay?key=pk123`)).toBe(true);
    expect(c.own('/_rp/42/events?key=pk123')).toBe(true);
    expect(c.own('/api/orders')).toBe(false);
  });

  it('tunnel is ignored under Capacitor (direct ingest)', async () => {
    const c = await cfgMod();
    c.dsn(DSN, '/_rp', true);
    expect(c.iurl('replay')).toBe('https://replay.example.com/ingest/fxglory-terminal/replay?key=pk123');
    expect(c.own('https://replay.example.com/ingest/fxglory-terminal/events?key=pk123')).toBe(true);
    expect(c.own('https://replay.example.com/api/x')).toBe(false);
  });

  it('keeps a path prefix of the DSN host and rejects DSNs without key/pid', async () => {
    const c = await cfgMod();
    c.dsn('https://k@h.example/sub/7', undefined, false);
    expect(c.iurl('events')).toBe('https://h.example/sub/ingest/7/events?key=k');
    expect(() => c.dsn('https://h.example/7', undefined, false)).toThrow();
    expect(() => c.dsn('https://k@h.example/', undefined, false)).toThrow();
  });
});

describe('options + remote config merge (PRD §4.12)', () => {
  it('applies defaults incl. redaction lists', async () => {
    const c = await cfgMod();
    c.resolve({ dsn: DSN });
    expect(c.O.redact.headers).toEqual(['authorization', 'cookie', 'set-cookie', 'x-api-key']);
    expect(c.O.redact.bodyKeys).toContain('card_number');
    expect(c.O.redact.queryParams).toEqual(['token', 'key', 'signature']);
    expect(c.O.websocket.sample.maxFramesPerSec).toBe(20);
    expect(c.O.errors.console).toEqual(['error', 'warn']);
  });

  it('user redaction lists extend (never replace) the defaults', async () => {
    const c = await cfgMod();
    c.resolve({ dsn: DSN, redact: { headers: ['X-Session'], bodyKeys: [], queryParams: ['sid'] } });
    expect(c.O.redact.headers).toEqual(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-session']);
    expect(c.O.redact.bodyKeys).toContain('password');
    expect(c.O.redact.queryParams).toContain('sid');
  });

  it('remote wins for rates/toggles, only extends redaction', async () => {
    const c = await cfgMod();
    c.resolve({ dsn: DSN, replay: { sampleRate: 1 }, errors: { sampleRate: 1 } });
    c.applyRc({
      v: 3,
      replay: { sampleRate: 0.25 },
      ws: { enabled: false, perChannelPerSec: 2, maxFramesPerSec: 5 },
      errors: { sampleRate: 0.5 },
      redact: { bodyKeys: ['pan'], headers: [] },
      ttl: 600,
    });
    expect(c.O.replay.sampleRate).toBe(0.25);
    expect(c.O.websocket.enabled).toBe(false);
    expect(c.O.websocket.sample).toMatchObject({ perChannelPerSec: 2, maxFramesPerSec: 5 });
    expect(c.O.errors.sampleRate).toBe(0.5);
    expect(c.O.redact.bodyKeys).toContain('pan');
    expect(c.O.redact.bodyKeys).toContain('token');
    expect(c.O.redact.headers).toContain('authorization');
  });

  it('ignores ill-typed remote values', async () => {
    const c = await cfgMod();
    c.resolve({ dsn: DSN });
    c.applyRc({ replay: { sampleRate: '0' }, ws: { enabled: 'no' }, redact: { bodyKeys: 'x' } });
    c.applyRc(null);
    c.applyRc('x');
    expect(c.O.replay.sampleRate).toBe(1);
    expect(c.O.websocket.enabled).toBe(true);
  });
});

describe('remote config fetch + cache', () => {
  let core: Awaited<ReturnType<typeof load>>;
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });
  afterEach(async () => {
    await core?.close();
  });

  const remote = { v: 3, disabled: false, replay: { sampleRate: 0 }, ws: { maxFramesPerSec: 7 }, ttl: 600 };

  it('fetches after load+idle when no cache, caches it and applies it', async () => {
    const f = mockFetch(() => Promise.resolve(res(200, { 'content-type': 'application/json' }, JSON.stringify(remote))));
    core = await load();
    core.init({ dsn: DSN });
    expect(f).not.toHaveBeenCalled(); // nothing before idle
    await vi.waitFor(() => expect(f).toHaveBeenCalled());
    expect(f.mock.calls[0]![0]).toBe('https://replay.example.com/ingest/fxglory-terminal/config?key=pk123');
    await vi.waitFor(() => expect(localStorage.getItem('rp_cfg')).toContain('"maxFramesPerSec":7'));
    const { O } = await import('../src/config');
    expect(O.websocket.sample.maxFramesPerSec).toBe(7);
  });

  it('uses a fresh cache synchronously at init and does not refetch', async () => {
    localStorage.setItem('rp_cfg', JSON.stringify({ t: Date.now() - 60_000, c: remote }));
    const f = mockFetch();
    core = await load();
    core.init({ dsn: DSN });
    const { O } = await import('../src/config');
    expect(O.websocket.sample.maxFramesPerSec).toBe(7);
    await new Promise((r) => setTimeout(r, 20));
    expect(f.mock.calls.filter((c) => String(c[0]).includes('/config')).length).toBe(0);
  });

  it('uses a stale cache immediately and refreshes in the background', async () => {
    localStorage.setItem('rp_cfg', JSON.stringify({ t: Date.now() - 11 * 60_000, c: remote }));
    const f = mockFetch(() =>
      Promise.resolve(res(200, {}, JSON.stringify({ ...remote, ws: { maxFramesPerSec: 9 } }))),
    );
    core = await load();
    core.init({ dsn: DSN });
    const { O } = await import('../src/config');
    expect(O.websocket.sample.maxFramesPerSec).toBe(7);
    await vi.waitFor(() => expect(O.websocket.sample.maxFramesPerSec).toBe(9));
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('remote kill switch disables capture', async () => {
    localStorage.setItem('rp_cfg', JSON.stringify({ t: Date.now(), c: { disabled: true } }));
    mockFetch();
    core = await load();
    core.init({ dsn: DSN });
    const u = await import('../src/u');
    expect(u.en).toBe(false);
  });

  it('config fetch failure keeps local config and never throws', async () => {
    mockFetch(() => Promise.reject(new TypeError('offline')));
    core = await load();
    core.init({ dsn: DSN, replay: { sampleRate: 0 } });
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    const { O } = await import('../src/config');
    expect(O.replay.sampleRate).toBe(0);
  });
});
