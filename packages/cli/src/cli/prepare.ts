import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PREPARED_ENV, ROOT_PREREQUISITES } from '../utils/commands';
import { Exit, workspaceRoot } from './command';

/**
 * `prepare` — runs the root scripts a project needs before it compiles:
 * codegen, then the library build. Every app's and site's `pre*` hooks are
 * this, so `npm run build -w @acme/shop` works on a fresh clone.
 *
 * Under the project runner it does nothing, because the runner has already run
 * them: `npm run build` runs every app's and site's `build`, each behind its
 * own `prebuild`, and without this the libraries were built once per project.
 */
export function prepare(_args: readonly string[], cwd: string): number {
  if (process.env[PREPARED_ENV]) {
    return 0;
  }
  runPrerequisites(workspaceRoot(cwd));
  return 0;
}

/** Runs whichever of `ROOT_PREREQUISITES` the root manifest has, in order. */
export function runPrerequisites(root: string): void {
  const scripts =
    (
      JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
        scripts?: Record<string, string>;
      }
    ).scripts ?? {};
  for (const script of ROOT_PREREQUISITES) {
    if (!scripts[script]) {
      continue;
    }
    const result = spawnSync('npm', ['run', script], {
      cwd: root,
      stdio: 'inherit',
      // `npm` is a .cmd shim on Windows, which only a shell runs.
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Exit(result.status ?? 1);
    }
  }
}
