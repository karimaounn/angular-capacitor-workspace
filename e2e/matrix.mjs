#!/usr/bin/env node
/**
 * The load-bearing test: generate → install → build → test → audit, in a temp
 * directory, against the real registry.
 *
 * Unit tests over the policy module and the JSON patches are cheap and worth
 * having, but they cannot catch what actually breaks this package. What breaks
 * it is upstream: Angular renaming an option, Storybook changing a peer range,
 * a new advisory landing in a transitive dependency. None of that is visible
 * from an in-memory tree, and all of it is visible here.
 *
 *   node e2e/matrix.mjs                 # every row
 *   node e2e/matrix.mjs --row minimal   # one row
 *   node e2e/matrix.mjs --keep          # leave the workspaces on disk
 *   node e2e/matrix.mjs --json report.json
 *   node e2e/matrix.mjs --deprecations         # also fail on unexpected deprecations
 *   node e2e/matrix.mjs --deprecations --deprecation-json out.json
 *
 * Deprecations are collected and printed on every run, and gate nothing unless
 * --deprecations is passed. That flag belongs to the nightly workflow and not to
 * the per-PR row: a deprecation arrives on the registry's clock, so gating a
 * pull request on one turns an upstream publication into somebody's red build on
 * a morning they touched nothing. See e2e/deprecations.mjs.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { classify, summarise } from './deprecations.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const createBin = join(repoRoot, 'packages/create-angular-capacitor-workspace/dist/index.js');

/**
 * The matrix.
 *
 * Each row exists because it exercises a policy path the others do not:
 * `minimal` proves the baseline is clean without any of our remedies;
 * `full` is the only row where Storybook forces the devkit peer, Capacitor
 * drags in xcode and orval drags in undici — three different rungs of the
 * ladder at once, and the only row that runs the e2e suites, including the
 * marketing site's AXE crawl. It also carries `--with cdk`, which is where a
 * catalog range meets the real resolver: a CDK the registry does not have at
 * the Angular line fails the install here rather than in someone's project;
 * `multi-app` proves per-app ports and script naming survive more than one
 * app, and that a site generated without an origin still builds; `lib-only`
 * proves the library stands alone, which is what `ng add` into an existing
 * workspace produces.
 */
const ROWS = {
  minimal: {
    args: ['--app', 'app'],
    checks: ['build', 'test'],
  },
  full: {
    args: [
      '--app',
      'shop',
      '--mobile',
      'android',
      '--marketing',
      'site',
      '--marketing-origin',
      'https://site.example',
      '--ui-lib',
      'ui',
      '--codegen',
      'orval',
      '--e2e',
      'playwright',
      '--with',
      'cdk',
    ],
    checks: [
      'build:libs',
      'contrast',
      'codegen',
      'build',
      'build:marketing',
      'test',
      'storybook',
      'e2e',
    ],
  },
  'multi-app': {
    args: [
      '--app',
      'shop',
      '--mobile',
      'android,ios',
      '--app',
      'admin',
      '--marketing',
      'site',
      '--ui-lib',
      'ui',
      '--e2e',
      'playwright',
    ],
    checks: ['build:libs', 'ports', 'build'],
  },
  'lib-only': {
    args: ['--ui-lib', 'ui'],
    checks: ['build:libs', 'contrast', 'test'],
  },
};

const { values } = parseArgs({
  options: {
    row: { type: 'string', multiple: true },
    keep: { type: 'boolean', default: false },
    json: { type: 'string' },
    'skip-install': { type: 'boolean', default: false },
    deprecations: { type: 'boolean', default: false },
    'deprecation-json': { type: 'string' },
  },
});

const selected = values.row?.length ? values.row : Object.keys(ROWS);

// A generated workspace depends on `angular-capacitor-workspace` so that
// `audit:policy`, `doctor` and `ng generate` keep working after generation.
// Before publication that version does not exist on the registry, so the matrix
// packs the local build and points the generated workspace at the tarball. This
// is the difference between testing what ships and testing something adjacent
// to it.
const selfSpec = packSelf();
const results = [];

for (const rowName of selected) {
  const row = ROWS[rowName];
  if (!row) {
    console.error(`Unknown row "${rowName}". Known: ${Object.keys(ROWS).join(', ')}.`);
    process.exit(2);
  }
  results.push(runRow(rowName, row));
}

if (values.json) {
  writeFileSync(values.json, `${JSON.stringify(results, null, 2)}\n`);
}

console.log('\n' + '='.repeat(70));
for (const result of results) {
  const mark = result.ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${result.row.padEnd(12)} ${result.steps.map((s) => s.name).join(' → ')}`);
  for (const step of result.steps.filter((s) => !s.ok)) {
    console.log(`      ${step.name}: ${step.summary}`);
  }
}

const failed = results.filter((result) => !result.ok);
console.log('='.repeat(70));
console.log(`${results.length - failed.length}/${results.length} rows passed.`);

// Not short-circuited on a failed row: a build that broke for its own reasons
// still installed, and the deprecation report it produced is still worth filing.
const deprecationsClean = reportDeprecations();
process.exit(failed.length === 0 && deprecationsClean ? 0 : 1);

/**
 * The deprecation rule, run only under --deprecations.
 *
 * Returns true when the run is clean by this rule. Every row still collects and
 * prints its deprecations without the flag; what the flag adds is the part that
 * can turn a build red, and that belongs to the nightly workflow alone.
 */
function reportDeprecations() {
  if (!values.deprecations) return true;

  // An empty result means "npm unpacked nothing", not "nothing is deprecated" —
  // npm warns while it reifies and says nothing about a tree already on disk. A
  // check that passes because it looked at an install that never happened is
  // worse than no check, so this is a hard error rather than a green tick.
  const installed = results.filter((result) => result.installed);
  if (installed.length === 0) {
    console.error(
      '\n--deprecations was passed but no row installed anything, so nothing was ' +
        'checked. Drop --skip-install.',
    );
    process.exit(2);
  }

  // Written whatever the verdict. Whether a waiver has gone stale is not
  // answerable from one invocation — each CI row runs in its own process, and
  // `--row minimal` carries no Storybook, so a waiver missing there means
  // nothing at all. e2e/deprecation-issue.mjs merges these and decides.
  if (values['deprecation-json']) {
    writeFileSync(
      values['deprecation-json'],
      `${JSON.stringify(
        {
          selected,
          allRows: Object.keys(ROWS),
          rows: installed.map(({ row, deprecations, direct }) => ({ row, deprecations, direct })),
        },
        null,
        2,
      )}\n`,
    );
  }

  const findings = results.flatMap((result) => result.deprecations.findings);
  if (findings.length === 0) {
    console.log('No unexpected deprecations.');
    return true;
  }

  console.log(`${findings.length} unexpected deprecation(s).`);
  return false;
}

/**
 * The dependency names the generated manifest declares.
 *
 * Recorded so the merge can tell a waiver whose package has left the tree from
 * one whose package is still there and merely stopped warning — the two are
 * indistinguishable in an install log and mean opposite things. See
 * `staleWaivers` in e2e/deprecations.mjs.
 *
 * Read off disk rather than inferred from the warnings, because the whole point
 * is to still be true when there are no warnings.
 */
function directDependencies(directory) {
  const manifest = join(directory, 'package.json');
  if (!existsSync(manifest)) return [];

  const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
  return [
    ...new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.devDependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]),
  ].sort();
}

/** `npm pack` the schematics package and return a `file:` spec for the tarball. */
function packSelf() {
  const packDir = mkdtempSync(join(tmpdir(), 'acw-pack-'));
  const pkgDir = join(repoRoot, 'packages/angular-capacitor-workspace');

  const result = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], {
    cwd: pkgDir,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error(`npm pack failed:\n${result.stderr}`);
    process.exit(2);
  }

  const [{ filename }] = JSON.parse(result.stdout);
  console.log(`packed ${filename}`);
  return `file:${join(packDir, filename)}`;
}

function runRow(name, row) {
  const workdir = mkdtempSync(join(tmpdir(), `acw-${name}-`));
  const target = join(workdir, name);
  const steps = [];
  console.log(`\n${'─'.repeat(70)}\n${name}\n${'─'.repeat(70)}`);

  // npm prints `npm warn deprecated` only while it unpacks a tree, so the install
  // inside this step is the one moment the information exists. The generator
  // writes it to --report rather than us scraping the prose it prints, which is
  // written for a person and free to change.
  const reportPath = join(workdir, 'run-report.json');

  try {
    // Generation runs the audit gate itself and exits non-zero if it fails, so
    // a clean exit here already means "audit-clean".
    steps.push(
      step('generate', () =>
        run(
          process.execPath,
          [
            createBin,
            target,
            ...row.args,
            '--self-spec',
            selfSpec,
            '--report',
            reportPath,
            ...(values['skip-install'] ? ['--no-install'] : []),
          ],
          workdir,
        ),
      ),
    );

    const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : {};
    const deprecations = classify(report.deprecations ?? []);
    const direct = directDependencies(report.directory ?? target);
    if (report.installed) {
      console.log(`  deprecations … ${summarise(deprecations)}`);
      for (const finding of deprecations.findings) {
        console.log(`      unexpected: ${finding.package}@${finding.version}`);
      }
    }

    if (steps[0].ok && !values['skip-install']) {
      for (const check of row.checks) {
        steps.push(step(check, () => runCheck(check, target)));
        if (!steps.at(-1).ok) break;
      }
    }

    const ok = steps.every((s) => s.ok);
    return {
      row: name,
      ok,
      directory: ok && !values.keep ? undefined : target,
      steps,
      installed: Boolean(report.installed),
      deprecations,
      direct,
    };
  } finally {
    if (!values.keep && steps.every((s) => s.ok)) {
      rmSync(workdir, { recursive: true, force: true });
    } else if (!values.keep) {
      console.log(`  (kept for inspection: ${target})`);
    }
  }
}

function runCheck(check, cwd) {
  switch (check) {
    case 'build':
      return run('npm', ['run', 'build'], cwd);
    case 'build:libs':
      return run('npm', ['run', 'build:libs'], cwd);
    case 'build:marketing':
      // Through npm, not `ng build`, so postbuild:site runs: the sitemap and the
      // prerender checks are part of what a marketing build is.
      return run('npm', ['run', 'build:site'], cwd, () => assertPrerendered(cwd));
    case 'test':
      return run('npm', ['test'], cwd);
    case 'contrast':
      return run('npm', ['run', 'check:contrast'], cwd);
    case 'storybook':
      return run('npm', ['run', 'test:storybook'], cwd);
    case 'e2e':
      // Type-checks each suite's specs, then runs them against the dev servers.
      return run('npm', ['run', 'e2e'], cwd);
    case 'codegen':
      // Generates a client from the fixture spec, then type-checks it as part
      // of the `build` step that follows. Milestone 6 is only done when the
      // generated code *compiles*, which running orval alone does not show.
      return run('npm', ['run', 'codegen'], cwd, () => assertClientGenerated(cwd), {
        OPENAPI_SPEC: join(repoRoot, 'e2e/fixtures/sample-openapi.yaml'),
      });
    case 'ports': {
      const problem = assertDistinctPorts(cwd);
      return { status: problem ? 1 : 0, output: problem ?? '', assertion: problem };
    }
    default:
      throw new Error(`Unknown check "${check}".`);
  }
}

/**
 * A static marketing build must emit prerendered HTML and no Node server.
 * Checking the exit code alone would pass a build that silently reverted to
 * `outputMode: "server"` — or one whose postbuild step never ran.
 */
function assertPrerendered(cwd) {
  const browser = join(cwd, 'dist/site/browser');
  if (!existsSync(join(browser, 'index.html'))) return 'no prerendered index.html';
  if (!existsSync(join(browser, '404/index.html'))) return 'no prerendered 404 page';
  if (!existsSync(join(browser, 'sitemap.xml')))
    return 'no sitemap.xml — postbuild:site did not run';
  if (existsSync(join(cwd, 'dist/site/server')))
    return 'a server bundle was emitted for a static site';
  return undefined;
}

/** orval must have written a client the build can then compile. */
function assertClientGenerated(cwd) {
  const generated = join(cwd, 'projects/shop/web/src/api/generated');
  if (!existsSync(generated)) {
    return 'codegen reported success but wrote no client';
  }
  return undefined;
}

/**
 * Every application has its own dev-server port in angular.json, and its
 * Playwright config serves it on that same port. Returns the problem, if any.
 */
function assertDistinctPorts(cwd) {
  const { projects } = JSON.parse(readFileSync(join(cwd, 'angular.json'), 'utf8'));
  const seen = new Map();

  for (const [name, project] of Object.entries(projects)) {
    if (project.projectType !== 'application') continue;
    const port = project.architect?.serve?.options?.port;
    if (typeof port !== 'number') return `${name} has no dev-server port in angular.json`;
    if (seen.has(port)) return `${name} and ${seen.get(port)} both use port ${port}`;
    seen.set(port, name);

    const config = join(cwd, project.root, 'playwright.config.ts');
    if (existsSync(config) && !readFileSync(config, 'utf8').includes(`port: ${port},`)) {
      return `${name}'s Playwright config does not serve it on port ${port}`;
    }
  }
  return undefined;
}

function step(name, fn) {
  process.stdout.write(`  ${name} … `);
  const started = Date.now();
  const result = fn();
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  const ok = result.status === 0 && !result.assertion;
  console.log(ok ? `ok (${seconds}s)` : `FAILED (${seconds}s)`);
  if (!ok) {
    console.log(indent(tail(result.output, 30), 6));
  }
  return {
    name,
    ok,
    seconds: Number(seconds),
    summary: result.assertion ?? firstError(result.output),
  };
}

function run(command, args, cwd, assert, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: '1', ...env },
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const assertion = result.status === 0 && assert ? assert() : undefined;
  return { status: result.status ?? 1, output, assertion };
}

function tail(text, lines) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

function indent(text, spaces) {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => pad + line)
    .join('\n');
}

function firstError(output) {
  const line = output.split('\n').find((candidate) => /error|failed|cannot find/i.test(candidate));
  return line?.trim().slice(0, 160) ?? 'see output above';
}
