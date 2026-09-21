import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as semver from 'semver';
import { describe, expect, it } from 'vitest';
import { ANGULAR_LINE } from '../src/policy/versions';

interface PackageManifest {
  version: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

function readManifest(...segments: string[]): PackageManifest {
  return JSON.parse(readFileSync(join(__dirname, '..', ...segments), 'utf8')) as PackageManifest;
}

const manifest = readManifest('package.json');
const createManifest = readManifest('..', 'create-angular-capacitor-workspace', 'package.json');

/**
 * The package's major is the Angular major it generates for: 22.x generates
 * Angular 22 workspaces, 23.0.0 ships with Angular 23. Minor and patch are
 * ours. Each of these is one line to forget when cutting a new major, and each
 * failure mode is silent — a 23.x release that still runs Angular 22's
 * skeletons, or installs into a workspace it cannot serve.
 */
describe('release line', () => {
  it('majors with the Angular line it generates for', () => {
    expect(String(semver.major(manifest.version))).toBe(ANGULAR_LINE);
  });

  it('peers the same Angular major, so npm and ng update refuse a mismatch', () => {
    expect(manifest.peerDependencies?.['@angular/core']).toBe(`^${ANGULAR_LINE}.0.0`);
  });

  it("runs the same Angular major's schematics", () => {
    for (const name of [
      '@angular-devkit/core',
      '@angular-devkit/schematics',
      '@schematics/angular',
    ]) {
      const range = manifest.dependencies?.[name];
      expect(range, name).toBeDefined();
      expect(String(semver.minVersion(range!)?.major), name).toBe(ANGULAR_LINE);
    }
  });

  it('versions the create-* shell in lockstep', () => {
    expect(createManifest.version).toBe(manifest.version);
    expect(createManifest.dependencies?.['angular-capacitor-workspace']).toBe(manifest.version);
  });
});

/**
 * npm packs a LICENSE only from the package's own directory, and MIT requires
 * the notice to travel with the code. So each package carries a copy of the
 * root file, and a copy that drifts from it is a licence nobody chose.
 */
describe('licence', () => {
  const root = readFileSync(join(__dirname, '..', '..', '..', 'LICENSE'), 'utf8');

  it.each(['angular-capacitor-workspace', 'create-angular-capacitor-workspace'])(
    'ships the root LICENSE with %s',
    (name) => {
      expect(readFileSync(join(__dirname, '..', '..', name, 'LICENSE'), 'utf8')).toBe(root);
    },
  );
});
