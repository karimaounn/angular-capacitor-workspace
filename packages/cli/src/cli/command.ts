import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Ends a command with an exit code.
 *
 * Thrown rather than calling `process.exit`, so a command stops wherever it is
 * and the entry point sets the code, and so a test can run a command without
 * its process ending. A message, when there is one, has already been written.
 */
export class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** Writes `message` to stderr and ends the command with `code`. */
export function fail(message: string, code = 1): never {
  process.stderr.write(`${message}\n`);
  throw new Exit(code);
}

/**
 * The workspace root: the nearest directory at or above `from` with an
 * `angular.json`.
 *
 * Searched for rather than assumed to be the current directory, because a
 * project's own scripts run in the project's directory — a site's `postbuild`
 * runs in `projects/<site>/web` — and every command here works on paths from
 * the root.
 */
export function workspaceRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'angular.json'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return fail(
        `No angular.json in ${resolve(from)} or any directory above it. ` +
          'Run this from inside an Angular workspace.',
        2,
      );
    }
    dir = parent;
  }
}
