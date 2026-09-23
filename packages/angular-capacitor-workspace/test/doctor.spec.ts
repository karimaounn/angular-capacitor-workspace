import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyFix, diagnose, inferFeatures } from '../src/cli/doctor';
import type { Policy } from '../src/policy/types';

let cwd: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'acw-doctor-'));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function write(relative: string, value: unknown): void {
  const path = join(cwd, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

function writeText(relative: string, contents: string): void {
  const path = join(cwd, relative);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
}

function readManifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
}

const POLICY: Policy = {
  reviewed: '2026-09-19',
  prune: [{ packages: ['express'], reason: 'test', unlessUsing: ['ssr:server'] }],
  overrides: [{ spec: { sockjs: { uuid: '^11.1.1' } }, reason: 'test', onlyWhen: ['storybook'] }],
  floors: [{ package: 'vitest', min: '4.1.11', range: '^4.1.11', reason: 'test' }],
  accepted: [],
  allowScripts: { esbuild: true },
};

describe('inferFeatures', () => {
  it('does not claim animations are used when nothing imports them', () => {
    write('package.json', { name: 'ws' });
    writeText('projects/ui/src/lib/button.ts', "import { Component } from '@angular/core';\n");

    expect(inferFeatures(cwd, {})).not.toContain('animations');
  });

  it('treats an import in the workspace source as the witness, not the dependency', () => {
    // The dependency entry cannot be the evidence: the guard exists to decide
    // whether that entry should survive. Declaring it without importing it must
    // still infer nothing.
    write('package.json', { name: 'ws', dependencies: { '@angular/animations': '^22.1.0' } });

    expect(
      inferFeatures(cwd, { dependencies: { '@angular/animations': '^22.1.0' } }),
    ).not.toContain('animations');

    writeText(
      'projects/shop/web/src/app/app.config.ts',
      "import { provideAnimations } from '@angular/animations';\n",
    );

    expect(inferFeatures(cwd, {})).toContain('animations');
  });

  it('does not read node_modules, where every Angular package mentions it', () => {
    write('package.json', { name: 'ws' });
    writeText(
      'projects/node_modules/@angular/platform-browser/index.d.ts',
      "export * from '@angular/animations';\n",
    );

    expect(inferFeatures(cwd, {})).not.toContain('animations');
  });

  it('reads the feature set from the workspace, not from a saved answer file', () => {
    write('package.json', {
      name: 'ws',
      devDependencies: { storybook: '^10.6.0', orval: '^8.34.0', '@capacitor/android': '^8.5.2' },
    });

    const features = inferFeatures(cwd, {
      devDependencies: { storybook: '^10.6.0', orval: '^8.34.0', '@capacitor/android': '^8.5.2' },
    });

    expect(features).toContain('storybook');
    expect(features).toContain('codegen');
    expect(features).toContain('mobile:android');
  });

  it('detects a catalog package from the manifest, which is the only witness', () => {
    // Unlike the animations guard above, nothing prunes a package the user
    // asked for by name, so reading the dependency entry is not circular here.
    write('package.json', { name: 'ws', dependencies: { '@angular/cdk': '^22.1.0' } });

    expect(inferFeatures(cwd, { dependencies: { '@angular/cdk': '^22.1.0' } })).toContain(
      'pkg:cdk',
    );
    expect(inferFeatures(cwd, {})).not.toContain('pkg:cdk');
  });

  it('detects a static marketing target from angular.json', () => {
    write('angular.json', {
      projects: {
        site: {
          projectType: 'application',
          root: 'projects/site/web',
          architect: { build: { options: { outputMode: 'static' } } },
        },
      },
    });

    expect(inferFeatures(cwd, {})).toContain('marketing');
  });
});

describe('diagnose', () => {
  it('reports a missing override the policy has since added', () => {
    write('package.json', { name: 'ws', devDependencies: { storybook: '^10.6.0' } });

    const { drifts } = diagnose(cwd, POLICY);

    expect(drifts).toContainEqual(expect.objectContaining({ tier: 'override', kind: 'missing' }));
  });

  it('reports a dependency the policy prunes for this feature set', () => {
    write('package.json', { name: 'ws', dependencies: { express: '^5.1.0' } });

    const { drifts } = diagnose(cwd, POLICY);

    expect(drifts).toContainEqual(
      expect.objectContaining({ tier: 'prune', actual: 'dependencies.express' }),
    );
  });

  it('keeps a pruned dependency that the workspace legitimately uses', () => {
    // express plus an SSR server target means the guard holds.
    write('package.json', { name: 'ws', dependencies: { express: '^5.1.0' } });
    write('angular.json', {
      projects: {
        site: {
          projectType: 'application',
          architect: { build: { options: { outputMode: 'server' } } },
        },
      },
    });

    const { drifts } = diagnose(cwd, POLICY);

    expect(drifts.filter((drift) => drift.tier === 'prune')).toHaveLength(0);
  });

  it('reports a range that sits below the policy floor', () => {
    write('package.json', { name: 'ws', devDependencies: { vitest: '^4.0.8' } });

    const { drifts } = diagnose(cwd, POLICY);

    expect(drifts).toContainEqual(
      expect.objectContaining({
        tier: 'floor',
        actual: 'vitest@^4.0.8',
        expected: 'vitest@^4.1.11',
      }),
    );
  });

  it('finds no drift in a workspace that already matches', () => {
    write('package.json', {
      name: 'ws',
      devDependencies: { vitest: '^4.1.11' },
      allowScripts: { esbuild: true },
    });

    expect(diagnose(cwd, POLICY).drifts).toHaveLength(0);
  });
});

describe('applyFix', () => {
  it('writes the policy blocks and leaves everything else alone', () => {
    write('package.json', {
      name: 'ws',
      version: '1.2.3',
      scripts: { start: 'ng serve' },
      dependencies: { express: '^5.1.0', rxjs: '~7.8.0' },
      devDependencies: { vitest: '^4.0.8' },
    });

    applyFix(diagnose(cwd, POLICY));
    const manifest = readManifest();

    // Policy-owned blocks are updated…
    expect(manifest['dependencies']).toEqual({ rxjs: '~7.8.0' });
    expect(manifest['devDependencies']).toEqual({ vitest: '^4.1.11' });
    expect(manifest['allowScripts']).toEqual({ esbuild: true });

    // …and the user's own fields are untouched.
    expect(manifest['version']).toBe('1.2.3');
    expect(manifest['scripts']).toEqual({ start: 'ng serve' });
  });

  it('is idempotent — a second run finds nothing to do', () => {
    write('package.json', { name: 'ws', devDependencies: { vitest: '^4.0.8' } });

    applyFix(diagnose(cwd, POLICY));
    expect(diagnose(cwd, POLICY).drifts).toHaveLength(0);
  });
});
