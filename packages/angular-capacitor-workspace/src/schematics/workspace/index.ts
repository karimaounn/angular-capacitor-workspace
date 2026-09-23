import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  filter,
  MergeStrategy,
  mergeWith,
  move,
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import { latestVersions } from '@schematics/angular/utility/latest-versions';
import { ANGULAR_LINE, pins } from '../../policy/versions';
import { JsonFile, updateJson } from '../../utils/json-file';
import {
  addDependencies,
  addGitignoreSection,
  addScripts,
  PACKAGE_JSON,
  setEngines,
  TSCONFIG_JSON,
} from '../../utils/workspace';

export interface WorkspaceOverlayOptions {
  e2e?: 'playwright' | false;
  uiLib?: string;
  mobile?: boolean;
  /** Dependency spec for this package. Defaults to the installed version. */
  selfSpec?: string;
}

/**
 * The root-level delta.
 *
 * Everything here is something `ng new` does not emit and every project in the
 * workspace shares: the tsconfig `paths` convention that makes libraries
 * consumable from `dist/`, one Playwright base config instead of one per app,
 * the house rules, and the scripts that keep the library build from being a
 * thing you have to remember.
 */
export function workspaceOverlay(options: WorkspaceOverlayOptions = {}): Rule {
  return (tree: Tree) => {
    const name = workspaceName(tree);

    const templates = apply(url('./files'), [
      filter((path) => options.e2e === 'playwright' || !path.includes('playwright.base')),
      applyTemplates({
        ...strings,
        name,
        angularLine: ANGULAR_LINE,
        e2e: options.e2e ?? false,
        uiLib: options.uiLib ?? '',
        // `__dot__` in a template path becomes a leading dot, which is how a
        // schematic emits `.github/` — a literal `.github` directory inside the
        // package would be picked up by tooling looking for *our* workflows.
        dot: '.',
      }),
      move('/'),
    ]);

    return chain([
      // Overwrite: `ng new` writes a README describing a bare CLI workspace,
      // which is no longer what this is.
      mergeWith(templates, MergeStrategy.Overwrite),
      preparePathsBlock(),
      rootScripts(options),
      rootDependencies(options),
      engines(),
      gitignore(options),
    ]);
  };
}

function workspaceName(tree: Tree): string {
  const file = new JsonFile(tree, PACKAGE_JSON);
  return file.mustGet<string>(['name'], 'the workspace name');
}

/**
 * Creates an empty `compilerOptions.paths` map for library schematics to fill.
 *
 * `ng new` emits no `paths`, and jsonc edits need the parent object to exist
 * before a child key can be added at a stable position. Creating it once here
 * keeps every library schematic from having to know that.
 */
function preparePathsBlock(): Rule {
  return (tree: Tree) => {
    updateJson(tree, TSCONFIG_JSON, (file) => {
      file.mustGet(['compilerOptions'], 'the root compilerOptions block');
      if (!file.has(['compilerOptions', 'paths'])) {
        file.modify(['compilerOptions', 'paths'], {});
      }
    });
  };
}

function rootScripts(_options: WorkspaceOverlayOptions): Rule {
  return (tree: Tree) => {
    // Angular has no "build every library" command, so `build:libs` is composed
    // one `ng build` at a time by the library schematics. It is deliberately not
    // created here: an empty `build:libs` that silently succeeds would make the
    // README's "run this first" instruction a lie in a workspace that has no
    // libraries yet, and a broken one in a workspace that gains them later.
    addScripts(tree, {
      'audit:policy': 'angular-capacitor-workspace audit',
      doctor: 'angular-capacitor-workspace doctor',
    });
  };
}

function rootDependencies(options: WorkspaceOverlayOptions): Rule {
  return (tree: Tree) => {
    const wanted: string[] = [];
    if (options.e2e === 'playwright') {
      wanted.push('@playwright/test');
    }
    if (wanted.length > 0) {
      addDependencies(tree, pins(wanted));
    }

    if (options.e2e === 'playwright') {
      // `playwright.base.ts` reads `process.env`, and each app's e2e script
      // type-checks it. Angular only adds @types/node alongside a server
      // target, so a workspace of client-rendered apps would not have it. The
      // range is the one Angular's own schematics write — delegated, like every
      // other version Angular has an opinion about, so the two never disagree.
      addDependencies(tree, { '@types/node': latestVersions['@types/node']! });
    }

    // This package installs itself into the workspace it generates.
    //
    // Without it `npm run audit:policy` and `npm run doctor` are scripts calling
    // a binary that is not there, and `ng generate angular-capacitor-workspace:app`
    // cannot resolve the collection. The dependency policy is supposed to stay
    // live in the workspace after generation; that only works if the thing that
    // enforces it is present.
    addDependencies(tree, {
      'angular-capacitor-workspace': options.selfSpec ?? `^${ownVersion()}`,
    });
  };
}

/**
 * Declares the same runtime floor this package declares.
 *
 * The generated workspace runs `angular-capacitor-workspace audit` and
 * `doctor`, so whatever they need, it needs. Copying the numbers into a
 * template would let the two drift, and the direction that drift breaks in is
 * the quiet one: on an npm below the floor, `allowScripts` and
 * `--strict-allow-scripts` are accepted and ignored, so a workspace that looks
 * gated is not. Reading them from our own manifest keeps that impossible.
 */
function engines(): Rule {
  return (tree: Tree) => {
    const declared = ownManifest().engines;
    if (!declared || Object.keys(declared).length === 0) {
      throw new SchematicsException(
        "Could not read this package's own `engines` from its manifest. The " +
          'generated workspace declares the same floor, and inventing one here ' +
          'would let the two disagree.',
      );
    }
    setEngines(tree, declared);
  };
}

/**
 * This package's own manifest.
 *
 * Hard-coding anything out of it would mean a release that forgot to update a
 * string generates workspaces describing a package that does not exist.
 */
function ownManifest(): { version?: string; engines?: Record<string, string> } {
  // dist/schematics/workspace/index.js → the package root is three levels up,
  // and the same is true of src/schematics/workspace/index.ts under ts-node.
  return JSON.parse(readFileSync(join(__dirname, '..', '..', '..', 'package.json'), 'utf8'));
}

/** The version of this package, read from its own manifest. */
function ownVersion(): string {
  const { version } = ownManifest();

  if (!version) {
    throw new SchematicsException(
      "Could not read this package's own version from its manifest. The " +
        'generated workspace needs it to depend on the generator that made it.',
    );
  }
  return version;
}

function gitignore(options: WorkspaceOverlayOptions): Rule {
  return (tree: Tree) => {
    addGitignoreSection(tree, 'Generated API clients', ['**/api/generated/']);

    if (options.e2e === 'playwright') {
      addGitignoreSection(tree, 'Playwright', [
        '/test-results/',
        '/playwright-report/',
        '/blob-report/',
        '/playwright/.cache/',
      ]);
    }

    if (options.mobile) {
      addGitignoreSection(tree, 'Capacitor', [
        '/projects/*/mobile/android/app/build/',
        '/projects/*/mobile/android/.gradle/',
        '/projects/*/mobile/android/local.properties',
        '/projects/*/mobile/ios/App/Pods/',
        '/projects/*/mobile/ios/App/build/',
      ]);
    }

    // The design-token working directory, if the team uses one.
    addGitignoreSection(tree, 'Design scratch', ['/.design/']);
  };
}
