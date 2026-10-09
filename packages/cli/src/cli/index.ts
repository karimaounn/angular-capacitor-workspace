#!/usr/bin/env node
import { parseArgs } from 'node:util';
import type { Severity } from '../gate/audit';
import { bold, cyan, dim, MARK, red } from '../style';
import { Exit } from './command';

// The commands are loaded when they run, not here. `run` is behind every
// `npm start` in a generated workspace, and loading the policy and the
// schematics engine for it would put a third of a second in front of each one.

/** `  --flag <v>   what it does`, with the flag lit and the prose quiet. */
function option(flag: string, description: string): string {
  // A flag too long for the column takes the line to itself, its description
  // wrapping underneath — padding it would only push the prose out of line.
  if (description === '') return `  ${cyan(flag)}`;
  return `  ${cyan(flag.padEnd(18))}  ${dim(description)}`;
}

const CONTINUED = ' '.repeat(22);

const USAGE = `${bold('angular-capacitor-workspace')} <command> [options]

${bold('Commands')}
${option('audit', 'Resolve a lockfile and fail on anything the policy does')}
${CONTINUED}${dim('not account for. The same gate that runs at generation.')}
${option('doctor [--fix]', 'Diff this workspace against the installed policy and')}
${CONTINUED}${dim('report (or apply) the delta.')}
${option('policy', 'Print the policy this version ships.')}

${bold('Workspace scripts')} ${dim('— what the generated npm scripts run')}
${option('run <verb> [<p>]', 'start | watch | build | test | e2e one project, or')}
${CONTINUED}${dim('every one: the root npm start, build and friends.')}
${option('prepare', "Run codegen and build the libraries: each project's")}
${CONTINUED}${dim('pre* hooks. Skipped under run, which does it once.')}
${option('clean-dist <site>', "Empty a site's dist/ before its per-language builds.")}
${option('sitemap <site>', "Write a prerendered site's sitemap.xml.")}
${option('verify-prerender <site>', '')}
${CONTINUED}${dim('Fail on prerendered pages a crawler could not use.')}
${CONTINUED}${dim('Both take --locales en,fr for a translated site.')}
${option('codegen', 'Run orval. --optional skips when the spec is unset;')}
${CONTINUED}${dim('--spec-env <NAME> names the variable that holds it.')}
${option('check-contrast <lib>', '')}
${CONTINUED}${dim("Check the library's src/config/contrast.ts against WCAG.")}
${option('preflight [<platform>]', '')}
${CONTINUED}${dim('Check for what a Capacitor build of android or ios needs.')}

${bold('Options')}
${option('--cwd <dir>', 'Workspace root. Default: the current directory.')}
${option('--audit-level <l>', 'low | moderate | high | critical. Default: moderate.')}
${option('--fix', 'doctor only: write the changes instead of printing them.')}
${option('--json', 'Machine-readable output.')}
${option('-h, --help', 'This message.')}
`;

/**
 * The workspace scripts take their own arguments, which go to them untouched:
 * `run start shop --port 4300` hands `--port 4300` to the app.
 */
async function workspaceScript(
  command: string,
  args: string[],
  cwd: string,
): Promise<number | undefined> {
  switch (command) {
    case 'run':
      return (require('./run') as typeof import('./run')).run(args, cwd);
    case 'prepare':
      return (require('./prepare') as typeof import('./prepare')).prepare(args, cwd);
    case 'clean-dist':
      return (require('./prerender') as typeof import('./prerender')).cleanDist(args, cwd);
    case 'sitemap':
      return (require('./prerender') as typeof import('./prerender')).sitemap(args, cwd);
    case 'verify-prerender':
      return (require('./prerender') as typeof import('./prerender')).verifyPrerender(args, cwd);
    case 'codegen':
      return (require('./codegen') as typeof import('./codegen')).codegen(args, cwd);
    case 'check-contrast':
      return (require('./contrast') as typeof import('./contrast')).checkContrast(args, cwd);
    case 'preflight':
      return (require('./preflight') as typeof import('./preflight')).preflight(args);
    default:
      return undefined;
  }
}

type Command = 'audit' | 'doctor' | 'policy';

async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (first !== undefined && !first.startsWith('-')) {
    const code = await workspaceScript(first, rest, process.cwd());
    if (code !== undefined) {
      return code;
    }
  }

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
    case 'policy': {
      const { POLICY } = require('../policy/advisories') as typeof import('../policy/advisories');
      process.stdout.write(`${JSON.stringify(POLICY, null, 2)}\n`);
      return 0;
    }
    default:
      process.stderr.write(`${MARK.fail} ${red(`Unknown command "${command}".`)}\n\n${USAGE}`);
      return 1;
  }
}

function commandAudit(cwd: string, auditLevel: Severity, json: boolean): number {
  const { runGate } = require('../gate') as typeof import('../gate');
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
  const { applyFix, diagnose, formatDiagnosis } = require('./doctor') as typeof import('./doctor');
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

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    // A command that ended itself has said why already.
    if (error instanceof Exit) {
      process.exitCode = error.code;
      return;
    }
    process.stderr.write(`${MARK.fail} ${red((error as Error).message)}\n`);
    process.exitCode = 1;
  },
);
