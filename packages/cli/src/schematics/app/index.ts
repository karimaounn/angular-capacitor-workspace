import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  externalSchematic,
  filter,
  MergeStrategy,
  mergeWith,
  move,
  schematic,
  url,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import {
  addStyleIncludePath,
  aggregateTests,
  addTsconfigReference,
  importDesignSystemStyles,
  nextFreePort,
  readProject,
  setDevServerPort,
  titleFromName,
  type AngularProject,
} from '../../utils/workspace';
import { findDesignSystem } from '../../extend/design-system';
import {
  addProjectScripts,
  addToBuild,
  addToE2e,
  claimDefaultStart,
  documentProjectScripts,
  ensureProjectManifest,
  hookLibraryBuild,
} from '../../utils/project-scripts';
import type { MobilePlatform } from '../../api';
import { extendWithPlugins } from '../../plugins/registry';

export interface AppOptions {
  name: string;
  mobile?: MobilePlatform[];
  e2e?: 'playwright' | false;
  port?: number;
  prefix?: string;
}

/** Where the Angular half of an app lives, beside its `mobile/` sibling. */
export const WEB_SUBDIR = 'web';

/**
 * A client-rendered application.
 *
 * Angular emits the skeleton; this adds the workspace shape around it — the
 * `web/` root that makes room for a Capacitor sibling, the conventional
 * scripts, and the per-app Playwright config that delegates to the root base.
 *
 * Client-rendered deliberately: `ssr: false`. An app that ships inside a
 * Capacitor shell has no server to render on, and a marketing site that wants
 * prerendering is a different schematic with a different answer.
 */
export function app(options: AppOptions): Rule {
  return (tree: Tree) => {
    const name = strings.dasherize(options.name);
    const port = options.port ?? nextFreePort(tree);
    const prefix = options.prefix ?? 'app';
    const mobile = options.mobile ?? [];

    return chain([
      externalSchematic('@schematics/angular', 'application', {
        name,
        style: 'scss',
        ssr: false,
        skipTests: false,
        prefix,
        standalone: true,

        // The `web/` half of the app, with `mobile/` as its sibling.
        //
        // Asking Angular to generate at the final location rather than moving
        // the project afterwards: `projectRoot` makes Angular compute every
        // path itself — `root`, `sourceRoot`, each builder option, the
        // `extends` in both tsconfigs and the root `references` — so none of
        // them is ours to keep correct across Angular minors.
        projectRoot: `projects/${name}/${WEB_SUBDIR}`,

        // Installing is the generator's job, after the audit gate has passed.
        // Left to itself the schematic installs an unaudited tree, which is
        // both slow and exactly the thing the gate exists to prevent.
        skipInstall: true,
      }),

      (host: Tree) => {
        addStyleIncludePath(host, name);
        setDevServerPort(host, name, port);
      },
      starterShell(name, prefix),
      appScripts(name),
      options.e2e === 'playwright' ? e2eConfig(name, port, prefix) : noop(),
      mobile.length > 0 ? schematic('mobile', { app: name, platforms: mobile }) : noop(),

      // After every script this app owns exists, because the hooks are named
      // after them.
      (host: Tree) => hookLibraryBuild(host, name),

      // Last: every plugin the workspace already carries has a per-project
      // half this app has not had yet — the theme toggle, translation, a
      // catalog package's stylesheet. In the registry's order, which is the
      // order a full generation applies them in.
      extendWithPlugins(name),
    ]);
  };
}

/**
 * Replaces Angular's welcome page with a starter screen for this workspace.
 *
 * Angular's splash is a deliberately temporary thing — it exists to prove the
 * app booted — and every workspace generated here used to ship it unchanged.
 * That left the most visible thing this generator adds, the design tokens,
 * invisible until somebody went looking in a library they had no reason to
 * open yet.
 *
 * The shell replaces `app.html`, `app.scss`, `app.ts`, `app.spec.ts` and
 * `app.routes.ts`: Angular's spec asserts on the markup of the page being
 * replaced, so leaving it behind means shipping a red test suite.
 *
 * Two versions, picked by whether the workspace has a design system. With one,
 * the screen renders its components and its tokens; without one, it is the
 * same shell in system colours, with no tokens to demonstrate. A starter page
 * that silently drops half its content is worse than one that was never
 * claiming to have it.
 *
 * Both keep the anchors in `src/extend/shell.ts` — the `<header>`, the spec's
 * TestBed providers, and with a design system the starter page's sections —
 * which is where the plugins add the theme toggle, the language picker and
 * their showcases.
 */
function starterShell(name: string, prefix: string): Rule {
  return (tree: Tree) => {
    const project = readProject(tree, name);
    const root = requireRoot(project, name);
    const library = findDesignSystem(tree);

    const templates = apply(url(library ? './files/shell' : './files/plain'), [
      applyTemplates({
        ...strings,
        name,
        prefix,
        title: titleFromName(name),
        libName: library?.name ?? '',
        libPrefix: library?.prefix ?? '',
      }),
      move(`/${root}`),
    ]);

    return chain([
      mergeWith(templates, MergeStrategy.Overwrite),
      (host: Tree) => {
        if (library) {
          importDesignSystemStyles(host, name, library.name);
        }
      },
    ]);
  };
}

function noop(): Rule {
  return (tree: Tree) => tree;
}

/**
 * The app's own `start`, `build` and `test`, in its own `package.json`, so the
 * root manifest does not grow by a block of scripts per app. Every app has the
 * same verbs, run from the root as `npm run <verb> -w <package>`.
 */
function appScripts(name: string): Rule {
  return (tree: Tree) => {
    const scripts = ensureProjectManifest(tree, name);
    addProjectScripts(tree, scripts, {
      start: `ng serve ${name}`,
      watch: `ng build ${name} --watch --configuration development`,
      build: `ng build ${name}`,
      test: `ng test ${name}`,
    });
    documentProjectScripts(tree, scripts, {
      start: `serves \`${name}\``,
      build: `production build of \`${name}\``,
      test: `unit tests for \`${name}\`, Vitest via \`@angular/build:unit-test\``,
    });

    claimDefaultStart(tree, name);
    addToBuild(tree, name);
    aggregateTests(tree);
  };
}

function e2eConfig(name: string, port: number, prefix: string): Rule {
  return (tree: Tree) => {
    const project = readProject(tree, name);
    const root = requireRoot(project, name);

    const context = {
      ...strings,
      name,
      port,
      prefix,
      // Config lives at projects/<name>/web/playwright.config.ts; the base is
      // at the workspace root.
      pathToRoot: '../'.repeat(root.split('/').filter(Boolean).length),
    };

    const templates = apply(url('./files/e2e'), [
      filter((path) => !path.endsWith('.gitkeep')),
      applyTemplates(context),
      move(`/${root}`),
    ]);

    return chain([mergeWith(templates, MergeStrategy.Overwrite), e2eScripts(name, root)]);
  };
}

/**
 * The per-app e2e script, which type-checks the specs before running them.
 *
 * Playwright strips types without checking them, and the specs sit outside
 * every application tsconfig, so without the `tsc` step nothing ever checks
 * them: a renamed helper surfaces as a confusing runtime failure, or not at
 * all. Shared with the marketing schematic, which emits the same tsconfig.
 */
export function e2eScripts(name: string, root: string): Rule {
  return (tree: Tree) => {
    const scripts = ensureProjectManifest(tree, name);
    addProjectScripts(tree, scripts, {
      e2e:
        `tsc -p ${scripts.projectPath('e2e/tsconfig.json')} && ` +
        `playwright test --config ${scripts.projectPath('playwright.config.ts')}`,
    });
    addToE2e(tree, name);
    addTsconfigReference(tree, `./${root}/e2e/tsconfig.json`);
    documentProjectScripts(tree, scripts, {
      e2e: `Playwright tests for \`${name}\`, against its own dev server`,
    });
  };
}

function requireRoot(project: AngularProject, name: string): string {
  if (!project.root) {
    throw new Error(`Project "${name}" has no root in angular.json.`);
  }
  return project.root;
}
