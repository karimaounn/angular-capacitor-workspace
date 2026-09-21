import { describe, expect, it } from 'vitest';
import { applyPolicy, PolicyError } from '../src/policy/apply';
import type { Manifest } from '../src/policy/apply';
import { POLICY } from '../src/policy/advisories';
import type { Policy, PolicyContext } from '../src/policy/types';
import { isGuardSatisfied } from '../src/policy/guards';

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

  it('rejects a malformed date rather than treating it as far future', () => {
    const policy: Policy = {
      ...EMPTY,
      accepted: [{ id: 'GHSA-test', packages: ['x'], reason: 'test', until: 'soon' }],
    };
    expect(() => applyPolicy({}, ctx(), policy)).toThrow(/Expected YYYY-MM-DD/);
  });
});

describe('the shipped policy', () => {
  it('keeps the devkit packages when Storybook is on', () => {
    // The correction that matters: Storybook declares build-angular as a
    // required peer, so pruning it is not available — npm puts it back.
    const { decisions } = applyPolicy(
      { devDependencies: { '@angular-devkit/build-angular': '^22.1.8' } },
      ctx({ features: new Set(['storybook']) }),
      POLICY,
    );

    const prune = decisions.find(
      (decision) =>
        decision.tier === 'prune' && decision.packages.includes('@angular-devkit/build-angular'),
    );
    expect(prune).toMatchObject({ outcome: 'skipped', guard: 'storybook' });
  });

  it('prunes the devkit packages when Storybook is off', () => {
    const { manifest } = applyPolicy(
      { devDependencies: { '@angular-devkit/build-angular': '^22.1.8' } },
      ctx(),
      POLICY,
    );
    expect(manifest.devDependencies?.['@angular-devkit/build-angular']).toBeUndefined();
  });

  it('writes the install-script allowlist', () => {
    const { manifest } = applyPolicy({}, ctx(), POLICY);
    expect(manifest.allowScripts).toMatchObject({ esbuild: true });
  });

  it('has no expired acceptances today', () => {
    // Guards the repo itself: a Tier 4 entry that nobody revisited fails here
    // before it reaches a user.
    expect(() => applyPolicy({}, ctx(), POLICY)).not.toThrow();
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
