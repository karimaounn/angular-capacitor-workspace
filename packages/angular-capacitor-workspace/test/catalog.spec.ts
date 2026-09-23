import * as semver from 'semver';
import { describe, expect, it } from 'vitest';
import { featuresFor } from '../src/api';
import { CATALOG, catalogEntry, resolveCatalog } from '../src/catalog';

describe('resolveCatalog', () => {
  it('returns entries in catalog order, whatever order they were asked for in', () => {
    // So two people who asked for the same packages get byte-identical
    // manifests and READMEs, whichever way round they typed them.
    const ids = CATALOG.map((entry) => entry.id);
    const reversed = resolveCatalog([...ids].reverse());
    expect(reversed.map((entry) => entry.id)).toEqual(ids);
  });

  it('ignores repeats', () => {
    expect(resolveCatalog(['cdk', 'cdk']).map((entry) => entry.id)).toEqual(['cdk']);
  });

  it('names the alternatives for an id that is not in the catalog', () => {
    expect(() => resolveCatalog(['cdk', 'nope'])).toThrow(/"nope" is not one of the packages/);
    expect(() => resolveCatalog(['nope'])).toThrow(/Known: cdk/);
  });

  it('is empty for an empty request, rather than a default set', () => {
    expect(resolveCatalog([])).toEqual([]);
  });
});

describe('the shipped catalog', () => {
  it('has a unique id per entry', () => {
    const ids = CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every package a resolvable range and a block', () => {
    for (const entry of CATALOG) {
      expect(entry.packages.length, entry.id).toBeGreaterThan(0);
      for (const pkg of entry.packages) {
        expect(semver.validRange(pkg.range), `${entry.id} → ${pkg.name}@${pkg.range}`).not.toBe(
          null,
        );
        expect(['dependencies', 'devDependencies']).toContain(pkg.block);
      }
    }
  });

  it('carries the CDK as a runtime dependency a library may build on', () => {
    const cdk = catalogEntry('cdk');
    expect(cdk?.libraryPeer).toBe(true);
    expect(cdk?.packages).toEqual([
      { name: '@angular/cdk', range: expect.any(String), block: 'dependencies' },
    ]);
  });
});

describe('featuresFor', () => {
  it('contributes a token per catalog package, so a remedy can be scoped to it', () => {
    const features = featuresFor({ directory: 'ws', packages: ['cdk'] });
    expect(features).toContain('pkg:cdk');
  });

  it('contributes none when none were asked for', () => {
    expect(
      [...featuresFor({ directory: 'ws' })].filter((token) => token.startsWith('pkg:')),
    ).toEqual([]);
  });
});
