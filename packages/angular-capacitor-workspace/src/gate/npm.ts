import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

export interface NpmRun {
  status: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs npm and hands back the raw result. Exit status is data, not an error:
 * `npm audit` exits non-zero precisely when it has something to say, and
 * treating that as a crash would throw away the report we came for.
 */
export function npm(args: string[], cwd: string, options: SpawnSyncOptions = {}): NpmRun {
  const result = spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    // npm audit on a large tree can exceed the 1 MB default.
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === 'win32',
    ...options,
  });

  if (result.error) {
    throw new Error(`Failed to run \`npm ${args.join(' ')}\` in ${cwd}: ${result.error.message}`);
  }

  return {
    status: result.status ?? 1,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

/**
 * Resolves a lockfile without unpacking anything.
 *
 * `--package-lock-only` is what makes the gate affordable: a full install of a
 * generated workspace is minutes, this is seconds, and it produces exactly the
 * tree `npm audit` reads. `--ignore-scripts` is belt and braces — nothing
 * should execute during a resolve, and if the registry ever disagrees we would
 * rather find out by the lockfile being wrong than by code running.
 */
export function resolveLockfile(cwd: string): NpmRun {
  return npm(['install', '--package-lock-only', '--ignore-scripts'], cwd);
}

export function auditJson(cwd: string): NpmRun {
  return npm(['audit', '--json'], cwd);
}
