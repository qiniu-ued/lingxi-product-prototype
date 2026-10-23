import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts', 'apps/desktop/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/protocol/src/**', 'apps/server/src/**', 'apps/desktop/src/assets.ts'],
      // The compiled process entry point is exercised by scripts/smoke.mjs.
      exclude: ['**/*.test.ts', 'apps/server/src/index.ts'],
      reporter: ['text', 'html', 'json-summary', 'lcov'],
      thresholds: { statements: 85, branches: 75, functions: 85, lines: 85 },
    },
  },
});
