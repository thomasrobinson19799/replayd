import tailwindcss from '@tailwindcss/vite'

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2026-11-01',
  ssr: false,
  telemetry: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt', '@nuxt/eslint'],
  css: ['~/assets/css/main.css'],
  app: {
    head: {
      title: 'replayd',
      htmlAttrs: { lang: 'en' },
    },
  },
  runtimeConfig: {
    public: {
      apiBase: '/api',
    },
  },
  typescript: {
    strict: true,
    typeCheck: false,
  },
  vite: {
    plugins: [tailwindcss()],
  },
  // `make dev`: the dashboard dev server proxies the API to the local replayd
  nitro: {
    devProxy: {
      '/api': { target: process.env.REPLAYD_API_URL ?? 'http://127.0.0.1:8080/api', changeOrigin: true },
    },
  },
})
