#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runGate } from '../gate';
import { POLICY } from '../policy/advisories';
import type { Severity } from '../gate/audit';
import { applyFix, diagnose, formatDiagnosis } from './doctor';
import { bold, cyan, dim, MARK, red } from '../style';

/** `  --flag <v>   what it does`, with the flag lit and the prose quiet. */
function option(flag: string, description: string): string {
  // A flag too long for the column takes the line to itself, its description
  // wrapping underneath — padding it would only push the prose out of line.
  if (description === '') return `  ${cyan(flag)}`;
  return `  ${cyan(flag.padEnd(18))}  ${dim(description)}`;
}

const USAGE = `${bold('angular-capacitor-workspace')} <command> [options]

${bold('Commands')}
${option('audit', 'Resolve a lockfile and fail on anything the policy does')}
${' '.repeat(22)}${dim('not account for. The same gate that runs at generation.')}
${option('doctor [--fix]', 'Diff this workspace against the installed policy and')}
${' '.repeat(22)}${dim('report (or apply) the delta.')}
${option('policy', 'Print the policy this version ships.')}

${bold('Options')}
${option('--cwd <dir>', 'Workspace root. Default: the current directory.')}
${option('--audit-level <l>', 'low | moderate | high | critical. Default: moderate.')}
${option('--fix', 'doctor only: write the changes instead of printing them.')}
${option('--json', 'Machine-readable output.')}
${option('-h, --help', 'This message.')}
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
      process.stderr.write(`${MARK.fail} ${red(`Unknown command "${command}".`)}\n\n${USAGE}`);
      return 1;
  }
}

function commandAudit(cwd: string, auditLevel: Severity, json: boolean): number {
  const result = runGate({
    cwd,
    auditLevel,
    log: json ? undefined : (message) => process.stdout.write(`${message}\n`),
  });

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ok: result.ok, unhandled: result.unhandled, accepted: result.accepted }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(`${result.report}\n\n`);
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
        `\n${MARK.ok} Applied ${diagnosis.drifts.length} change(s) to package.json.\n` +
          `${dim('Run `npm install` to re-resolve the lockfile.')}\n`,
      );
    }
  }

  // --fix having done its job is a success; reporting un-applied drift is not.
  return diagnosis.drifts.length === 0 || fix ? 0 : 1;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${MARK.fail} ${red((error as Error).message)}\n`);
  process.exitCode = 1;
}
