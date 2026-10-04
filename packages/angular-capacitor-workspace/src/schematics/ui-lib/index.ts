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
  hookLibraryBuild,
  importDesignSystemStyles,
  appendToScript,
  documentScripts,
  ANGULAR_JSON,
  prependHook,
  readProject,
  readProjects,
} from '../../utils/workspace';
import { installedPackages } from '../packages';

export interface UiLibOptions {
  name?: string;
  prefix?: string;
  storybook?: boolean;
}

/**
 * The design-system library: wiring and theme architecture, not components.
 *
 * What ships is the machinery — the SCSS layering, the Storybook setup,
 * browser-mode component tests, the contrast checker, and the
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
          adoptExistingApps(name),
          libraryScripts(name, root, storybook),
          libraryDependencies(storybook),
          libraryGitignore(),

          // A catalog package already in the workspace declares itself a peer
          // of every library, and this one did not exist when it was added.
          installedPackages(),
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
export * from './lib/theme/theme';
export * from './lib/theme/theme-toggle';
`,
    );
  };
}

/**
 * Maps the SCSS sources into the library's build output, at `styles/`.
 *
 * ng-packagr compiles TypeScript and bundles component styles, but a
 * consumer's global stylesheet needs the *sources* — an application's
 * `styles.scss` does `@use '<lib>/styles'` and compiles the tokens into its own
 * bundle. Without this, `dist/<lib>` has no .scss in it at all and the import
 * fails at build time with a path that looks correct.
 *
 * The `output` is what makes that import the one written in the documentation.
 * A bare `'./src/styles'` copies the directory at its *source* path, so the
 * sheet lands at `dist/<lib>/src/styles/` and every consumer has to write
 * `@use '<lib>/src/styles'` — leaking the library's internal layout into every
 * application, and into every README that gets it wrong.
 */
function packageAssets(name: string, root: string): Rule {
  return (tree: Tree) => {
    updateJson(tree, `/${root}/ng-package.json`, (file) => {
      file.mustGet(['lib'], `the ng-package "lib" block for "${name}"`);
      file.modify(['assets'], [{ glob: '**/*.scss', input: './src/styles', output: './styles' }]);
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
 * `@storybook/angular-vite` also runs from the `storybook` CLI, but through the
 * builder it reads `styles`, `stylePreprocessorOptions` and the tsconfig out of
 * `angular.json`, so a story renders with the same style pipeline the
 * application uses instead of a parallel one in `viteFinal` that drifts.
 */
function storybookTargets(name: string, root: string): Rule {
  return (tree: Tree) => {
    // The design tokens go in as a global sheet, the way an application takes
    // them. The webpack framework could not do this — its sass-loader rule
    // handed a global sheet to the JavaScript parser, which died on the first
    // `@layer` — and the workaround was a separately compiled tokens.css linked
    // from preview-head.html. Vite compiles it like any other stylesheet.
    //
    // `includePaths` is spelled out rather than inherited: the Vite framework
    // reads nothing from the library's build target, and does not install
    // Angular's root-relative Sass importer either (storybookjs/storybook#36012).
    const shared = {
      configDir: `${root}/.storybook`,
      tsConfig: `${root}/.storybook/tsconfig.json`,
      styles: [`${root}/src/styles/index.scss`],
      stylePreprocessorOptions: { includePaths: [`${root}/src/styles`] },
    };

    updateJson(tree, ANGULAR_JSON, (file) => {
      file.mustGet(['projects', name, 'architect'], `the architect block for library "${name}"`);

      file.modify(['projects', name, 'architect', 'storybook'], {
        builder: '@storybook/angular-vite:start-storybook',
        options: { ...shared, port: 6006 },
      });

      file.modify(['projects', name, 'architect', 'build-storybook'], {
        builder: '@storybook/angular-vite:build-storybook',
        options: { ...shared, outputDir: 'dist/storybook' },
      });
    });
  };
}

/**
 * Wires existing applications up to the library they just gained.
 *
 * The include path makes `@use '<lib>/styles'` resolvable; the import is what
 * makes it happen. Both are set by the app and marketing schematics during a
 * full generation, so this finds nothing to do there. It matters for
 * `ng g ui-lib` in a workspace whose apps predate the library — which is what
 * `ng add` into an existing workspace produces.
 *
 * The stylesheet import is the only thing retrofitted into an app's source. An
 * app that already exists has a shell somebody has edited, and rewriting that
 * to demonstrate a new library would be destructive; a token import at the top
 * of `styles.scss` is additive and reversible.
 */
function adoptExistingApps(name: string): Rule {
  return (tree: Tree) => {
    for (const [projectName, project] of Object.entries(readProjects(tree))) {
      if (project.projectType === 'library') {
        continue;
      }
      addStyleIncludePath(tree, projectName);
      importDesignSystemStyles(tree, projectName, name);
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
        'every other npm script here runs it first',
      'watch:libs': 'rebuilds libraries on change',
      [`test:${name}`]: `component tests for \`${name}\`, in a real browser engine`,
      'setup:test-browsers': 'downloads the browser engines those tests run in — once per machine',
      'check:contrast': 'checks every declared colour pairing against WCAG, in light and dark mode',
    });

    // Part of `npm test`, like every app's suite. Browser mode needs the
    // engines `setup:test-browsers` downloads; CI installs them before this.
    aggregateTests(tree);

    // `ng serve` does not build workspace libraries, and an app that imports
    // from dist/ cannot start until one exists. These three cover the
    // workspace-wide entry points.
    prependHook(tree, 'prestart', 'npm run build:libs');
    prependHook(tree, 'pretest', 'npm run build:libs');

    // `prebuild` joins them now that every application's stylesheet imports the
    // library's tokens: a build from a fresh clone would otherwise fail in Sass,
    // on a path that does not exist yet rather than one that is wrong.
    prependHook(tree, 'prebuild', 'npm run build:libs');

    // And the same for the per-project entry points of whatever is already
    // here. An app generated after this library hooks its own; one that
    // predates it — every app, when `ng add` retrofits a design system — has
    // nothing else to do it.
    for (const [projectName, project] of Object.entries(readProjects(tree))) {
      if (project.projectType !== 'library') {
        hookLibraryBuild(tree, projectName);
      }
    }

    if (storybook) {
      addScripts(tree, {
        // Through `ng run`, not the `storybook` CLI, so the builder reads styles
        // and tsconfig from angular.json. See storybookTargets.
        storybook: `ng run ${name}:storybook`,
        'build-storybook': `ng run ${name}:build-storybook`,
        // Building the static Storybook is the cheapest check that every story
        // still compiles. It catches a renamed input that no unit test touches.
        'test:storybook': 'npm run build-storybook',
      });
      documentScripts(tree, {
        storybook: `Storybook for \`${name}\`, with controls derived from the component sources`,
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
        '@storybook/angular-vite',
        '@storybook/addon-docs',
        '@analogjs/vite-plugin-angular',
        // Required peers of the framework. Left implicit, npm backtracks them
        // off the Angular line. See policy/versions.ts.
        '@angular-devkit/core',
        '@angular-devkit/architect',
        // @angular/animations is NOT listed, though it is a required peer too:
        // npm installs it either way, and listing it would make a deprecated
        // package one this generator chose. See policy/versions.ts.
      );
    }

    // Written directly rather than through addDependencies so the pins are
    // authoritative: these versions were resolved together and verified to
    // install cleanly at the Angular line.
    //
    // Authoritative includes overwriting what the Angular schematic already
    // wrote. `ng new` emits its own `vitest` range, and @angular/cli 22.2 moved
    // it to `^5.0.0` while the browser provider's vitest peer is an exact
    // version — deferring to the emitted range resolved vitest one line above
    // the provider and failed the install on ERESOLVE. Whichever range the CLI
    // of the day writes, the pair here is what was verified together.
    updateJson(tree, '/package.json', (file) => {
      for (const [name, range] of Object.entries(pins(wanted))) {
        file.modify(['devDependencies', name], range);
      }
      file.sortKeys(['devDependencies']);
    });
  };
}

function libraryGitignore(): Rule {
  return (tree: Tree) => {
    addGitignoreSection(tree, 'Storybook build output', ['/dist/storybook/', '/storybook-static/']);
  };
}

/** Re-exported for the schematic tests, which assert on the emitted anchors. */
export { JsonFile };
