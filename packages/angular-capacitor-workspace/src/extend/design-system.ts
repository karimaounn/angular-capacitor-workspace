import { SchematicsException, type Tree } from '@angular-devkit/schematics';
import { updateJson } from '../utils/json-file';
import { runtimeRange } from '../utils/own-package';
import { addDependencies } from '../utils/workspace';
import { treeView, type WorkspaceView } from '../utils/workspace-view';

/**
 * The extension points of the design-system library.
 *
 * What the `ui-lib` host promises plugins about the library it generates: a
 * public API they can add exports to, and a stylesheet entry point they can add
 * partials to. A plugin names what it adds, never a line of either file, so a
 * change to the library's templates is a change here and nowhere else.
 */

/** A design-system library in this workspace. */
export interface DesignSystem {
  /** Its import name, which is also its project name. */
  readonly name: string;
  /** Its component selector prefix. */
  readonly prefix: string;
  /** Its project root, workspace-relative. */
  readonly root: string;
}

/**
 * Finds the design-system library, if the workspace has one.
 *
 * Identified by the file that makes it one — `src/styles/index.scss`, the entry
 * point applications `@use` — rather than by name or by position in the project
 * map. A workspace can hold several libraries, and only this one has a token
 * sheet to wire into an application.
 *
 * Detection rather than an option, because every caller needs the same answer
 * from a different direction: during a full generation the library was created
 * moments ago, for a bare `ng generate app` it was created months ago by
 * someone who will not think to pass its name, and `doctor` reads it off disk.
 */
export function designSystemIn(workspace: WorkspaceView): DesignSystem | undefined {
  for (const [name, project] of Object.entries(workspace.projects)) {
    if (project.projectType !== 'library' || !project.root) {
      continue;
    }
    if (workspace.exists(`${project.root}/src/styles/index.scss`)) {
      return { name, prefix: project.prefix ?? name.split('/').pop()!, root: project.root };
    }
  }
  return undefined;
}

export function findDesignSystem(tree: Tree): DesignSystem | undefined {
  return designSystemIn(treeView(tree));
}

/** `findDesignSystem`, or an error saying which schematic needs one and how to get it. */
export function requireDesignSystem(tree: Tree, why: string): DesignSystem {
  const design = findDesignSystem(tree);
  if (!design) {
    throw new SchematicsException(
      `${why}, and this workspace has none. Generate one first ` +
        '(`ng generate angular-capacitor-workspace:ui-lib`), or pass --ui-lib ' +
        'when creating the workspace.',
    );
  }
  return design;
}

/**
 * Adds exports to the library's public API, once.
 *
 * `from` is the module the block exports from, and the idempotency key: a
 * `public-api.ts` that already mentions it is left alone, so a re-run — and an
 * export someone has trimmed by hand — stays as it is.
 */
export function exportFromLibrary(
  tree: Tree,
  design: DesignSystem,
  from: string,
  block: readonly string[],
): void {
  const path = `/${design.root}/src/public-api.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected the design system to have ${path}, which is what \`ng-packagr\` ` +
        `builds its entry point from.`,
    );
  }
  if (source.includes(from)) {
    return;
  }
  tree.overwrite(path, `${source.replace(/\n*$/, '\n')}\n${block.join('\n')}\n`);
}

/**
 * Adds `@use '<partial>';` to the library's stylesheet entry point, once.
 *
 * After the other `@use` lines, so it lands in the same group: `@use` must come
 * before every rule in a Sass file, and a partial a plugin adds is reachable
 * from the entry point or it never ships.
 */
export function useLibraryStyles(tree: Tree, design: DesignSystem, partial: string): void {
  const path = `/${design.root}/src/styles/index.scss`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected the design system to have ${path}, which is the file that ` +
        `identifies it as one.`,
    );
  }
  const statement = `@use '${partial}';`;
  if (source.includes(statement)) {
    return;
  }

  const lines = source.split('\n');
  const last = lines.reduce((found, text, index) => (/^@use '/.test(text) ? index : found), -1);
  lines.splice(last + 1, 0, statement);
  tree.overwrite(path, lines.join('\n'));
}

/**
 * Makes the design system build on one of the runtime packages a plugin ships:
 * a dependency of the workspace, and a peer of the library.
 *
 * A dependency at the root, which is where the audit gate and `doctor` read
 * dependencies from and where every application resolves them. A peer of the
 * library, because the library re-exports the package: the `package.json` it
 * publishes has to ask its consumers for it, the way it asks for
 * `@angular/core`.
 *
 * `spec` replaces the range at the root, for a workspace generated against a
 * build of the package that is not on the registry yet; the peer is always the
 * range. Neither replaces one that is already there.
 */
export function buildOn(tree: Tree, design: DesignSystem, name: string, spec?: string): void {
  addDependencies(tree, { [name]: spec ?? runtimeRange() }, 'dependencies');

  const manifest = `/${design.root}/package.json`;
  if (!tree.exists(manifest)) {
    return;
  }
  updateJson(tree, manifest, (file) => {
    file.mustGet(
      ['peerDependencies'],
      `the peerDependencies block of library "${design.name}", which the Angular ` +
        `library schematic creates`,
    );
    if (!file.has(['peerDependencies', name])) {
      file.modify(['peerDependencies', name], runtimeRange());
      file.sortKeys(['peerDependencies']);
    }
  });
}
