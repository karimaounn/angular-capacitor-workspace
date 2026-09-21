#!/usr/bin/env node
/**
 * The daily advisory sweep.
 *
 * Generates each matrix row, resolves a lockfile and audits it — without
 * installing, which makes the whole sweep a few minutes rather than an hour.
 * Anything the policy does not account for is written out as a ready-to-file
 * issue containing the advisory, the dependency path and the proposed tier.
 *
 * This is what converts "I would have to patch the generator" from a thing
 * someone remembers into a thing they are told. A new advisory in a transitive
 * dependency of a generated workspace becomes a red build here, on the day it
 * lands, rather than a surprise in the next project somebody starts.
 *
 *   node e2e/sweep.mjs                       # report to stdout, exit 1 on findings
 *   node e2e/sweep.mjs --issue issue.md      # also write an issue body
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const createBin = join(repoRoot, 'packages/create-angular-capacitor-workspace/dist/index.js');
const cliBin = join(repoRoot, 'packages/angular-capacitor-workspace/dist/cli/index.js');

const ROWS = {
  minimal: ['--app', 'app'],
  full: [
    '--app',
    'shop',
    '--mobile',
    'android',
    '--marketing',
    'site',
    '--ui-lib',
    'ui',
    '--codegen',
    'orval',
    '--e2e',
    'playwright',
  ],
  'lib-only': ['--ui-lib', 'ui'],
};

const { values } = parseArgs({
  options: {
    issue: { type: 'string' },
    'audit-level': { type: 'string', default: 'moderate' },
  },
});

// See matrix.mjs: a generated workspace depends on this package, which does not
// exist on the registry until it is published.
const selfSpec = packSelf();
const findings = [];

for (const [name, args] of Object.entries(ROWS)) {
  process.stdout.write(`sweeping ${name} … `);
  const workdir = mkdtempSync(join(tmpdir(), `acw-sweep-${name}-`));
  const target = join(workdir, name);

  try {
    // --no-install: the gate runs on the lockfile, and unpacking node_modules
    // would add tens of minutes for information the lockfile already has.
    const generated = spawnSync(
      process.execPath,
      [
        createBin,
        target,
        ...args,
        '--self-spec',
        selfSpec,
        '--no-install',
        '--audit-level',
        values['audit-level'],
      ],
      { cwd: workdir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    if (generated.status === 0) {
      console.log('clean');
      continue;
    }

    // Re-run the gate in JSON so the report is structured rather than scraped.
    const audited = spawnSync(
      process.execPath,
      [cliBin, 'audit', '--json', '--cwd', target, '--audit-level', values['audit-level']],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );

    let report;
    try {
      report = JSON.parse(audited.stdout);
    } catch {
      report = undefined;
    }

    // A non-zero exit with no advisories is a generation failure, not an
    // advisory — an unsatisfiable peer range, a renamed Angular option, a
    // registry outage. Reporting it as "0 unhandled advisories" would file an
    // empty issue every morning and train everyone to ignore the sweep.
    if (!report || report.unhandled.length === 0) {
      console.log('FAILED (generation error, not an advisory)');
      findings.push({
        row: name,
        generationFailed: true,
        output: tail(`${generated.stdout}${generated.stderr}`, 40),
      });
      continue;
    }

    console.log(`${report.unhandled.length} unhandled`);
    findings.push({ row: name, unhandled: report.unhandled });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

if (findings.length === 0) {
  console.log('\nEvery row is clean against the current policy.');
  process.exit(0);
}

const body = renderIssue(findings);
console.log(`\n${body}`);
if (values.issue) {
  writeFileSync(values.issue, body);
}
process.exit(1);

function renderIssue(findings) {
  const lines = [
    '## Advisory sweep failed',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} against the live registry.`,
    '',
  ];

  for (const finding of findings) {
    lines.push(`### Row: \`${finding.row}\``, '');

    if (finding.generationFailed) {
      lines.push(
        'Generation itself failed — this is not an advisory. Usually an ERESOLVE',
        'from an upstream peer range moving.',
        '',
        '```',
        finding.output,
        '```',
        '',
      );
      continue;
    }

    for (const advisory of finding.unhandled) {
      lines.push(
        `#### ${advisory.severity.toUpperCase()} — ${advisory.id}`,
        '',
        `**${advisory.title}**`,
        '',
        `- package: \`${advisory.package}\``,
        `- vulnerable: \`${advisory.range}\``,
        `- advisory: ${advisory.url}`,
        ...advisory.paths.slice(0, 3).map((path) => `- path: \`${path.join(' → ')}\``),
        '',
        `Proposed remedy — **tier ${advisory.proposal.tier}**: ${advisory.proposal.rationale}`,
        '',
        '```ts',
        advisory.proposal.snippet,
        '```',
        '',
      );
    }
  }

  lines.push(
    '---',
    '',
    'Add the entries above to `src/policy/advisories.ts`, verify with',
    '`npm run sweep`, and cut a release. Existing workspaces pick the remedy up',
    'with `npx angular-capacitor-workspace doctor --fix`.',
  );

  return lines.join('\n');
}

function tail(text, lines) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/** `npm pack` the schematics package and return a `file:` spec for the tarball. */
function packSelf() {
  const packDir = mkdtempSync(join(tmpdir(), 'acw-sweep-pack-'));
  const result = spawnSync('npm', ['pack', '--pack-destination', packDir, '--json'], {
    cwd: join(repoRoot, 'packages/angular-capacitor-workspace'),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error(`npm pack failed:\n${result.stderr}`);
    process.exit(2);
  }

  const [{ filename }] = JSON.parse(result.stdout);
  return `file:${join(packDir, filename)}`;
}
