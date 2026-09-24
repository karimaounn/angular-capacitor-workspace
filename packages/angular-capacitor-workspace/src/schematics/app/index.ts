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
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import {
  addScripts,
  addStyleIncludePath,
  addToBuild,
  aggregateTests,
  addTsconfigReference,
  appendToScript,
  claimDefaultStart,
  documentScripts,
  findDesignSystem,
  hookLibraryBuild,
  importDesignSystemStyles,
  nextFreePort,
  readProject,
  setDevServerPort,
  titleFromName,
  type AngularProject,
  type DesignSystem,
} from '../../utils/workspace';
import type { MobilePlatform } from '../../api';
import { installedPackages } from '../packages';

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

      // Last: whatever the workspace already carries from the catalog has a
      // per-project half this app has not had applied to it yet.
      installedPackages(),
    ]);
  };
}

/**
 * Replaces Angular's welcome page with a starter screen for this workspace.
 *
 * Angular's splash is a deliberately temporary thing — it exists to prove the
 * app booted — and every workspace generated here used to ship it unchanged.
 * That left the two most visible things this generator adds, the design tokens
 * and the theming, invisible until somebody went looking in a library they had
 * no reason to open yet.
 *
 * The shell replaces `app.html`, `app.scss`, `app.ts`, `app.spec.ts` and
 * `app.routes.ts`: Angular's spec asserts on the markup of the page being
 * replaced, so leaving it behind means shipping a red test suite.
 *
 * Two versions, picked by whether the workspace has a design system. With one,
 * the screen renders its components and its tokens and carries the theme
 * toggle; without one, it is the same shell in system colours, with no tokens
 * to demonstrate and nothing to switch. A starter page that silently drops half
 * its content is worse than one that was never claiming to have it.
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
        if (!library) {
          return;
        }
        importDesignSystemStyles(host, name, library.name);
        applyThemeBeforePaint(host, root, library);
      },
    ]);
  };
}

/**
 * The script that applies a saved theme before the first paint.
 *
 * Without it the page renders in the OS colour scheme, Angular boots, and the
 * saved preference lands a few hundred milliseconds later — a white flash on
 * every load for the users who most specifically asked not to have one. There
 * is no way to do this from Angular: by the time any framework code runs, the
 * first frame is on screen.
 *
 * Blocking and inline for the same reason: an external file is a round trip
 * that the paint does not wait for. A workspace with a strict Content-Security
 * -Policy needs a hash or nonce for this tag, which is the trade being made and
 * the reason it is one small script rather than a convenience layer.
 */
function applyThemeBeforePaint(tree: Tree, root: string, library: DesignSystem): void {
  const path = `/${root}/src/index.html`;
  const html = tree.read(path)?.toString('utf8');
  if (html === undefined) {
    throw new SchematicsException(`Expected Angular to have written ${path}.`);
  }
  if (!html.includes('</head>')) {
    throw new SchematicsException(
      `${path} has no </head> to insert the theme script before. If Angular's ` +
        `index.html changed shape, update this rule.`,
    );
  }

  const script = `  <script>
    // Applies the stored theme before the first paint. Keys and values are
    // written by ThemeService in ${library.name}.
    (function () {
      try {
        var root = document.documentElement;
        var mode = localStorage.getItem('${library.prefix}.theme-mode');
        if (mode === 'light' || mode === 'dark') {
          root.setAttribute('data-theme', mode);
        }
        var palette = localStorage.getItem('${library.prefix}.theme-palette');
        if (palette) {
          root.setAttribute('data-palette', palette);
        }
      } catch (error) {
        // Storage can be blocked outright. The page then renders in the system
        // scheme, which is the right answer when nothing is stored.
      }
    })();
  </script>
`;

  tree.overwrite(path, html.replace('</head>', `${script}</head>`));
}

function noop(): Rule {
  return (tree: Tree) => tree;
}

/**
 * Scripts follow `<verb>:<app>`, so a workspace with four apps reads as a
 * table rather than as four inconsistent inventions.
 */
function appScripts(name: string): Rule {
  return (tree: Tree) => {
    addScripts(tree, {
      [`start:${name}`]: `ng serve ${name}`,
      [`build:${name}`]: `ng build ${name}`,
      [`test:${name}`]: `ng test ${name}`,
    });
    documentScripts(tree, {
      [`start:${name}`]: `serves \`${name}\``,
      [`build:${name}`]: `production build of \`${name}\``,
      [`test:${name}`]: `unit tests for \`${name}\`, Vitest via \`@angular/build:unit-test\``,
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

    // The theme suite exists only where there is a theme to test. It covers the
    // one thing the library's own tests cannot reach: the inline script in
    // index.html, which runs before Angular does.
    const themed: Rule[] = findDesignSystem(tree)
      ? [
          mergeWith(
            apply(url('./files/shell-e2e'), [applyTemplates(context), move(`/${root}`)]),
            MergeStrategy.Overwrite,
          ),
        ]
      : [];

    return chain([
      mergeWith(templates, MergeStrategy.Overwrite),
      ...themed,
      e2eScripts(name, root),
    ]);
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
    addScripts(tree, {
      [`e2e:${name}`]:
        `tsc -p ${root}/e2e/tsconfig.json && ` +
        `playwright test --config ${root}/playwright.config.ts`,
    });
    appendToScript(tree, 'e2e', `npm run e2e:${name}`);
    addTsconfigReference(tree, `./${root}/e2e/tsconfig.json`);
    documentScripts(tree, {
      [`e2e:${name}`]: `Playwright tests for \`${name}\`, against its own dev server`,
      e2e: 'every Playwright suite in the workspace',
    });
  };
}

function requireRoot(project: AngularProject, name: string): string {
  if (!project.root) {
    throw new Error(`Project "${name}" has no root in angular.json.`);
  }
  return project.root;
}
