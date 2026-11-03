import { defineConfig } from 'vitest/config';

import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '#imports': fileURLToPath(new URL('./packages/nuxt/test/imports-stub.ts', import.meta.url)) } },
  define: { __RP_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    environment: 'happy-dom',
    restoreMocks: true,
  },
});
