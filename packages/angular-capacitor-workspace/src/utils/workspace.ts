import { SchematicsException, type Tree } from '@angular-devkit/schematics';
import { JsonFile, updateJson } from './json-file';

export const ANGULAR_JSON = '/angular.json';
export const PACKAGE_JSON = '/package.json';
export const TSCONFIG_JSON = '/tsconfig.json';

export interface AngularProject {
  projectType?: 'application' | 'library';
  root?: string;
  sourceRoot?: string;
  prefix?: string;
  architect?: Record<string, { builder?: string; options?: Record<string, unknown> }>;
}

export function readProjects(tree: Tree): Record<string, AngularProject> {
  const file = new JsonFile(tree, ANGULAR_JSON);
  return file.mustGet<Record<string, AngularProject>>(['projects'], 'the workspace project map');
}

export function readProject(tree: Tree, name: string): AngularProject {
  const projects = readProjects(tree);
  const project = projects[name];
  if (!project) {
    throw new SchematicsException(
      `Project "${name}" is not in ${ANGULAR_JSON}. Known projects: ` +
        `${Object.keys(projects).join(', ') || '(none)'}.`,
    );
  }
  return project;
}

/**
 * Every builder the workspace actually uses.
 *
 * This is what the policy's builder guards are checked against: a prune rule
 * naming `@angular-devkit/build-angular:*` must not fire if some target still
 * resolves to that builder, whoever added it.
 */
export function collectBuilders(tree: Tree): Set<string> {
  const builders = new Set<string>();
  if (!tree.exists(ANGULAR_JSON)) {
    return builders;
  }
  for (const project of Object.values(readProjects(tree))) {
    for (const target of Object.values(project.architect ?? {})) {
      if (target.builder) {
        builders.add(target.builder);
      }
    }
  }
  return builders;
}

/** Adds dependencies without clobbering ranges a user may have raised. */
export function addDependencies(
  tree: Tree,
  deps: Record<string, string>,
  block: 'dependencies' | 'devDependencies' = 'devDependencies',
  { overwrite = false }: { overwrite?: boolean } = {},
): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    for (const [name, range] of Object.entries(deps)) {
      if (!overwrite && file.has([block, name])) {
        continue;
      }
      file.modify([block, name], range);
    }
    file.sortKeys([block]);
  });
}

/**
 * Adds npm scripts, refusing to overwrite one that already differs.
 *
 * Silently replacing a script is how a regenerate eats a user's customisation.
 */
export function addScripts(tree: Tree, scripts: Record<string, string>): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    for (const [name, command] of Object.entries(scripts)) {
      const existing = file.get<string>(['scripts', name]);
      if (existing !== undefined && existing !== command) {
        continue;
      }
      file.modify(['scripts', name], command);
    }
  });
}

/**
 * Declares the runtime floor the generated workspace needs.
 *
 * Unlike `addScripts`, an existing value is replaced rather than preserved. A
 * floor is a correctness constraint, not a preference: the generated workspace
 * runs this package's own `audit` and `doctor`, so it needs at least what this
 * package needs. Leaving a lower floor in place because something wrote one
 * first is how the workspace ends up claiming to support a runtime on which its
 * own dependency policy silently does nothing.
 */
export function setEngines(tree: Tree, engines: Record<string, string>): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    for (const [name, range] of Object.entries(engines)) {
      file.modify(['engines', name], range);
    }
  });
}

/**
 * Appends a command to a script, building up a chain across schematic runs.
 *
 * `build:libs` is the motivating case: Angular has no way to build every
 * library in one command, so each library schematic adds its own `ng build`.
 * Sequential `&&` rather than parallel because libraries can depend on one
 * another, and generation order is the only dependency order we know.
 */
export function appendToScript(tree: Tree, name: string, command: string): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const existing = file.get<string>(['scripts', name]);
    if (existing === undefined) {
      file.modify(['scripts', name], command);
      return;
    }
    if (existing.split('&&').some((part) => part.trim() === command.trim())) {
      return;
    }
    file.modify(['scripts', name], `${existing} && ${command}`);
  });
}

/**
 * Chains a script onto an npm `pre*` hook, preserving anything already there.
 *
 * Codegen needs to run before every build, serve and test entry point, and the
 * hooks are shared with whatever else the workspace has bolted on.
 */
export function prependHook(tree: Tree, hookName: string, command: string): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const existing = file.get<string>(['scripts', hookName]);
    if (existing === undefined) {
      file.modify(['scripts', hookName], command);
      return;
    }
    if (existing.includes(command)) {
      return;
    }
    file.modify(['scripts', hookName], `${command} && ${existing}`);
  });
}

/**
 * Makes a project's own entry points build the libraries first.
 *
 * The root `prestart`, `pretest` and `prebuild` hooks cover `npm start`,
 * `npm test` and `npm run build` — and nothing else. Every project adds four
 * more entry points of its own, and in a workspace that imports libraries from
 * `dist/` all four fail on a fresh clone: `start:` and `e2e:` cannot resolve
 * the import, `test:` the same, `build:` dies in Sass on a path nothing has
 * created yet. npm hooks each of them under its own `pre` name, which is the
 * only place a fix can go.
 *
 * Only the scripts the project actually has, and only once `build:libs`
 * exists: a `pre` hook for a script nobody can run is dead weight, and one
 * calling a script that does not exist fails on first use.
 */
export function hookLibraryBuild(tree: Tree, projectName: string): void {
  const scripts = new JsonFile(tree, PACKAGE_JSON).get<Record<string, string>>(['scripts']) ?? {};
  if (!scripts['build:libs']) {
    return;
  }
  for (const verb of ['start', 'build', 'test', 'e2e']) {
    if (scripts[`${verb}:${projectName}`]) {
      prependHook(tree, `pre${verb}:${projectName}`, 'npm run build:libs');
    }
  }
}

/** Registers a directory as an npm workspace member. */
export function addWorkspaceMember(tree: Tree, pattern: string): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const members = file.get<string[]>(['workspaces']) ?? [];
    if (members.includes(pattern)) {
      return;
    }
    file.modify(['workspaces'], [...members, pattern].sort());
  });
}

/**
 * Maps a library onto its build output in the root `tsconfig.json`.
 *
 * Consuming libraries from `dist/` rather than from source is the workspace
 * convention this generator encodes; it keeps apps honest about the public API
 * surface, at the cost of needing `build:libs` before a first `ng serve`. The
 * `prestart`/`pretest` hooks cover most of that, and the generated README
 * covers the rest.
 */
export function addLibraryPath(tree: Tree, importName: string, distPath: string): void {
  updateJson(tree, TSCONFIG_JSON, (file) => {
    file.mustGet(['compilerOptions'], 'the root compilerOptions block');
    file.modify(['compilerOptions', 'paths', importName], [distPath]);
    file.modify(['compilerOptions', 'paths', `${importName}/*`], [`${distPath}/*`]);
  });
}

/**
 * Lets an application's stylesheets resolve `@use '<lib>/styles'` through
 * `dist/`.
 *
 * Sass does not read tsconfig `paths`, so the mapping that makes
 * `import { Button } from 'ui'` work does nothing for SCSS. Adding `dist` to
 * the style include paths is the stylesheet equivalent of that mapping.
 *
 * Applied to every application whether or not a library exists yet: an include
 * path that resolves nothing is inert, and applying it up front means an app
 * generated before the library still works when the library arrives.
 */
export function addStyleIncludePath(tree: Tree, projectName: string, path = 'dist'): void {
  updateJson(tree, ANGULAR_JSON, (file) => {
    const optionPath = [
      'projects',
      projectName,
      'architect',
      'build',
      'options',
      'stylePreprocessorOptions',
      'includePaths',
    ];
    const existing = file.get<string[]>(optionPath) ?? [];
    if (!existing.includes(path)) {
      file.modify(optionPath, [...existing, path]);
    }
  });
}

/**
 * `acme-shop` → `Acme Shop`. A starting point for a heading, which the user
 * owns from the moment it is written.
 */
export function titleFromName(name: string): string {
  return name
    .split(/[-_/]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/** A design-system library in this workspace: its import name and selector prefix. */
export interface DesignSystem {
  name: string;
  prefix: string;
}

/**
 * Finds the design-system library, if the workspace has one.
 *
 * Identified by the file that makes it one — `src/styles/index.scss`, the
 * entry point applications `@use` — rather than by name or by position in the
 * project map. A workspace can hold several libraries, and only this one has a
 * token sheet to wire into an application.
 *
 * Detection rather than an option, because both callers need the same answer
 * from different directions: during a full generation the library was created
 * moments ago, and for a bare `ng generate app` it was created months ago by
 * someone who will not think to pass its name.
 */
export function findDesignSystem(tree: Tree): DesignSystem | undefined {
  for (const [name, project] of Object.entries(readProjects(tree))) {
    if (project.projectType !== 'library' || !project.root) {
      continue;
    }
    if (tree.exists(`/${project.root}/src/styles/index.scss`)) {
      return { name, prefix: project.prefix ?? name.split('/').pop()! };
    }
  }
  return undefined;
}

/**
 * Points an application's global stylesheet at the design system.
 *
 * Without this the tokens are generated, built and published, and no
 * application ever loads them — every `var(--surface)` in the library resolves
 * to nothing and the components render unstyled. `stylePreprocessorOptions`
 * only makes the import *resolvable*; something still has to write the import.
 *
 * Prepended, and idempotent on the `@use` line: `@use` must precede every rule
 * in a Sass file, so appending to a stylesheet somebody has already written in
 * is a compile error rather than a merge conflict.
 */
export function importDesignSystemStyles(tree: Tree, projectName: string, library: string): void {
  const path = globalStylesheet(tree, projectName);
  if (!path) {
    return;
  }

  const current = tree.read(path)?.toString('utf8') ?? '';
  const statement = `@use '${library}/styles' as *;`;
  if (current.includes(`'${library}/styles'`)) {
    return;
  }

  tree.overwrite(
    path,
    `${statement}\n\n` +
      `// Design tokens, base element styling and every palette come from the\n` +
      `// line above. It resolves through dist/, like the library's TypeScript\n` +
      `// does, so \`npm run build:libs\` has to have run at least once.\n` +
      `//\n` +
      `// Anything written below overrides it: the tokens live in the \`tokens\`\n` +
      `// cascade layer and this file is unlayered, so a rule here wins without\n` +
      `// needing to out-specify anything.\n` +
      `${current.trimStart()}`,
  );
}

/** The project's own `styles.scss`, as `angular.json` names it. */
function globalStylesheet(tree: Tree, projectName: string): string | undefined {
  const project = readProject(tree, projectName);
  const styles = (project.architect?.['build']?.options?.['styles'] ?? []) as StyleEntry[];
  for (const entry of styles) {
    const input = styleInput(entry);
    if (input?.endsWith('.scss') && tree.exists(`/${input}`)) {
      return `/${input}`;
    }
  }
  return undefined;
}

/** A `styles` entry in `angular.json`: a path, or a path with build options. */
type StyleEntry = string | { input?: string };

function styleInput(entry: StyleEntry): string | undefined {
  return typeof entry === 'string' ? entry : entry.input;
}

/**
 * Puts global stylesheets at the front of an application's `styles`, once each.
 *
 * The front, not the end, and that is the whole reason this is a helper rather
 * than a push. `styles` is concatenated in the order it is written, so a vendor
 * sheet appended after the application's own wins every rule the application
 * wrote to override it — same specificity, later wins, no warning from anyone.
 * A sheet that arrives first is one the app can restyle, which is the only
 * arrangement that leaves the user in charge of their own workspace.
 *
 * Idempotent on the path, so re-running for a package the app already has
 * leaves the array — and any reordering someone did on purpose — alone.
 */
export function prependStyles(tree: Tree, projectName: string, styles: readonly string[]): void {
  updateJson(tree, ANGULAR_JSON, (file) => {
    const optionPath = ['projects', projectName, 'architect', 'build', 'options', 'styles'];
    const existing = file.mustGet<StyleEntry[]>(
      optionPath,
      `the build \`styles\` of application "${projectName}", which the Angular ` +
        `application schematic writes`,
    );
    const have = new Set(existing.map(styleInput));
    const missing = styles.filter((style) => !have.has(style));
    if (missing.length > 0) {
      file.modify(optionPath, [...missing, ...existing]);
    }
  });
}

export const README_MD = '/README.md';
export const SCRIPTS_TABLE_START = '<!-- angular-capacitor-workspace:scripts -->';
export const SCRIPTS_TABLE_END = '<!-- /angular-capacitor-workspace:scripts -->';

/**
 * Adds rows to the scripts table in the generated README, idempotently.
 *
 * Each schematic documents the scripts it adds, at the point it adds them, so
 * the table lists what this workspace actually has — including what a later
 * `ng generate` brings — rather than a fixed list that is wrong for most
 * feature combinations.
 *
 * Unlike the JSON patches, a missing anchor is not an error. The README is the
 * user's to rewrite, and failing `ng generate app` because someone did would
 * put the documentation ahead of the thing it documents.
 */
export function documentScripts(tree: Tree, scripts: Record<string, string>): void {
  if (!tree.exists(README_MD)) {
    return;
  }
  const current = tree.read(README_MD)!.toString('utf8');
  const start = current.indexOf(SCRIPTS_TABLE_START);
  const end = current.indexOf(SCRIPTS_TABLE_END, start);
  if (start === -1 || end === -1) {
    return;
  }

  const table = current.slice(start + SCRIPTS_TABLE_START.length, end);
  const rows = Object.entries(scripts)
    .map(([name, description]) => ({ cell: `| \`${invocation(name)}\` |`, description }))
    .filter(({ cell }) => !table.includes(cell))
    .map(({ cell, description }) => `${cell} ${description} |`);
  if (rows.length === 0) {
    return;
  }

  // The blank line before the end marker ends the table unambiguously. Without
  // it, whether the marker reads as one more table row is up to the renderer.
  const head = current.slice(0, start + SCRIPTS_TABLE_START.length);
  const tail = current.slice(end);
  tree.overwrite(README_MD, `${head}${table.trimEnd()}\n${rows.join('\n')}\n\n${tail}`);
}

/** `start` and `test` are the two scripts npm runs without `run`. */
function invocation(script: string): string {
  return script === 'start' || script === 'test' ? `npm ${script}` : `npm run ${script}`;
}

export const MOBILE_SECTION_START = '<!-- angular-capacitor-workspace:mobile -->';
export const MOBILE_SECTION_END = '<!-- /angular-capacitor-workspace:mobile -->';

/**
 * Written once, ahead of the first app's block: the heading a reader sees,
 * and the one sentence of "why" that no per-app block should have to repeat.
 */
const MOBILE_INTRO = `## Mobile

Each mobile app is a Capacitor shell, registered as its own npm workspace
member so its plugins resolve from there instead of the workspace root.`;

/**
 * Appends one app's mobile setup to the README's Mobile section, idempotently.
 *
 * The empty section markers ship in the workspace template unconditionally —
 * same placement whether or not this workspace has a mobile app — so a
 * workspace generated with none renders nothing between them (no heading, no
 * empty section) and a mobile app added later with `ng generate` still has
 * an anchor to write into, not only one chosen at generation time.
 */
export function documentMobile(tree: Tree, block: string): void {
  if (!tree.exists(README_MD)) {
    return;
  }
  const current = tree.read(README_MD)!.toString('utf8');
  const start = current.indexOf(MOBILE_SECTION_START);
  const end = current.indexOf(MOBILE_SECTION_END, start);
  if (start === -1 || end === -1) {
    return;
  }

  const existing = current.slice(start + MOBILE_SECTION_START.length, end);
  const heading = block.match(/^###.+$/m)?.[0];
  if (heading && existing.includes(heading)) {
    return;
  }

  const head = current.slice(0, start + MOBILE_SECTION_START.length);
  const tail = current.slice(end);
  const body = existing.trim()
    ? `${existing.trim()}\n\n${block.trim()}`
    : `${MOBILE_INTRO}\n\n${block.trim()}`;
  tree.overwrite(README_MD, `${head}\n\n${body}\n\n${tail}`);
}

/** Appends lines to `.gitignore` under a labelled section, idempotently. */
export function addGitignoreSection(tree: Tree, heading: string, patterns: string[]): void {
  const path = '/.gitignore';
  const current = tree.exists(path) ? tree.read(path)!.toString('utf8') : '';
  const missing = patterns.filter((pattern) => !current.split('\n').includes(pattern));
  if (missing.length === 0) {
    return;
  }

  const block = `\n# ${heading}\n${missing.join('\n')}\n`;
  if (tree.exists(path)) {
    tree.overwrite(path, current.replace(/\n*$/, '\n') + block);
  } else {
    tree.create(path, block.trimStart());
  }
}

/**
 * Makes `npm test` run every project's unit tests, once.
 *
 * `ng test` is one of the CLI's multi-target commands: with no project named it
 * runs every project that has a `test` target, and exits non-zero if any fails
 * without skipping the rest. That already is the aggregate — including projects
 * added later by hand or by Angular's own schematics — so nothing is composed
 * per project. It only needs `--no-watch`: the unit-test builder watches by
 * default in a terminal, and a watching first project would never hand over
 * to the second.
 *
 * A `test` script someone has rewritten is left alone.
 */
export function aggregateTests(tree: Tree): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const existing = file.get<string>(['scripts', 'test']);
    if (existing === undefined || existing.trim() === 'ng test') {
      file.modify(['scripts', 'test'], 'ng test --no-watch');
    }
  });
  documentScripts(tree, {
    test: 'every unit-test suite in the workspace, once, without watching',
  });
}

/**
 * Adds an application to `npm run build`.
 *
 * `ng build`, unlike `ng test`, is single-target: with no project named it
 * builds the only one, and with several it is an error. So the aggregate is an
 * `&&` chain of the per-app scripts, which also keeps each app's `prebuild:*`
 * hooks running.
 *
 * While the script is still Angular's project-less `ng build`, it is replaced
 * by every application already in the workspace, not just this one. In a fresh
 * workspace that is the same thing; in `ng add` into an existing one, starting
 * from this app alone would silently stop building the apps that were there
 * first. A `build` script someone has rewritten is appended to.
 */
export function addToBuild(tree: Tree, name: string): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const existing = file.get<string>(['scripts', 'build']);
    if (existing !== undefined && existing.trim() !== 'ng build') {
      return;
    }
    const scripts = file.get<Record<string, string>>(['scripts']) ?? {};
    const apps = Object.entries(readProjects(tree))
      .filter(
        ([, project]) => project.projectType === 'application' && project.architect?.['build'],
      )
      .map(([app]) => (scripts[`build:${app}`] ? `npm run build:${app}` : `ng build ${app}`));
    if (apps.length > 0) {
      file.modify(['scripts', 'build'], apps.join(' && '));
    } else {
      file.remove(['scripts', 'build']);
    }
  });
  appendToScript(tree, 'build', `npm run build:${name}`);
  documentScripts(tree, { build: 'builds every app in the workspace' });
}

/**
 * Makes `npm start` and `npm run watch` mean this project, if nothing has
 * claimed them yet.
 *
 * Angular's `start` and `watch` are project-less, which works in a
 * single-project workspace and fails in this one — `ng serve` with three
 * projects and no default is an error, not a choice. Unlike `build` and
 * `test`, these cannot aggregate: one command serves one app. So the first app
 * generated takes them, and a marketing site takes them only when there is no
 * app.
 */
export function claimDefaultStart(tree: Tree, name: string): void {
  let claimed = false;
  updateJson(tree, PACKAGE_JSON, (file) => {
    const start = file.get<string>(['scripts', 'start']);
    if (start !== undefined && start !== 'ng serve') {
      return;
    }
    file.modify(['scripts', 'start'], `npm run start:${name}`);
    file.modify(['scripts', 'watch'], `ng build ${name} --watch --configuration development`);
    claimed = true;
  });

  if (claimed) {
    documentScripts(tree, {
      start: `\`npm run start:${name}\` — the first app generated is the default`,
      watch: `rebuilds \`${name}\` on change`,
    });
  }
}

/** Angular's dev-server port when a project does not set one. */
const DEFAULT_DEV_PORT = 4200;

/**
 * The lowest dev-server port no application in the workspace uses.
 *
 * Distinct because two apps in one workspace are routinely served at once, and
 * Angular's default of 4200-for-everyone turns that into a race. Read from
 * `angular.json` rather than counted, so deleting an app does not hand its
 * neighbour's port to the next one generated. An app with no port of its own
 * is taken to be on Angular's default.
 */
export function nextFreePort(tree: Tree): number {
  if (!tree.exists(ANGULAR_JSON)) {
    return DEFAULT_DEV_PORT;
  }

  const used = new Set<number>();
  for (const project of Object.values(readProjects(tree))) {
    if (project.projectType === 'library') {
      continue;
    }
    const port = project.architect?.['serve']?.options?.['port'];
    used.add(typeof port === 'number' ? port : DEFAULT_DEV_PORT);
  }

  let port = DEFAULT_DEV_PORT;
  while (used.has(port)) {
    port++;
  }
  return port;
}

/**
 * Writes a project's dev-server port into `angular.json`.
 *
 * There, rather than only in the Playwright config, so `npm run start:<app>`,
 * a bare `ng serve <app>` and the e2e suite all agree on where the app lives.
 */
export function setDevServerPort(tree: Tree, name: string, port: number): void {
  updateJson(tree, ANGULAR_JSON, (file) => {
    const serve = ['projects', name, 'architect', 'serve'];
    file.mustGet(serve, `the "serve" target for "${name}", which the Angular schematic creates`);
    file.modify([...serve, 'options', 'port'], port);
  });
}

/**
 * Adds a project to the root `tsconfig.json` references.
 *
 * The root config is solution-style — `"files": []` plus references — and an
 * editor uses the references to decide which tsconfig governs a file. A
 * tsconfig nobody references still works with `tsc -p`, but the editor checks
 * its files against the wrong options.
 */
export function addTsconfigReference(tree: Tree, path: string): void {
  updateJson(tree, TSCONFIG_JSON, (file) => {
    const references = file.get<Array<{ path: string }>>(['references']);
    if (references === undefined) {
      file.modify(['references'], [{ path }]);
    } else if (!references.some((reference) => reference.path === path)) {
      file.modify(['references', -1], { path });
    }
  });
}

/**
 * Appends a `## heading` section to a Markdown file, once.
 *
 * The heading is the idempotency key, so a second run finds its own section and
 * leaves it alone. As with the scripts table, a missing file is not an error:
 * the docs are the user's to delete, and failing generation over it would put
 * the documentation ahead of what it documents.
 */
export function appendSection(tree: Tree, path: string, heading: string, body: string): void {
  if (!tree.exists(path)) {
    return;
  }
  const current = tree.read(path)!.toString('utf8');
  if (current.split('\n').includes(`## ${heading}`)) {
    return;
  }
  tree.overwrite(path, `${current.replace(/\n*$/, '\n')}\n## ${heading}\n\n${body.trim()}\n`);
}
