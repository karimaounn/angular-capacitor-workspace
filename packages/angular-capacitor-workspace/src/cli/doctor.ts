import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOG, packageFeature } from '../catalog';
import { POLICY } from '../policy/advisories';
import { applyPolicy, type Manifest } from '../policy/apply';
import type { Policy, PolicyContext, Tier } from '../policy/types';
import { bold, cyan, dim, green, MARK, red, yellow } from '../style';

export interface Drift {
  tier: Tier | 'allowScripts';
  kind: 'missing' | 'stale' | 'unnecessary';
  /** What the workspace has now, rendered for display. */
  actual: string;
  /** What the current policy wants. */
  expected: string;
  description: string;
}

export interface Diagnosis {
  cwd: string;
  /** Feature tokens inferred from the workspace, not from a saved answer file. */
  features: string[];
  drifts: Drift[];
  /** The manifest the current policy would produce. */
  desired: Manifest;
}

/**
 * Infers the feature set from what is actually in the workspace.
 *
 * Deliberately not read from a stashed answers file. A workspace is two years
 * old by the time `doctor` matters, and by then the file records what someone
 * once asked for rather than what the project became — a Storybook that was
 * removed, a mobile target that was added by hand. The tree is the truth.
 */
export function inferFeatures(cwd: string, manifest: Manifest): Set<string> {
  const features = new Set<string>();
  const deps = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
  };

  if ('storybook' in deps || '@storybook/angular' in deps) {
    features.add('storybook');
    features.add('ui-lib');
  }
  if ('orval' in deps) features.add('codegen');
  if ('@playwright/test' in deps) features.add('e2e:playwright');

  // `ssr:server` is deliberately NOT inferred from express being installed.
  // That would be circular: the guard exists to decide whether express should
  // be pruned, so taking express's presence as evidence that it is needed means
  // it can never be pruned. The build configuration is the independent witness.

  // Same principle as ssr:server: the dependency entry cannot be the evidence,
  // because the guard exists to decide whether that entry should stay. An
  // `@angular/animations` import in the workspace's own source is the
  // independent witness. A mention in a comment counts as use and keeps the
  // package — the false positive errs towards leaving a build working.
  if (importsAnimations(cwd)) features.add('animations');

  // Catalog packages, read straight from the manifest. That is circular for a
  // guard whose job is to decide whether a package should be there — see
  // animations above — and it is not circular here: nothing prunes a package
  // the user asked for by name. The token exists so a remedy can be scoped to
  // the workspaces that carry it, and the entry is the only evidence there is.
  for (const entry of CATALOG) {
    if (entry.packages.some((pkg) => pkg.name in deps)) {
      features.add(packageFeature(entry.id));
    }
  }

  if ('@capacitor/cli' in deps || '@capacitor/core' in deps) features.add('mobile');
  if ('@capacitor/android' in deps) features.add('mobile:android');
  if ('@capacitor/ios' in deps) features.add('mobile:ios');

  const angularJson = readJsonIfPresent(join(cwd, 'angular.json')) as
    { projects?: Record<string, AngularProjectShape> } | undefined;

  for (const [projectName, project] of Object.entries(angularJson?.projects ?? {})) {
    if (project.projectType === 'library') features.add('ui-lib');
    if (project.projectType === 'application') features.add('app');

    const build = project.architect?.['build'];
    const outputMode = build?.options?.['outputMode'];
    if (outputMode === 'static') features.add('marketing');

    // A Node request handler, not merely server-side rendering. A static
    // marketing app keeps `options.server` (main.server.ts) because
    // prerendering runs the app on the server to produce HTML — but it has no
    // running server, and so no use for express. `outputMode: server` or an
    // `ssr` entry is what distinguishes the two.
    if (outputMode === 'server' || build?.options?.['ssr'] !== undefined) {
      features.add('ssr:server');
    }

    // A Capacitor sibling is the other reliable mobile tell, for a workspace
    // where the deps were hoisted into the member package rather than the root.
    const root = project.root ?? '';
    if (root && existsSync(join(cwd, root, 'mobile', 'capacitor.config.ts'))) {
      features.add('mobile');
    }
    void projectName;
  }

  return features;
}

/**
 * Where a workspace's own TypeScript lives. Bounded deliberately: walking from
 * the root would walk node_modules, where half of Angular mentions
 * @angular/animations and every scan would come back positive.
 */
const SOURCE_ROOTS = ['src', 'projects', 'apps', 'libs'];

/** True when the workspace's own source imports `@angular/animations`. */
function importsAnimations(cwd: string): boolean {
  return SOURCE_ROOTS.some((root) => scanForAnimations(join(cwd, root)));
}

function scanForAnimations(dir: string): boolean {
  if (!existsSync(dir)) return false;

  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) {
        continue;
      }
      if (scanForAnimations(path)) return true;
      continue;
    }

    if (!entry.name.endsWith('.ts')) continue;
    try {
      if (readFileSync(path, 'utf8').includes('@angular/animations')) return true;
    } catch {
      // An unreadable file is not evidence either way; keep looking.
    }
  }

  return false;
}

interface AngularProjectShape {
  projectType?: string;
  root?: string;
  architect?: Record<string, { builder?: string; options?: Record<string, unknown> }>;
}

function readJsonIfPresent(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

function collectBuilders(cwd: string): Set<string> {
  const builders = new Set<string>();
  const angularJson = readJsonIfPresent(join(cwd, 'angular.json')) as
    { projects?: Record<string, AngularProjectShape> } | undefined;
  for (const project of Object.values(angularJson?.projects ?? {})) {
    for (const target of Object.values(project.architect ?? {})) {
      if (target.builder) builders.add(target.builder);
    }
  }
  return builders;
}

/**
 * Diffs a workspace against the installed policy.
 *
 * The comparison is made by running the policy over the workspace's own
 * manifest and diffing the result, rather than by reimplementing each rule as a
 * check. One code path decides what the policy means, so `doctor --fix` and
 * generation cannot drift apart.
 */
export function diagnose(cwd: string, policy: Policy = POLICY): Diagnosis {
  const manifestPath = join(cwd, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`No package.json in ${cwd}. Run this from a workspace root.`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const features = inferFeatures(cwd, manifest);
  const ctx: PolicyContext = { features, builders: collectBuilders(cwd) };
  const { manifest: desired } = applyPolicy(manifest, ctx, policy);

  const drifts: Drift[] = [];

  // Pruned packages that came back, or were never removed.
  for (const block of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    for (const name of Object.keys(manifest[block] ?? {})) {
      if (desired[block]?.[name] === undefined) {
        drifts.push({
          tier: 'prune',
          kind: 'unnecessary',
          actual: `${block}.${name}`,
          expected: '(removed)',
          description:
            `${name} is a ${block} entry the policy prunes for this feature set. ` +
            `Nothing here loads it.`,
        });
      }
    }
  }

  // Floors that are not met.
  for (const block of ['dependencies', 'devDependencies'] as const) {
    for (const [name, range] of Object.entries(desired[block] ?? {})) {
      const current = manifest[block]?.[name];
      if (current !== undefined && current !== range) {
        drifts.push({
          tier: 'floor',
          kind: 'stale',
          actual: `${name}@${current}`,
          expected: `${name}@${range}`,
          description: `${name} sits below the policy floor.`,
        });
      }
    }
  }

  // Overrides that are missing or stale.
  for (const [name, spec] of Object.entries(desired.overrides ?? {})) {
    const current = manifest.overrides?.[name];
    const expected = JSON.stringify(spec);
    if (current === undefined) {
      drifts.push({
        tier: 'override',
        kind: 'missing',
        actual: '(none)',
        expected: `overrides.${name} = ${expected}`,
        description: `The policy pins a transitive dependency under ${name}.`,
      });
    } else if (JSON.stringify(current) !== expected) {
      drifts.push({
        tier: 'override',
        kind: 'stale',
        actual: `overrides.${name} = ${JSON.stringify(current)}`,
        expected: `overrides.${name} = ${expected}`,
        description: `The override under ${name} no longer matches the policy.`,
      });
    }
  }

  // allowScripts entries the policy has added since this workspace was made.
  for (const [name, allowed] of Object.entries(desired.allowScripts ?? {})) {
    if (manifest.allowScripts?.[name] !== allowed) {
      drifts.push({
        tier: 'allowScripts',
        kind: 'missing',
        actual:
          manifest.allowScripts?.[name] === undefined
            ? '(absent)'
            : String(manifest.allowScripts[name]),
        expected: String(allowed),
        description: `${name} needs an install script and is not yet allowlisted.`,
      });
    }
  }

  // Allowlist entries that are no longer needed: nothing in the tree provides
  // them any more, so the exemption is pure attack surface.
  const installed = installedPackages(cwd);
  if (installed !== undefined) {
    for (const name of Object.keys(manifest.allowScripts ?? {})) {
      if (!installed.has(name)) {
        drifts.push({
          tier: 'allowScripts',
          kind: 'unnecessary',
          actual: `allowScripts.${name}`,
          expected: '(removed)',
          description:
            `${name} is allowlisted to run install scripts but is not in the ` +
            `dependency tree. An unused exemption is surface for nothing.`,
        });
      }
    }
  }

  return { cwd, features: [...features].sort(), drifts, desired };
}

/** Package names present in node_modules, or `undefined` when not installed. */
function installedPackages(cwd: string): Set<string> | undefined {
  const modules = join(cwd, 'node_modules');
  if (!existsSync(modules)) return undefined;

  const names = new Set<string>();
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      for (const scoped of readdirSync(join(modules, entry.name), { withFileTypes: true })) {
        if (scoped.isDirectory()) names.add(`${entry.name}/${scoped.name}`);
      }
    } else if (!entry.name.startsWith('.')) {
      names.add(entry.name);
    }
  }
  return names;
}

/**
 * Writes the policy's view of the manifest back to disk.
 *
 * Only the blocks the policy owns are replaced; everything else in the file is
 * left exactly as the user wrote it.
 */
export function applyFix(diagnosis: Diagnosis): void {
  const manifestPath = join(diagnosis.cwd, 'package.json');
  const current = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  for (const block of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'overrides',
    'allowScripts',
  ] as const) {
    const value = diagnosis.desired[block];
    if (value === undefined) {
      delete current[block];
    } else {
      current[block] = value as never;
    }
  }

  writeFileSync(manifestPath, `${JSON.stringify(current, null, 2)}\n`);
}

export function formatDiagnosis(diagnosis: Diagnosis): string {
  const lines = [
    `${dim('Workspace')}  ${diagnosis.cwd}`,
    `${dim('Features')}   ${diagnosis.features.map((f) => cyan(f)).join(dim(', ')) || dim('(none detected)')}`,
    '',
  ];

  if (diagnosis.drifts.length === 0) {
    lines.push(
      `${MARK.ok} ${green('No drift.')} ${dim('This workspace matches the installed policy.')}`,
    );
    return lines.join('\n');
  }

  lines.push(
    `${MARK.warn} ${bold(`${diagnosis.drifts.length} difference(s)`)} from the installed policy`,
    '',
  );
  for (const drift of diagnosis.drifts) {
    lines.push(`  ${yellow(`[${drift.tier}/${drift.kind}]`)} ${drift.description}`);
    lines.push(`      ${dim('now ')} ${red(drift.actual)}`);
    lines.push(`      ${dim('want')} ${green(drift.expected)}`);
    lines.push('');
  }
  lines.push(dim('Run with --fix to apply, then `npm install` to re-resolve the lockfile.'));
  return lines.join('\n');
}
