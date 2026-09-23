import { describe, expect, it } from 'vitest';
import { classify, EXPECTED, renderIssue, staleWaivers, summarise } from '../deprecations.mjs';

/** The five warnings a `full` row actually produced, verbatim. */
const OBSERVED = [
  {
    package: '@angular-devkit/build-angular',
    version: '22.1.8',
    message: "Angular's Webpack support is deprecated.",
    direct: true,
  },
  {
    package: '@angular/platform-browser-dynamic',
    version: '22.1.7',
    message: 'Use `@angular/platform-browser` instead.',
    direct: true,
  },
  {
    package: '@ngtools/webpack',
    version: '22.1.8',
    message: "Angular's Webpack support is deprecated.",
    direct: false,
  },
  {
    package: 'whatwg-encoding',
    version: '3.1.1',
    message: 'Use @exodus/bytes instead.',
    direct: false,
  },
];

describe('classify', () => {
  it('passes the deprecations a real workspace ships today', () => {
    // The rule has to be quiet on the current tree, or it is a rule nobody
    // leaves switched on.
    const { findings, waived, transitive } = classify(OBSERVED);

    expect(findings).toEqual([]);
    expect(waived.map((entry) => entry.package)).toEqual([
      '@angular-devkit/build-angular',
      '@angular/platform-browser-dynamic',
    ]);
    expect(transitive.map((entry) => entry.package)).toEqual([
      '@ngtools/webpack',
      'whatwg-encoding',
    ]);
  });

  it('fails a direct deprecation nobody has waived', () => {
    // The @angular/animations case: a package the generator wrote into the
    // manifest itself, deprecated, and not a required peer of anything.
    const { findings } = classify([
      ...OBSERVED,
      {
        package: '@angular/animations',
        version: '22.1.7',
        message: 'Use `animate.enter` and `animate.leave` instead.',
        direct: true,
      },
    ]);

    expect(findings.map((entry) => entry.package)).toEqual(['@angular/animations']);
  });

  it('never fails a transitive deprecation, however loud', () => {
    // Nothing here can act on one, so gating on it would only produce a red
    // build with no move available.
    const { findings, transitive } = classify([
      { package: 'left-pad', version: '1.0.0', message: 'critical sounding words', direct: false },
    ]);

    expect(findings).toEqual([]);
    expect(transitive).toHaveLength(1);
  });
});

describe('staleWaivers', () => {
  it('reports a waiver that no row exercised any more', () => {
    const stale = staleWaivers(new Set(['@angular-devkit/build-angular']));
    expect(stale.map((entry) => entry.package)).toEqual(['@angular/platform-browser-dynamic']);
  });

  it('is empty when every waiver was seen', () => {
    expect(staleWaivers(new Set(EXPECTED.map((entry) => entry.package)))).toEqual([]);
  });
});

describe('the waiver list', () => {
  it('says why each entry cannot simply be removed', () => {
    // An entry without a peer forcing it is one that belongs in POLICY.prune
    // instead, and the list rots the moment that distinction goes unrecorded.
    for (const entry of EXPECTED) {
      expect(entry.peerOf, `${entry.package} names no forcing peer`).toBeTruthy();
      expect(entry.reason.length, `${entry.package} has no reason`).toBeGreaterThan(40);
      expect(entry.revisitWhen, `${entry.package} has no revisit trigger`).toBeTruthy();
    }
  });
});

describe('renderIssue', () => {
  const rows = [
    {
      row: 'full',
      deprecations: classify([
        ...OBSERVED,
        {
          package: '@angular/animations',
          version: '22.1.7',
          message: 'Use `animate.enter` and `animate.leave` instead.',
          direct: true,
        },
      ]),
    },
  ];

  it('leads with the finding and the move available', () => {
    const body = renderIssue(rows);

    expect(body).toContain('@angular/animations@22.1.7');
    expect(body).toContain('POLICY.prune');
    expect(body.indexOf('@angular/animations')).toBeLessThan(
      body.indexOf('### Transitive, for information'),
    );
  });

  it('carries the waived ones as context rather than as work', () => {
    const body = renderIssue(rows);

    expect(body).toContain('Expected, and why');
    expect(body).toContain('required peer of');
    expect(body).toContain('whatwg-encoding@3.1.1');
  });

  it('asks for a stale waiver to be deleted', () => {
    const body = renderIssue(rows, [EXPECTED[0]]);
    expect(body).toContain('Waivers that no row exercised');
    expect(body).toContain(EXPECTED[0].package);
  });
});

describe('summarise', () => {
  it('says none rather than nothing when a row is clean', () => {
    expect(summarise(classify([]))).toBe('none');
  });

  it('counts each kind separately', () => {
    expect(summarise(classify(OBSERVED))).toBe('2 expected, 2 transitive');
  });
});
