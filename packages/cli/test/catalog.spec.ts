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

  it('pulls in what an entry requires, so a peer is never left to npm', () => {
    // `--with aria` alone has to produce a workspace that resolves: the aria
    // peer on the CDK is an exact version, so the CDK has to be declared at a
    // range we chose rather than auto-installed at whatever npm picks.
    expect(resolveCatalog(['aria']).map((entry) => entry.id)).toEqual(['cdk', 'aria']);
  });

  it('asks for something once when it was asked for and required both', () => {
    expect(resolveCatalog(['aria', 'cdk']).map((entry) => entry.id)).toEqual(['cdk', 'aria']);
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

  it('wires the CDK overlay sheet, and only that one', () => {
    // a11y-prebuilt.css is opt-in: it is needed only by `cdkVisuallyHidden`,
    // and the README says how to add it.
    expect(catalogEntry('cdk')?.appStyles).toEqual([
      'node_modules/@angular/cdk/overlay-prebuilt.css',
    ]);
  });

  it('carries Aria as a runtime dependency that brings the CDK with it', () => {
    const aria = catalogEntry('aria');
    expect(aria?.libraryPeer).toBe(true);
    expect(aria?.requires).toEqual(['cdk']);
    expect(aria?.packages).toEqual([
      { name: '@angular/aria', range: expect.any(String), block: 'dependencies' },
    ]);
    // Headless: there is no stylesheet to wire, and the popup patterns borrow
    // the CDK overlay's, which the `cdk` entry already prepends.
    expect(aria?.appStyles).toBeUndefined();
  });

  it('gives Aria and the CDK the same range, since Aria peers it exactly', () => {
    expect(catalogEntry('aria')?.packages[0]?.range).toBe(catalogEntry('cdk')?.packages[0]?.range);
  });

  it('carries the service worker as an application concern, not a library one', () => {
    const sw = catalogEntry('service-worker');
    expect(sw?.appSetup).toBe('service-worker');
    // A library that registered a service worker would decide caching for every
    // application consuming it.
    expect(sw?.libraryPeer).toBeUndefined();
    expect(sw?.packages).toEqual([
      { name: '@angular/service-worker', range: expect.any(String), block: 'dependencies' },
    ]);
  });

  it('keeps the service worker on the framework range, which it peers exactly', () => {
    expect(catalogEntry('service-worker')?.packages[0]?.range).toBe(
      catalogEntry('cdk')?.packages[0]?.range,
    );
  });

  it('only ever requires an id that is in the catalog', () => {
    for (const entry of CATALOG) {
      for (const id of entry.requires ?? []) {
        expect(catalogEntry(id), `${entry.id} requires "${id}"`).toBeDefined();
      }
    }
  });

  it('gives every wired stylesheet a workspace-relative path', () => {
    // How the Angular builder resolves a `styles` entry. A leading slash or a
    // `./` prefix resolves somewhere else, or nowhere, without complaint.
    for (const entry of CATALOG) {
      for (const style of entry.appStyles ?? []) {
        expect(style, `${entry.id} → ${style}`).toMatch(/^[^./]/);
      }
    }
  });
});

describe('featuresFor', () => {
  it('contributes a token per catalog package, so a remedy can be scoped to it', () => {
    const features = featuresFor({ directory: 'ws', packages: ['cdk'] });
    expect(features).toContain('pkg:cdk');
  });

  it('contributes a token for a package that came along, not only the one typed', () => {
    // A policy remedy scoped to `pkg:cdk` has to reach a workspace that asked
    // for aria, because that workspace has the CDK.
    const features = featuresFor({ directory: 'ws', packages: ['aria'] });
    expect([...features].filter((token) => token.startsWith('pkg:')).sort()).toEqual([
      'pkg:aria',
      'pkg:cdk',
    ]);
  });

  it('contributes none when none were asked for', () => {
    expect(
      [...featuresFor({ directory: 'ws' })].filter((token) => token.startsWith('pkg:')),
    ).toEqual([]);
  });
});
