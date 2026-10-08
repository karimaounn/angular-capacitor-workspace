/**
 * `npm pack` the packages a generated workspace installs from this repository,
 * for anything that generates one from this checkout.
 *
 * A generated workspace depends on `angular-capacitor-workspace`, and on the
 * runtime package of each plugin it has — `@angular-capacitor-workspace/i18n`,
 * `/theming` — at versions that do not exist on the registry until they are
 * published. So the e2e matrix, the advisory sweep and `npm run create` pack
 * the local builds and hand the generator a `file:` spec for each tarball:
 * `--self-spec` for the generator, `--package-spec <name>=<spec>` for the rest.
 * `createArgs()` builds those flags.
 *
 * The runtime packages are packed from their ng-packagr output, which is what
 * publishes, so they have to have been built first.
 */
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** The runtime packages, and the directory each publishes from. */
export const RUNTIME_PACKAGES = [
  { name: '@angular-capacitor-workspace/i18n', dir: 'packages/i18n/dist' },
  { name: '@angular-capacitor-workspace/theming', dir: 'packages/theming/dist' },
];

/**
 * Packs the generator and every runtime package into `destination`. Returns the
 * generator's `npm pack --json` entry plus its absolute path, with `runtime`
 * holding the same for each runtime package, by name.
 */
export function packSelf(destination) {
  const self = pack('packages/angular-capacitor-workspace', destination);
  const runtime = RUNTIME_PACKAGES.map(({ name, dir }) => {
    if (!existsSync(join(repoRoot, dir))) {
      console.error(`${dir} does not exist. Run \`npm run build\` first.`);
      process.exit(2);
    }
    return { name, ...pack(dir, destination) };
  });
  return { ...self, runtime };
}

/** The `create-*` flags that point a generated workspace at what `packSelf` packed. */
export function createArgs(packed) {
  return [
    '--self-spec',
    `file:${packed.path}`,
    ...packed.runtime.flatMap((entry) => ['--package-spec', `${entry.name}=file:${entry.path}`]),
  ];
}

function pack(dir, destination) {
  const result = spawnSync('npm', ['pack', '--pack-destination', destination, '--json'], {
    cwd: join(repoRoot, dir),
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error(`npm pack failed in ${dir}:\n${result.stderr}`);
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
