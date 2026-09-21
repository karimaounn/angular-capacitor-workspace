/**
 * Version pins for everything `ng new` does not choose for us.
 *
 * Angular's own packages are deliberately absent. `ng new` picks them, and
 * delegating that choice is the entire reason this generator overlays the
 * Angular schematics instead of freezing a template tree. Pinning
 * `@angular/core` here would reintroduce the drift we are avoiding.
 *
 * Regenerate with `npm run sync-versions`, which resolves the highest release
 * of each package compatible with `ANGULAR_LINE` and opens a PR.
 */

export interface VersionPin {
  /** The semver range written into the generated `package.json`. */
  range: string;
  /**
   * Why this range rather than `latest`. Present only where the answer is not
   * "latest at sync time" — an upper bound always needs a reason.
   */
  constraint?: string;
}

/**
 * The Angular major this release line generates for.
 *
 * The package's own major matches it, as does its `@angular/core` peer; see
 * test/release-line.spec.ts. Bumping this is cutting a new major.
 */
export const ANGULAR_LINE = '22';

/** Accepted `@angular/cli` range for the `ng new` bootstrap. */
export const ANGULAR_CLI_RANGE = `^${ANGULAR_LINE}`;

export const VERSIONS_SYNCED_AT = '2026-09-19';

export const VERSIONS = {
  // ── Unit testing ────────────────────────────────────────────────────────
  // Angular 22 emits `vitest: ^4.0.8` for a generated application. We raise it
  // to the Tier 3 floor; see policy/advisories.ts for GHSA-82fw-gwwq-j7x9.
  vitest: {
    range: '^4.1.11',
    constraint: '@angular/build:unit-test peers vitest ^4.0.8 — the 5.x line is not available.',
  },
  // Browser-mode testing. @angular/build's unit-test builder probes for
  // `@vitest/browser-<provider>` and silently falls back to jsdom when it finds
  // none — so this package being present is the difference between "component
  // tests run in a real engine" and "component tests claim to".
  '@vitest/browser-playwright': {
    range: '4.1.11',
    constraint: 'Peers `vitest: 4.1.11` exactly, not a range. Pinned, not caret.',
  },

  // ── End-to-end ──────────────────────────────────────────────────────────
  '@playwright/test': { range: '^1.63.0' },
  // Injected into each page by the marketing site's accessibility spec. Loaded
  // as a file rather than through a Playwright wrapper, which would add a
  // package that exists only to call `axe.run`.
  'axe-core': { range: '^4.13.0' },
  playwright: {
    range: '^1.63.0',
    constraint: 'Peer of @vitest/browser-playwright; supplies the engines for browser mode.',
  },

  // ── Styles ──────────────────────────────────────────────────────────────
  sass: {
    range: '^1.104.1',
    constraint:
      'Declared explicitly because check-contrast.mjs imports it directly. ' +
      '@angular/build depends on it too, but relying on a transitive for a ' +
      'first-party script is how a script breaks on an unrelated upgrade.',
  },

  // ── Storybook ───────────────────────────────────────────────────────────
  storybook: { range: '^10.6.0' },
  '@storybook/angular': {
    range: '^10.6.0',
    constraint: 'Must match the storybook core version exactly (peer: storybook ^10.6.0).',
  },
  '@storybook/addon-docs': {
    range: '^10.6.0',
    constraint: 'Must match the storybook core version. Supplies setCompodocJson and autodocs.',
  },
  '@compodoc/compodoc': { range: '^2.0.0' },

  // Storybook 10.6 declares these as REQUIRED peers with ranges as wide as
  // `>=18.0.0 < 23.0.0`. Left to itself npm satisfies them by backtracking —
  // observed resolving @angular-devkit/build-angular to 21.2.24 and
  // @angular/platform-browser-dynamic to 20.0.7 against an Angular 22
  // workspace, which then fails ERESOLVE on @angular/compiler-cli. Declaring
  // them explicitly at the Angular line is what makes the install deterministic.
  //
  // These are resolution pins, not advisory floors, which is why they live here
  // and not in POLICY.floors. The advisory they expose is handled at Tier 2.
  '@angular-devkit/build-angular': {
    range: `^${ANGULAR_LINE}.1.8`,
    constraint:
      'Required peer of @storybook/angular. Pinned to the Angular line to stop backtracking.',
  },
  '@angular-devkit/core': {
    range: `^${ANGULAR_LINE}.1.8`,
    constraint: 'Required peer of @storybook/angular.',
  },
  '@angular-devkit/architect': {
    range: '^0.2201.8',
    constraint:
      'Required peer of @storybook/angular. Angular ships architect on the 0.<major><minor> scheme.',
  },
  '@angular/platform-browser-dynamic': {
    range: `^${ANGULAR_LINE}.1.0`,
    constraint: 'Required peer of @storybook/angular.',
  },
  '@angular/animations': {
    range: `^${ANGULAR_LINE}.1.0`,
    constraint: 'Optional peer of @storybook/angular, but pinned so npm cannot backtrack it.',
  },

  // ── Capacitor ───────────────────────────────────────────────────────────
  '@capacitor/core': { range: '^8.5.2' },
  '@capacitor/cli': { range: '^8.5.2' },
  '@capacitor/android': { range: '^8.5.2' },
  '@capacitor/ios': { range: '^8.5.2' },

  // ── OpenAPI codegen ─────────────────────────────────────────────────────
  orval: { range: '^8.34.0' },

  // ── Design system ───────────────────────────────────────────────────────
  '@fontsource/inter': {
    range: '^5.3.0',
    constraint: 'Example font for the ui skeleton; swap freely.',
  },
} as const satisfies Record<string, VersionPin>;

export type PinnedPackage = keyof typeof VERSIONS;

/** The pinned range for `name`, or `undefined` when we delegate the choice. */
export function pinFor(name: string): string | undefined {
  return (VERSIONS as Record<string, VersionPin | undefined>)[name]?.range;
}

/** Builds a `{ name: range }` block for the given packages. */
export function pins(names: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const range = pinFor(name);
    if (!range) {
      throw new Error(
        `No version pin for "${name}". Add it to src/policy/versions.ts, or let ` +
          `the Angular schematic add it and do not request a pin here.`,
      );
    }
    out[name] = range;
  }
  return out;
}
