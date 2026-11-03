/** @replayd/nuxt client plugin (≤ 1 KB): init from runtime config + Vue error handler + app:error. */
import { defineNuxtPlugin, useAppConfig, useRuntimeConfig } from '#imports';
import { captureException, init, type ReplaydOptions } from '@replayd/core';
import { ReplaydVue } from '@replayd/vue';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type A = any;
export default defineNuxtPlugin({
  name: 'replayd',
  enforce: 'pre',
  setup(nuxtApp: A) {
    const pub = useRuntimeConfig().public as A, c = { ...pub.replayd } as ReplaydOptions & { release?: string };
    if (!c.dsn) return;
    const ac = useAppConfig() as A;
    c.release ??= ac.app_version ?? ac.version;
    const urls = c.replay?.networkDetailAllowUrls;
    if (urls) c.replay = { ...c.replay, networkDetailAllowUrls: urls.map((u: unknown) => (u == 'self' ? location.origin : u == 'apiHost' ? pub.apiHost : u)).filter(Boolean) };
    init(c);
    // chain Nuxt's own vueApp errorHandler: capture synchronously, before Nuxt logs it (its vue:error hook
    // runs async, after the console.error — that order would report the error twice)
    nuxtApp.vueApp.use(ReplaydVue);
    nuxtApp.hook('app:error', (err: unknown) => captureException(err, { source: 'vue', ctx: { info: 'app:error' } }));
  },
});
