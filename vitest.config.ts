import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/*.test.ts', 'apps/server/**/*.test.ts'],
    coverage: { provider: 'v8', include: ['packages/protocol/src/**', 'apps/server/src/**'] },
  },
});
