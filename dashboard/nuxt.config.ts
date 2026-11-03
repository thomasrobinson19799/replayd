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
})
