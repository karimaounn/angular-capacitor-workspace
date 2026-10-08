import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_PREREQUISITES } from '../utils/commands';
import { Exit, fail, workspaceRoot } from './command';

/**
 * `run <verb> [<project>] [flags]` — one project's script, or every project's,
 * from the workspace root. The root `start`, `watch`, `build`, `test` and `e2e`
 * are this:
 *
 *     npm start <app>               serves one app or site
 *     npm run watch <app>           rebuilds one app or site on change
 *     npm run build [<project>]     builds one project, or every app and site
 *     npm test [<project>]          tests one project, or every project once
 *     npm run e2e [<project>]       one project's Playwright suite, or every one
 *
 * Flags after the name go to the project, behind npm's `--`:
 * `npm start -- shop --port 4300`.
 *
 * Each app and site keeps its scripts in a package.json of its own, an npm
 * workspace member, and this finds that from angular.json. So the root
 * package.json names no project, nothing changes when one is added, and nothing
 * is a default: serving needs a name. The project's own `pre*` and `post*`
 * hooks still run, because its script is run through npm.
 *
 * A project without a manifest of its own, such as a library or an app Angular
 * generated before the workspace adopted the generator, is run with `ng`.
 */
export const VERBS = ['start', 'watch', 'build', 'test', 'e2e'] as const;
type Verb = (typeof VERBS)[number];

interface Project {
  projectType?: string;
  root?: string;
}

interface Manifest {
  name?: string;
  workspaces?: string[];
  scripts?: Record<string, string>;
}

export function run(args: readonly string[], cwd: string): number {
  const [verb, ...rest] = args;
  if (!(VERBS as readonly string[]).includes(verb ?? '')) {
    fail(`usage: angular-capacitor-workspace run <${VERBS.join('|')}> [<project>] [flags]`, 2);
  }
  const name = rest[0] && !rest[0].startsWith('-') ? rest.shift() : undefined;
  return new Runner(workspaceRoot(cwd), verb as Verb, rest).run(name);
}

class Runner {
  private readonly projects: Record<string, Project>;
  private readonly rootManifest: Manifest;
  private readonly members: Set<string>;
  private prepared = false;

  constructor(
    private readonly root: string,
    private readonly verb: Verb,
    private readonly flags: readonly string[],
  ) {
    this.projects =
      this.readJson<{ projects?: Record<string, Project> }>('angular.json').projects ?? {};
    this.rootManifest = this.readJson<Manifest>('package.json');
    this.members = new Set(this.rootManifest.workspaces ?? []);
  }

  run(name: string | undefined): number {
    const { projects, verb } = this;
    const apps = Object.keys(projects).filter(
      (key) => projects[key]!.projectType === 'application',
    );

    if (name) {
      if (!projects[name]) {
        fail(`There is no project "${name}". Projects: ${Object.keys(projects).join(', ')}.`);
      }
      this.runProject(name);
    } else if (verb === 'start' || verb === 'watch') {
      // One command serves one app, and choosing one for the reader is what
      // this exists to avoid.
      fail(
        `Name the app: npm ${verb === 'start' ? 'start' : 'run watch'} <app>.\n` +
          `Apps: ${apps.join(', ') || '(none yet — ng generate angular-capacitor-workspace:app)'}.`,
      );
    } else if (verb === 'test') {
      // A project-less `ng test` already runs every project, libraries
      // included, in one process. Running each project's own script instead
      // would build the libraries once per project.
      this.prepare();
      this.spawn('ng', ['test', '--no-watch', ...this.flags]);
    } else if (verb === 'e2e') {
      const suites = Object.keys(projects).filter((key) => this.ownScript(key, 'e2e'));
      if (suites.length === 0) {
        fail('No project has an e2e suite.');
      }
      suites.forEach((project) => this.runProject(project));
    } else if (apps.length > 0) {
      apps.forEach((project) => this.runProject(project));
    } else {
      // No apps: Angular's own project-less build, which builds the only project.
      this.spawn('ng', ['build', ...this.flags]);
    }
    return 0;
  }

  /** Runs the verb for one project: its own script when it has one, `ng` otherwise. */
  private runProject(project: string): void {
    const { verb, flags } = this;
    const manifest = this.ownScript(project, verb);
    if (manifest) {
      const npmVerb = verb === 'start' || verb === 'test' ? [verb] : ['run', verb];
      this.spawn('npm', [
        ...npmVerb,
        '-w',
        manifest.name!,
        ...(flags.length ? ['--', ...flags] : []),
      ]);
      return;
    }
    if (verb === 'e2e') {
      fail(`"${project}" has no e2e suite.`);
    }
    // An app without hooks of its own still imports the libraries from dist/.
    if (this.projects[project]!.projectType === 'application') {
      this.prepare();
    }
    const ng = {
      start: ['serve', project],
      watch: ['build', project, '--watch', '--configuration', 'development'],
      build: ['build', project],
      test: ['test', project],
    }[verb];
    this.spawn('ng', [...ng, ...flags]);
  }

  /** The project's own manifest, if it is a workspace member with that script. */
  private ownScript(project: string, script: string): Manifest | undefined {
    const root = this.projects[project]!.root;
    if (!root || !this.members.has(root)) {
      return undefined;
    }
    const manifest = this.readJson<Manifest>(join(root, 'package.json'));
    return manifest.scripts?.[script] ? manifest : undefined;
  }

  /** What the projects' own `pre*` hooks would run, once. */
  private prepare(): void {
    if (this.prepared) {
      return;
    }
    this.prepared = true;
    for (const script of ROOT_PREREQUISITES) {
      if (this.rootManifest.scripts?.[script]) {
        this.spawn('npm', ['run', script]);
      }
    }
  }

  private spawn(command: string, args: readonly string[]): void {
    const result = spawnSync(command, args, {
      cwd: this.root,
      stdio: 'inherit',
      // `npm` and `ng` are .cmd shims on Windows, which only a shell runs.
      shell: process.platform === 'win32',
    });
    if (result.status !== 0) {
      throw new Exit(result.status ?? 1);
    }
  }

  private readJson<T>(file: string): T {
    return JSON.parse(readFileSync(join(this.root, file), 'utf8')) as T;
  }
}
