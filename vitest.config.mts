import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.spec.ts'],
    // Schematic tests spin up an in-memory Tree per case; they are fast but not
    // parallel-safe across the shared @angular-devkit/schematics registry cache.
    pool: 'forks',
    testTimeout: 30_000,
  },
});
