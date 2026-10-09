/**
 * The commands a generated workspace's npm scripts run.
 *
 * The scripts call this package's own CLI instead of a copy of a script in the
 * workspace, so a fix to one reaches every workspace with an
 * `npm install`, and nobody edits a script the generator will want to update.
 * What a workspace tunes, it tunes in a config file it owns.
 *
 * No imports, so the CLI's commands can share these without loading the
 * schematics engine on every `npm start`.
 */

/** The bin this package installs, which the generated scripts call. */
export const CLI = 'angular-capacitor-workspace';

/** `sitemap site` → `angular-capacitor-workspace sitemap site`. */
export function cli(args: string): string {
  return `${CLI} ${args}`;
}

/**
 * The root script that runs a project's script by name, or every project's
 * (`src/cli/run.ts`). The root `start`, `watch`, `build`, `test` and `e2e` are
 * this with the verb, so the root manifest names no project.
 */
export function projectRunner(verb: string): string {
  return cli(`run ${verb}`);
}

/**
 * Whether a root script is the project runner for `verb`: this release's, or
 * the copy 22.5 wrote into `scripts/project.mjs`, which a workspace from it
 * still runs.
 */
export function isProjectRunner(command: string | undefined, verb: string): boolean {
  return command === projectRunner(verb) || command === `node scripts/project.mjs ${verb}`;
}

/** The variable that holds the OpenAPI document, when codegen is not told another. */
export const DEFAULT_SPEC_ENV = 'OPENAPI_SPEC';

/**
 * The root scripts that run before a project's entry points, in the order they
 * run: codegen first, since a library can import the client. Each project's
 * `pre*` hooks run them through `PREPARE`, and the project runner runs them
 * itself, once, however many projects it runs.
 */
export const ROOT_PREREQUISITES = ['codegen:optional', 'build:libs'] as const;

/** The command in each project's `pre*` hooks, which runs `ROOT_PREREQUISITES`. */
export const PREPARE = cli('prepare');

/**
 * Set by the project runner for what it spawns once it has run
 * `ROOT_PREREQUISITES`, so the projects' own hooks below it skip them.
 * Without it `npm run build` built the libraries once per app and site.
 */
export const PREPARED_ENV = 'ANGULAR_CAPACITOR_WORKSPACE_PREPARED';
