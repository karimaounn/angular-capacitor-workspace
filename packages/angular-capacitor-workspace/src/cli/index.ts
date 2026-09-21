#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runGate } from '../gate';
import { POLICY } from '../policy/advisories';
import type { Severity } from '../gate/audit';
import { applyFix, diagnose, formatDiagnosis } from './doctor';

const USAGE = `angular-capacitor-workspace <command> [options]

Commands
  audit               Resolve a lockfile and fail on anything the policy does
                      not account for. The same gate that runs at generation.
  doctor [--fix]      Diff this workspace against the installed policy and
                      report (or apply) the delta.
  policy              Print the policy this version ships.

Options
  --cwd <dir>         Workspace root. Default: the current directory.
  --audit-level <l>   low | moderate | high | critical. Default: moderate.
  --fix               doctor only: write the changes instead of printing them.
  --json              Machine-readable output.
  -h, --help          This message.
`;

type Command = 'audit' | 'doctor' | 'policy';

function main(argv: string[]): number {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      'audit-level': { type: 'string' },
      fix: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  if (values.help || positionals.length === 0) {
    process.stdout.write(USAGE);
    return values.help ? 0 : 1;
  }

  const command = positionals[0] as Command;
  const cwd = values.cwd ?? process.cwd();

  switch (command) {
    case 'audit':
      return commandAudit(cwd, (values['audit-level'] as Severity) ?? 'moderate', values.json);
    case 'doctor':
      return commandDoctor(cwd, values.fix, values.json);
    case 'policy':
      process.stdout.write(`${JSON.stringify(POLICY, null, 2)}\n`);
      return 0;
    default:
      process.stderr.write(`Unknown command "${command}".\n\n${USAGE}`);
      return 1;
  }
}

function commandAudit(cwd: string, auditLevel: Severity, json: boolean): number {
  const result = runGate({
    cwd,
    auditLevel,
    log: json ? undefined : (message) => process.stderr.write(`${message}\n`),
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: result.ok, unhandled: result.unhandled, accepted: result.accepted }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${result.report}\n`);
  }

  return result.ok ? 0 : 1;
}

function commandDoctor(cwd: string, fix: boolean, json: boolean): number {
  const diagnosis = diagnose(cwd);

  if (fix && diagnosis.drifts.length > 0) {
    applyFix(diagnosis);
  }

  if (json) {
    process.stdout.write(`${JSON.stringify({ ...diagnosis, fixed: fix }, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatDiagnosis(diagnosis)}\n`);
    if (fix && diagnosis.drifts.length > 0) {
      process.stdout.write(
        `\nApplied ${diagnosis.drifts.length} change(s) to package.json. ` +
          `Run \`npm install\` to re-resolve the lockfile.\n`,
      );
    }
  }

  // --fix having done its job is a success; reporting un-applied drift is not.
  return diagnosis.drifts.length === 0 || fix ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exitCode = 1;
}
