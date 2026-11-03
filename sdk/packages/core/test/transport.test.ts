import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReplaydEvent } from '../src/types';
import { DSN, gunzip, res } from './h';

import type * as TM from '../src/transport';
import type * as UM from '../src/u';
type T = typeof TM;
type U = typeof UM;

async function setup(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  vi.resetModules();
  const c = await import('../src/config');
  const u: U = await import('../src/u');
  const t: T = await import('../src/transport');
  c.resolve({ dsn: DSN });
  c.dsn(DSN, undefined, false);
  const f = vi.fn(impl);
  t.setTf(f as unknown as typeof fetch);
  u.setOk(true);
  return { t, u, f };
}
const body = (n: number) => new Uint8Array(n).fill(1);
const flushMicro = () => vi.advanceTimersByTimeAsync(0);

describe('transport (retry, backoff, Retry-After, drop, disable)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers({ now: 1_730_620_000_000 });
  });
  afterEach(() => vi.useRealTimers());

  it('POSTs text/plain with no custom headers, credentials omitted, to the events URL', async () => {
    const { t, f } = await setup(() => Promise.resolve(res(202)));
    t.send('events', body(10));
    await flushMicro();
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://replay.example.com/ingest/fxglory-terminal/events?key=pk123');
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'text/plain' } });
    expect(Object.keys(init!.headers as object)).toEqual(['Content-Type']);
  });

  it('uses keepalive only below 60 KB', async () => {
    const { t, f } = await setup(() => Promise.resolve(res(202)));
    t.send('events', body(59_999));
    await flushMicro();
    t.send('events', body(60_000));
    await flushMicro();
    expect(f.mock.calls.map((c) => c[1]!.keepalive)).toEqual([true, false]);
  });

  it('retries network errors / 5xx with exponential backoff 1 s, 2 s, 4 s, 8 s and gives up after 5 attempts', async () => {
    let n = 0;
    const { t, f } = await setup(() => (n++ % 2 ? Promise.resolve(res(500)) : Promise.reject(new TypeError('net'))));
    t.send('events', body(5));
    await flushMicro();
    const at = [0];
    for (const d of [1000, 2000, 4000, 8000]) {
      await vi.advanceTimersByTimeAsync(d - 1);
      expect(f).toHaveBeenCalledTimes(at.length);
      await vi.advanceTimersByTimeAsync(1);
      at.push(d);
      expect(f).toHaveBeenCalledTimes(at.length);
    }
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(5);
    // queue is empty again: next body goes out immediately
    t.send('events', body(5));
    await flushMicro();
    expect(f).toHaveBeenCalledTimes(6);
  });

  it('honours Retry-After on 429 and 503', async () => {
    const seq = [res(429, { 'Retry-After': '7' }), res(503, { 'Retry-After': '3' }), res(202)];
    const { t, f } = await setup(() => Promise.resolve(seq.shift()!));
    t.send('events', body(5));
    await flushMicro();
    await vi.advanceTimersByTimeAsync(6_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('drops a batch on 403 / 413 without retry and continues with the next', async () => {
    const seq = [res(403), res(413), res(202)];
    const { t, f } = await setup(() => Promise.resolve(seq.shift()!));
    t.send('events', body(1));
    t.send('events', body(2));
    t.send('events', body(3));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(f.mock.calls.map((c) => (c[1]!.body as Uint8Array).length)).toEqual([1, 2, 3]);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('sends one request at a time, in order', async () => {
    const pending: ((r: Response) => void)[] = [];
    const { t, f } = await setup(() => new Promise<Response>((r) => pending.push(r)));
    t.send('events', body(1));
    t.send('events', body(2));
    await flushMicro();
    expect(f).toHaveBeenCalledTimes(1);
    pending[0]!(res(202));
    await flushMicro();
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('X-Replayd-Disable on any response stops capture and persists the until-timestamp', async () => {
    const { t, u, f } = await setup(() => Promise.resolve(res(202, { 'X-Replayd-Disable': '120' })));
    t.send('events', body(1));
    await flushMicro();
    expect(u.en).toBe(false);
    expect(+localStorage.getItem('rp_off')!).toBe(Date.now() + 120_000);
    t.send('events', body(1));
    await flushMicro();
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(u.en).toBe(true);
  });

  it('bounds the queue at 5 MB by dropping the oldest entries', async () => {
    const pending: ((r: Response) => void)[] = [];
    const { t, f } = await setup(() => new Promise<Response>((r) => pending.push(r)));
    for (let i = 0; i < 12; i++) t.send('events', body(1 << 20)); // 12 × 1 MB
    await flushMicro();
    for (let i = 0; i < 20; i++) {
      pending.shift()?.(res(202));
      await flushMicro();
    }
    // head was in flight; the queue never held more than 5 MB
    expect(f.mock.calls.length).toBeLessThanOrEqual(6);
    expect(f.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('on page hide sends everything not in flight with keepalive within a 60 KB budget', async () => {
    const pending: ((r: Response) => void)[] = [];
    const { t, f } = await setup(() => new Promise<Response>((r) => pending.push(r)));
    t.send('events', body(10)); // in flight
    t.send('events', body(30_000));
    t.send('events', body(25_000));
    t.send('events', body(10_000));
    await flushMicro();
    t.pump(true);
    expect(f.mock.calls.map((c) => [(c[1]!.body as Uint8Array).length, c[1]!.keepalive])).toEqual([
      [10, true],
      [30_000, true],
      [25_000, true],
      [10_000, false],
    ]);
  });

  it('batches events every 2 s or at 10 events as gzip JSON', async () => {
    const { t, f } = await setup(() => Promise.resolve(res(202)));
    const ev = (i: number) => ({ id: String(i), message: 'm' + i }) as unknown as ReplaydEvent;
    for (let i = 0; i < 3; i++) t.pushEv(ev(i));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(f).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    vi.useRealTimers();
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(1));
    const b = new Uint8Array(f.mock.calls[0]![1]!.body as ArrayBuffer);
    expect([b[0], b[1]]).toEqual([0x1f, 0x8b]);
    expect(JSON.parse(await gunzip(b)).map((e: ReplaydEvent) => e.id)).toEqual(['0', '1', '2']);
    for (let i = 0; i < 10; i++) t.pushEv(ev(i));
    await vi.waitFor(() => expect(f).toHaveBeenCalledTimes(2));
  });

  it('page-hide flush sends pending events synchronously as plain JSON', async () => {
    const { t, f } = await setup(() => Promise.resolve(res(202)));
    t.pushEv({ id: 'a' } as ReplaydEvent);
    t.flushEv(true);
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(new TextDecoder().decode(f.mock.calls[0]![1]!.body as Uint8Array))).toEqual([{ id: 'a' }]);
  });
});
