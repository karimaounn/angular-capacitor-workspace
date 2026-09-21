import type { Policy } from './types';

/**
 * The dependency policy for generated workspaces.
 *
 * This is the file you patch. It holds data and no logic: adding a remedy for a
 * new advisory is an edit here plus a release, and nothing else in the package
 * changes. `doctor --fix` then carries the edit into workspaces that already
 * exist, which is the difference between patching future projects and patching
 * every project.
 *
 * Every entry below was verified against the live registry on `reviewed`, by
 * generating the affected matrix row, resolving a lockfile and running
 * `npm audit`. Entries carry the evidence rather than the anecdote, because an
 * unverified remedy is indistinguishable from a superstition six months later.
 */
export const POLICY: Policy = {
  reviewed: '2026-09-19',

  /**
   * Tier 1 — never installed.
   *
   * The strongest remedy is not installing the package. Each rule needs a
   * reason and a set of guards naming when the package is legitimate.
   */
  prune: [
    {
      packages: [
        '@angular-devkit/build-angular',
        '@angular-devkit/architect',
        '@angular-devkit/core',
      ],
      advisories: ['GHSA-w5hq-g745-h8pq'],
      reason:
        'Drags webpack-dev-server -> sockjs -> uuid@8, which npm reports as ' +
        'unfixable (fixAvailable: false at every node). Angular 22 does not ' +
        'install it: `ng new` plus `ng generate application` yields only ' +
        '@angular/build, and every builder emitted by this generator is an ' +
        '@angular/build:* builder. Verified 2026-09-19: a generated workspace ' +
        'without Storybook audits clean with these absent.',
      // Storybook 10.6 declares @angular-devkit/build-angular, /core and
      // /architect as REQUIRED peers (peerDependenciesMeta marks only zone.js,
      // @angular/cli and @angular/animations optional). npm reinstalls them as
      // peers no matter what we delete, so with Storybook on, pruning is not
      // available and the ladder escalates to the Tier 2 override below.
      unlessUsing: ['storybook', '@angular-devkit/build-angular:*'],
    },
    {
      packages: ['express', '@types/express'],
      reason:
        'Only a Node SSR server entry point uses these. The marketing app is ' +
        'generated with outputMode "static" and no server.ts, so there is ' +
        'nothing for a server to serve.',
      unlessUsing: ['ssr:server'],
    },
  ],

  /**
   * Tier 2 — a real dependency drags in a bad version; pin the transitive.
   *
   * Scoped, always. `{ sockjs: { uuid: ... } }` rewrites uuid only beneath
   * sockjs; a bare `{ uuid: ... }` would rewrite every uuid in the tree.
   */
  overrides: [
    {
      spec: { sockjs: { uuid: '^11.1.1' } },
      advisories: ['GHSA-w5hq-g745-h8pq'],
      reason:
        'Storybook -> @angular-devkit/build-angular -> @angular-devkit/build-webpack ' +
        '-> webpack-dev-server -> sockjs -> uuid@8.3.2. uuid has no patched 8.x, ' +
        'so npm reports the whole chain unfixable; sockjs only uses uuid for ' +
        'session ids, which is API-compatible across the major. Verified ' +
        '2026-09-19: this single override takes the Storybook row from 7 ' +
        'moderate advisories to 0.',
      onlyWhen: ['storybook'],
    },
    {
      spec: { xcode: { uuid: '^11.1.1' } },
      advisories: ['GHSA-w5hq-g745-h8pq'],
      reason:
        '@capacitor/cli -> xcode@3 -> uuid@7.0.3. xcode is a dependency of the ' +
        'CLI itself, not of @capacitor/ios, so the chain exists on any mobile ' +
        'target including android-only. npm offers only `audit fix --force`, ' +
        'which downgrades @capacitor/cli to 8.4.3 — a breaking change to fix a ' +
        'dev-time uuid call. xcode uses uuid to mint pbxproj object ids. ' +
        'Verified 2026-09-19: the override takes the mobile row from 3 ' +
        'moderate advisories to 0.',
      onlyWhen: ['mobile'],
    },
    {
      spec: { '@scalar/json-magic': { undici: '^7.29.0' } },
      advisories: [
        'GHSA-vmh5-mc38-953g',
        'GHSA-vxpw-j846-p89q',
        'GHSA-hm92-r4w5-c3mj',
        'GHSA-jr45-8vmc-qm54',
        'GHSA-v3r7-h72x-cjcm',
      ],
      reason:
        'orval -> @scalar/openapi-parser -> @scalar/json-magic -> undici@7.x, ' +
        'which carries five advisories including a TLS certificate validation ' +
        'bypass. Fixed across the set by 7.29.0; @scalar/json-magic has not ' +
        'moved its range. undici is only reached when generating a client from ' +
        'a remote spec, but the codegen step runs in CI on every build, so a ' +
        'certificate bypass there is not hypothetical. Verified 2026-09-19: ' +
        'takes the codegen row from 10 advisories to 0.',
      onlyWhen: ['codegen'],
    },
  ],

  /**
   * Tier 3 — the direct range permits a bad version; raise the minimum.
   *
   * A caret range is not a floor. npm resolves the highest version that
   * satisfies every constraint in the tree, and a peer elsewhere can drag a
   * caret range down onto a vulnerable release.
   */
  floors: [
    {
      package: 'vitest',
      min: '4.1.11',
      range: '^4.1.11',
      advisories: ['GHSA-82fw-gwwq-j7x9'],
      reason:
        'Path traversal / arbitrary file read via the @vitest/mocker redirect ' +
        'mock, affecting vitest <= 4.1.10. Angular 22 emits `vitest: ^4.0.8`, ' +
        'and @angular/build peers the 4.x line, so upgrading to 5.x is not ' +
        'available. Verified 2026-09-19: under Storybook, npm backtracks ' +
        '`^4.0.8` onto 4.1.10 (vulnerable) to satisfy the rest of the tree, so ' +
        'the caret alone does not hold. The floor does.',
    },
  ],

  /**
   * Tier 4 — knowingly shipped, with an expiry.
   *
   * `until` is enforced, not advisory: an expired entry fails generation and
   * fails `audit`. Empty is the correct state, and it should stay empty.
   */
  accepted: [],

  /**
   * The npm >= 11.6 lifecycle-script allowlist, emitted as `allowScripts`.
   *
   * An allowlist, not a denylist. The default posture for a generated project
   * is that a transitive dependency cannot run code at install time; the
   * entries below are the packages that genuinely need a native postinstall,
   * and a fifth requires a deliberate edit here.
   *
   * This is the one rung that is preventative rather than reactive — it bounds
   * the blast radius of an advisory that does not exist yet, which is the only
   * kind worth defending against in advance.
   *
   * Generated CI runs `npm ci --strict-allow-scripts`, which turns an
   * uncovered install script into a hard error rather than a warning.
   */
  allowScripts: {
    '@parcel/watcher': true,
    esbuild: true,
    lmdb: true,
    'msgpackr-extract': true,
  },
};
