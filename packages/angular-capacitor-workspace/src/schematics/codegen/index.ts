import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  MergeStrategy,
  mergeWith,
  move,
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import { pins } from '../../policy/versions';
import { updateJson } from '../../utils/json-file';
import {
  addGitignoreSection,
  addScripts,
  documentScripts,
  prependHook,
  readProject,
  readProjects,
} from '../../utils/workspace';

export interface CodegenOptions {
  apps?: string[];
  specEnvVar?: string;
}

/**
 * OpenAPI client generation with orval.
 *
 * Opt-in, and off by default. A workspace with no API contract should not carry
 * a codegen step, because a `pre*` hook that fails is a workspace where nothing
 * runs — and "clone the repo, `npm start` fails" is a worse first impression
 * than "add codegen when you need it".
 */
export function codegen(options: CodegenOptions = {}): Rule {
  return (tree: Tree) => {
    const specEnvVar = options.specEnvVar ?? 'OPENAPI_SPEC';
    const apps = (options.apps?.length ? options.apps : applicationNames(tree)).map((name) =>
      strings.dasherize(name),
    );

    if (apps.length === 0) {
      throw new SchematicsException(
        'Codegen needs at least one application to generate a client into, and ' +
          'this workspace has none. Generate an app first.',
      );
    }

    const appRoots = Object.fromEntries(
      apps.map((name) => {
        const root = readProject(tree, name).root;
        if (!root) {
          throw new SchematicsException(`Project "${name}" has no root in angular.json.`);
        }
        return [name, root];
      }),
    );

    const rootTemplates = apply(url('./files/root'), [
      applyTemplates({ ...strings, apps, appRoots, specEnvVar }),
      move('/'),
    ]);

    return chain([
      mergeWith(rootTemplates, MergeStrategy.Overwrite),
      ...apps.map((name) => apiClientFor(name, appRoots[name]!)),
      codegenScripts(apps, specEnvVar),
      codegenDependencies(),
      codegenGitignore(),
    ]);
  };
}

function applicationNames(tree: Tree): string[] {
  return Object.entries(readProjects(tree))
    .filter(([, project]) => project.projectType !== 'library')
    .map(([name]) => name);
}

function apiClientFor(name: string, root: string): Rule {
  const templates = apply(url('./files/app'), [
    applyTemplates({
      ...strings,
      name,
      // Left as a literal so it shows up in a search for configuration that
      // still needs doing, rather than silently defaulting to localhost.
      baseUrlPlaceholder: '/api',
    }),
    move(`/${root}/src/api`),
  ]);
  return mergeWith(templates, MergeStrategy.Overwrite);
}

/**
 * Wires codegen into every entry point that compiles the app.
 *
 * Generated output is gitignored, so on a fresh clone it does not exist. Every
 * command that would compile against it has to be able to produce it first —
 * otherwise the failure mode is an import error in a file the developer cannot
 * find, because it was never written.
 */
function codegenScripts(apps: string[], specEnvVar: string): Rule {
  return (tree: Tree) => {
    addScripts(tree, {
      codegen: 'node scripts/codegen.mjs',
      // The hooks use the optional form, which skips with a message when no
      // spec is configured. See scripts/codegen.mjs for why the two differ.
      'codegen:optional': 'node scripts/codegen.mjs --optional',
    });
    documentScripts(tree, {
      codegen:
        `generates the API client from the OpenAPI document at \`$${specEnvVar}\` ` +
        '(a path or a URL); build, serve and test run it first, and skip it when unset',
    });

    const hook = 'npm run codegen:optional';
    for (const name of ['prebuild', 'prestart', 'pretest']) {
      prependHook(tree, name, hook);
    }

    for (const app of apps) {
      prependHook(tree, `prebuild:${app}`, hook);
      prependHook(tree, `prestart:${app}`, hook);
    }
  };
}

function codegenDependencies(): Rule {
  return (tree: Tree) => {
    updateJson(tree, '/package.json', (file) => {
      for (const [name, range] of Object.entries(pins(['orval']))) {
        if (!file.has(['devDependencies', name])) {
          file.modify(['devDependencies', name], range);
        }
      }
      file.sortKeys(['devDependencies']);
    });
  };
}

function codegenGitignore(): Rule {
  return (tree: Tree) => {
    addGitignoreSection(tree, 'orval output', ['**/src/api/generated/']);
  };
}
