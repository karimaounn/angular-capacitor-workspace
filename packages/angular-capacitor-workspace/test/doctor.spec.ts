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
  retired: [{ spec: { 'old-parent': { child: '^2.0.0' } }, lastShipped: '22.0.0', reason: 'test' }],
  allowScripts: { esbuild: true },
};

/** A lockfile listing these packages, at whatever depth the path gives. */
function writeLockfile(...paths: string[]): void {
  write('package-lock.json', {
    lockfileVersion: 3,
    packages: Object.fromEntries([['', { name: 'ws' }], ...paths.map((path) => [path, {}])]),
  });
}

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

  it('detects a Capacitor shell beside the web app, where the generator puts it', () => {
    // The root manifest declares no Capacitor package: they belong to the
    // shell, which is a workspace member of its own.
    write('angular.json', {
      projects: { shop: { projectType: 'application', root: 'projects/shop/web' } },
    });
    writeText('projects/shop/mobile/capacitor.config.ts', 'export default {};\n');

    expect(inferFeatures(cwd, {})).toContain('mobile');
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

  it('detects runtime translation from the design system, where the i18n schematic puts it', () => {
    // `featuresFor` sets `i18n` at generation. Without this, a rule guarded on
    // it would apply when the workspace is generated and be ignored by doctor.
    write('angular.json', {
      projects: { ui: { projectType: 'library', root: 'projects/ui' } },
    });
    expect(inferFeatures(cwd, {})).not.toContain('i18n');

    writeText(
      'projects/ui/src/lib/i18n/i18n.tokens.ts',
      "export const LOCALES = ['en'] as const;\n",
    );
    expect(inferFeatures(cwd, {})).toContain('i18n');
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

  it('reports and fixes an override the policy has since raised', () => {
    write('package.json', {
      name: 'ws',
      devDependencies: { storybook: '^10.6.0' },
      overrides: { sockjs: { uuid: '^8.3.2' } },
    });

    const diagnosis = diagnose(cwd, POLICY);
    expect(diagnosis.drifts).toContainEqual(
      expect.objectContaining({ tier: 'override', kind: 'stale' }),
    );

    applyFix(diagnosis);
    expect(readManifest()['overrides']).toEqual({ sockjs: { uuid: '^11.1.1' } });
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

describe('diagnose — overrides that pin nothing', () => {
  const retired = { 'old-parent': { child: '^2.0.0' } };
  const overrideDrifts = () => diagnose(cwd, POLICY).drifts.filter((d) => d.tier === 'override');

  it('removes a retired override whose parent has left the lockfile', () => {
    write('package.json', { name: 'ws', overrides: { ...retired, mine: { x: '^1.0.0' } } });
    writeLockfile('node_modules/mine');

    const diagnosis = diagnose(cwd, POLICY);
    expect(diagnosis.drifts).toContainEqual(
      expect.objectContaining({ tier: 'override', kind: 'unnecessary', expected: '(removed)' }),
    );

    applyFix(diagnosis);
    // The user's own override is not the generator's to judge.
    expect(readManifest()['overrides']).toEqual({ mine: { x: '^1.0.0' } });
  });

  it('keeps it while any copy of the parent is in the lockfile', () => {
    // Nested, not hoisted: node_modules alone would miss it.
    write('package.json', { name: 'ws', overrides: retired });
    writeLockfile('node_modules/a/node_modules/old-parent');

    expect(overrideDrifts()).toHaveLength(0);
  });

  it('keeps one that differs from what was released', () => {
    write('package.json', { name: 'ws', overrides: { 'old-parent': { child: '^3.0.0' } } });
    writeLockfile();

    expect(overrideDrifts()).toHaveLength(0);
  });

  it('decides nothing without a lockfile', () => {
    write('package.json', { name: 'ws', overrides: retired });

    expect(overrideDrifts()).toHaveLength(0);
  });

  it('removes a live override whose scope the workspace has left', () => {
    // The sockjs rule is onlyWhen storybook, and this workspace has none.
    write('package.json', { name: 'ws', overrides: { sockjs: { uuid: '^11.1.1' } } });
    writeLockfile();

    applyFix(diagnose(cwd, POLICY));
    expect(readManifest()['overrides']).toBeUndefined();
  });

  it('keeps a live override while its scope holds, parent or not', () => {
    write('package.json', {
      name: 'ws',
      devDependencies: { storybook: '^10.6.0' },
      overrides: { sockjs: { uuid: '^11.1.1' } },
    });
    writeLockfile();

    expect(overrideDrifts()).toHaveLength(0);
  });
});

describe('diagnose — allowlist entries nothing needs', () => {
  const allowDrifts = () =>
    diagnose(cwd, POLICY).drifts.filter((drift) => drift.tier === 'allowScripts');

  it('removes an entry the workspace added for a package that has left the lockfile', () => {
    write('package.json', { name: 'ws', allowScripts: { esbuild: true, 'left-pad': true } });
    writeLockfile('node_modules/esbuild');

    const diagnosis = diagnose(cwd, POLICY);
    expect(diagnosis.drifts).toContainEqual(
      expect.objectContaining({ tier: 'allowScripts', kind: 'unnecessary' }),
    );

    // Reported and then applied: a drift `--fix` says it fixed and the next
    // run still reports is a doctor nobody believes.
    applyFix(diagnosis);
    expect(readManifest()['allowScripts']).toEqual({ esbuild: true });
    expect(allowDrifts()).toHaveLength(0);
  });

  it('never flags an entry the policy owns, which it writes whatever the tree holds', () => {
    // Flagging it would be a removal the next run puts straight back.
    write('package.json', { name: 'ws', allowScripts: { esbuild: true } });
    writeLockfile();

    expect(allowDrifts()).toHaveLength(0);
  });

  it('counts a nested copy as in the tree', () => {
    write('package.json', { name: 'ws', allowScripts: { esbuild: true, 'left-pad': true } });
    writeLockfile('node_modules/a/node_modules/left-pad');

    expect(allowDrifts()).toHaveLength(0);
  });

  it('decides nothing without a lockfile', () => {
    write('package.json', { name: 'ws', allowScripts: { esbuild: true, 'left-pad': true } });

    expect(allowDrifts()).toHaveLength(0);
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
