import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: { __RP_VERSION__: JSON.stringify('0.0.0-test') },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'packages/*/test/**/*.test.tsx'],
    environment: 'happy-dom',
    restoreMocks: true,
  },
});
