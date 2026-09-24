#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import {
  CATALOG,
  generateWorkspace,
  PLACEHOLDER_ORIGIN,
  style,
  type AppSpec,
  type GenerateOptions,
  type MarketingSpec,
} from 'angular-capacitor-workspace';
import { ArgError, parseArguments, parseOrigin, USAGE } from './args';
import { Prompter } from './prompts';

const { bold, command, dim, heading, MARK, note, red } = style;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArguments(argv);

  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const options = parsed.nonInteractive
    ? await completeNonInteractive(parsed.directory, parsed.options)
    : await ask(parsed.directory, parsed.options);

  const result = await generateWorkspace({
    ...options,
    log: (message) => process.stdout.write(`${message}\n`),
  });

  // Written before the gate is consulted below, so a failed run still reports
  // what it saw rather than only what went wrong.
  if (parsed.reportPath !== undefined) {
    writeFileSync(
      parsed.reportPath,
      `${JSON.stringify({ directory: result.directory, installed: result.installed, deprecations: result.deprecations }, null, 2)}\n`,
    );
  }

  if (options.dryRun) {
    // The gate still ran, against a scratch copy — so a dry run answers "would
    // this be audit-clean" as well as "what would be written".
    process.stdout.write(dryRunSummary(result.directory, result.files));
    return result.gate && !result.gate.ok ? 1 : 0;
  }

  if (result.gate && !result.gate.ok) {
    process.stderr.write(
      `\n${MARK.fail} ${red('The audit gate failed, so nothing was installed.')}\n` +
        `${dim(`The workspace is on disk at ${result.directory} — inspect it, or delete it.`)}\n`,
    );
    return 1;
  }

  process.stdout.write(summary(result.directory, options, result.installed));
  return 0;
}

async function completeNonInteractive(
  directory: string | undefined,
  options: Partial<GenerateOptions>,
): Promise<GenerateOptions> {
  if (!directory) {
    throw new ArgError('A target directory is required. See --help.');
  }
  return { ...options, directory } as GenerateOptions;
}

/**
 * The interactive path.
 *
 * Defaults are chosen so that pressing Return through every question produces
 * the smallest workspace that is actually useful: one app, a ui library, e2e
 * wiring — and no mobile target, no marketing site and no codegen, each of
 * which adds a dependency surface that a workspace should only carry once
 * someone has decided it needs it.
 */
async function ask(
  directory: string | undefined,
  preset: Partial<GenerateOptions>,
): Promise<GenerateOptions> {
  const prompter = new Prompter();
  try {
    const target =
      directory ?? (await prompter.text('Where should the workspace go?', './my-workspace'));
    const defaultAppName = sanitize(basename(resolve(target)));

    const apps: AppSpec[] = [];
    const appName = await prompter.text('Name of the first application', defaultAppName);
    const platforms = await prompter.multi(
      'Capacitor platforms for this app?',
      [
        { value: 'android' as const, label: 'Android' },
        { value: 'ios' as const, label: 'iOS' },
      ],
      [],
    );
    apps.push(platforms.length > 0 ? { name: appName, mobile: platforms } : { name: appName });

    while (await prompter.confirm('Add another application?', false)) {
      // Numbered, because a run of name questions that all read "Name" gives
      // no way to tell which project is being named — and the answer to the
      // one above has already collapsed into the transcript by then.
      const name = await prompter.text(`Name of the ${ordinal(apps.length + 1)} application`);
      const more = await prompter.multi(
        `Capacitor platforms for ${name}?`,
        [
          { value: 'android' as const, label: 'Android' },
          { value: 'ios' as const, label: 'iOS' },
        ],
        [],
      );
      apps.push(more.length > 0 ? { name, mobile: more } : { name });
    }

    const wantsUiLib = await prompter.confirm('Add a design-system library?', true);
    const uiLib = wantsUiLib ? await prompter.text('Library name', 'ui') : false;

    // Offered with the library name as the default, which is also what the
    // schematic derives when no prefix is given. Accepting it therefore sends
    // nothing, leaving that derivation — including the dasherising — in the one
    // place that already does it, rather than freezing the raw answer here.
    let uiLibPrefix: string | undefined;
    if (uiLib) {
      const answer = await prompter.text('Component selector prefix', uiLib);
      uiLibPrefix = answer === uiLib ? undefined : answer;
    }

    // Asked the way the applications are, and for the same reason: a product
    // site and a docs site are one workspace's worth of pages sharing a design
    // system, and a question that only ever takes one answer sends the second
    // one to a second repository.
    const marketing: MarketingSpec[] = [];
    if (await prompter.confirm('Add a prerendered marketing site?', false)) {
      marketing.push(await askSite(prompter, 'Name of the first marketing site', 'site'));
      while (await prompter.confirm('Add another marketing site?', false)) {
        marketing.push(
          await askSite(prompter, `Name of the ${ordinal(marketing.length + 1)} marketing site`),
        );
      }
    }

    const e2e = (await prompter.confirm('Wire up Playwright end-to-end tests?', true))
      ? ('playwright' as const)
      : false;

    const codegen = (await prompter.confirm(
      'Generate an API client from an OpenAPI spec (orval)?',
      false,
    ))
      ? ('orval' as const)
      : false;

    // Offered as a list rather than one question per package: the catalog is
    // meant to grow, and a run of yes/no questions grows with it into an
    // interrogation.
    const packages = await prompter.multi(
      'Add any of these packages?',
      CATALOG.map((entry) => ({ value: entry.id, label: `${entry.title} — ${entry.summary}` })),
      [],
    );

    const auditLevel = await prompter.select(
      'Fail the audit gate at which severity?',
      [
        { value: 'low' as const, label: 'low' },
        { value: 'moderate' as const, label: 'moderate' },
        { value: 'high' as const, label: 'high' },
        { value: 'critical' as const, label: 'critical' },
      ],
      'moderate',
    );

    return {
      ...preset,
      directory: target,
      apps,
      uiLib,
      uiLibPrefix,
      marketing,
      e2e,
      codegen,
      packages,
      auditLevel,
    };
  } finally {
    prompter.close();
  }
}

/**
 * `1` → `first`, for the questions that name one project out of several.
 *
 * Named as far as the tenth and numbered after that: nobody generates eleven
 * of anything in one run, but a question reading "the undefinedth application"
 * if somebody does is worse than the three lines that prevent it.
 */
const ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
];

function ordinal(position: number): string {
  if (position <= ORDINALS.length) return ORDINALS[position - 1]!;
  // 11th to 13th are the exception the st/nd/rd rule forgets.
  const teen = position % 100 >= 11 && position % 100 <= 13;
  return `${position}${teen ? 'th' : (['th', 'st', 'nd', 'rd'][position % 10] ?? 'th')}`;
}

/** One site: its name, then the address its canonical URLs will be built on. */
async function askSite(
  prompter: Prompter,
  question: string,
  fallback?: string,
): Promise<MarketingSpec> {
  const name = await prompter.text(question, fallback);
  const origin = await askOrigin(prompter);
  // Accepting the placeholder sends nothing, leaving the default in the
  // schematic, the one place that owns it.
  return origin === undefined ? { name } : { name, origin };
}

/**
 * Checked while the question is still on screen, rather than after it, so a
 * mistyped URL is corrected in place instead of leaving an answered-looking
 * question above the complaint about it.
 */
async function askOrigin(prompter: Prompter): Promise<string | undefined> {
  const answer = await prompter.text(
    'Its production URL, for canonical links and the sitemap',
    PLACEHOLDER_ORIGIN,
    (value) => {
      if (value === PLACEHOLDER_ORIGIN) return undefined;
      try {
        parseOrigin(value);
        return undefined;
      } catch (error) {
        if (!(error instanceof ArgError)) throw error;
        return error.message;
      }
    },
  );
  return answer === PLACEHOLDER_ORIGIN ? undefined : parseOrigin(answer);
}

function sanitize(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'app'
  );
}

function summary(directory: string, options: GenerateOptions, installed: boolean): string {
  const lines = ['', `${MARK.ok} ${bold('Created')} ${directory}`];

  if (!installed) {
    lines.push(heading('Next'), `  ${dim('Dependencies were not installed.')}`);
    lines.push(`  ${command(`cd ${directory}`)}`, `  ${command('npm install')}`);
  } else {
    lines.push(heading('Next'), `  ${command(`cd ${directory}`)}`);
    if (options.uiLib) {
      lines.push(
        `  ${command('npm run build:libs'.padEnd(20))} ${note('# libraries are consumed from dist/')}`,
      );
    }
    lines.push(`  ${command('npm start')}`);
  }

  lines.push(heading('The dependency policy is live in this workspace'));
  lines.push(
    `  ${command('npm run audit:policy'.padEnd(20))} ${note('# the same gate that just ran')}`,
  );
  lines.push(
    `  ${command('npm run doctor'.padEnd(20))} ${note('# drift from the installed policy')}`,
  );
  lines.push('');
  return lines.join('\n');
}

/**
 * A dry run generated into a scratch directory and deleted it, so the summary
 * must not read like a workspace anyone can `cd` into.
 */
function dryRunSummary(directory: string, files: string[]): string {
  const lines = ['', `${bold('Dry run')} — nothing was written to ${directory}.`];
  lines.push(heading(`${files.length} file(s) would be created`), '');

  // The whole tree is long and mostly Angular's. The interesting part is what
  // this generator adds on top, so show the roots and let --help point at the
  // rest.
  const roots = new Map<string, number>();
  for (const file of files) {
    const root = file.includes('/') ? `${file.slice(0, file.indexOf('/'))}/` : file;
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }

  for (const [root, count] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(count === 1 ? `  ${root}` : `  ${root.padEnd(24)} ${dim(`${count} files`)}`);
  }

  lines.push('', dim('Re-run without --dry-run to create it.'), '');
  return lines.join('\n');
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ArgError) {
      process.stderr.write(`\n${MARK.fail} ${red(error.message)}\n\n${USAGE}`);
    } else {
      const detail = (error as { detail?: string }).detail;
      process.stderr.write(`\n${MARK.fail} ${red((error as Error).message)}\n`);
      if (detail) {
        process.stderr.write(`\n${dim(detail)}\n`);
      }
    }
    process.exitCode = 1;
  });
