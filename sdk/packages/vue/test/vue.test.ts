// T-40: @replayd/vue chains app.config.errorHandler and reports component + info.
import { describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, h, nextTick } from 'vue';

const cap = vi.fn();
const init = vi.fn();
vi.mock('@replayd/core', () => ({ captureException: (...a: unknown[]) => cap(...a), init: (...a: unknown[]) => init(...a) }));

describe('@replayd/vue', () => {
  it('reports errors with source vue, component name and lifecycle info, then calls the previous handler', async () => {
    const { ReplaydVue } = await import('../src/index');
    const Bad = defineComponent({ name: 'OrderPanel', setup() { throw new TypeError('boom'); }, render: () => h('div') });
    const app = createApp({ render: () => h(Bad) });
    const prev = vi.fn();
    app.config.errorHandler = prev;
    app.use(ReplaydVue, { dsn: 'https://pk@r.example/p' });
    expect(init).toHaveBeenCalledWith({ dsn: 'https://pk@r.example/p' });
    app.mount(document.createElement('div'));
    await nextTick();
    expect(cap).toHaveBeenCalledTimes(1);
    const [err, hint] = cap.mock.calls[0]!;
    expect((err as Error).message).toBe('boom');
    expect(hint).toEqual({ source: 'vue', ctx: { component: 'OrderPanel', info: 'setup function' } });
    expect(prev).toHaveBeenCalledTimes(1);
  });

  it('without options does not init, and logs like Vue when there is no previous handler', async () => {
    vi.resetModules();
    init.mockClear();
    const { ReplaydVue } = await import('../src/index');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = createApp({ render: () => h(defineComponent({ __name: 'Watchlist', setup() { throw new Error('x'); }, render: () => null })) });
    app.use(ReplaydVue);
    app.mount(document.createElement('div'));
    expect(init).not.toHaveBeenCalled();
    expect(cap.mock.calls.at(-1)![1].ctx.component).toBe('Watchlist');
    expect(log).toHaveBeenCalled();
  });
});
