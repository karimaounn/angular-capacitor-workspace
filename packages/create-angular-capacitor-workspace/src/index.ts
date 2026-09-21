#!/usr/bin/env node
import { basename, resolve } from 'node:path';
import {
  generateWorkspace,
  PLACEHOLDER_ORIGIN,
  type AppSpec,
  type GenerateOptions,
} from 'angular-capacitor-workspace';
import { ArgError, parseArguments, parseOrigin, USAGE } from './args';
import { Prompter } from './prompts';

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

  if (options.dryRun) {
    // The gate still ran, against a scratch copy — so a dry run answers "would
    // this be audit-clean" as well as "what would be written".
    process.stdout.write(dryRunSummary(result.directory, result.files));
    return result.gate && !result.gate.ok ? 1 : 0;
  }

  if (result.gate && !result.gate.ok) {
    process.stderr.write(
      `\nThe audit gate failed, so nothing was installed.\n` +
        `The workspace is on disk at ${result.directory} — inspect it, or delete it.\n`,
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
      const name = await prompter.text('Name');
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

    const wantsMarketing = await prompter.confirm('Add a prerendered marketing site?', false);
    const marketing = wantsMarketing
      ? await prompter.text('Marketing site name', 'site')
      : undefined;

    // Accepting the placeholder sends nothing, leaving the default in the
    // schematic, the one place that owns it.
    let marketingOrigin: string | undefined;
    if (marketing) {
      marketingOrigin = await askOrigin(prompter);
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
      marketingOrigin,
      e2e,
      codegen,
      auditLevel,
    };
  } finally {
    prompter.close();
  }
}

async function askOrigin(prompter: Prompter): Promise<string | undefined> {
  const answer = await prompter.text(
    'Its production URL, for canonical links and the sitemap',
    PLACEHOLDER_ORIGIN,
  );
  if (answer === PLACEHOLDER_ORIGIN) return undefined;
  try {
    return parseOrigin(answer);
  } catch (error) {
    if (!(error instanceof ArgError)) throw error;
    process.stdout.write(`${error.message}\n`);
    return askOrigin(prompter);
  }
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
  const lines = ['', `Created ${directory}`, ''];

  if (!installed) {
    lines.push('Dependencies were not installed.', '');
    lines.push(`  cd ${directory}`, '  npm install', '');
  } else {
    lines.push(`  cd ${directory}`);
    if (options.uiLib) {
      lines.push('  npm run build:libs   # libraries are consumed from dist/');
    }
    lines.push('  npm start', '');
  }

  lines.push('The dependency policy is live in this workspace:');
  lines.push('  npm run audit:policy   # the same gate that just ran');
  lines.push('  npm run doctor         # drift from the installed policy');
  lines.push('');
  return lines.join('\n');
}

/**
 * A dry run generated into a scratch directory and deleted it, so the summary
 * must not read like a workspace anyone can `cd` into.
 */
function dryRunSummary(directory: string, files: string[]): string {
  const lines = ['', `Dry run — nothing was written to ${directory}.`, ''];
  lines.push(`${files.length} file(s) would be created:`, '');

  // The whole tree is long and mostly Angular's. The interesting part is what
  // this generator adds on top, so show the roots and let --help point at the
  // rest.
  const roots = new Map<string, number>();
  for (const file of files) {
    const root = file.includes('/') ? `${file.slice(0, file.indexOf('/'))}/` : file;
    roots.set(root, (roots.get(root) ?? 0) + 1);
  }

  for (const [root, count] of [...roots].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(count === 1 ? `  ${root}` : `  ${root.padEnd(24)} ${count} files`);
  }

  lines.push('', 'Re-run without --dry-run to create it.', '');
  return lines.join('\n');
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof ArgError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
    } else {
      const detail = (error as { detail?: string }).detail;
      process.stderr.write(`${(error as Error).message}\n`);
      if (detail) {
        process.stderr.write(`\n${detail}\n`);
      }
    }
    process.exitCode = 1;
  });
