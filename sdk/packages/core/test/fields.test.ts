import { afterEach, beforeEach, expect, it } from 'vitest';
import { DSN, gunzip, load, mockFetch, res, type Core } from './h';
import type { ReplaydEvent } from '../src/types';
let core: Core;
let fetcher: ReturnType<typeof mockFetch>;
beforeEach(async () => {
  localStorage.clear(); sessionStorage.clear();
  fetcher = mockFetch(u => Promise.resolve(String(u).includes('/config') ? res(200, {}, '{}') : res(202)));
  core = await load();
  core.init({ dsn: DSN, appVersion: 'explicit-2' });
});
afterEach(async () => { await core.close(); });
async function event(): Promise<ReplaydEvent> {
  core.captureMessage('field test'); await core.flush();
  await new Promise(r => setTimeout(r, 20));
  const call = fetcher.mock.calls.find(([u]) => String(u).includes('/events'))!;
  return JSON.parse(await gunzip(call[1]!.body))[0];
}
it('merges/removes fields atomically, preserves JSON values and recursively redacts keys', async () => {
  const fields = { plan: 'pro', nested: { Password: 'secret', values: [true, 3, null] } };
  core.setCustomFields(fields);
  fields.nested.values[0] = false;
  core.setCustomFields({ plan: null, extra: 'ok' });
  core.setCustomFields({ huge: 'x'.repeat(16 * 1024) });
  core.setCustomFields({ huge: '💚'.repeat(5000) });
  const ev = await event();
  expect(ev.custom_fields).toEqual({ nested: { Password: '[Filtered]', values: [true, 3, null] }, extra: 'ok' });
  expect(JSON.stringify(ev)).not.toContain('secret');
});
it('accepts eight levels and rejects deeper, cyclic and non-JSON updates without changing state', async () => {
  let nested: unknown = 'leaf';
  for (let i = 0; i < 7; i++) nested = { child: nested };
  core.setCustomFields({ nested });
  core.setCustomFields({ tooDeep: { child: nested } });
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  core.setCustomFields({ cycle });
  core.setCustomFields({ invalid: undefined });
  core.setCustomFields({ invalid: NaN });
  expect((await event()).custom_fields).toEqual({ nested });
});
it('allows the full 16 KiB UTF-8 boundary and retains the previous value above it', async () => {
  const value = 'x'.repeat(16 * 1024 - JSON.stringify({ x: '' }).length);
  core.setCustomFields({ x: value });
  core.setCustomFields({ x: value + 'x' });
  expect((await event()).custom_fields).toEqual({ x: value });
});
it('captures identity history, device local time and the explicit app version', async () => {
  const start = Date.now();
  const user = { id: 'user-1', email: 'first@example.com', name: 'First' };
  core.setUser(user); user.name = 'mutated by caller';
  core.setCustomFields({ country: 'test' });
  core.setUser({ id: 'user-2', email: 'second@example.com', name: 'Second' });
  core.setContext('app', { version: 'native-1' });
  const ev = await event();
  expect(ev.user?.name).toBe('Second');
  expect(ev.app_version).toBe('explicit-2');
  expect(ev.timezone).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
  expect(ev.local_time).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d [+-]\d\d:\d\d$/);
  const changes = (await import('../src/ring')).drain().filter(e => e.type === 'fields');
  expect(changes.map(e => e.data.field)).toEqual(['user', 'custom_fields', 'user']);
  expect(changes[0]?.data.value).toEqual({ id: 'user-1', email: 'first@example.com', name: 'First' });
  expect(changes.every(e => e.ts >= start && e.ts <= Date.now())).toBe(true);
});
it('falls back to native app version and supports clearing user identity', async () => {
  (await import('../src/config')).resolve({ dsn: DSN });
  core.setContext('app', { version: 'native-1' });
  core.setUser({ name: 'Old' }); core.setUser(null);
  const ev = await event();
  expect(ev.user).toBeUndefined(); expect(ev.app_version).toBe('native-1');
});
it('preserves JSON prototype-named keys as data without changing object prototypes', async () => {
  core.setCustomFields(JSON.parse('{"__proto__":{"safe":"value"}}'));
  expect((await event()).custom_fields).toEqual(JSON.parse('{"__proto__":{"safe":"value"}}'));
  expect(({} as Record<string, unknown>).safe).toBeUndefined();
});
