/**
 * @replayd/nuxt (PRD §4.1/§4.2): Nuxt 4 module. Adds a client-only plugin that calls `init()` from
 * `runtimeConfig.public.replayd` (so `NUXT_PUBLIC_REPLAYD_DSN` etc. work), takes the release from
 * `useAppConfig().app_version`, maps `networkDetailAllowUrls: ['self', 'apiHost']`, and reports Vue errors
 * (chained `vueApp.config.errorHandler` + `app:error`) with the component name. Under Capacitor core switches to direct ingest by itself.
 *
 *   export default defineNuxtConfig({ modules: ['@replayd/nuxt'],
 *     runtimeConfig: { public: { replayd: { dsn: '…', tunnel: '/_rp' } } } })
 */
import { addPlugin, createResolver, defineNuxtModule } from '@nuxt/kit';
import type { NuxtModule } from '@nuxt/schema';
import type { ReplaydOptions } from '@replayd/core';

export type ModuleOptions = Partial<ReplaydOptions>;

const module: NuxtModule<ModuleOptions> = defineNuxtModule<ModuleOptions>({
  meta: { name: '@replayd/nuxt', configKey: 'replayd' },
  defaults: {},
  setup(opts, nuxt) {
    const { resolve } = createResolver(import.meta.url);
    const pub = nuxt.options.runtimeConfig.public as Record<string, unknown>;
    // module options are defaults; runtimeConfig.public.replayd (and its env overrides) win
    pub.replayd = { ...opts, ...(pub.replayd as object | undefined) };
    addPlugin({ src: resolve('./runtime/plugin.client'), mode: 'client' });
  },
});
export default module;
