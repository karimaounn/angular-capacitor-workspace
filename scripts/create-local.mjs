#!/usr/bin/env node
/**
 * Generates a workspace from this checkout, without publishing anything.
 *
 * Builds every package, packs the schematics package and the runtime packages
 * into `.local/`, and runs the local create bin pointing at those tarballs, so
 * the workspace's `audit:policy`, `doctor`, `ng generate` and the plugins'
 * runtime code are the code you have here rather than whatever is on the
 * registry.
 *
 *   npm run create -- my-workspace                    # asks, like npm create
 *   npm run create -- my-workspace --app shop --ui-lib
 *
 * Each pack keeps its own tarball, named by content hash, since the workspace's
 * lockfile pins that tarball's integrity: overwriting it would break the next
 * `npm ci` there. That also ties the workspace to this checkout — delete
 * `.local/` and it needs regenerating. The directory resolves from where you
 * ran npm, not from the repo root.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArgs, packSelf } from './pack-self.mjs';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const createBin = join(repoRoot, 'packages/create/dist/index.js');
const localDir = join(repoRoot, '.local');

const build = spawnSync('npm', ['run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);

mkdirSync(localDir, { recursive: true });
const packed = packSelf(localDir);
// Renamed by content hash, generator and runtime packages alike: see above.
for (const entry of [packed, ...packed.runtime]) {
  const tarball = entry.path.replace(/\.tgz$/, `-${entry.shasum.slice(0, 8)}.tgz`);
  renameSync(entry.path, tarball);
  entry.path = tarball;
  console.log(`packed ${tarball}`);
}

const create = spawnSync(
  process.execPath,
  [createBin, ...process.argv.slice(2), ...createArgs(packed)],
  {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    stdio: 'inherit',
  },
);
process.exit(create.status ?? 1);
