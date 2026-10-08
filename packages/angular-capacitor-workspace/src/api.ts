import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { NodeWorkflow } from '@angular-devkit/schematics/tools';
import { resolveCatalog } from './catalog';
import { runGate, type GateResult, type Severity } from './gate';
import { collectDeprecations, type Deprecation } from './gate/deprecations';
import { formatDecisions } from './gate/report';
import { requestedFeatures, requestedPlugins } from './plugins/registry';
import { applyPolicy, type Manifest } from './policy/apply';
import { POLICY } from './policy/advisories';
import type { Policy, PolicyContext, PolicyDecision } from './policy/types';
import { ANGULAR_CLI_RANGE } from './policy/versions';
import { withSpinner, withSpinnerAsync } from './spinner';
import { heading, progress } from './style';

export type MobilePlatform = 'android' | 'ios';

export interface AppSpec {
  name: string;
  /** Capacitor platforms; an empty array means web-only. */
  mobile?: MobilePlatform[];
}

export interface MarketingSpec {
  name: string;
  /**
   * Production origin of this site, for its canonical URLs, sitemap and
   * robots.txt. Defaults to a placeholder the site's build warns about.
   */
  origin?: string;
}

export interface GenerateOptions {
  /** Absolute or relative path of the workspace to create. */
  directory: string;
  apps?: AppSpec[];
  /**
   * Prerendered marketing sites. Several are allowed, the way several apps
   * are: a product site and a docs site are one workspace's worth of pages
   * that share a design system, not two repositories.
   */
  marketing?: MarketingSpec[];
  /** Name of the design-system library, or `false` to skip it. */
  uiLib?: string | false;
  /** Selector prefix for the design-system components. Defaults to `uiLib`. */
  uiLibPrefix?: string;
  /**
   * Theme switching — a colour-scheme and palette toggle in every app's header,
   * remembered and applied before the first paint. On by default whenever there
   * is a design system; `false` leaves the apps following the system colour
   * scheme. Ignored without one.
   */
  theming?: boolean;
  codegen?: 'orval' | false;
  e2e?: 'playwright' | false;
  /**
   * Curated packages to wire in, by catalog id — `['cdk']`. See src/catalog.ts;
   * an id that is not in it fails during generation rather than installing
   * something nobody has resolved against the Angular line.
   */
  packages?: string[];
  /**
   * Locale tags to generate runtime translation for — `['en', 'fr', 'ar']`.
   * The first is the source locale unless `defaultLocale` says otherwise.
   * Requires a design system: the mechanism lives there.
   */
  i18n?: string[];
  /** Source locale, the fallback for an untranslated key. Defaults to `i18n[0]`. */
  defaultLocale?: string;
  auditLevel?: Severity;
  /** Run `npm install` after the gate passes. */
  install?: boolean;
  dryRun?: boolean;
  policy?: Policy;
  /**
   * Dependency spec for `angular-capacitor-workspace` in the generated
   * workspace. Defaults to the running version. The integration matrix points
   * this at a local tarball so it can test an unpublished build.
   */
  selfSpec?: string;
  /**
   * Dependency specs for the runtime packages the plugins install, by package
   * name — `{ '@angular-capacitor-workspace/i18n': 'file:…' }`. Each defaults
   * to `^` this version. For the same reason as `selfSpec`.
   */
  packageSpecs?: Readonly<Record<string, string>>;
  log?: (message: string) => void;
}

export interface GenerateResult {
  directory: string;
  /** Files the schematics created, relative to the workspace root. */
  files: string[];
  decisions: PolicyDecision[];
  gate?: GateResult;
  installed: boolean;
  /**
   * Deprecation warnings npm printed during the install.
   *
   * Reported, never gated on — see gate/deprecations.ts. Empty whenever nothing
   * was installed, which is not the same as nothing being deprecated.
   */
  deprecations: Deprecation[];
}

export class GenerateError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'GenerateError';
  }
}

/**
 * The feature token set the policy guards are evaluated against.
 *
 * Derived from the options rather than from the generated tree, because a guard
 * has to answer "is this package legitimate here" before the package is
 * installed. The builder half of a guard is checked against angular.json
 * separately, once there is one.
 *
 * The hosts' tokens are here; each plugin's come from its own definition in
 * `src/plugins/`, beside the `detect` that `doctor` reads them back with.
 */
export function featuresFor(options: GenerateOptions): Set<string> {
  const features = requestedFeatures(options);
  const apps = options.apps ?? [];

  if (apps.length > 0) features.add('app');
  if ((options.marketing ?? []).length > 0) features.add('marketing');
  if (options.uiLib) {
    features.add('ui-lib');
    // The ui library carries Storybook, whose required peers include the
    // devkit's core and architect packages.
    features.add('storybook');
  }
  if (options.e2e) features.add(`e2e:${options.e2e}`);

  for (const app of apps) {
    for (const platform of app.mobile ?? []) {
      features.add('mobile');
      features.add(`mobile:${platform}`);
    }
  }

  return features;
}

/**
 * Bootstraps an empty Angular workspace, overlays the delta, applies the
 * dependency policy, and runs the audit gate.
 *
 * The ordering is load-bearing. The policy runs after every schematic, so it
 * sees the final dependency set; the gate runs after the policy and before
 * `npm install`, so a workspace that would fail the gate is never installed —
 * but is still left on disk to inspect.
 */
export async function generateWorkspace(options: GenerateOptions): Promise<GenerateResult> {
  const log = options.log ?? (() => {});
  const requested = resolve(options.directory);
  const dryRun = options.dryRun ?? false;
  const policy = options.policy ?? POLICY;

  if (existsSync(requested) && !dryRun) {
    throw new GenerateError(`${requested} already exists. Choose another name or remove it first.`);
  }

  // Before the Angular bootstrap, not inside the schematic that consumes them:
  // an unknown id is a typo, and a typo should cost a line of output rather
  // than the minute `ng new` takes to fail after it.
  try {
    resolveCatalog(options.packages ?? []);
  } catch (error) {
    throw new GenerateError((error as Error).message);
  }

  // A dry run generates for real, into a scratch directory that is thrown away.
  //
  // The alternative — stopping after the Angular bootstrap and describing what
  // would happen next — reports a guess. Every interesting thing this generator
  // does is a patch applied to output Angular produced, so a preview that never
  // runs the patches cannot tell you whether they apply. Generation is seconds;
  // it is only `npm install` that is slow, and a dry run skips that anyway.
  const scratch = dryRun ? mkdtempSync(join(tmpdir(), 'acw-dry-run-')) : undefined;
  const directory = scratch ? join(scratch, basename(requested)) : requested;
  const name = basename(directory);
  const parent = dirname(directory);

  try {
    return await generate();
  } finally {
    if (scratch) {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async function generate(): Promise<GenerateResult> {
    // ── 1. Delegate the skeleton to Angular ─────────────────────────────────
    // Everything Angular owns stays Angular's. We never template a file the CLI
    // is willing to emit, which is what keeps this generator alive across minors.
    log(heading('Workspace'));
    const bootstrap = withSpinner(log, `Bootstrapping with @angular/cli${ANGULAR_CLI_RANGE}…`, () =>
      spawnSync(
        'npx',
        [
          '--yes',
          `@angular/cli@${ANGULAR_CLI_RANGE}`,
          'new',
          name,
          '--no-create-application',
          '--skip-install',
          '--skip-git',
          '--package-manager=npm',
        ],
        { cwd: parent, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32' },
      ),
    );

    if (bootstrap.status !== 0) {
      throw new GenerateError(
        'The Angular CLI could not create the workspace.',
        bootstrap.stderr || bootstrap.stdout,
      );
    }

    // ── 2. Overlay the delta ──────────────────────────────────────────────
    const files = await runOverlay(directory, options, log);

    // ── 3. Apply the dependency policy ────────────────────────────────────
    const { decisions, context } = applyPolicyToDisk(directory, options, policy);
    log(formatDecisions(decisions));

    // ── 4. Gate ───────────────────────────────────────────────────────────
    // Runs even on a dry run: "would this workspace be audit-clean" is the
    // question most worth answering before committing to the real thing, and
    // the lockfile resolve is the affordable half of the operation.
    const gate = runGate({
      cwd: directory,
      auditLevel: options.auditLevel ?? 'moderate',
      policy,
      context,
      log,
    });
    log(gate.report);

    if (dryRun) {
      // The full tree, not just what our schematics reported creating — the
      // Angular bootstrap's files are as much a part of "what would be written"
      // as the overlay's, and a count that silently excludes them is wrong in
      // the direction that matters.
      const everything = listFiles(directory);
      log(progress(`Dry run: ${everything.length} file(s) would be written to ${requested}.`));
      return {
        directory: requested,
        files: everything,
        decisions,
        gate,
        installed: false,
        deprecations: [],
      };
    }

    if (!gate.ok) {
      return { directory, files, decisions, gate, installed: false, deprecations: [] };
    }

    // ── 5. Install ────────────────────────────────────────────────────────
    let installed = false;
    let deprecations: Deprecation[] = [];
    if (options.install ?? true) {
      log(heading('Install'));
      const install = withSpinner(log, 'Installing dependencies…', () =>
        spawnSync('npm', ['install'], {
          cwd: directory,
          encoding: 'utf8',
          stdio: 'pipe',
          shell: process.platform === 'win32',
        }),
      );
      if (install.status !== 0) {
        throw new GenerateError(
          'Dependency installation failed after the gate passed.',
          install.stderr || install.stdout,
        );
      }
      installed = true;

      // The only moment this information exists. npm warns while it unpacks, so
      // a second install into the tree it just populated reports nothing, and
      // the output was until now read only when the install failed.
      deprecations = collectDeprecations(
        `${install.stdout ?? ''}\n${install.stderr ?? ''}`,
        JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Manifest,
      );
    }

    return { directory, files, decisions, gate, installed, deprecations };
  }
}

/** Every file under `root`, workspace-relative, excluding node_modules. */
function listFiles(root: string): string[] {
  const out: string[] = [];

  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(join(directory, entry.name), relative);
      } else {
        out.push(relative);
      }
    }
  };

  walk(root, '');
  return out.sort();
}

/** Runs our own schematics against a real directory via the Node workflow. */
async function runOverlay(
  directory: string,
  options: GenerateOptions,
  log: (message: string) => void,
): Promise<string[]> {
  const collection = join(__dirname, 'collection.json');
  const workflow = new NodeWorkflow(directory, {
    force: false,
    dryRun: false,
    resolvePaths: [__dirname, directory],
    schemaValidation: true,
    packageManager: 'npm',
  });

  const files: string[] = [];
  workflow.reporter.subscribe((event) => {
    if (event.kind === 'create') {
      files.push(event.path.replace(/^\//, ''));
    }
  });

  const apps = options.apps ?? [];
  const steps: Array<{ schematic: string; options: Record<string, unknown> }> = [
    {
      schematic: 'workspace',
      options: {
        e2e: options.e2e ?? false,
        uiLib: options.uiLib || undefined,
        mobile: apps.some((app) => (app.mobile ?? []).length > 0),
        selfSpec: options.selfSpec,
      },
    },
  ];

  if (options.uiLib) {
    steps.push({
      schematic: 'ui-lib',
      options: { name: options.uiLib, prefix: options.uiLibPrefix },
    });
  }

  for (const app of apps) {
    steps.push({
      schematic: 'app',
      options: { name: app.name, mobile: app.mobile ?? [], e2e: options.e2e ?? false },
    });
  }

  for (const site of options.marketing ?? []) {
    steps.push({
      schematic: 'marketing',
      options: {
        name: site.name,
        e2e: options.e2e ?? false,
        // Omitted rather than defaulted, so the placeholder lives in the
        // schema alone and a site without an origin is told apart from one
        // that was given the placeholder on purpose.
        ...(site.origin ? { origin: site.origin } : {}),
      },
    });
  }

  // Then the plugins, after every project they extend exists, in the
  // registry's order. See src/plugins/registry.ts.
  steps.push(...requestedPlugins(options));

  for (const step of steps) {
    await withSpinnerAsync(log, `Running ${step.schematic}…`, () =>
      workflow
        .execute({
          collection,
          schematic: step.schematic,
          options: step.options,
          allowPrivate: true,
          debug: false,
          logger: undefined as never,
        })
        .toPromise(),
    );
  }

  return files;
}

/**
 * Applies the policy to the manifest the schematics produced.
 *
 * Reads `angular.json` for the builder half of the guards — by this point the
 * workspace exists, so "which builders does this project actually use" has a
 * real answer rather than an assumption.
 */
function applyPolicyToDisk(
  directory: string,
  options: GenerateOptions,
  policy: Policy,
): { manifest: Manifest; decisions: PolicyDecision[]; context: PolicyContext } {
  const manifestPath = join(directory, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

  const builders = new Set<string>();
  const angularJsonPath = join(directory, 'angular.json');
  if (existsSync(angularJsonPath)) {
    const angularJson = JSON.parse(readFileSync(angularJsonPath, 'utf8')) as {
      projects?: Record<string, { architect?: Record<string, { builder?: string }> }>;
    };
    for (const project of Object.values(angularJson.projects ?? {})) {
      for (const target of Object.values(project.architect ?? {})) {
        if (target.builder) builders.add(target.builder);
      }
    }
  }

  const context: PolicyContext = { features: featuresFor(options), builders };
  const result = applyPolicy(manifest, context, policy);
  writeFileSync(manifestPath, `${JSON.stringify(result.manifest, null, 2)}\n`);
  return { manifest: result.manifest, decisions: result.decisions, context };
}
