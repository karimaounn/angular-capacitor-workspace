#!/usr/bin/env node
/**
 * Checks a release tag against the tree it points at, and lifts out the
 * changelog section that becomes the release body.
 *
 *   node scripts/check-release.mjs v22.1.0 [--notes notes.md]
 *
 * The release workflow runs this first, ahead of the build and the matrix row,
 * because nothing it catches is fixed by the code: the answer is always to
 * move the tag or finish the changelog, and the gate it precedes takes half an
 * hour to tell you the same thing.
 *
 * It deliberately does not check that the three manifests agree on a version,
 * or that `create-*` pins the generator at exactly it. That is
 * `test/release-line.spec.ts`, which runs on every commit rather than only on
 * a tag. The question here is narrower — whether the tag names the version the
 * tree already settled on.
 */
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { notes: { type: 'string' } },
});

const tag = positionals[0];
if (!tag) {
  fail('Usage: check-release.mjs <tag> [--notes <path>]');
}

// `v22.1.0`, or `v22.1.0-rc.1` for a prerelease — which publishes under `next`
// rather than `latest`, so that an `npm install` with no version asked for
// cannot land on it.
const parsed = /^v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag);
if (!parsed) {
  fail(`\`${tag}\` is not a release tag. Expected v<major>.<minor>.<patch>[-prerelease].`);
}

const version = parsed[1];
const distTag = version.includes('-') ? 'next' : 'latest';

const manifestVersion = readJson('package.json').version;
if (manifestVersion !== version) {
  fail(
    `\`${tag}\` points at a tree whose version is ${manifestVersion}.\n` +
      'The tag is on the wrong commit, or the bump was never committed. Move ' +
      'the tag; editing the manifest to match would release something no ' +
      'commit describes.',
  );
}

const notes = changelogSection(version);

console.log(`${tag} → ${version}, publishing under the \`${distTag}\` dist-tag.\n`);
console.log(notes);

if (values.notes) {
  writeFileSync(values.notes, `${notes}\n`);
}

// Read back by the publish job, which needs the version to ask the registry
// whether this release already went out.
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(process.env.GITHUB_OUTPUT, `version=${version}\ndist-tag=${distTag}\n`);
}

/**
 * The body of `## [<version>]`, up to the next section.
 *
 * A missing section is a release whose GitHub notes would be empty and whose
 * changes nobody wrote down — most often a tag cut while the entry was still
 * sitting under `## [Unreleased]`.
 */
function changelogSection(version) {
  const lines = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8').split('\n');

  const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
  if (start === -1) {
    fail(
      `CHANGELOG.md has no \`## [${version}]\` section.\n` +
        'Every release gets one; if the entry is still under `## [Unreleased]`, ' +
        'promote it and move the tag onto that commit.',
    );
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  const body = (end === -1 ? rest : rest.slice(0, end))
    // The link definitions sit below the last section, so they only fall
    // inside one when the oldest release is the one being cut.
    .filter((line) => !/^\[[^\]]+\]:\s+https?:/.test(line))
    .join('\n')
    .trim();

  if (body === '') {
    fail(`CHANGELOG.md's \`## [${version}]\` section is empty.`);
  }

  return body;
}

function readJson(...segments) {
  return JSON.parse(readFileSync(join(repoRoot, ...segments), 'utf8'));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
