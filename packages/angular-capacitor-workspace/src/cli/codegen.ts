import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SPEC_ENV } from '../utils/commands';
import { fail, workspaceRoot } from './command';

/**
 * `codegen [--optional] [--spec-env <NAME>]` — runs orval, or explains why it
 * did not.
 *
 * Two callers with different needs:
 *
 * - `npm run codegen` — you asked for it. Missing configuration is an error.
 * - `npm run codegen:optional`, from the `pre*` hooks — you asked to build.
 *   Missing configuration is a fact about the machine, not a mistake, and
 *   failing here would make `npm start` impossible on a fresh clone of a
 *   workspace whose API contract lives somewhere the clone cannot see.
 *
 * The second case is the one that matters. A `pre*` hook that fails is a
 * workspace where nothing runs, and "clone the repo, `npm start` fails" is a
 * worse first impression than a generated client that is briefly absent.
 *
 * orval itself, and `orval.config.ts`, are the workspace's.
 */
export function codegen(args: readonly string[], cwd: string): number {
  const optional = args.includes('--optional');
  const flag = args.indexOf('--spec-env');
  const variable = flag === -1 ? DEFAULT_SPEC_ENV : args[flag + 1];
  if (!variable || variable.startsWith('--')) {
    fail('usage: angular-capacitor-workspace codegen [--optional] [--spec-env <NAME>]', 2);
  }

  const root = workspaceRoot(cwd);
  const spec = process.env[variable];

  if (!spec) {
    const message =
      `${variable} is not set, so there is no OpenAPI document to generate from.\n` +
      `\n` +
      `  ${variable}=../api/openapi.yaml npm run codegen\n` +
      `  ${variable}=https://api.example.com/openapi.json npm run codegen\n`;
    if (optional) {
      process.stdout.write(`codegen: skipped — ${message}`);
      return 0;
    }
    fail(`codegen: ${message}`);
  }

  // A path that does not exist is worth catching here rather than inside
  // orval, which reports it as a parse failure several frames down. Relative to
  // the workspace root, which is where `npm run codegen` runs.
  if (!/^https?:\/\//.test(spec) && !existsSync(resolve(root, spec))) {
    process.stderr.write(`codegen: ${variable} points at "${spec}", which does not exist.\n`);
    return optional ? 0 : 1;
  }

  const result = spawnSync('npx', ['orval', '--config', 'orval.config.ts'], {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  return result.status ?? 1;
}
