// T-40: @replayd/nuxt client plugin — init from runtime config, release from app config, URL aliases, hooks.
import { describe, expect, it, vi } from 'vitest';
import { state } from './imports-stub';

const cap = vi.fn();
const init = vi.fn();
vi.mock('@replayd/core', () => ({ captureException: (...a: unknown[]) => cap(...a), init: (...a: unknown[]) => init(...a) }));

type Plugin = { setup(app: unknown): void };
const app = () => {
  const hooks: Record<string, (...a: unknown[]) => void> = {};
  const used: unknown[] = [];
  const vueApp = { config: { errorHandler: undefined as unknown }, use: (p: { install(a: unknown): void }) => (used.push(p), p.install(vueApp)) };
  return { hooks, used, vueApp, hook: (n: string, f: (...a: unknown[]) => void) => (hooks[n] = f) };
};

describe('@replayd/nuxt', () => {
  it('inits from runtimeConfig.public.replayd with the app_version release and mapped URLs', async () => {
    state.public = { apiHost: 'https://api.fxglory.test', replayd: { dsn: 'https://pk@r/p', tunnel: '/_rp', replay: { networkDetailAllowUrls: ['self', 'apiHost', 'https://x'] } } };
    state.app = { app_version: '1.42.0' };
    const p = (await import('../src/runtime/plugin.client')).default as unknown as Plugin;
    const a = app();
    p.setup(a);
    expect(init).toHaveBeenCalledWith({
      dsn: 'https://pk@r/p', tunnel: '/_rp', release: '1.42.0',
      replay: { networkDetailAllowUrls: [location.origin, 'https://api.fxglory.test', 'https://x'] },
    });
    const e = new Error('x');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    (a.vueApp.config.errorHandler as (e: unknown, vm: unknown, info: string) => void)(e, { $options: { __name: 'OrderPanel' } }, 'mounted hook');
    expect(cap).toHaveBeenCalledWith(e, { source: 'vue', ctx: { component: 'OrderPanel', info: 'mounted hook' } });
    a.hooks['app:error']!(e);
    expect(cap).toHaveBeenLastCalledWith(e, { source: 'vue', ctx: { info: 'app:error' } });
  });

  it('does nothing without a dsn', async () => {
    init.mockClear();
    state.public = {};
    const p = (await import('../src/runtime/plugin.client')).default as unknown as Plugin;
    const a = app();
    p.setup(a);
    expect(init).not.toHaveBeenCalled();
    expect(a.hooks).toEqual({});
    expect(a.used).toEqual([]);
  });
});
