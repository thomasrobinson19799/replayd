import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const load = async () => {
  vi.resetModules();
  return import('../src/session');
};

describe('session manager (PRD §4.5)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    vi.useFakeTimers({ now: 1_730_620_000_000 });
  });
  afterEach(() => vi.useRealTimers());

  it('creates a session when storage is missing and persists it in sessionStorage', async () => {
    const s = await load();
    const onNew = vi.fn();
    const a = s.sInit(false, onNew);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(JSON.parse(sessionStorage.getItem('rp_s')!).id).toBe(a.id);
    expect(localStorage.getItem('rp_s')).toBeNull();
  });

  it('resumes the stored session across reloads', async () => {
    const a = (await load()).sInit(false, () => {});
    vi.advanceTimersByTime(60_000);
    const onNew = vi.fn();
    const b = (await load()).sInit(false, onNew);
    expect(b.id).toBe(a.id);
    expect(onNew).not.toHaveBeenCalled();
  });

  it('rolls over after > 15 min idle', async () => {
    const s = await load();
    const onNew = vi.fn();
    const a = s.sInit(false, onNew);
    vi.advanceTimersByTime(14 * 60_000);
    s.act();
    expect(s.sess().id).toBe(a.id);
    vi.advanceTimersByTime(15 * 60_000 + 1);
    s.act();
    expect(s.sess().id).not.toBe(a.id);
    expect(onNew).toHaveBeenCalledTimes(2);
  });

  it('rolls over after 60 min even when active', async () => {
    const s = await load();
    const a = s.sInit(false, () => {});
    for (let i = 0; i < 12; i++) {
      vi.advanceTimersByTime(5 * 60_000);
      s.act();
    }
    expect(s.sess().id).toBe(a.id);
    vi.advanceTimersByTime(60_001 - 0);
    s.act();
    expect(s.sess().id).not.toBe(a.id);
  });

  it('rolls over when the stored session is corrupt', async () => {
    sessionStorage.setItem('rp_s', '{"id":"x","st":"nope"}');
    const s = await load();
    expect(s.sInit(false, () => {}).id).not.toBe('x');
  });

  it('throttles activity writes to storage', async () => {
    const s = await load();
    s.sInit(false, () => {});
    const stored = () => JSON.parse(sessionStorage.getItem('rp_s')!).la;
    const la0 = stored();
    for (let i = 0; i < 100; i++) {
      vi.advanceTimersByTime(10);
      s.act();
    }
    expect(stored()).toBe(la0);
    expect(s.sess().la).toBe(Date.now());
    vi.advanceTimersByTime(5_001);
    s.act();
    expect(stored()).toBe(Date.now());
  });

  it('uses localStorage under Capacitor', async () => {
    const a = (await load()).sInit(true, () => {});
    expect(JSON.parse(localStorage.getItem('rp_s')!).id).toBe(a.id);
    expect(sessionStorage.getItem('rp_s')).toBeNull();
  });

  it('decides sampling once per session and stores it', async () => {
    const s = await load();
    s.sInit(false, () => {});
    const r = vi.spyOn(Math, 'random').mockReturnValue(0.7);
    expect(s.sampled(0.5)).toBe(false);
    r.mockReturnValue(0.1);
    expect(s.sampled(0.5)).toBe(false); // already decided
    const s2 = await load();
    s2.sInit(false, () => {});
    expect(s2.sampled(1)).toBe(false); // persisted across reloads
    vi.advanceTimersByTime(16 * 60_000);
    s2.act(); // new session → new decision
    expect(s2.sampled(0.5)).toBe(true);
  });

  it('hands out increasing segment seqs and persists them', async () => {
    const s = await load();
    s.sInit(false, () => {});
    expect([s.nextSeq(), s.nextSeq(), s.nextSeq()]).toEqual([0, 1, 2]);
    const s2 = await load();
    s2.sInit(false, () => {});
    expect(s2.nextSeq()).toBe(3);
  });

  it('survives blocked storage', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceeded');
    });
    const s = await load();
    expect(s.sInit(false, () => {}).id).toHaveLength(36);
    expect(() => s.act()).not.toThrow();
  });
});

describe('uuid7', () => {
  it('has v7 layout, embeds the timestamp and sorts by creation order', async () => {
    vi.resetModules();
    const { uuid7 } = await import('../src/u');
    const t = Date.now();
    const ids = Array.from({ length: 5000 }, () => uuid7());
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const ms = parseInt(ids[0]!.replace(/-/g, '').slice(0, 12), 16);
    expect(Math.abs(ms - t)).toBeLessThan(1000);
    expect([...ids].sort()).toEqual(ids); // monotonic within the page (per-ms counter)
    expect(new Set(ids).size).toBe(ids.length);
  });
});
