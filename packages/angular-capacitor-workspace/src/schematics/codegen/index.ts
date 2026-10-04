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
import { pins } from '../../policy/versions';
import { JsonFile, updateJson } from '../../utils/json-file';
import {
  addGitignoreSection,
  addScripts,
  documentScripts,
  PACKAGE_JSON,
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

    // Written once. A second run — to give an app generated later its client —
    // must not reset the config to the apps named this time, nor a spec variable
    // chosen with --spec-env-var back to the default. It adds entries instead.
    const rootTemplates = apply(url('./files/root'), [
      applyTemplates({ specEnvVar }),
      move('/'),
      filter((path) => !tree.exists(path)),
    ]);

    return chain([
      mergeWith(rootTemplates, MergeStrategy.Overwrite),
      (host: Tree) => addOrvalEntries(host, apps, appRoots),
      ...apps.map((name) => apiClientFor(tree, name, appRoots[name]!)),
      codegenScripts(apps, specEnvVar),
      codegenDependencies(),
      codegenGitignore(),
    ]);
  };
}

const ORVAL_CONFIG = '/orval.config.ts';

/**
 * Gives each app an entry in `orval.config.ts`, unless it already has one.
 *
 * Appended rather than rendered with the rest of the file, so the first run and
 * every later one go through the same code: the template writes an empty
 * `defineConfig({})` and this fills it. An entry already there — the app's, by
 * its key or by its output path — is left as it is, along with whatever else
 * someone has changed in the file.
 *
 * The end of the object is found by matching braces from its opening one, as
 * `appendProvider` does for a providers array. A brace inside a string or a
 * comment would fool it, and nothing this collection writes there has one.
 */
function addOrvalEntries(tree: Tree, apps: string[], appRoots: Record<string, string>): void {
  const source = tree.read(ORVAL_CONFIG)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(`Expected ${ORVAL_CONFIG} to exist; this schematic writes it.`);
  }

  const missing = apps.filter((app) => !configures(source, app, appRoots[app]!));
  if (missing.length === 0) {
    return;
  }

  const entries = missing.map((app) => orvalEntry(app, appRoots[app]!)).join('');
  const handEdited = new SchematicsException(
    `Could not find \`export default defineConfig({ … })\` in ${ORVAL_CONFIG}, so ` +
      `${missing.join(', ')} could not be added to it. Add the entry by hand:\n\n${entries}`,
  );

  const opening = 'export default defineConfig({';
  const start = source.indexOf(opening);
  if (start === -1) {
    throw handEdited;
  }

  const from = start + opening.length;
  let depth = 1;
  let end = -1;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === '{') depth++;
    else if (char === '}' && --depth === 0) {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw handEdited;
  }

  // The template ends every entry with a comma; a file someone has tidied may not.
  const existing = source.slice(from, end).replace(/\s+$/, '');
  const comma = existing === '' || existing.endsWith(',') ? '' : ',';
  tree.overwrite(
    ORVAL_CONFIG,
    `${source.slice(0, from)}${existing}${comma}\n${entries}${source.slice(end)}`,
  );
}

/** True when the config already has an entry for `app`, by its key or its output. */
function configures(source: string, app: string, root: string): boolean {
  return (
    new RegExp(`^ {2}${strings.camelize(app)}: \\{`, 'm').test(source) ||
    source.includes(`'${root}/src/api/generated/index.ts'`)
  );
}

/** One app's entry in `orval.config.ts`, at the indent of a top-level key. */
function orvalEntry(app: string, root: string): string {
  return `  ${strings.camelize(app)}: {
    input: { target: spec },
    output: {
      mode: 'tags-split',
      target: '${root}/src/api/generated/index.ts',
      schemas: '${root}/src/api/generated/model',
      client: 'angular',
      clean: true,
      override: {
        // Every generated call routes through this factory, which is where an
        // interceptor, a base URL or auth headers get attached. Generated code
        // should never be edited; this is the seam that means you never need to.
        mutator: {
          path: '${root}/src/api/api-client.ts',
          name: 'apiClient',
        },
      },
    },
    hooks: {
      afterAllFilesWrite: 'prettier --write',
    },
  },
`;
}

function applicationNames(tree: Tree): string[] {
  return Object.entries(readProjects(tree))
    .filter(([, project]) => project.projectType !== 'library')
    .map(([name]) => name);
}

/**
 * The app's `api-client.ts`, written only if it has none.
 *
 * The file is the app's from the moment it exists: its own header promises
 * that regeneration never overwrites the base URL, auth headers and error
 * mapping configured there. Running this schematic again — for an app added
 * later, say — is regeneration too.
 */
function apiClientFor(tree: Tree, name: string, root: string): Rule {
  const templates = apply(url('./files/app'), [
    applyTemplates({
      ...strings,
      name,
      // Left as a literal so it shows up in a search for configuration that
      // still needs doing, rather than silently defaulting to localhost.
      baseUrlPlaceholder: '/api',
    }),
    move(`/${root}/src/api`),
    filter((path) => !tree.exists(path)),
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

    // Each app's own entry points too, since npm hooks each under its own
    // `pre` name — and only the ones the app has, as `hookLibraryBuild` does.
    const scripts = new JsonFile(tree, PACKAGE_JSON).get<Record<string, string>>(['scripts']) ?? {};
    for (const app of apps) {
      for (const verb of ['build', 'start', 'test', 'e2e']) {
        if (scripts[`${verb}:${app}`]) {
          prependHook(tree, `pre${verb}:${app}`, hook);
        }
      }
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
