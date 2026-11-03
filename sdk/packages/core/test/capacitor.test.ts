// T-26: Capacitor chunk — app/device info, lifecycle, error-event IndexedDB queue.
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Internal } from '../src/types';
import { clearDb } from './h';

type L = (e: unknown) => void;
function fakeCapacitor() {
  const ls: Record<string, L[]> = {};
  (window as unknown as { Capacitor: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App: {
        getInfo: () => Promise.resolve({ version: '1.42.0', build: '142' }),
        addListener: (ev: string, f: L) => ((ls[ev] ??= []).push(f), Promise.resolve({ remove() {} })),
      },
      Device: { getInfo: () => Promise.resolve({ model: 'SM-A525F', osVersion: '14', webViewVersion: '130.0' }) },
    },
  };
  return (ev: string, e?: unknown) => ls[ev]?.forEach((f) => f(e));
}
function internal() {
  const c = {
    tags: {} as Record<string, string>, ctx: {} as Record<string, unknown>,
    rec: [] as unknown[], crumbs: [] as unknown[], sent: [] as [string, Uint8Array][], hides: 0, sess: 0,
    lost: null as null | ((k: string, b: Uint8Array | ArrayBuffer) => void),
  };
  const I = {
    m: () => ({ tags: c.tags, ctx: c.ctx }),
    r: (type: string, data: unknown) => c.rec.push([type, data]),
    b: (cat: string, msg: string) => c.crumbs.push([cat, msg]),
    h: () => c.hides++,
    q: (f: typeof c.lost) => (c.lost = f),
    send: (k: string, b: Uint8Array) => c.sent.push([k, b]),
    sess: () => (c.sess++, { id: 's', seq: 0, st: 0, la: 0 }),
    en: () => true,
    platform: 'capacitor-android',
  } as unknown as Internal;
  return { I, c };
}
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 2));
};

describe('capacitor chunk', () => {
  beforeEach(async () => {
    vi.resetModules();
    await clearDb();
  });

  it('adds app/device info to the error context, tags and (via ctx) the replay init', async () => {
    fakeCapacitor();
    const { I, c } = internal();
    (await import('../src/capacitor/index')).startCapacitor(I);
    await settle();
    expect(c.ctx.app).toEqual({ version: '1.42.0 (142)', device: 'SM-A525F', os: '14', webview: '130.0' });
    expect(c.tags).toEqual({ app_version: '1.42.0 (142)', device: 'SM-A525F' });
  });

  it('works without App/Device plugins', async () => {
    (window as unknown as { Capacitor: unknown }).Capacitor = { isNativePlatform: () => true, Plugins: {} };
    const { I, c } = internal();
    (await import('../src/capacitor/index')).startCapacitor(I);
    await settle();
    expect(c.ctx.app).toEqual({});
  });

  it('pause flushes core + replay; resume checks the session and drains; app breadcrumbs', async () => {
    const fire = fakeCapacitor();
    const { I, c } = internal();
    const seen: string[] = [];
    for (const e of ['replayd:flush', 'replayd:resume']) window.addEventListener(e, () => seen.push(e));
    (await import('../src/capacitor/index')).startCapacitor(I);
    fire('pause');
    expect(c.hides).toBe(1);
    fire('resume');
    expect(c.sess).toBe(1);
    fire('appStateChange', { isActive: false });
    fire('backButton', { canGoBack: true });
    expect(seen).toEqual(['replayd:flush', 'replayd:resume']);
    expect(c.rec).toEqual([['app', { event: 'pause' }], ['app', { event: 'resume' }], ['app', { event: 'appStateChange', isActive: false }], ['app', { event: 'backButton', canGoBack: true }]]);
    expect(c.crumbs.map((x) => (x as string[])[1])).toEqual(['pause', 'resume', 'appStateChange', 'backButton']);
  });

  it('stores event bodies the transport gave up on and re-sends them oldest first on online', async () => {
    fakeCapacitor();
    const { I, c } = internal();
    (await import('../src/capacitor/index')).startCapacitor(I);
    await settle();
    c.lost!('events', new TextEncoder().encode('[1]'));
    c.lost!('events', new TextEncoder().encode('[2]'));
    await settle();
    expect(c.sent).toEqual([]);
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(c.sent.map(([k, b]) => [k, new TextDecoder().decode(b)])).toEqual([['events', '[1]'], ['events', '[2]']]);
    // drained = deleted
    c.sent = [];
    window.dispatchEvent(new Event('online'));
    await settle();
    expect(c.sent).toEqual([]);
  });

  it('a new start drains what a previous app run left behind', async () => {
    fakeCapacitor();
    const idb = await import('../src/idb');
    await idb.put('e', { t: Date.now(), k: 'events', b: new TextEncoder().encode('[old]') });
    await idb.put('e', { t: Date.now() - 25 * 3600e3, k: 'events', b: new TextEncoder().encode('[expired]') });
    const { I, c } = internal();
    (await import('../src/capacitor/index')).startCapacitor(I);
    await settle();
    expect(c.sent.map(([, b]) => new TextDecoder().decode(b))).toEqual(['[old]']);
  });
});
