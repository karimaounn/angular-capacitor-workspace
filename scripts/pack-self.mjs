/**
 * `npm pack` the schematics package, for anything that generates a workspace
 * from this checkout.
 *
 * A generated workspace depends on `angular-capacitor-workspace`, and the
 * version it names does not exist on the registry until it is published. So the
 * e2e matrix, the advisory sweep and `npm run create` pack the local build and
 * hand the generator a `file:` spec for the tarball via `--self-spec`.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Packs into `destination` and returns the `npm pack --json` entry plus its absolute path. */
export function packSelf(destination) {
  const result = spawnSync('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: join(repoRoot, 'packages/angular-capacitor-workspace'),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error(`npm pack failed:\n${result.stderr}`);
    process.exit(2);
  }

  const entry = packResult(result.stdout);
  return { ...entry, path: join(destination, entry.filename) };
}

/**
 * `npm pack --json` reports one entry per packed tarball, but the envelope
 * changed shape: npm <= 11 emits an array, npm >= 12 an object keyed by package
 * name. CI pins Node 24 (npm 11) while a contributor on current Node runs npm
 * 12, so the script has to read both or it breaks on whichever it was not
 * written against.
 */
function packResult(stdout) {
  const parsed = JSON.parse(stdout);
  const [entry] = Array.isArray(parsed) ? parsed : Object.values(parsed);

  if (!entry?.filename) {
    console.error(`npm pack --json returned no tarball:\n${stdout}`);
    process.exit(2);
  }

  return entry;
}
