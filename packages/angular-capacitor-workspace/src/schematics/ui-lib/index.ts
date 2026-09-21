import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  externalSchematic,
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
  addStyleIncludePath,
  aggregateTests,
  appendToScript,
  documentScripts,
  ANGULAR_JSON,
  prependHook,
  readProject,
  readProjects,
} from '../../utils/workspace';

export interface UiLibOptions {
  name?: string;
  prefix?: string;
  storybook?: boolean;
}

/**
 * The design-system library: wiring and theme architecture, not components.
 *
 * What ships is the machinery — the SCSS layering, the Storybook and Compodoc
 * setup, browser-mode component tests, the contrast checker, and the
 * `ng-package.json` asset mapping that lets an app consume the styles the same
 * way it consumes the code.
 *
 * What also ships is two real components. A skeleton whose test suite is empty
 * is a skeleton whose test suite is untested: without something to render, the
 * browser-mode runner, the Storybook build and the contrast table are all
 * configuration nobody has ever executed.
 */
export function uiLib(options: UiLibOptions = {}): Rule {
  return (tree: Tree) => {
    const name = strings.dasherize(options.name ?? 'ui');
    // Derived here and not in schema.json: the devkit fills schema defaults in
    // before the factory runs, so a `"default"` on `prefix` would shadow this
    // and every library would ship `ui-` selectors regardless of its name.
    // A scoped name contributes only its last segment — `@acme/ui-button` is
    // not a selector.
    const prefix = options.prefix ?? name.split('/').pop()!;
    const storybook = options.storybook ?? true;

    return chain([
      externalSchematic('@schematics/angular', 'library', {
        name,
        prefix,
        // See the app schematic: installing happens once, after the gate.
        skipInstall: true,
      }),

      (host: Tree) => {
        const project = readProject(host, name);
        const root = project.root;
        if (!root) {
          throw new SchematicsException(`Library "${name}" has no root in angular.json.`);
        }

        const templates = apply(url('./files'), [
          applyTemplates({
            ...strings,
            name,
            prefix,
            importName: name,
          }),
          move(`/${root}`),
        ]);

        return chain([
          mergeWith(templates, MergeStrategy.Overwrite),
          removePlaceholderComponent(name, root),
          publicApi(name, root),
          packageAssets(name, root),
          browserModeTests(name),
          storybook ? storybookTargets(name, root) : (host: Tree) => host,
          styleIncludePaths(),
          libraryScripts(name, root, storybook),
          libraryDependencies(storybook),
          libraryGitignore(root),
        ]);
      },
    ]);
  };
}

/**
 * Drops the one-line placeholder component Angular's library schematic emits.
 *
 * It exists so a fresh library exports something; this one exports two real
 * components instead, and leaving the placeholder behind means shipping a
 * public `Ui` class nobody meant to publish.
 */
function removePlaceholderComponent(name: string, root: string): Rule {
  return (tree: Tree) => {
    for (const suffix of ['.ts', '.spec.ts']) {
      const path = `/${root}/src/lib/${name}${suffix}`;
      if (tree.exists(path)) {
        tree.delete(path);
      }
    }
  };
}

function publicApi(name: string, root: string): Rule {
  return (tree: Tree) => {
    const path = `/${root}/src/public-api.ts`;
    tree.overwrite(
      path,
      `/*
 * Public API surface of ${name}.
 *
 * Consumers import from '${name}', which tsconfig maps to this library's build
 * output in dist/. Anything not exported here is genuinely private: it will not
 * resolve from an application, which is the point of consuming from dist/
 * rather than from source.
 */

export * from './lib/button/button';
export * from './lib/field/field';
`,
    );
  };
}

/**
 * Maps the SCSS sources into the library's build output.
 *
 * ng-packagr compiles TypeScript and bundles component styles, but a
 * consumer's global stylesheet needs the *sources* — an application's
 * `styles.scss` does `@use '<lib>/styles'` and compiles the tokens into its own
 * bundle. Without this, `dist/<lib>` has no .scss in it at all and the import
 * fails at build time with a path that looks correct.
 */
function packageAssets(name: string, root: string): Rule {
  return (tree: Tree) => {
    updateJson(tree, `/${root}/ng-package.json`, (file) => {
      file.mustGet(['lib'], `the ng-package "lib" block for "${name}"`);
      file.modify(['assets'], ['./src/styles']);
    });
  };
}

/**
 * Switches this library's tests into a real browser engine.
 *
 * `@angular/build:unit-test` runs in jsdom unless `browsers` is set. For a
 * component library that default is close to useless: focus management,
 * `:focus-visible`, computed styles, layout and scrolling are exactly what a
 * design system must get right and exactly what jsdom does not implement.
 *
 * The builder probes for `@vitest/browser-<provider>` and falls back to jsdom
 * when it finds none — silently. `libraryDependencies` installs the playwright
 * provider so the fallback never fires.
 */
function browserModeTests(name: string): Rule {
  return (tree: Tree) => {
    updateJson(tree, ANGULAR_JSON, (file) => {
      const target = ['projects', name, 'architect', 'test'];
      file.mustGet(
        target,
        `the "test" target for library "${name}", which the Angular library ` +
          `schematic should have created`,
      );
      file.modify([...target, 'options', 'browsers'], ['chromium']);
      file.modify([...target, 'options', 'headless'], true);
    });
  };
}

/**
 * Registers Storybook's Angular builder targets.
 *
 * `@storybook/angular` 10 refuses to run from the `storybook` CLI — it throws
 * `AngularLegacyBuildOptionsError` and points at the builder. That is the right
 * call: through the builder it reads `styles`, `stylePreprocessorOptions`,
 * `assets` and the tsconfig out of `angular.json`, so a story renders with the
 * same style pipeline the application uses instead of a parallel one that
 * drifts.
 *
 * `compodoc: false` because the workspace runs Compodoc itself, via
 * `docs:compodoc`. The builder's built-in pass writes `documentation.json` to
 * the workspace root, while `preview.ts` reads it from the library directory;
 * owning the step keeps those two facts in one place.
 */
function storybookTargets(name: string, root: string): Rule {
  return (tree: Tree) => {
    // No `styles` option. @storybook/angular routes .scss through
    // resolve-url-loader and sass-loader and stops there — correct for Angular
    // component styles, which want a raw string, and fatal for a global sheet,
    // which then reaches webpack's JavaScript parser and dies on the first
    // `@layer`. Importing it from preview.ts hits the same rule and fails the
    // same way. The tokens are compiled by `styles:tokens` and linked from
    // preview-head.html instead.
    const shared = {
      configDir: `${root}/.storybook`,
      tsConfig: `${root}/.storybook/tsconfig.json`,
      compodoc: false,
    };

    updateJson(tree, ANGULAR_JSON, (file) => {
      file.mustGet(['projects', name, 'architect'], `the architect block for library "${name}"`);

      file.modify(['projects', name, 'architect', 'storybook'], {
        builder: '@storybook/angular:start-storybook',
        options: { ...shared, port: 6006 },
      });

      file.modify(['projects', name, 'architect', 'build-storybook'], {
        builder: '@storybook/angular:build-storybook',
        options: { ...shared, outputDir: 'dist/storybook' },
      });
    });
  };
}

/**
 * Retrofits the style include path onto applications that already exist.
 *
 * The app and marketing schematics set this themselves, so during a full
 * generation this finds nothing to do. It matters for `ng g ui-lib` in a
 * workspace whose apps predate the library.
 */
function styleIncludePaths(): Rule {
  return (tree: Tree) => {
    for (const [projectName, project] of Object.entries(readProjects(tree))) {
      if (project.projectType === 'library') {
        continue;
      }
      addStyleIncludePath(tree, projectName);
    }
  };
}

function libraryScripts(name: string, root: string, storybook: boolean): Rule {
  return (tree: Tree) => {
    // Composed, because Angular has no "build every library" command.
    appendToScript(tree, 'build:libs', `ng build ${name} --configuration production`);
    addScripts(tree, {
      'watch:libs': `ng build ${name} --watch --configuration development`,
      'check:contrast': `node ${root}/scripts/check-contrast.mjs`,
      [`test:${name}`]: `ng test ${name}`,

      // Browser-mode tests need the engines on disk, and Playwright ships the
      // headless shell as a download separate from `chromium` — installing
      // only `chromium` leaves the runner failing with a path that does not
      // exist. Both are named here so the first `npm test` on a new machine,
      // or in CI, does not end in that error.
      'setup:test-browsers': 'playwright install chromium chromium-headless-shell',
    });
    documentScripts(tree, {
      'build:libs':
        'builds every library into `dist/`, where apps import them from; ' +
        '`npm start` and `npm test` run it first',
      'watch:libs': 'rebuilds libraries on change',
      [`test:${name}`]: `component tests for \`${name}\`, in a real browser engine`,
      'setup:test-browsers': 'downloads the browser engines those tests run in — once per machine',
      'check:contrast': 'checks every declared colour pairing against WCAG, in light and dark mode',
    });

    // Part of `npm test`, like every app's suite. Browser mode needs the
    // engines `setup:test-browsers` downloads; CI installs them before this.
    aggregateTests(tree);

    // `ng serve` does not build workspace libraries, and an app that imports
    // from dist/ cannot start until one exists. These two hooks cover the
    // entry points npm can reach; the README covers the two it cannot.
    prependHook(tree, 'prestart', 'npm run build:libs');
    prependHook(tree, 'pretest', 'npm run build:libs');

    if (storybook) {
      const prepare = `npm run docs:compodoc && npm run styles:tokens`;
      addScripts(tree, {
        'docs:compodoc': `compodoc -p ${root}/tsconfig.lib.json -e json -d ${root}`,
        'styles:tokens': `sass ${root}/src/styles/index.scss ${root}/.storybook/static/tokens.css --load-path=${root}/src/styles --no-source-map`,
        // Through `ng run`, not the `storybook` CLI. @storybook/angular 10
        // rejects a direct CLI invocation with AngularLegacyBuildOptionsError:
        // it needs the builder so it can read styles, assets and tsconfig from
        // angular.json rather than guessing them.
        storybook: `${prepare} && ng run ${name}:storybook`,
        'build-storybook': `${prepare} && ng run ${name}:build-storybook`,
        // Building the static Storybook is the cheapest check that every story
        // still compiles. It catches a renamed input that no unit test touches.
        'test:storybook': 'npm run build-storybook',
      });
      documentScripts(tree, {
        storybook: `Storybook for \`${name}\`, with controls derived by Compodoc`,
        'build-storybook': 'a static Storybook build',
        'test:storybook': 'builds Storybook, which fails if any story no longer compiles',
      });
    }
  };
}

function libraryDependencies(storybook: boolean): Rule {
  return (tree: Tree) => {
    const wanted = [
      'vitest',
      '@vitest/browser-playwright',
      'playwright',
      'sass',
      '@fontsource/inter',
    ];

    if (storybook) {
      wanted.push(
        'storybook',
        '@storybook/angular',
        '@storybook/addon-docs',
        '@compodoc/compodoc',
        // Storybook 10.6 declares these as required peers. Left implicit, npm
        // backtracks them onto Angular 20/21 releases and the install fails
        // ERESOLVE against Angular 22. See policy/versions.ts.
        '@angular-devkit/build-angular',
        '@angular-devkit/core',
        '@angular-devkit/architect',
        '@angular/platform-browser-dynamic',
        '@angular/animations',
      );
    }

    // Written directly rather than through addDependencies so the pins are
    // authoritative: these versions were resolved together and verified to
    // install cleanly at the Angular line.
    updateJson(tree, '/package.json', (file) => {
      for (const [name, range] of Object.entries(pins(wanted))) {
        if (!file.has(['devDependencies', name])) {
          file.modify(['devDependencies', name], range);
        }
      }
      file.sortKeys(['devDependencies']);
    });
  };
}

function libraryGitignore(root: string): Rule {
  return (tree: Tree) => {
    addGitignoreSection(tree, 'Storybook and Compodoc build output', [
      `/${root}/documentation.json`,
      `/${root}/.storybook/static/`,
      '/dist/storybook/',
      '/storybook-static/',
    ]);
  };
}

/** Re-exported for the schematic tests, which assert on the emitted anchors. */
export { JsonFile };
