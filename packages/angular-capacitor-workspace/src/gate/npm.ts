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

/**
 * The oldest npm this gate can run on.
 *
 * 11.6 is the first npm with the install-script allowlist, which *is* the Tier 1
 * `allowScripts` remedy. On anything older the field is inert and
 * `--strict-allow-scripts` is accepted and silently ignored — so a workspace
 * that looks gated is not, which is the failure mode worth being loud about.
 *
 * Older npm also cannot resolve this tree at all. npm 10.9.8 — the newest npm
 * any Node 22.x release bundles — dies in arborist's peer-set walk with
 * `Cannot read properties of null (reading 'edgesOut')` while following
 * vitest's optional `@vitest/browser-*` peers. That surfaces as a generation
 * failure pointing at the Angular line, which is the wrong place to look.
 *
 * `engines.node` is `>=24.8.0` for this reason and no other: 24.8 is the first
 * Node whose bundled npm clears this floor. Keep the two in step — a Node floor
 * that ships an npm below this one puts every install back in the case above.
 */
export const NPM_FLOOR = '11.6.0';

/** The running npm's version, or `undefined` if it could not be determined. */
export function npmVersion(cwd: string): string | undefined {
  try {
    const version = npm(['--version'], cwd).stdout.trim();
    return /^\d+\.\d+\.\d+/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
