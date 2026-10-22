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
  reviewed: '2026-10-22',

  /**
   * Tier 1 — never installed.
   *
   * The strongest remedy is not installing the package. Each rule needs a
   * reason and a set of guards naming when the package is legitimate.
   */
  prune: [
    {
      packages: ['@angular-devkit/build-angular'],
      reason:
        'Angular 22 does not install it: `ng new` plus `ng generate ' +
        'application` yields only @angular/build, and every builder emitted by ' +
        'this generator is an @angular/build:* builder — Storybook included, ' +
        'since the design system moved to @storybook/angular-vite. It is ' +
        "Angular's deprecated webpack toolchain, and the root of the braces " +
        'chain accepted below. Verified 2026-10-03: the `lib-only` row with ' +
        'the Vite framework installs none of it and audits clean.',
      // The webpack framework, @storybook/angular, declares it a REQUIRED peer,
      // so npm reinstalls it there no matter what we delete. Workspaces
      // generated before the switch still run the webpack framework, and its
      // builders in angular.json are the witness — the `storybook` feature token
      // is not, because it is on for both frameworks.
      unlessUsing: ['@storybook/angular:*', '@angular-devkit/build-angular:*'],
    },
    {
      packages: ['@angular-devkit/architect', '@angular-devkit/core'],
      reason:
        'Angular 22 does not declare them: they arrive through @angular/cli ' +
        'and @angular/build, which depend on them at exact versions. ' +
        'Verified 2026-09-19: a ' +
        'generated workspace without Storybook audits clean with these absent.',
      // Required peers of both Storybook frameworks — npm puts them back
      // whatever we delete, so with Storybook on, pruning is not available.
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
        'packages, but the webpack Storybook framework marks it OPTIONAL (as ' +
        'does @angular/platform-browser), so npm installed it only because we ' +
        'asked. Verified 2026-09-23: with the declaration gone the install ' +
        'still resolves with no ERESOLVE, `npm ls @angular/animations` is ' +
        'empty, and one deprecation warning disappears from every install. ' +
        'The Vite framework that replaced it peers the package as REQUIRED, so ' +
        'workspaces with Storybook install it again as of 2026-10-03 — but as ' +
        "Storybook's choice, not as a line in this manifest, which is the " +
        'part this rule controls.',
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
        'rows from 1 high advisory to 0, with no ERESOLVE. Generated ' +
        'workspaces have used the Vite framework since 2026-10-03, which has ' +
        'no builder-webpack5; this stays for the ones generated before, which ' +
        '`doctor --fix` reaches.',
      // The webpack framework's builders, not the `storybook` token, which is
      // on for the Vite framework too and would write an override for a
      // package the tree does not have.
      onlyWhen: ['@storybook/angular:*'],
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
      spec: { '@angular/build': { vite: '^8.3.3' } },
      advisories: [
        'GHSA-rq7h-c2jc-7f22',
        'GHSA-vfpm-58rq-9qcg',
        'GHSA-9jrq-w75r-8gcw',
        'GHSA-698v-4r3x-3vcv',
        'GHSA-r825-w8mm-5pxw',
        'GHSA-587h-7wmj-h5pm',
      ],
      reason:
        '@angular/build -> vite. The 22.2 line pins vite at exactly 8.3.0, not a ' +
        'range, so npm cannot move it, and six advisories landed against ' +
        '8.3.0-8.3.2: files outside `server.fs.allow` served when a project path ' +
        'matches a system path (GHSA-rq7h-c2jc-7f22), the first bytes of files ' +
        'outside `server.fs` exposed through `?vite-wasm-instance` ' +
        '(GHSA-vfpm-58rq-9qcg), cross-origin script execution through custom ' +
        'middleware (GHSA-9jrq-w75r-8gcw), and three in the bundled launch-editor ' +
        'on Windows (GHSA-698v-4r3x-3vcv, GHSA-r825-w8mm-5pxw, ' +
        'GHSA-587h-7wmj-h5pm). All are fixed in 8.3.3, published 2026-10-06, and ' +
        'all are the dev server: nothing reaches production output. Every other ' +
        'parent in the tree (vitest, @storybook/builder-vite, ' +
        "@analogjs/vite-plugin-angular) already resolves 8.3.5; Angular's pin is " +
        'the one holding it back, and its own 22.3.0-next.2 moves to 8.3.4, so a ' +
        'patch of vite is what Angular ships next anyway. Verified 2026-10-22: ' +
        'the sweep reported the six on every row, the gate having suggested ' +
        'accepting them because no version satisfies both `8.3.0` and the fix; ' +
        'with this override every row audits clean, and the `minimal` row ' +
        'installs, builds and tests. Once a 22.x @angular/build pins >= 8.3.3 ' +
        'itself and the 22.2 line is old enough not to matter, move this to ' +
        '`retired`.',
      // Where @angular/build runs, which is every workspace this generator has
      // written; the guard is what keeps it from being written somewhere it
      // has no parent.
      onlyWhen: ['@angular/build:*'],
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
   * `doctor` wherever its `onlyWhen` holds, and fails this repo's own tests
   * everywhere. Empty is the correct state; an entry here is a debt with a date.
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
        'exists only where the webpack Storybook framework forces the devkit ' +
        'peer (see the prune rule above), and it lives in the dev server proxy, ' +
        "which matches patterns from the developer's own proxy config, never " +
        'from a request. Nothing here reaches production output. Since ' +
        '2026-10-03 no generated workspace has the chain — the design system ' +
        'uses @storybook/angular-vite — so this entry covers only workspaces ' +
        'generated before, whose `audit:policy` would otherwise fail on it. ' +
        'Revisit when braces publishes a fix. At `until`, remove it along with ' +
        'the webpack-dev-middleware override and the `@storybook/angular:*` ' +
        'guard on the build-angular prune: by then a workspace still on the ' +
        'webpack framework has had six months to move.',
      until: '2027-04-03',
      // The webpack framework's builders, as on the override and the prune.
      // Unscoped, its expiry would fail generation of Vite workspaces too,
      // which have no braces to accept.
      onlyWhen: ['@storybook/angular:*'],
      devOnly: true,
    },
  ],

  /**
   * Overrides a release wrote and the policy no longer does.
   *
   * When an override leaves the list above and has shipped, it moves here, so
   * `doctor --fix` can take it out of the workspaces that have it. It does so
   * only where it can show the pin does nothing: an exact match to what was
   * released, and its parent package absent from the lockfile. A parent still
   * in the tree keeps its pin, because there the pin may still be holding.
   * Live overrides whose `onlyWhen` no longer holds are removed on the same
   * terms, and need no entry here.
   */
  retired: [
    {
      spec: { sockjs: { uuid: '^11.1.1' } },
      lastShipped: '22.4.0',
      reason:
        'GHSA-w5hq-g745-h8pq via @angular-devkit/build-angular -> ' +
        'webpack-dev-server 5 -> sockjs -> uuid@8, written into every Storybook ' +
        'workspace from 22.0.0. build-angular 22.2 moved to webpack-dev-server ' +
        '6, which dropped sockjs, so a lockfile past 22.1 has nothing for it to ' +
        'pin. One still on 22.1 has sockjs, and keeps the override.',
    },
    {
      spec: { '@scalar/json-magic': { undici: '^7.29.0' } },
      lastShipped: '22.4.0',
      reason:
        'orval -> @scalar/openapi-parser -> @scalar/json-magic -> undici@7.x, ' +
        'written into every codegen workspace from 22.0.0. json-magic pinned ' +
        'undici at an exact version with advisories open against it: five, ' +
        'fixed in 7.29.0, when this shipped, then seven more fixed in 7.29.1 ' +
        '(GHSA-rfgv-xxqx-mfg5, GHSA-w293-vg96-wgc3, GHSA-3wwx-pv8p-q78v, ' +
        'GHSA-pmjh-fq2x-6v4x, GHSA-3xpg-4rpp-hhhm, GHSA-2jfj-6hjv-fm6j, ' +
        'GHSA-rx4f-c7p8-82vq), and the override floated the tree past them. ' +
        '22.5.0 raised it to ^7.29.1, the entry below, which says why both ' +
        'leave now. Listed separately because doctor removes an exact match ' +
        'only, and a workspace from before 22.5.0 that never ran `doctor ' +
        '--fix` still holds this shape.',
    },
    {
      spec: { '@scalar/json-magic': { undici: '^7.29.1' } },
      lastShipped: '22.9.1',
      reason:
        'The entry above, raised past the seven advisories fixed in undici ' +
        '7.29.1. Since 2026-10-02 @scalar/json-magic pins 7.29.1 or later ' +
        'itself, and orval 8.44.0 resolves 0.15.7 (undici 7.29.1) and 0.16.1 ' +
        '(7.30.1). Verified 2026-10-22: a lockfile of orval ^8.34.0 audits ' +
        'clean without this entry, and `npm run sweep` is clean on every row. ' +
        'What a caret kept past its need does next is hold undici on 7.x once ' +
        'json-magic moves to 8, so it leaves while it still pins nothing. A ' +
        'workspace keeps it while json-magic is in its lockfile, where it ' +
        "floats nothing above upstream's own choice; one whose lockfile still " +
        'holds undici below 7.29.1 (generated before 22.5.0 and not run ' +
        'through `doctor --fix` since) is reported by `audit`, and ' +
        '`npm update undici` moves it.',
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
