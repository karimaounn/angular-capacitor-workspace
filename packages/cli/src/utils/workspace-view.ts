import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Tree } from '@angular-devkit/schematics';
import { JsonFile } from './json-file';
import type { AngularProject } from './workspace';

/**
 * A read-only look at a workspace, the same whether it is a schematic `Tree` or
 * a directory on disk.
 *
 * It exists so a plugin says once how it recognises itself. The schematics read
 * the tree they are editing; `doctor`, `audit` and `ng add` read the workspace
 * from disk; and a plugin's `detect` answers all of them from one function, so
 * generation and `doctor` cannot come to disagree about what a workspace has.
 *
 * Paths are workspace-relative, with no leading slash: `projects/ui/src/...`.
 */
export interface WorkspaceView {
  /** `angular.json`'s projects, or none when the workspace has no `angular.json`. */
  readonly projects: Readonly<Record<string, AngularProject>>;
  /** The root manifest's dependency blocks, merged. */
  readonly dependencies: Readonly<Record<string, string>>;
  exists(path: string): boolean;
  /** A file's text, or `undefined` when it does not exist. */
  read(path: string): string | undefined;
}

type Manifest = Partial<
  Record<'dependencies' | 'devDependencies' | 'optionalDependencies', Record<string, string>>
>;

function merged(manifest: Manifest | undefined): Record<string, string> {
  return {
    ...manifest?.dependencies,
    ...manifest?.devDependencies,
    ...manifest?.optionalDependencies,
  };
}

/** The workspace a schematic is editing, as it stands at the moment of the call. */
export function treeView(tree: Tree): WorkspaceView {
  const absolute = (path: string) => (path.startsWith('/') ? path : `/${path}`);
  const read = (path: string) => tree.read(absolute(path))?.toString('utf8');
  const json = <T>(path: string, at: string[]): T | undefined =>
    tree.exists(path) ? new JsonFile(tree, path).get<T>(at) : undefined;

  return {
    projects: json<Record<string, AngularProject>>('/angular.json', ['projects']) ?? {},
    dependencies: merged(json<Manifest>('/package.json', [])),
    exists: (path) => tree.exists(absolute(path)),
    read,
  };
}

/** The workspace rooted at `cwd`, as `doctor` and `audit` see it. */
export function diskView(cwd: string): WorkspaceView {
  const read = (path: string): string | undefined => {
    const full = join(cwd, path);
    if (!existsSync(full)) return undefined;
    try {
      return readFileSync(full, 'utf8');
    } catch {
      return undefined;
    }
  };
  const json = (path: string): unknown => {
    const text = read(path);
    if (text === undefined) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      return undefined;
    }
  };

  const angular = json('angular.json') as { projects?: Record<string, AngularProject> } | undefined;
  return {
    projects: angular?.projects ?? {},
    dependencies: merged(json('package.json') as Manifest | undefined),
    exists: (path) => existsSync(join(cwd, path)),
    read,
  };
}

/**
 * A prerendered site, recognised by the build option that makes it one.
 *
 * `outputMode: 'static'` rather than a name or a path: it is what the marketing
 * schematic sets, it is what a site someone converted by hand also has, and it
 * is the one thing every rule that has to treat a site differently from an app
 * can agree on.
 */
export function isPrerendered(project: AngularProject | undefined): boolean {
  return project?.architect?.['build']?.options?.['outputMode'] === 'static';
}
