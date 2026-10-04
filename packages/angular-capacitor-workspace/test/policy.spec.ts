import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as semver from 'semver';
import { describe, expect, it } from 'vitest';
import { applyPolicy, PolicyError } from '../src/policy/apply';
import type { Manifest } from '../src/policy/apply';
import { POLICY } from '../src/policy/advisories';
import type { Policy, PolicyContext } from '../src/policy/types';
import { isGuardSatisfied } from '../src/policy/guards';
import { VERSIONS } from '../src/policy/versions';

function ctx(partial: Partial<PolicyContext> = {}): PolicyContext {
  return {
    features: partial.features ?? new Set(),
    builders: partial.builders ?? new Set(),
    ...(partial.today ? { today: partial.today } : {}),
  };
}

const EMPTY: Policy = {
  reviewed: '2026-01-01',
  prune: [],
  overrides: [],
  floors: [],
  accepted: [],
  allowScripts: {},
};

describe('guards', () => {
  it('matches a feature token exactly', () => {
    expect(isGuardSatisfied('storybook', ctx({ features: new Set(['storybook']) }))).toBe(true);
    expect(isGuardSatisfied('storybook', ctx({ features: new Set(['mobile']) }))).toBe(false);
  });

  it('globs a builder', () => {
    const context = ctx({ builders: new Set(['@angular-devkit/build-angular:browser']) });
    expect(isGuardSatisfied('@angular-devkit/build-angular:*', context)).toBe(true);
    expect(isGuardSatisfied('@angular/build:*', context)).toBe(false);
  });

  it('does not treat a feature token as a builder glob', () => {
    // 'ssr:server' contains a colon but names a capability, not a builder.
    const context = ctx({ builders: new Set(['@angular/build:application']) });
    expect(isGuardSatisfied('ssr:server', context)).toBe(false);
  });
});

describe('prune', () => {
  const policy: Policy = {
    ...EMPTY,
    prune: [
      {
        packages: ['express', '@types/express'],
        reason: 'test',
        unlessUsing: ['ssr:server'],
      },
    ],
  };

  it('removes packages when no guard holds', () => {
    const manifest: Manifest = {
      dependencies: { express: '^5.1.0', rxjs: '~7.8.0' },
      devDependencies: { '@types/express': '^5.0.1' },
    };

    const { manifest: out, decisions } = applyPolicy(manifest, ctx(), policy);

    expect(out.dependencies).toEqual({ rxjs: '~7.8.0' });
    expect(out.devDependencies).toBeUndefined();
    expect(decisions[0]).toMatchObject({ tier: 'prune', outcome: 'applied' });
  });

  it('keeps packages when a guard holds, and says which one', () => {
    const manifest: Manifest = { dependencies: { express: '^5.1.0' } };

    const { manifest: out, decisions } = applyPolicy(
      manifest,
      ctx({ features: new Set(['ssr:server']) }),
      policy,
    );

    expect(out.dependencies).toEqual({ express: '^5.1.0' });
    expect(decisions[0]).toMatchObject({
      tier: 'prune',
      outcome: 'skipped',
      guard: 'ssr:server',
    });
  });

  it('does not mutate the input manifest', () => {
    const manifest: Manifest = { dependencies: { express: '^5.1.0' } };
    applyPolicy(manifest, ctx(), policy);
    expect(manifest.dependencies).toEqual({ express: '^5.1.0' });
  });
});

describe('override', () => {
  it('merges nested specs and respects onlyWhen', () => {
    const policy: Policy = {
      ...EMPTY,
      overrides: [
        { spec: { sockjs: { uuid: '^11.1.1' } }, reason: 'a', onlyWhen: ['storybook'] },
        { spec: { xcode: { uuid: '^11.1.1' } }, reason: 'b', onlyWhen: ['mobile'] },
      ],
    };

    const { manifest } = applyPolicy({}, ctx({ features: new Set(['storybook']) }), policy);

    expect(manifest.overrides).toEqual({ sockjs: { uuid: '^11.1.1' } });
  });

  it('refuses to silently reconcile conflicting pins', () => {
    const policy: Policy = {
      ...EMPTY,
      overrides: [
        { spec: { sockjs: { uuid: '^11.1.1' } }, reason: 'a' },
        { spec: { sockjs: { uuid: '^9.0.0' } }, reason: 'b' },
      ],
    };

    expect(() => applyPolicy({}, ctx(), policy)).toThrow(PolicyError);
    expect(() => applyPolicy({}, ctx(), policy)).toThrow(/Conflicting overrides/);
  });
});

describe('floor', () => {
  const policy: Policy = {
    ...EMPTY,
    floors: [{ package: 'vitest', min: '4.1.11', range: '^4.1.11', reason: 'test' }],
  };

  it('raises a range whose minimum sits below the floor', () => {
    const { manifest } = applyPolicy({ devDependencies: { vitest: '^4.0.8' } }, ctx(), policy);
    expect(manifest.devDependencies?.['vitest']).toBe('^4.1.11');
  });

  it('leaves a range that is already at or above the floor', () => {
    const { manifest } = applyPolicy({ devDependencies: { vitest: '^4.2.0' } }, ctx(), policy);
    expect(manifest.devDependencies?.['vitest']).toBe('^4.2.0');
  });

  it('judges by the range minimum, not by whether the floor satisfies it', () => {
    // `^4.0.8` *permits* 4.1.11, so a naive `satisfies` check would pass it —
    // but it also permits 4.0.8, which is the vulnerable version. This is the
    // distinction the whole tier rests on.
    const { manifest } = applyPolicy({ devDependencies: { vitest: '^4.0.8' } }, ctx(), policy);
    expect(manifest.devDependencies?.['vitest']).toBe('^4.1.11');
  });

  it('ignores a package that is not installed', () => {
    const { manifest, decisions } = applyPolicy({ devDependencies: {} }, ctx(), policy);
    expect(manifest.devDependencies?.['vitest']).toBeUndefined();
    expect(decisions.find((d) => d.tier === 'floor')?.outcome).toBe('skipped');
  });
});

describe('accepted advisories', () => {
  it('fails the run when an acceptance has expired', () => {
    const policy: Policy = {
      ...EMPTY,
      accepted: [{ id: 'GHSA-test', packages: ['left-pad'], reason: 'test', until: '2026-01-01' }],
    };

    expect(() => applyPolicy({}, ctx({ today: new Date('2026-06-01T00:00:00Z') }), policy)).toThrow(
      /expired on 2026-01-01/,
    );
  });

  it('passes while the acceptance is current', () => {
    const policy: Policy = {
      ...EMPTY,
      accepted: [{ id: 'GHSA-test', packages: ['left-pad'], reason: 'test', until: '2026-12-31' }],
    };

    const { decisions } = applyPolicy({}, ctx({ today: new Date('2026-06-01T00:00:00Z') }), policy);
    expect(decisions[0]).toMatchObject({ tier: 'accept', outcome: 'applied' });
  });

  it('does not fail a run the acceptance does not apply to', () => {
    const policy: Policy = {
      ...EMPTY,
      accepted: [
        {
          id: 'GHSA-test',
          packages: ['left-pad'],
          reason: 'test',
          until: '2026-01-01',
          onlyWhen: ['legacy:*'],
        },
      ],
    };
    const today = new Date('2026-06-01T00:00:00Z');

    const { decisions } = applyPolicy({}, ctx({ today }), policy);
    expect(decisions[0]).toMatchObject({ tier: 'accept', outcome: 'skipped' });

    expect(() =>
      applyPolicy({}, ctx({ today, builders: new Set(['legacy:build']) }), policy),
    ).toThrow(/expired on 2026-01-01/);
  });

  it('rejects a malformed date rather than treating it as far future', () => {
    const policy: Policy = {
      ...EMPTY,
      accepted: [{ id: 'GHSA-test', packages: ['x'], reason: 'test', until: 'soon' }],
    };
    expect(() => applyPolicy({}, ctx(), policy)).toThrow(/Expected YYYY-MM-DD/);
  });
});

describe('the shipped policy', () => {
  it('keeps build-angular where the webpack Storybook framework still runs', () => {
    // A workspace generated before the switch to @storybook/angular-vite: the
    // webpack framework declares build-angular a required peer, so pruning it
    // is not available — npm puts it back. Its builders are the witness.
    const { manifest, decisions } = applyPolicy(
      { devDependencies: { '@angular-devkit/build-angular': '^22.1.8', storybook: '^10.6.0' } },
      ctx({
        features: new Set(['storybook']),
        builders: new Set(['@storybook/angular:build-storybook']),
      }),
      POLICY,
    );

    expect(manifest.devDependencies?.['@angular-devkit/build-angular']).toBe('^22.1.8');
    const prune = decisions.find(
      (decision) =>
        decision.tier === 'prune' && decision.packages.includes('@angular-devkit/build-angular'),
    );
    expect(prune).toMatchObject({ outcome: 'skipped', guard: '@storybook/angular:*' });
  });

  it('prunes build-angular under the Vite Storybook framework', () => {
    // The `storybook` token is on for both frameworks, so it cannot be the
    // guard — and the glob for the webpack builders must not match angular-vite.
    const { manifest } = applyPolicy(
      { devDependencies: { '@angular-devkit/build-angular': '^22.1.8', storybook: '^10.6.1' } },
      ctx({
        features: new Set(['storybook']),
        builders: new Set(['@storybook/angular-vite:build-storybook']),
      }),
      POLICY,
    );
    expect(manifest.devDependencies?.['@angular-devkit/build-angular']).toBeUndefined();
  });

  it('keeps core and architect under either Storybook framework', () => {
    // Required peers of both.
    const { manifest } = applyPolicy(
      {
        devDependencies: {
          '@angular-devkit/core': '^22.1.8',
          '@angular-devkit/architect': '^0.2201.8',
        },
      },
      ctx({
        features: new Set(['storybook']),
        builders: new Set(['@storybook/angular-vite:build-storybook']),
      }),
      POLICY,
    );
    expect(manifest.devDependencies?.['@angular-devkit/core']).toBe('^22.1.8');
    expect(manifest.devDependencies?.['@angular-devkit/architect']).toBe('^0.2201.8');
  });

  it('pins webpack-dev-middleware only under the webpack Storybook framework', () => {
    const vite = applyPolicy(
      {},
      ctx({
        features: new Set(['storybook']),
        builders: new Set(['@storybook/angular-vite:build-storybook']),
      }),
      POLICY,
    );
    expect(vite.manifest.overrides?.['@storybook/builder-webpack5']).toBeUndefined();

    const webpack = applyPolicy(
      {},
      ctx({
        features: new Set(['storybook']),
        builders: new Set(['@storybook/angular:build-storybook']),
      }),
      POLICY,
    );
    expect(webpack.manifest.overrides?.['@storybook/builder-webpack5']).toEqual({
      'webpack-dev-middleware': '^7.4.6',
    });
  });

  it('prunes the devkit packages when Storybook is off', () => {
    const { manifest } = applyPolicy(
      { devDependencies: { '@angular-devkit/build-angular': '^22.1.8' } },
      ctx(),
      POLICY,
    );
    expect(manifest.devDependencies?.['@angular-devkit/build-angular']).toBeUndefined();
  });

  it('removes the deprecated animations package from an existing workspace', () => {
    // Reaches workspaces generated before the pin was dropped: the schematic
    // change alone only fixes projects nobody has created yet.
    const { manifest } = applyPolicy(
      { devDependencies: { '@angular/animations': '^22.1.0', storybook: '^10.6.0' } },
      ctx({ features: new Set(['storybook']) }),
      POLICY,
    );
    expect(manifest.devDependencies?.['@angular/animations']).toBeUndefined();
    expect(manifest.devDependencies?.['storybook']).toBe('^10.6.0');
  });

  it('keeps animations when the workspace actually imports them', () => {
    // `doctor --fix` must not delete a package out from under a real
    // provideAnimations call in a workspace that has been alive for a year.
    const { manifest, decisions } = applyPolicy(
      { dependencies: { '@angular/animations': '^22.1.0' } },
      ctx({ features: new Set(['animations']) }),
      POLICY,
    );
    expect(manifest.dependencies?.['@angular/animations']).toBe('^22.1.0');

    const prune = decisions.find(
      (decision) => decision.tier === 'prune' && decision.packages.includes('@angular/animations'),
    );
    expect(prune).toMatchObject({ outcome: 'skipped', guard: 'animations' });
  });

  it('raises the @types/node range Angular writes for a server target', () => {
    // Angular's server schematic adds `^20.17.19` after the overlay has run, so
    // the policy — which runs last — is the rung that holds. Left alone it is
    // types for a Node the workspace refuses to run, and vitest 5's peer
    // rejects it outright.
    const { manifest, decisions } = applyPolicy(
      { devDependencies: { '@types/node': '^20.17.19' } },
      ctx(),
      POLICY,
    );
    expect(manifest.devDependencies?.['@types/node']).toBe(VERSIONS['@types/node'].range);

    const floor = decisions.find(
      (decision) => decision.tier === 'floor' && decision.packages.includes('@types/node'),
    );
    expect(floor).toMatchObject({ outcome: 'applied' });
  });

  it('leaves a @types/node range that already types the right Node', () => {
    const { manifest } = applyPolicy(
      { devDependencies: { '@types/node': '^26.0.0' } },
      ctx(),
      POLICY,
    );
    expect(manifest.devDependencies?.['@types/node']).toBe('^26.0.0');
  });

  it('writes the install-script allowlist', () => {
    const { manifest } = applyPolicy({}, ctx(), POLICY);
    expect(manifest.allowScripts).toMatchObject({ esbuild: true });
  });

  it('has no expired acceptances today', () => {
    // Guards the repo itself: a Tier 4 entry that nobody revisited fails here
    // before it reaches a user. Every entry is put in scope, because a scoped
    // one is skipped — expiry included — by a run its guards do not match.
    const features = new Set(POLICY.accepted.flatMap((entry) => entry.onlyWhen ?? []));
    expect(() => applyPolicy({}, ctx({ features }), POLICY)).not.toThrow();
  });

  it('scopes the braces acceptance to the webpack Storybook framework', () => {
    // Past `until`: a workspace on the Vite framework, which has no braces,
    // still generates; one on the webpack framework is told to move.
    const today = new Date('2027-05-01T00:00:00Z');
    const vite = { today, features: new Set(['storybook']) };

    expect(() =>
      applyPolicy(
        {},
        ctx({ ...vite, builders: new Set(['@storybook/angular-vite:start-storybook']) }),
        POLICY,
      ),
    ).not.toThrow();
    expect(() =>
      applyPolicy(
        {},
        ctx({ ...vite, builders: new Set(['@storybook/angular:start-storybook']) }),
        POLICY,
      ),
    ).toThrow(/GHSA-vfj7-8cjw-p6xm expired/);
  });

  it('sorts dependency blocks so generated manifests do not churn', () => {
    const { manifest } = applyPolicy(
      { devDependencies: { zod: '^3.0.0', axios: '^1.0.0' } },
      ctx(),
      POLICY,
    );
    expect(Object.keys(manifest.devDependencies!)).toEqual(['axios', 'zod']);
  });
});

/**
 * The pins in versions.ts that no resolver checks for us.
 *
 * `@vitest/browser-playwright` peers vitest at an exact version, so the two
 * ranges are really one decision. Bumping either alone installs nothing and
 * fails the audit gate on ERESOLVE, at generation time, in a user's terminal.
 */
describe('version pins', () => {
  it('pins vitest and its browser provider to the same exact version', () => {
    const vitest = VERSIONS['vitest'].range;
    const provider = VERSIONS['@vitest/browser-playwright'].range;

    expect(
      semver.valid(vitest),
      `vitest pin "${vitest}" must be exact, not a range`,
    ).not.toBeNull();
    expect(
      semver.valid(provider),
      `@vitest/browser-playwright pin "${provider}" must be exact, not a range`,
    ).not.toBeNull();
    expect(provider).toBe(vitest);
  });

  it('types the Node the generated workspace requires, not an older one', () => {
    // The workspace declares this package's own `engines.node`, and @types/node
    // is pinned rather than delegated to Angular's `latestVersions`, which
    // writes the floor Angular's tooling supports (`^20` on the 22.1 line).
    // Types below the engine describe a Node the workspace refuses to run; they
    // are also what vitest 5's `^22.0.0 || >=24.0.0` peer rejected, taking the
    // whole install down with it.
    const engines = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      engines: { node: string };
    };

    const node = semver.minVersion(engines.engines.node);
    const types = semver.minVersion(VERSIONS['@types/node'].range);
    expect(node).not.toBeNull();
    expect(types).not.toBeNull();
    expect(types!.major).toBe(node!.major);
    expect(semver.satisfies(types!, '^22.0.0 || >=24.0.0')).toBe(true);
  });

  it('keeps the vitest pin at or above the advisory floor', () => {
    const floor = POLICY.floors.find((rule) => rule.package === 'vitest');
    expect(floor).toBeDefined();
    expect(semver.lt(VERSIONS['vitest'].range, floor!.min)).toBe(false);
  });
});
