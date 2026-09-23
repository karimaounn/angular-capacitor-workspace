import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The e2e harness is plain .mjs and is not built, but the rule it enforces
    // is worth testing without waiting for a nightly full matrix run.
    include: ['packages/*/test/**/*.spec.ts', 'e2e/test/**/*.spec.mjs'],
    // Schematic tests spin up an in-memory Tree per case; they are fast but not
    // parallel-safe across the shared @angular-devkit/schematics registry cache.
    pool: 'forks',
    testTimeout: 30_000,
  },
});
