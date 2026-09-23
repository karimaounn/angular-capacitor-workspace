#!/usr/bin/env node
/**
 * Writes the next version everywhere the release line records it.
 *
 *   node scripts/bump.mjs 22.2.0
 *   npm run bump -- minor
 *   npm run bump -- patch --dry-run
 *
 * There are five places, and a release needs all five: the version in each of
 * the three manifests, the exact `angular-capacitor-workspace` pin in
 * `create-*`, and the changelog's `## [Unreleased]` heading with the two link
 * definitions at the foot of the file.
 *
 * Every one of them is already checked, but late. `test/release-line.spec.ts`
 * catches a missed manifest on the next CI run; `check-release.mjs` catches an
 * unpromoted changelog only once a tag exists, and by then the fix is moving
 * the tag. This runs before the commit, so neither gate has anything to say.
 *
 * It stops at the manifests and the headings. It does not commit, tag or
 * touch the prose: folding entries into the right `###` subsection is a
 * judgement about what changed, and the tag is the release trigger, which
 * should stay something a person types.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const generator = 'packages/angular-capacitor-workspace/package.json';
const create = 'packages/create-angular-capacitor-workspace/package.json';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { 'dry-run': { type: 'boolean', default: false } },
});

const current = read('package.json').match(/^ {2}"version": "([^"]+)"/m)?.[1];
if (!current) {
  fail('No top-level `"version"` in package.json. Has the manifest changed shape?');
}

const target = resolve(positionals[0], current);
const date = new Date().toLocaleDateString('sv-SE'); // ISO-8601, the format the changelog uses.

// Accumulated so the two edits to the `create-*` manifest compose, and so a
// failure anywhere leaves the tree untouched rather than half-bumped.
const edits = new Map();
const summary = [];

pin('package.json', /^( {2}"version": ")[^"]+(")/m, 'version');
pin(generator, /^( {2}"version": ")[^"]+(")/m, 'version');
pin(create, /^( {2}"version": ")[^"]+(")/m, 'version');
pin(create, /^( {4}"angular-capacitor-workspace": ")[^"]+(")/m, 'angular-capacitor-workspace pin');
promoteChangelog();

for (const line of summary) {
  console.log(line);
}

if (values['dry-run']) {
  console.log(`\n${current} → ${target}, in ${edits.size} files. Nothing written.`);
  process.exit(0);
}

for (const [path, text] of edits) {
  writeFileSync(join(repoRoot, path), text);
}

console.log(`\n${current} → ${target}. Then:\n`);
console.log(`  npm test`);
console.log(`  git commit -am 'Release ${target}'`);
console.log(`  git tag v${target}`);
console.log(`  git push origin main v${target}\n`);

/**
 * The version to write: `minor`, `patch`, or one spelled out.
 *
 * `major` is not a bump this script can make. The major belongs to the Angular
 * line the generator targets — `ANGULAR_LINE` in `src/policy/versions.ts` —
 * and raising it means retargeting the schematics, the peer range and the
 * pins. `release-line.spec.ts` fails on a major that moved alone, which is the
 * point: a 23.0.0 that still runs Angular 22's skeletons is the failure this
 * refusal exists to prevent.
 */
function resolve(requested, from) {
  if (!requested) {
    fail('Usage: bump.mjs <version|minor|patch> [--dry-run]');
  }

  const line = angularLine();
  const base = parse(from);

  let next;
  if (requested === 'minor') {
    next = `${base.major}.${base.minor + 1}.0`;
  } else if (requested === 'patch') {
    next = `${base.major}.${base.minor}.${base.patch + 1}`;
  } else if (requested === 'major') {
    fail(
      'A major is the Angular line, not a bump.\n' +
        `This tree generates for Angular ${line}. Retarget \`ANGULAR_LINE\` and the ` +
        'pins it feeds first, then name the version here in full.',
    );
  } else {
    next = requested;
  }

  const parsed = parse(next);
  if (!parsed) {
    fail(`\`${requested}\` is not a version. Expected <major>.<minor>.<patch>[-prerelease].`);
  }

  if (String(parsed.major) !== line) {
    fail(
      `${next} is a ${parsed.major}.x release, but this tree generates for Angular ${line}.\n` +
        'The major tracks the Angular line; `release-line.spec.ts` fails if they disagree.',
    );
  }

  if (next === from) {
    fail(`The tree is already at ${from}.`);
  }

  // Compares the release triple only. A full prerelease ordering is a semver
  // dependency, and the mistake worth catching — naming a version below the
  // one already released — shows up in the triple.
  if (rank(parsed) < rank(base)) {
    fail(`${next} is below ${from}. A release does not go backwards.`);
  }

  return next;
}

/** Read the way `sync-versions.mjs` reads it: as text, so no build is needed. */
function angularLine() {
  const source = read('packages/angular-capacitor-workspace/src/policy/versions.ts');
  const line = source.match(/ANGULAR_LINE\s*=\s*'([^']+)'/)?.[1];
  if (!line) {
    fail('No `ANGULAR_LINE` in src/policy/versions.ts.');
  }
  return line;
}

/**
 * Rewrites one version string, anchored on the version the root manifest
 * already carries.
 *
 * Anchoring is what makes this safe to re-run and refuses to paper over drift:
 * if a manifest disagrees with the root before the bump, it is the disagreement
 * `release-line.spec.ts` exists to catch, and writing the new version over it
 * would hide that rather than fix it.
 */
function pin(path, pattern, what) {
  const text = edits.get(path) ?? read(path);
  const match = text.match(pattern);

  if (!match) {
    fail(`${path} has no \`${what}\` line matching the shape this script edits.`);
  }

  const found = match[0].slice(match[1].length, -match[2].length);
  if (found !== current) {
    fail(
      `${path} has ${what} at ${found}, but the root manifest is at ${current}.\n` +
        'The line has drifted. Reconcile it before bumping, or the bump buries it.',
    );
  }

  edits.set(path, text.replace(pattern, `$1${target}$2`));
  summary.push(`${path}  ${what}: ${current} → ${target}`);
}

/**
 * Promotes `## [Unreleased]` to the release, opens a fresh empty one above it,
 * and moves the compare links along.
 *
 * An empty section is the one thing here a script cannot fix — the release
 * would go out with notes nobody wrote — so it fails rather than promoting a
 * heading with nothing under it. That is the same check `check-release.mjs`
 * makes, moved to before the tag exists.
 */
function promoteChangelog() {
  const path = 'CHANGELOG.md';
  const lines = read(path).split('\n');
  const isLinkDefinition = (line) => /^\[[^\]]+\]:\s+https?:/.test(line);

  const start = lines.findIndex((line) => line.startsWith('## [Unreleased]'));
  if (start === -1) {
    fail('CHANGELOG.md has no `## [Unreleased]` section to promote.');
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end))
    .filter((line) => !isLinkDefinition(line))
    .join('\n')
    .trim();

  if (body === '') {
    fail(
      "CHANGELOG.md's `## [Unreleased]` section is empty.\n" +
        'Write the entry first; a release whose changes nobody wrote down is what ' +
        'the release workflow refuses to publish.',
    );
  }

  lines.splice(start, 1, '## [Unreleased]', '', `## [${target}] — ${date}`);

  // The link base is taken from the file rather than hardcoded, so a fork or a
  // move of the repository needs no edit here.
  const unreleased = lines.findIndex((line) => /^\[unreleased\]:\s/i.test(line));
  if (unreleased === -1) {
    fail('CHANGELOG.md has no `[unreleased]:` link definition.');
  }

  const compare = lines[unreleased].match(
    /^(\[unreleased\]:\s+)(\S+)\/compare\/v(\S+)\.\.\.HEAD$/i,
  );
  if (!compare) {
    fail(`\`${lines[unreleased]}\` is not the compare link this script knows how to move.`);
  }

  const [, label, base, previous] = compare;
  if (previous !== current) {
    fail(
      `The \`[unreleased]\` link compares from v${previous}, but the tree is at ${current}.\n` +
        'The last release left its links half-written. Fix them before bumping.',
    );
  }

  lines.splice(
    unreleased,
    1,
    `${label}${base}/compare/v${target}...HEAD`,
    `[${target}]: ${base}/compare/v${current}...v${target}`,
  );

  edits.set(path, lines.join('\n'));
  summary.push(`${path}  \`## [Unreleased]\` → \`## [${target}] — ${date}\`, links moved`);
}

function parse(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version);
  return match
    ? { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
    : undefined;
}

function rank({ major, minor, patch }) {
  return major * 1e6 + minor * 1e3 + patch;
}

function read(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
