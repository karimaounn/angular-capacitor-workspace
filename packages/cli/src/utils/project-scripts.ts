import { strings } from '@angular-devkit/core';
import type { Tree } from '@angular-devkit/schematics';
import { isProjectRunner, PREPARE, projectRunner, ROOT_PREREQUISITES } from './commands';
import { JsonFile, updateJson } from './json-file';
import {
  addScripts,
  addWorkspaceMember,
  appendToScript,
  documentCommands,
  documentScripts,
  PACKAGE_JSON,
  readProject,
  readProjects,
} from './workspace';

/**
 * Where a project's own npm scripts live, and how to reach them.
 *
 * Each application and site keeps its `start`, `build`, `test` and `e2e` — and
 * the `pre*` hooks that make them work on a fresh clone — in a `package.json`
 * of its own, registered as an npm workspace member. The root manifest keeps
 * only what concerns the whole workspace, so it stays the same size however
 * many projects there are. From the root, `npm run build shop` reaches a
 * project's script through the project runner (`src/cli/run.ts`), and
 * `npm run build -w @acme/shop` reaches it directly.
 *
 * Earlier 22.x releases wrote them into the root manifest as `<verb>:<project>`
 * instead, and a schematic run in one of those workspaces meets that shape:
 * `ng generate ui-lib` hooks the libraries into the apps already there, and
 * `ng generate i18n` rewrites the build of the sites already there. The handle
 * hides which shape a project has, so those callers patch whichever it is.
 * Projects generated from now on always get the member shape.
 */
export interface ProjectScripts {
  /** The manifest that holds the project's scripts. */
  readonly manifest: string;
  /** What the project's `verb` script is called in that manifest. */
  key(verb: string): string;
  /** The command that runs the project's `verb` script from the workspace root. */
  run(verb: string): string;
  /**
   * The command a reader types for it: `npm run build shop` where the root
   * `build` is the project runner, and `run(verb)` where it is not. For docs;
   * a script calling another uses `run`, which does not depend on the root.
   */
  command(verb: string): string;
  /** The command that runs a root script from where this project's scripts run. */
  rootScript(name: string): string;
  /** A workspace-root path, as seen from where this project's scripts run. */
  rootPath(path: string): string;
  /** A path inside the project, as seen from where this project's scripts run. */
  projectPath(path: string): string;
  /** The command that runs the project's `verb` script from `dir`, a workspace path. */
  runFrom(dir: string, verb: string): string;
}

/** The relative path from a workspace directory back to the workspace root. */
export function upToRoot(dir: string): string {
  const depth = dir.split('/').filter(Boolean).length;
  return depth === 0 ? '.' : Array.from({ length: depth }, () => '..').join('/');
}

/**
 * The scripts handle for an Angular project.
 *
 * A project whose root already has a `package.json` is a member. One whose
 * scripts are in the root manifest is the older shape. One with neither is
 * about to be generated, and gets the member shape — as does nothing else: a
 * project at the workspace root, which is where `ng new` puts its first app,
 * has no directory of its own to put a manifest in.
 */
export function projectScripts(tree: Tree, name: string): ProjectScripts {
  const root = readProject(tree, name).root ?? '';
  const manifest = `/${root}/package.json`;
  const rootScripts = new JsonFile(tree, PACKAGE_JSON).get<Record<string, string>>(['scripts']);
  const legacy =
    root === '' ||
    (!tree.exists(manifest) &&
      ['start', 'build', 'test'].some((verb) => rootScripts?.[`${verb}:${name}`] !== undefined));

  const command = (verb: string, fallback: string) =>
    isProjectRunner(rootScripts?.[verb], verb)
      ? `${verb === 'start' || verb === 'test' ? `npm ${verb}` : `npm run ${verb}`} ${name}`
      : fallback;

  if (legacy) {
    return {
      manifest: PACKAGE_JSON,
      key: (verb) => `${verb}:${name}`,
      run: (verb) => `npm run ${verb}:${name}`,
      command: (verb) => command(verb, `npm run ${verb}:${name}`),
      rootScript: (script) => `npm run ${script}`,
      rootPath: (path) => path,
      projectPath: (path) => (root ? `${root}/${path}` : path),
      runFrom: (dir, verb) => `npm run ${verb}:${name} --prefix ${upToRoot(dir)}`,
    };
  }

  const toRoot = upToRoot(root);
  const packageName = projectPackageName(tree, name, manifest);
  const run = (verb: string) =>
    verb === 'start' || verb === 'test'
      ? `npm ${verb} -w ${packageName}`
      : `npm run ${verb} -w ${packageName}`;
  return {
    manifest,
    key: (verb) => verb,
    run,
    command: (verb) => command(verb, run(verb)),
    rootScript: (script) => `npm run ${script} --prefix ${toRoot}`,
    rootPath: (path) => `${toRoot}/${path}`,
    projectPath: (path) => path,
    // `--prefix` and not `cd`: npm resolves it the same way on every shell,
    // and with it `-w` finds the member from anywhere in the tree.
    runFrom: (dir, verb) => `${run(verb)} --prefix ${upToRoot(dir)}`,
  };
}

/**
 * The npm package name of a project's manifest: whatever it says, once it
 * exists, since the name is the user's to change and `-w` has to match it.
 * Until then `@<workspace>/<project>`, the scheme the mobile shells use.
 */
function projectPackageName(tree: Tree, name: string, manifest: string): string {
  if (tree.exists(manifest)) {
    const declared = new JsonFile(tree, manifest).get<string>(['name']);
    if (declared) {
      return declared;
    }
  }
  const workspace = new JsonFile(tree, PACKAGE_JSON).mustGet<string>(
    ['name'],
    'the workspace name',
  );
  return `@${strings.dasherize(workspace)}/${name}`;
}

/**
 * Creates a project's own manifest and registers it as a workspace member.
 *
 * Scripts only. Dependencies stay in the root manifest, where the audit gate
 * and `doctor` read them and where Angular's builders resolve them from: the
 * project directory has no `node_modules`, and does not need one.
 */
export function ensureProjectManifest(tree: Tree, name: string): ProjectScripts {
  const scripts = projectScripts(tree, name);
  if (scripts.manifest === PACKAGE_JSON) {
    return scripts;
  }
  if (!tree.exists(scripts.manifest)) {
    const packageName = projectPackageName(tree, name, scripts.manifest);
    tree.create(
      scripts.manifest,
      `${JSON.stringify({ name: packageName, version: '0.0.0', private: true, scripts: {} }, null, 2)}\n`,
    );
  }
  addWorkspaceMember(tree, readProject(tree, name).root!);
  return scripts;
}

/** Adds a project's own scripts, by verb, wherever its scripts live. */
export function addProjectScripts(
  tree: Tree,
  scripts: ProjectScripts,
  byVerb: Record<string, string>,
): void {
  addScripts(
    tree,
    Object.fromEntries(
      Object.entries(byVerb).map(([verb, command]) => [scripts.key(verb), command]),
    ),
    scripts.manifest,
  );
}

/** Adds rows for a project's scripts to the README, by verb, as run from the root. */
export function documentProjectScripts(
  tree: Tree,
  scripts: ProjectScripts,
  byVerb: Record<string, string>,
): void {
  documentCommands(
    tree,
    Object.fromEntries(
      Object.entries(byVerb).map(([verb, description]) => [scripts.command(verb), description]),
    ),
  );
}

/** The verbs every project may have, which the `pre*` hooks are keyed on. */
const ENTRY_POINTS = ['start', 'watch', 'build', 'test', 'e2e'] as const;

/**
 * Makes a project's own entry points run codegen and build the libraries
 * first, through `PREPARE`.
 *
 * In a workspace that imports libraries from `dist/`, each of them fails on a
 * fresh clone: `start` and `e2e` cannot resolve the import, `test` the same,
 * `build` and `watch` die in Sass on a path nothing has created yet. npm hooks
 * each script under its own `pre` name, so every entry point a project has
 * needs one, whether it is run from the root through the project runner or
 * with `-w`. Only the scripts the project actually has: a hook for a script
 * nobody can run is dead weight.
 *
 * One command rather than a `npm run <prerequisite>` each, so the runner can
 * run them once for every project it runs, and the order is always
 * `ROOT_PREREQUISITES`'s. The commands 22.6 and 22.7 wrote in their place, and
 * earlier releases' root `pre<verb>:<project>`, are replaced.
 *
 * Only once a prerequisite exists: a hook with nothing to run is noise, and
 * `PREPARE` would have nothing to do.
 */
export function hookPrerequisites(tree: Tree, projectName: string): void {
  const root = new JsonFile(tree, PACKAGE_JSON).get<Record<string, string>>(['scripts']) ?? {};
  if (!ROOT_PREREQUISITES.some((script) => root[script])) {
    return;
  }
  const scripts = projectScripts(tree, projectName);
  if (!tree.exists(scripts.manifest)) {
    return;
  }
  const replaced = new Set<string>(ROOT_PREREQUISITES.map((script) => scripts.rootScript(script)));
  updateJson(tree, scripts.manifest, (file) => {
    for (const verb of ENTRY_POINTS) {
      if (!file.get<string>(['scripts', scripts.key(verb)])) {
        continue;
      }
      const hook = ['scripts', `pre${scripts.key(verb)}`];
      const parts = (file.get<string>(hook) ?? '')
        .split('&&')
        .map((part) => part.trim())
        .filter(Boolean);
      const rest = parts.filter((part) => !replaced.has(part));
      const wanted = (rest.includes(PREPARE) ? rest : [PREPARE, ...rest]).join(' && ');
      if (wanted !== parts.join(' && ')) {
        file.modify(hook, wanted);
      }
    }
  });
}

/**
 * Keeps the root `prestart`, `prebuild` and `pretest` hooks only where
 * something needs them.
 *
 * The project runner (`angular-capacitor-workspace run`) runs codegen and the
 * library build itself, once, so with it in `start`, `build` and `test` a root
 * hook would only run them again. The same goes for a root script that only
 * calls project scripts with `-w`, each of which has its own hooks. A root hook is still needed when the
 * script runs anything else: Angular's project-less `ng serve`, `ng build` or
 * `ng test`, or an earlier release's chain of root scripts.
 *
 * Re-evaluated whenever a root hook or one of those scripts changes, since the
 * answer changes with them. Only the exact command written here is ever
 * removed, so anything else in a hook is left alone.
 */
export function syncRootHooks(tree: Tree): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const scripts = file.get<Record<string, string>>(['scripts']) ?? {};
    for (const verb of ['start', 'build', 'test']) {
      const hook = `pre${verb}`;
      const covered = delegatesToProjects(verb, scripts[verb]);
      // Prepended in reverse, so the hook runs them in ROOT_PREREQUISITES order.
      for (const prerequisite of [...ROOT_PREREQUISITES].reverse()) {
        if (!scripts[prerequisite]) {
          continue;
        }
        const command = `npm run ${prerequisite}`;
        const parts = (file.get<string>(['scripts', hook]) ?? '')
          .split('&&')
          .map((part) => part.trim())
          .filter(Boolean);
        const without = parts.filter((part) => part !== command);
        const wanted = covered ? without : parts.includes(command) ? parts : [command, ...parts];
        if (wanted.length === 0) {
          file.remove(['scripts', hook]);
        } else if (wanted.join(' && ') !== parts.join(' && ')) {
          file.modify(['scripts', hook], wanted.join(' && '));
        }
      }
    }
  });
}

/**
 * Whether a root script needs no root hook: the project runner, which runs
 * what a hook would itself, or nothing but project scripts, `npm run <verb> -w
 * <package>`, each of which carries its own `pre*` hooks.
 *
 * An earlier release's root `npm run <verb>:<project>` does not count: not
 * every 22.x hooked each of those, so the root hooks of a workspace from one
 * stay as they are.
 */
function delegatesToProjects(verb: string, command: string | undefined): boolean {
  if (!command) {
    return false;
  }
  if (isProjectRunner(command, verb)) {
    return true;
  }
  return command
    .split('&&')
    .map((part) => part.trim())
    .every((part) => /^npm (?:run )?[\w-]+ -w \S+$/.test(part));
}

/**
 * Adds an application to `npm run build`.
 *
 * `ng build`, unlike `ng test`, is single-target: with no project named it
 * builds the only one, and with several it is an error. So the aggregate is an
 * `&&` chain of the per-project builds, which also keeps each project's
 * `prebuild` hook running.
 *
 * While the script is still Angular's project-less `ng build`, it is replaced
 * by every application already in the workspace, not just this one. In a fresh
 * workspace that is the same thing; in `ng add` into an existing one, starting
 * from this app alone would silently stop building the apps that were there
 * first. A `build` script someone has rewritten is appended to.
 *
 * Nothing to do where `build` is the project runner, which finds every app
 * itself. The chain is what a workspace from an earlier 22.x has.
 */
export function addToBuild(tree: Tree, name: string): void {
  if (isProjectRunner(rootScript(tree, 'build'), 'build')) {
    return;
  }
  updateJson(tree, PACKAGE_JSON, (file) => {
    const existing = file.get<string>(['scripts', 'build']);
    if (existing !== undefined && existing.trim() !== 'ng build') {
      return;
    }
    const apps = Object.entries(readProjects(tree))
      .filter(
        ([, project]) => project.projectType === 'application' && project.architect?.['build'],
      )
      .map(([app]) =>
        hasProjectScript(tree, app, 'build')
          ? projectScripts(tree, app).run('build')
          : `ng build ${app}`,
      );
    if (apps.length > 0) {
      file.modify(['scripts', 'build'], apps.join(' && '));
    } else {
      file.remove(['scripts', 'build']);
    }
  });
  appendToScript(tree, 'build', projectScripts(tree, name).run('build'));
  syncRootHooks(tree);
  documentScripts(tree, { build: 'builds every app in the workspace' });
}

/**
 * Adds a project's e2e suite to `npm run e2e`.
 *
 * Where the root `build` is the project runner, `e2e` is too, which finds every
 * suite itself: it is written here when the first suite arrives in a
 * workspace generated without Playwright. Elsewhere it is a chain, as an
 * earlier 22.x wrote it.
 */
export function addToE2e(tree: Tree, name: string): void {
  const e2e = rootScript(tree, 'e2e');
  if (isProjectRunner(e2e, 'e2e')) {
    return;
  }
  if (e2e === undefined && isProjectRunner(rootScript(tree, 'build'), 'build')) {
    addScripts(tree, { e2e: projectRunner('e2e') });
    documentCommands(tree, {
      'npm run e2e [<project>]': "runs one project's Playwright suite, or every one",
    });
    return;
  }
  appendToScript(tree, 'e2e', projectScripts(tree, name).run('e2e'));
  documentScripts(tree, { e2e: 'every Playwright suite in the workspace' });
}

function rootScript(tree: Tree, name: string): string | undefined {
  return new JsonFile(tree, PACKAGE_JSON).get<string>(['scripts', name]);
}

function hasProjectScript(tree: Tree, name: string, verb: string): boolean {
  const scripts = projectScripts(tree, name);
  return (
    tree.exists(scripts.manifest) &&
    new JsonFile(tree, scripts.manifest).get<string>(['scripts', scripts.key(verb)]) !== undefined
  );
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
 *
 * That is an earlier 22.x's answer, kept for the workspaces it generated.
 * Where `start` is the project runner there is no default to claim: the reader
 * names the app.
 */
export function claimDefaultStart(tree: Tree, name: string): void {
  if (isProjectRunner(rootScript(tree, 'start'), 'start')) {
    return;
  }
  const start = projectScripts(tree, name).run('start');
  let claimed = false;
  updateJson(tree, PACKAGE_JSON, (file) => {
    const existing = file.get<string>(['scripts', 'start']);
    if (existing !== undefined && existing !== 'ng serve') {
      return;
    }
    file.modify(['scripts', 'start'], start);
    file.modify(['scripts', 'watch'], `ng build ${name} --watch --configuration development`);
    claimed = true;
  });
  syncRootHooks(tree);

  if (claimed) {
    documentScripts(tree, {
      start: `\`${start}\` — the first app generated is the default`,
      watch: `rebuilds \`${name}\` on change`,
    });
  }
}
