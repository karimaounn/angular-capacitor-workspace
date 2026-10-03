import type { Policy } from './types';
import { VERSIONS } from './versions';

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
  reviewed: '2026-10-03',

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
      reason:
        'Angular 22 does not install it: `ng new` plus `ng generate ' +
        'application` yields only @angular/build, and every builder emitted by ' +
        'this generator is an @angular/build:* builder. Verified 2026-09-19: a ' +
        'generated workspace without Storybook audits clean with these absent. ' +
        'This rule once also carried GHSA-w5hq-g745-h8pq, via ' +
        'webpack-dev-server -> sockjs -> uuid@8; devkit 22.2 moved to ' +
        'webpack-dev-server 6, which dropped sockjs, so that chain is gone and ' +
        'the advisory no longer reaches a generated workspace this way. The ' +
        'rule stands on the paragraph above, which was never about an advisory.',
      // Storybook 10.6 declares @angular-devkit/build-angular, /core and
      // /architect as REQUIRED peers (peerDependenciesMeta marks only zone.js,
      // @angular/cli and @angular/animations optional). npm reinstalls them as
      // peers no matter what we delete, so with Storybook on, pruning is not
      // available. That used to escalate to a Tier 2 override on sockjs; since
      // webpack-dev-server 6 dropped sockjs there is nothing left to escalate
      // to, and the devkit subtree is clean on its own.
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
    {
      packages: ['@angular/animations'],
      reason:
        'Angular 22 deprecates the package in favour of `animate.enter` and ' +
        '`animate.leave`, and nothing a generated workspace emits imports it. ' +
        'It was once declared as a Storybook peer pin alongside the devkit ' +
        'packages, but Storybook marks it OPTIONAL (as does ' +
        '@angular/platform-browser), so npm installed it only because we asked. ' +
        'Verified 2026-09-23: with the declaration gone the install still ' +
        'resolves with no ERESOLVE, `npm ls @angular/animations` is empty, and ' +
        'one deprecation warning disappears from every install.',
      // Not a security remedy — the ladder is the right shape for "a package we
      // should not be installing" whatever the reason, and this is the only rung
      // that reaches workspaces that already exist.
      //
      // The guard matters here in a way it does not for express: a workspace
      // that has been alive for a year may have grown a real `provideAnimations`
      // call, and `doctor --fix` must not delete the package out from under it.
      // The import is the independent witness, not the dependency entry.
      unlessUsing: ['animations'],
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
      spec: { '@storybook/builder-webpack5': { 'webpack-dev-middleware': '^7.4.6' } },
      advisories: ['GHSA-g84c-rxfj-3j2c'],
      reason:
        '@storybook/angular -> @storybook/builder-webpack5 -> ' +
        'webpack-dev-middleware@6. A publicPath that does not end in a slash ' +
        'lets a request walk out of the served root, so the dev server hands ' +
        'back arbitrary files to anyone who can reach it. The advisory covers ' +
        '<7.4.5 and 8.0.0-8.2.x, which leaves the entire 6.x line vulnerable ' +
        'with nothing to upgrade to: the fix only exists across a major. ' +
        'builder-webpack5 still declares `^6.1.2` as of Storybook 10.6.1 ' +
        '(latest), so there is no upstream release to wait for. 7.4.6 needs ' +
        'node >= 18.12 and a generated workspace already requires >= 24.8. ' +
        'Verified 2026-09-30: the override takes the `full` and `lib-only` ' +
        'rows from 1 high advisory to 0, with no ERESOLVE.',
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
      spec: { '@scalar/json-magic': { undici: '^7.29.1' } },
      advisories: [
        'GHSA-rfgv-xxqx-mfg5',
        'GHSA-w293-vg96-wgc3',
        'GHSA-3wwx-pv8p-q78v',
        'GHSA-pmjh-fq2x-6v4x',
        'GHSA-3xpg-4rpp-hhhm',
        'GHSA-2jfj-6hjv-fm6j',
        'GHSA-rx4f-c7p8-82vq',
      ],
      reason:
        'orval -> @scalar/openapi-parser -> @scalar/json-magic -> undici@7.x. ' +
        'undici is only reached when generating a client from a remote spec, ' +
        'but the codegen step runs in CI on every build, so a certificate ' +
        'bypass there is not hypothetical. The original five advisories this ' +
        'entry named were fixed by 7.29.0 and @scalar/json-magic has since ' +
        'pinned exactly that — but seven further advisories have landed against ' +
        'undici, two of them high (a TLS validation bypass via dropped ' +
        'BalancedPool connect options, and a WebSocket subprotocol DoS), all ' +
        'fixed in 7.29.1. So upstream now pins precisely the version that is ' +
        'vulnerable, and this override is what floats the tree past it. Pinned ' +
        '^7.29.1 rather than ^7.29.0: a caret is not a floor, and the older ' +
        'range still permitted the exact version upstream had settled on. ' +
        'Verified 2026-09-30: removing this entry reproduces all seven; with it ' +
        'the codegen row is clean.',
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
      package: '@types/node',
      min: '24.0.0',
      range: VERSIONS['@types/node'].range,
      reason:
        'Angular writes @types/node itself whenever a project has a server ' +
        "target — `^20.17.19` on the 22.1 line, its own tooling's floor — and it " +
        'does so after this overlay has run, so the pin in schematics/workspace ' +
        'is not the last word. A generated workspace declares `node >= 24.8.0`, ' +
        'so those are types for a Node it refuses to run, and vitest 5 peers ' +
        '`@types/node: ^22.0.0 || >=24.0.0`, which `^20` cannot satisfy: the ' +
        'install failed ERESOLVE and nothing was written. The policy runs after ' +
        'the whole overlay, which is what makes this the rung that holds — and ' +
        'the one that reaches workspaces already generated with `^20`.',
    },
    {
      package: 'vitest',
      min: '4.1.11',
      range: '^4.1.11',
      advisories: ['GHSA-82fw-gwwq-j7x9'],
      reason:
        'Path traversal / arbitrary file read via the @vitest/mocker redirect ' +
        'mock, affecting vitest <= 4.1.10. Verified 2026-09-19: under Storybook, ' +
        'npm backtracks the `^4.0.8` Angular used to emit onto 4.1.10 ' +
        '(vulnerable) to satisfy the rest of the tree, so the caret alone does ' +
        'not hold. The floor does. Generated workspaces now pin the 5.x line ' +
        '(see policy/versions.ts), which is unaffected and sits above this ' +
        'floor; the floor stays for workspaces still on 4.x.',
    },
  ],

  /**
   * Tier 4 — knowingly shipped, with an expiry.
   *
   * `until` is enforced, not advisory: an expired entry fails generation and
   * fails `audit`. Empty is the correct state, and it should stay empty.
   */
  accepted: [
    {
      id: 'GHSA-vfj7-8cjw-p6xm',
      packages: ['braces'],
      reason:
        '@angular-devkit/build-angular -> [webpack-dev-server ->] ' +
        'http-proxy-middleware -> micromatch -> braces. A deeply nested brace ' +
        'pattern overflows the stack in braces <= 3.0.3, and 3.0.3 is the latest ' +
        'release: there is no fixed version to pin, and no override reaches ' +
        'one — micromatch 4.0.8 (latest) needs braces ^3.0.3 and ' +
        'http-proxy-middleware 4.2.0 (latest) still uses micromatch. The chain ' +
        'exists only where Storybook forces the devkit peer (see the prune rule ' +
        'above), and it lives in the dev server proxy, which matches patterns ' +
        "from the developer's own proxy config, never from a request. Nothing " +
        'here reaches production output. Verified 2026-10-03: the `full`, ' +
        '`multi-app` and `lib-only` rows each report exactly this one advisory. ' +
        'Revisit when braces publishes a fix.',
      until: '2027-04-03',
      devOnly: true,
    },
  ],

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
