import { parseArgs } from 'node:util';
import {
  CATALOG,
  catalogEntry,
  style,
  unknownPackageMessage,
  type AppSpec,
  type GenerateOptions,
  type MobilePlatform,
} from 'angular-capacitor-workspace';

const { bold, cyan, dim } = style;

/** `  --flag <v>   what it does`, with the flag lit and the prose quiet. */
function option(flag: string, description: string): string {
  // A flag too long for the column takes the line to itself, its description
  // wrapping underneath — padding it would only push the prose out of line.
  if (description === '') return `  ${cyan(flag)}`;
  return `  ${cyan(flag.padEnd(22))}  ${dim(description)}`;
}

const CONTINUED = ' '.repeat(26);

export const USAGE = `${bold('npm create angular-capacitor-workspace@latest')} <directory> -- [options]

${option('--app <name>', 'app to create (repeatable)')}
${option('--mobile android,ios', 'Capacitor platforms for the preceding --app')}
${option('--marketing <name>', 'prerendered static site')}
${option('--marketing-origin <url>', '')}
${CONTINUED}${dim('its production origin, for canonical URLs and the')}
${CONTINUED}${dim('sitemap (default: https://example.com, which its')}
${CONTINUED}${dim('build warns about)')}
${option('--ui-lib [name]', 'design-system library skeleton (default: ui)')}
${option('--ui-lib-prefix <p>', 'selector prefix for its components (default: its name)')}
${option('--codegen orval', 'OpenAPI client generation')}
${option('--e2e playwright', 'end-to-end test wiring')}
${option('--with <pkg>', 'extra package to wire in (repeatable, comma-separated)')}
${CATALOG.map((entry) => `${CONTINUED}${dim(`${entry.id} — ${entry.summary}`)}`).join('\n')}
${option('--audit-level <lvl>', 'low|moderate|high|critical  (default: moderate)')}
${option('--no-install', 'stop after generating; still writes the lockfile to audit')}
${option('--dry-run', 'show what would be generated')}
${option('-h, --help', 'this message')}

${dim('Interactive when no flags are given. Non-interactive when any flag is present,')}
${dim('so CI and the integration tests take the same path users do.')}

${dim('The \`--\` matters: without it npm reads the flags as its own configuration and')}
${dim('passes on only their values.')}
`;

export interface ParsedArgs {
  directory?: string;
  options: Partial<GenerateOptions>;
  /** True when any flag was supplied, which suppresses every prompt. */
  nonInteractive: boolean;
  help: boolean;
  /**
   * Where to write the machine-readable run report, if anywhere.
   *
   * Undocumented, like `--self-spec`: it exists so the integration matrix can
   * read what the run observed — the deprecation warnings npm printed during
   * the install, which exist only in that moment — without scraping prose that
   * is written for a person and free to change.
   */
  reportPath?: string;
}

const AUDIT_LEVELS = ['low', 'moderate', 'high', 'critical'] as const;

/**
 * What Angular accepts as a selector prefix, copied from its own schemas.
 *
 * Checked here so a typo fails on the first line of output, rather than several
 * minutes in, as a schema violation from inside `@schematics/angular:library`.
 */
const SELECTOR_PREFIX = /^[a-zA-Z][.0-9a-zA-Z]*(-[.0-9a-zA-Z]*)*$/;

export class ArgError extends Error {}

/**
 * Checks and trims a site origin: a scheme and a host, nothing after.
 *
 * Checked here, like the selector prefix, so a mistake fails on the first line
 * of output rather than minutes later inside the marketing schematic. A path is
 * the likely mistake — `https://example.org/site` — and canonical URLs built on
 * one would all point one directory too deep.
 */
export function parseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ArgError(`--marketing-origin must be a URL like https://example.org (got "${raw}").`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ArgError(`--marketing-origin must be an http(s) URL (got "${raw}").`);
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new ArgError(
      `--marketing-origin takes the origin alone, without a path (got "${raw}"; ` +
        `did you mean ${url.origin}?).`,
    );
  }
  return url.origin;
}

/**
 * Parses argv, binding each `--mobile` to the `--app` it follows.
 *
 * Position matters here and nowhere else in the CLI:
 *
 *     --app shop --mobile android --app admin
 *
 * gives the mobile target to `shop` alone. `parseArgs` collects repeated flags
 * into flat arrays and discards the interleaving, so the association is
 * recovered from the raw argv order instead.
 */
export function parseArguments(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: fillBareFlag(argv, 'ui-lib', 'ui'),
    allowPositionals: true,
    // Lets `--no-install` negate the `install` boolean rather than being
    // rejected as an unknown flag.
    allowNegative: true,
    options: {
      app: { type: 'string', multiple: true },
      mobile: { type: 'string', multiple: true },
      marketing: { type: 'string' },
      'marketing-origin': { type: 'string' },
      'ui-lib': { type: 'string' },
      'ui-lib-prefix': { type: 'string' },
      codegen: { type: 'string' },
      e2e: { type: 'string' },
      with: { type: 'string', multiple: true },
      'audit-level': { type: 'string' },
      install: { type: 'boolean', default: true },
      'dry-run': { type: 'boolean', default: false },
      'self-spec': { type: 'string' },
      report: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });

  const apps = pairAppsWithPlatforms(argv);

  const options: Partial<GenerateOptions> = {};
  if (apps.length > 0) options.apps = apps;
  if (values.marketing) options.marketing = values.marketing;

  const marketingOrigin = values['marketing-origin'];
  if (marketingOrigin !== undefined) {
    if (!options.marketing) {
      throw new ArgError(
        '--marketing-origin is the address of the marketing site, and there is no ' +
          '--marketing. Write `--marketing site --marketing-origin https://example.org`.',
      );
    }
    options.marketingOrigin = parseOrigin(marketingOrigin);
  }

  if ('ui-lib' in values) {
    // A bare `--ui-lib` arrives here already filled in; `--ui-lib=` still
    // reaches this as an empty string. Both mean the documented default.
    options.uiLib =
      values['ui-lib'] === '' || values['ui-lib'] === undefined ? 'ui' : values['ui-lib'];
  }

  const uiLibPrefix = values['ui-lib-prefix'];
  if (uiLibPrefix !== undefined) {
    if (!options.uiLib) {
      throw new ArgError(
        '--ui-lib-prefix names the selector prefix of the design-system library, ' +
          'and there is no --ui-lib. Write `--ui-lib ui --ui-lib-prefix acme`.',
      );
    }
    if (!SELECTOR_PREFIX.test(uiLibPrefix)) {
      throw new ArgError(
        `--ui-lib-prefix must be a valid element-selector prefix (got "${uiLibPrefix}").`,
      );
    }
    options.uiLibPrefix = uiLibPrefix;
  }

  if (values.codegen !== undefined) {
    if (values.codegen !== 'orval') {
      throw new ArgError(`--codegen only supports "orval" (got "${values.codegen}").`);
    }
    options.codegen = 'orval';
  }

  if (values.e2e !== undefined) {
    if (values.e2e !== 'playwright') {
      throw new ArgError(`--e2e only supports "playwright" (got "${values.e2e}").`);
    }
    options.e2e = 'playwright';
  }

  const wanted = parsePackages(values.with ?? []);
  if (wanted.length > 0) {
    options.packages = wanted;
  }

  const auditLevel = values['audit-level'];
  if (auditLevel !== undefined) {
    if (!(AUDIT_LEVELS as readonly string[]).includes(auditLevel)) {
      throw new ArgError(
        `--audit-level must be one of ${AUDIT_LEVELS.join(', ')} (got "${auditLevel}").`,
      );
    }
    options.auditLevel = auditLevel as GenerateOptions['auditLevel'];
  }

  options.install = values.install;
  options.dryRun = values['dry-run'];
  if (values['self-spec'] !== undefined) {
    options.selfSpec = values['self-spec'];
  }

  // `--no-install` and `--dry-run` are how the tests and CI drive this, so they
  // must not count as "the user made choices" — but every other flag does.
  // `--self-spec` and `--report` are harness plumbing and count for even less.
  const nonInteractive = argv.some(
    (arg) =>
      arg.startsWith('--') &&
      !['--no-install', '--dry-run'].includes(arg) &&
      !arg.startsWith('--self-spec') &&
      !arg.startsWith('--report'),
  );

  return {
    directory: positionals[0],
    options,
    nonInteractive,
    help: values.help,
    reportPath: values.report,
  };
}

/**
 * Rewrites a valueless `--<flag>` into `--<flag>=<fallback>`.
 *
 * `parseArgs` has no notion of an optional value: a `type: 'string'` option
 * with nothing usable after it throws before any of this module's own
 * validation runs, which made the documented `--ui-lib [name]` exit on a raw
 * TypeError with no usage attached. The rewrite happens on argv rather than
 * after parsing because by then the distinction is gone.
 */
function fillBareFlag(argv: string[], flag: string, fallback: string): string[] {
  return argv.map((arg, index) => {
    if (arg !== `--${flag}`) return arg;
    const next = argv[index + 1];
    // Anything starting with `-` is the next flag, not this one's value.
    return next === undefined || next.startsWith('-') ? `--${flag}=${fallback}` : arg;
  });
}

/**
 * Reads `--with` into catalog ids: repeatable, and comma-separated within each.
 *
 * Both forms because both are reflexes — `--with cdk --with gsap` from someone
 * copying the `--app` habit, `--with cdk,gsap` from someone copying `--mobile`.
 * Checked against the catalog here so a typo costs a line rather than the
 * minutes generation takes to reach the schematic that would reject it.
 */
function parsePackages(raw: string[]): string[] {
  const ids: string[] = [];

  for (const value of raw.flatMap((entry) => entry.split(','))) {
    const id = value.trim();
    if (id === '') {
      throw new ArgError('--with needs the name of a package. See --help for the list.');
    }
    if (!catalogEntry(id)) {
      throw new ArgError(`--with: ${unknownPackageMessage(id)}`);
    }
    if (!ids.includes(id)) {
      ids.push(id);
    }
  }

  return ids;
}

function pairAppsWithPlatforms(argv: string[]): AppSpec[] {
  const apps: AppSpec[] = [];

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;

    if (arg === '--app' || arg.startsWith('--app=')) {
      const name = arg.startsWith('--app=') ? arg.slice('--app='.length) : argv[++index];
      if (!name) {
        throw new ArgError('--app needs a name.');
      }
      apps.push({ name });
      continue;
    }

    if (arg === '--mobile' || arg.startsWith('--mobile=')) {
      const raw = arg.startsWith('--mobile=') ? arg.slice('--mobile='.length) : argv[++index];
      if (!raw) {
        throw new ArgError('--mobile needs at least one platform.');
      }
      const target = apps.at(-1);
      if (!target) {
        throw new ArgError(
          '--mobile applies to the --app before it, and there is no --app yet. ' +
            'Write `--app shop --mobile android`.',
        );
      }
      target.mobile = parsePlatforms(raw);
    }
  }

  return apps;
}

function parsePlatforms(raw: string): MobilePlatform[] {
  return raw.split(',').map((value) => {
    const platform = value.trim().toLowerCase();
    if (platform !== 'android' && platform !== 'ios') {
      throw new ArgError(`--mobile only supports android and ios (got "${value}").`);
    }
    return platform;
  });
}
