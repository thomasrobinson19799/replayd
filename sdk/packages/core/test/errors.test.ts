import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplaydEvent, ReplaydOptions } from '../src/types';
import { DSN, gunzip, load, mockFetch, res, type Core } from './h';

let core: Core | undefined;
let f: ReturnType<typeof mockFetch>;

async function start(o: Partial<ReplaydOptions> = {}) {
  f = mockFetch((u) => Promise.resolve(String(u).includes('/config') ? res(200, {}, '{}') : res(202)));
  core = await load();
  core.init({ dsn: DSN, release: '1.42.0', environment: 'production', ...o });
  return core;
}
/** flushes and returns all events uploaded so far */
async function events(): Promise<ReplaydEvent[]> {
  await core!.flush();
  await new Promise((r) => setTimeout(r, 30)); // batches flushed at 10 events gzip asynchronously
  const out: ReplaydEvent[] = [];
  for (const [u, i] of f.mock.calls) if (String(u).includes('/events')) out.push(...JSON.parse(await gunzip(i!.body)));
  return out;
}
const ring = async () => (await import('../src/ring')).drain();

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(async () => {
  await core?.close();
  core = undefined;
});

const fireError = (e: Error) => window.dispatchEvent(new ErrorEvent('error', { error: e, message: e.message }));

describe('window error / unhandledrejection', () => {
  it('captures uncaught errors with the §4.11 schema', async () => {
    await start();
    core!.setUser({ id: '10023451' });
    core!.setTags({ brand: 'fxglory' });
    core!.setContext('order', { id: 7 });
    core!.addBreadcrumb({ msg: 'before', cat: 'custom' });
    const e = new TypeError('x is undefined');
    fireError(e);
    const [ev] = await events();
    expect(ev).toMatchObject({
      level: 'error',
      source: 'onerror',
      type: 'TypeError',
      message: 'x is undefined',
      stack: e.stack,
      release: '1.42.0',
      env: 'production',
      platform: 'web',
      user: { id: '10023451' },
      tags: { brand: 'fxglory' },
      ctx: { order: { id: 7 } },
      count: 1,
    });
    expect(ev!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(ev!.sid).toBe(JSON.parse(sessionStorage.getItem('rp_s')!).id);
    expect(ev!.url).toBe(location.href);
    expect(ev!.breadcrumbs.at(-1)).toMatchObject({ cat: 'custom', msg: 'before' });
  });

  it('ignores resource load errors (non-bubbling error events on elements)', async () => {
    await start();
    const img = document.createElement('img');
    document.body.appendChild(img);
    img.dispatchEvent(new Event('error'));
    expect(await events()).toEqual([]);
    img.remove();
  });

  it('captures error events without an Error object (e.g. cross-origin) with a synthetic frame', async () => {
    await start();
    window.dispatchEvent(new ErrorEvent('error', { message: 'Uncaught boom', filename: 'https://a.example/app.js', lineno: 3, colno: 9 }));
    const [ev] = await events();
    expect(ev).toMatchObject({ type: 'Error', message: 'Uncaught boom', stack: '    at https://a.example/app.js:3:9' });
  });

  it('captures unhandled rejections (Error and non-Error reasons)', async () => {
    await start();
    const r1 = Object.assign(new Event('unhandledrejection'), { reason: new RangeError('bad') });
    const r2 = Object.assign(new Event('unhandledrejection'), { reason: { code: 42 } });
    window.dispatchEvent(r1);
    window.dispatchEvent(r2);
    const evs = await events();
    expect(evs.map((e) => [e.source, e.type, e.message])).toEqual([
      ['unhandledrejection', 'RangeError', 'bad'],
      ['unhandledrejection', 'UnhandledRejection', '{code:42}'],
    ]);
  });

  it('mirrors errors into the ring buffer and calls the force-flush hook', async () => {
    await start();
    const { setOnErr } = await import('../src/errors');
    const hook = vi.fn();
    setOnErr(hook);
    fireError(new Error('mirrored'));
    expect(hook).toHaveBeenCalledTimes(1);
    expect((await ring()).find((e) => e.type === 'error')?.data).toMatchObject({ level: 'error', source: 'onerror', message: 'mirrored' });
  });

  it('captureException / captureMessage', async () => {
    await start();
    core!.captureException(new Error('manual'), { source: 'vue', ctx: { component: 'OrderPanel', info: 'mounted hook' } });
    core!.captureException('a string');
    core!.captureMessage('heads up', 'warning');
    const evs = await events();
    expect(evs.map((e) => [e.level, e.source, e.type, e.message])).toEqual([
      ['error', 'vue', 'Error', 'manual'],
      ['error', 'manual', 'Error', 'a string'],
      ['warning', 'manual', 'Message', 'heads up'],
    ]);
    expect(evs[0]!.ctx).toMatchObject({ component: 'OrderPanel', info: 'mounted hook' });
  });
});

describe('filters, sampling, beforeSend', () => {
  it('errors.sampleRate 0 drops everything', async () => {
    await start({ errors: { sampleRate: 0 } });
    fireError(new Error('a'));
    expect(await events()).toEqual([]);
  });

  it('ignoreErrors (substring / RegExp) and denyUrls (top frame URL)', async () => {
    await start({ errors: { ignoreErrors: ['Script error.', /ResizeObserver loop/], denyUrls: [/extensions\//, /^chrome:\/\//] } });
    window.dispatchEvent(new ErrorEvent('error', { message: 'Script error.' }));
    fireError(new Error('ResizeObserver loop limit exceeded'));
    const ext = new Error('from extension');
    ext.stack = 'Error: from extension\n    at x (chrome-extension://abc/extensions/content.js:1:2)\n    at https://a.example/app.js:1:1';
    fireError(ext);
    const ch = new Error('chrome');
    ch.stack = 'Error: chrome\n    at chrome://settings/x.js:3:4';
    fireError(ch);
    const ff = new Error('firefox frames');
    ff.stack = 'fn@https://a.example/app.js:10:5\n';
    fireError(ff);
    expect((await events()).map((e) => e.message)).toEqual(['firefox frames']);
  });

  it('beforeSend can modify or drop; a throwing beforeSend drops and is counted', async () => {
    let mode = 'modify';
    await start({
      beforeSend: (e) => {
        if (mode === 'drop') return null;
        if (mode === 'throw') throw new Error('oops');
        return { ...e, tags: { touched: '1' } };
      },
    });
    const u = await import('../src/u');
    fireError(new Error('one'));
    mode = 'drop';
    fireError(new Error('two'));
    mode = 'throw';
    const ie = u.ie;
    fireError(new Error('three'));
    expect(u.ie).toBe(ie + 1);
    const evs = await events();
    expect(evs.map((e) => [e.message, e.tags])).toEqual([['one', { touched: '1' }]]);
  });
});

describe('flood control', () => {
  afterEach(() => vi.useRealTimers());

  it('same signature: first sent, then ≤ 1 per 10 s carrying the suppressed count', async () => {
    await start();
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    const e = new Error('same');
    for (let i = 0; i < 5; i++) fireError(e);
    vi.setSystemTime(Date.now() + 10_001);
    fireError(e);
    fireError(e);
    const evs = await events();
    expect(evs.map((x) => x.count)).toEqual([1, 5]);
  });

  it('different stacks are different signatures', async () => {
    await start();
    const a = new Error('m'), b = new Error('m');
    a.stack = 'Error: m\n    at a (https://x/a.js:1:1)';
    b.stack = 'Error: m\n    at b (https://x/b.js:1:1)';
    fireError(a);
    fireError(b);
    expect(await events()).toHaveLength(2);
  });

  it('caps at 20 / minute and 100 / session', async () => {
    await start();
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    for (let i = 0; i < 30; i++) fireError(new Error(`e${i}`));
    expect(await events()).toHaveLength(20);
    for (let m = 0; m < 6; m++) {
      vi.setSystemTime(Date.now() + 60_001);
      core!.addBreadcrumb({ msg: 'keepalive' });
      (await import('../src/session')).act();
      for (let i = 0; i < 30; i++) fireError(new Error(`m${m}-${i}`));
    }
    expect(await events()).toHaveLength(100);
  });
});

describe('console', () => {
  it('calls the original first, records all levels, errors/warnings per errors.console', async () => {
    const calls: string[] = [];
    const orig = { error: console.error, warn: console.warn, log: console.log, info: console.info, debug: console.debug };
    console.error = () => calls.push('orig-error');
    console.warn = () => calls.push('orig-warn');
    console.log = () => calls.push('orig-log');
    try {
      await start();
      const { setOnErr } = await import('../src/errors');
      setOnErr(() => calls.push('captured'));
      console.error('failed to place order', { id: 7 });
      console.warn('slow');
      console.log('just info');
      expect(calls).toEqual(['orig-error', 'captured', 'orig-warn', 'captured', 'orig-log']);
      const evs = await events();
      expect(evs.map((e) => [e.level, e.source, e.type, e.message])).toEqual([
        ['error', 'console', 'console.error', 'failed to place order {id:7}'],
        ['warning', 'console', 'console.warn', 'slow'],
      ]);
      const r = (await ring()).filter((e) => e.type === 'console');
      expect(r.map((e) => e.data.level)).toEqual(['error', 'warn', 'log']);
      expect(r[0]!.data.args).toEqual(['failed to place order', '{id:7}']);
    } finally {
      Object.assign(console, orig);
    }
  });

  it('uses the Error argument for type + stack; only the configured levels become events', async () => {
    const orig = { error: console.error, info: console.info, warn: console.warn };
    console.error = () => {};
    console.info = () => {};
    console.warn = () => {};
    try {
      await start({ errors: { console: ['error', 'info'] } });
      const e = new SyntaxError('bad json');
      console.error('parse failed:', e);
      console.info('info event');
      console.warn('not an event');
      const evs = await events();
      expect(evs.map((x) => [x.level, x.type, x.stack === e.stack])).toEqual([
        ['error', 'SyntaxError', true],
        ['warning', 'console.info', false],
      ]);
    } finally {
      Object.assign(console, orig);
    }
  });

  it('does not patch console.time/timeEnd and restores on close', async () => {
    const t = console.time, te = console.timeEnd, err = console.error;
    await start();
    expect(console.time).toBe(t);
    expect(console.timeEnd).toBe(te);
    expect(console.error).not.toBe(err);
    await core!.close();
    core = undefined;
    expect(console.error).toBe(err);
  });

  it('safe stringify: circular, depth 3, 1 KB per arg, max 5 args, never throws', async () => {
    const { ser } = await import('../src/errors');
    const o: Record<string, unknown> = { a: 1 };
    o.self = o;
    expect(ser(o)).toBe('{a:1,self:[Circular]}');
    expect(ser({ l1: { l2: { l3: { l4: 1 } } } })).toBe('{l1:{l2:{l3:[Object]}}}');
    expect(ser('x'.repeat(5000))).toHaveLength(1024);
    expect(ser({ big: 'y'.repeat(5000) }).length).toBeLessThanOrEqual(1024);
    expect(ser([1, 'a', null, undefined, () => 1])).toBe('[1,"a",null,undefined,[Function]]');
    const evil = { get boom() { throw new Error('getter'); } };
    expect(ser(evil)).toBe('{boom:?}');
    expect(ser(document.createElement('div'))).toBe('div');
    const orig = console.log;
    console.log = () => {};
    try {
      await start();
      console.log(1, 2, 3, 4, 5, 6, 7);
      const r = (await ring()).find((e) => e.type === 'console');
      expect(r!.data.args).toEqual(['1', '2', '3', '4', '5']);
    } finally {
      console.log = orig;
    }
  });
});

describe('history + clicks', () => {
  it('records navigations (redacted) and click descriptors', async () => {
    await start();
    history.pushState({}, '', '/trade?symbol=EURUSD&token=secret');
    history.replaceState({}, '', '/trade?symbol=XAUUSD');
    const b = document.createElement('button');
    b.id = 'buy';
    b.className = 'btn primary';
    b.innerHTML = '<span>Buy 1.00 lot</span>';
    document.body.appendChild(b);
    (b.firstChild as HTMLElement).click();
    const { crumbs } = await import('../src/ring');
    expect(crumbs.filter((c) => c.cat === 'nav').map((c) => c.msg)).toEqual([
      `${location.origin}/trade?symbol=EURUSD&token=[Filtered]`,
      `${location.origin}/trade?symbol=XAUUSD`,
    ]);
    expect(crumbs.find((c) => c.cat === 'click')?.msg).toBe('button#buy.btn.primary');
    const navs = (await ring()).filter((e) => e.type === 'nav');
    expect(navs).toHaveLength(2);
    expect(navs[1]!.data.to).toBe(`${location.origin}/trade?symbol=XAUUSD`);
    b.remove();
    history.replaceState({}, '', '/');
  });
});
