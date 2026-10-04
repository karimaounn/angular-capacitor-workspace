#!/usr/bin/env node
/**
 * Merges the per-row deprecation reports into one issue body.
 *
 * It exists because the nightly runs each matrix row as its own job, in its own
 * process, so no single run of `matrix.mjs` ever sees the whole picture. Two
 * questions need it:
 *
 *   - whether a waiver in EXPECTED has gone stale. A waiver missing from
 *     `minimal` means nothing — that row carries no library and so forces no
 *     library's peers. Only the union across every row is evidence of absence.
 *   - whether to open one issue or four. Four jobs racing to file the same
 *     issue produce duplicates, and a tracker that duplicates is a tracker
 *     people mute.
 *
 *   node e2e/deprecation-issue.mjs reports/ --out issue.md
 *   node e2e/deprecation-issue.mjs reports/ --waivers waivers.json
 *
 * `--waivers` judges against a JSON array of entries in place of `EXPECTED`.
 * The list is empty today, and staleness is a property of the list, so this is
 * how the tests exercise it — and how to see what a proposed entry would do to
 * last night's reports before adding it.
 *
 * Exit codes are the interface: 0 clean, 1 there is an issue body to file, 2 the
 * run was too broken to judge. The workflow branches on the body existing rather
 * than on failure alone, so a 2 never files an issue about nothing.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { dormantWaivers, EXPECTED, renderIssue, staleWaivers } from './deprecations.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { out: { type: 'string' }, waivers: { type: 'string' } },
});

const directory = positionals[0];
if (!directory) {
  console.error(
    'Usage: node e2e/deprecation-issue.mjs <reports-dir> [--out issue.md] [--waivers waivers.json]',
  );
  process.exit(2);
}

const waivers = values.waivers ? JSON.parse(readFileSync(values.waivers, 'utf8')) : EXPECTED;

const reports = existsSync(directory)
  ? readdirSync(directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => JSON.parse(readFileSync(join(entry.parentPath, entry.name), 'utf8')))
  : [];

if (reports.length === 0) {
  // Distinct from "clean", and reported on a different exit code so the
  // workflow does not try to file an issue about it: no report means no row got
  // far enough to install, which is a broken nightly rather than a healthy one.
  console.error(`No deprecation reports in ${directory}. Did every row fail before installing?`);
  process.exit(2);
}

const rows = reports.flatMap((report) => report.rows ?? []);
const covered = new Set(reports.flatMap((report) => report.selected ?? []));
const allRows = new Set(reports.flatMap((report) => report.allRows ?? []));

// Absence is only evidence once every row has reported. Anything less and a
// waiver is missing because nothing exercised it, not because it went stale.
const rowsComplete = [...allRows].every((row) => covered.has(row));

// A row that predates `direct` cannot answer "is the package still in the
// tree", and falling back to the warnings would reinstate exactly the
// conflation `staleWaivers` exists to avoid — so it is treated as a run that
// cannot be judged rather than one with nothing present.
const recorded = rows.length > 0 && rows.every((row) => Array.isArray(row.direct));
const judgeable = rowsComplete && recorded;

const present = new Set(rows.flatMap((row) => row.direct ?? []));
const warned = new Set(
  rows.flatMap((row) => row.deprecations.waived.map((entry) => entry.package)),
);
const stale = judgeable ? staleWaivers(present, waivers) : [];
const dormant = judgeable ? dormantWaivers(present, warned, waivers) : [];

const findings = rows.flatMap((row) => row.deprecations.findings);

const caveat = !rowsComplete
  ? ' (partial run — staleness not assessed)'
  : !recorded
    ? ' (rows recorded no direct dependencies — staleness not assessed)'
    : '';

console.log(
  `${rows.length} row(s) reported; ${findings.length} unexpected, ${stale.length} stale waiver(s), ` +
    `${dormant.length} dormant${caveat}.`,
);

// Dormant waivers are context, never a failure: the package is still needed and
// there is nothing to do but wait and see whether the marker returns.
if (findings.length === 0 && stale.length === 0) {
  process.exit(0);
}

const body = renderIssue(rows, stale, dormant);
if (values.out) {
  writeFileSync(values.out, body);
} else {
  console.log(`\n${body}`);
}
process.exit(1);
