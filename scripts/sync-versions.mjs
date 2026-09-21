#!/usr/bin/env node
/**
 * Checks every pin in `src/policy/versions.ts` against the registry.
 *
 * Reports rather than rewrites. A pin here is usually load-bearing — several
 * carry a constraint that no resolver enforces, like `@vitest/browser-playwright`
 * needing to match vitest exactly, or the devkit packages existing only to stop
 * npm backtracking Storybook's peers onto Angular 20. A script that bumped them
 * automatically would quietly undo the reasoning in the `constraint` field.
 *
 * So: this tells you what moved, and a human decides. The matrix run is what
 * proves the decision was right.
 *
 *   npm run sync-versions
 *   npm run sync-versions -- --json
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const versionsPath = join(repoRoot, 'packages/angular-capacitor-workspace/src/policy/versions.ts');

const { values } = parseArgs({ options: { json: { type: 'boolean', default: false } } });

const source = readFileSync(versionsPath, 'utf8');
const pins = parsePins(source);

if (pins.length === 0) {
  console.error(`No pins parsed from ${versionsPath}. Has the file's shape changed?`);
  process.exit(2);
}

const rows = [];
for (const pin of pins) {
  const latest = latestVersion(pin.name);
  const satisfied = latest !== undefined && satisfies(latest, pin.range);
  rows.push({ ...pin, latest, upToDate: satisfied });
}

if (values.json) {
  console.log(JSON.stringify(rows, null, 2));
} else {
  const width = Math.max(...rows.map((row) => row.name.length));
  for (const row of rows) {
    const mark = row.latest === undefined ? '?' : row.upToDate ? ' ' : '↑';
    console.log(
      `${mark} ${row.name.padEnd(width)}  pinned ${row.range.padEnd(12)} latest ${row.latest ?? 'unknown'}`,
    );
    if (!row.upToDate && row.constraint) {
      console.log(`  ${' '.repeat(width)}  constraint: ${row.constraint}`);
    }
  }

  const behind = rows.filter((row) => !row.upToDate && row.latest !== undefined);
  console.log(`\n${rows.length - behind.length}/${rows.length} pins are current.`);
  if (behind.length > 0) {
    console.log(
      '\nEach ↑ needs a decision, not a bump. Read its `constraint` first, then ' +
        'raise the pin and run `npm run e2e` before trusting it.',
    );
  }
}

process.exit(0);

/**
 * Extracts `'name': { range: '…', constraint?: '…' }` entries.
 *
 * Text parsing rather than importing the module, so this runs without a build
 * step and cannot be broken by a compile error in the package it inspects.
 */
function parsePins(text) {
  const body = text.slice(text.indexOf('export const VERSIONS'));
  const pins = [];

  // Each key at two-space indent starts an entry; its extent is found by
  // counting braces rather than by a lazy match to the next `},`. A lazy match
  // reaches past every single-line entry to the next multi-line one and
  // swallows the entries in between — which fails silently, reporting a
  // shorter list rather than an error.
  const key = /^ {2}'?([@\w/.-]+)'?:\s*\{/gm;

  for (const match of body.matchAll(key)) {
    const start = match.index + match[0].length - 1;
    const end = matchingBrace(body, start);
    if (end === -1) continue;

    const entry = body.slice(start, end + 1);
    const range = entry.match(/range:\s*(?:'([^']+)'|`([^`]+)`)/);
    if (!range) continue;

    const constraint = entry.match(/constraint:\s*\n?\s*'([^']+)'/)?.[1];
    pins.push({
      name: match[1],
      range: range[1] ?? resolveTemplate(range[2] ?? '', text),
      ...(constraint ? { constraint } : {}),
    });
  }

  return pins;
}

/** Index of the `}` closing the `{` at `open`. */
function matchingBrace(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}' && --depth === 0) return index;
  }
  return -1;
}

/** Resolves `${ANGULAR_LINE}` in a templated range. */
function resolveTemplate(template, source) {
  const line = source.match(/ANGULAR_LINE\s*=\s*'([^']+)'/)?.[1] ?? '';
  return template.replaceAll('${ANGULAR_LINE}', line);
}

function latestVersion(name) {
  const result = spawnSync('npm', ['view', name, 'version'], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * Whether `version` falls inside `range`, for the range shapes this file uses:
 * an exact pin or a caret. Deliberately narrow — a general semver
 * implementation is a dependency, and the pins here are all one of two shapes.
 */
function satisfies(version, range) {
  if (!range.startsWith('^')) {
    return version === range;
  }

  const pinned = parse(range.slice(1));
  const actual = parse(version);
  if (!pinned || !actual) return false;

  // Caret allows changes that do not modify the left-most non-zero component.
  if (pinned.major !== 0) return actual.major === pinned.major && gte(actual, pinned);
  if (pinned.minor !== 0) {
    return actual.major === 0 && actual.minor === pinned.minor && gte(actual, pinned);
  }
  return actual.major === 0 && actual.minor === 0 && actual.patch === pinned.patch;
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

function gte(a, b) {
  if (a.major !== b.major) return a.major > b.major;
  if (a.minor !== b.minor) return a.minor > b.minor;
  return a.patch >= b.patch;
}
