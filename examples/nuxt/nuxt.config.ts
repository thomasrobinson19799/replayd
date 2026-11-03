// PRD §4.2 usage; the DSN comes from NUXT_PUBLIC_REPLAYD_DSN at generate time here (SPA).
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: false,
  telemetry: false,
  devtools: { enabled: false },
  modules: ['@replayd/nuxt'],
  runtimeConfig: {
    public: {
      apiHost: 'https://api.example.test',
      replayd: { dsn: '', tunnel: '', environment: 'example', replay: { networkDetailAllowUrls: ['self', 'apiHost'] } },
    },
  },
  sourcemap: { client: 'hidden' },
})
