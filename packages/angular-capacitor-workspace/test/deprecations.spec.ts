import { describe, expect, it } from 'vitest';
import { collectDeprecations } from '../src/gate/deprecations';

/**
 * Verbatim npm 11.16 output from installing a generated `full` row on
 * 2026-09-23. Copied rather than paraphrased: the whole job of the parser is to
 * survive what npm actually prints, including a message that contains a URL
 * with a colon in it and a package name that repeats inside its own message.
 */
const OUTPUT = `
npm warn deprecated @angular/animations@22.1.7: @angular/animations is deprecated. Use \`animate.enter\` and \`animate.leave\` instead. For more information see: https://v22.angular.dev/guide/animations.
npm warn deprecated @angular-devkit/build-angular@22.1.8: Angular's Webpack support is deprecated. Use the esbuild and Vite-based "@angular/build" package instead.
npm warn deprecated @angular/platform-browser-dynamic@22.1.7: @angular/platform-browser-dynamic is deprecated. Use \`@angular/platform-browser\` instead.
npm warn deprecated @ngtools/webpack@22.1.8: Angular's Webpack support is deprecated. Use the esbuild and Vite-based "@angular/build" package instead.
npm warn deprecated whatwg-encoding@3.1.1: Use @exodus/bytes instead for a more spec-conformant and faster implementation

added 1077 packages in 2m

266 packages are looking for funding
  run \`npm fund\` for details
`;

const MANIFEST = {
  dependencies: { '@angular/core': '^22.1.0' },
  devDependencies: {
    '@angular-devkit/build-angular': '^22.1.8',
    '@angular/platform-browser-dynamic': '^22.1.0',
  },
};

describe('collectDeprecations', () => {
  it('splits a scoped name from its version on the right @', () => {
    const found = collectDeprecations(OUTPUT);

    expect(found.map((entry) => `${entry.package}@${entry.version}`)).toEqual([
      '@angular-devkit/build-angular@22.1.8',
      '@angular/animations@22.1.7',
      '@angular/platform-browser-dynamic@22.1.7',
      '@ngtools/webpack@22.1.8',
      'whatwg-encoding@3.1.1',
    ]);
  });

  it('keeps a message that contains a colon and an @ of its own', () => {
    const [, animations] = collectDeprecations(OUTPUT);

    expect(animations?.message).toBe(
      '@angular/animations is deprecated. Use `animate.enter` and `animate.leave` ' +
        'instead. For more information see: https://v22.angular.dev/guide/animations.',
    );
  });

  it('marks only what the manifest declares as direct', () => {
    const found = collectDeprecations(OUTPUT, MANIFEST);
    const direct = found.filter((entry) => entry.direct).map((entry) => entry.package);

    // The distinction the whole rule rests on: a direct entry is one this
    // generator chose, a transitive one arrived underneath something else.
    expect(direct).toEqual(['@angular-devkit/build-angular', '@angular/platform-browser-dynamic']);
  });

  it('reads nothing but deprecation warnings out of the install log', () => {
    expect(collectDeprecations('added 1077 packages in 2m\nnpm warn EBADENGINE')).toEqual([]);
  });

  it('deduplicates a package npm warned about more than once', () => {
    const twice = `npm warn deprecated uuid@8.3.2: Please upgrade.
npm warn deprecated uuid@8.3.2: Please upgrade.`;

    expect(collectDeprecations(twice)).toHaveLength(1);
  });

  it('returns nothing for an install that unpacked nothing', () => {
    // Not the same as "nothing is deprecated" — npm warns only while it
    // reifies, so a tree already on disk reports clean. Callers have to know
    // the difference; this only documents that the parser cannot tell them.
    expect(collectDeprecations('up to date in 2s')).toEqual([]);
  });
});
