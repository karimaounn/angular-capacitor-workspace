import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          // The e2e harness is plain .mjs and is not built, but the rule it
          // enforces is worth testing without waiting for a nightly full matrix
          // run.
          include: [
            'packages/cli/test/**/*.spec.ts',
            'packages/create/test/**/*.spec.ts',
            'e2e/test/**/*.spec.mjs',
          ],
          // Schematic tests spin up an in-memory Tree per case; they are fast
          // but not parallel-safe across the shared @angular-devkit/schematics
          // registry cache.
          pool: 'forks',
        },
      },
      {
        extends: true,
        test: {
          // The runtime packages a generated workspace installs: Angular code,
          // tested with TestBed in a DOM, compiled just in time.
          name: 'angular',
          include: ['packages/i18n/test/**/*.spec.ts', 'packages/theming/test/**/*.spec.ts'],
          environment: 'jsdom',
          // A document with an origin, which is what gives jsdom a
          // localStorage; an opaque one has none.
          environmentOptions: { jsdom: { url: 'http://localhost/' } },
          setupFiles: ['./vitest.angular-setup.ts'],
        },
      },
    ],
  },
});
