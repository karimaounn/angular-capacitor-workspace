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
  addScripts,
  addStyleIncludePath,
  addToBuild,
  aggregateTests,
  addTsconfigReference,
  appendToScript,
  claimDefaultStart,
  documentScripts,
  nextFreePort,
  readProject,
  setDevServerPort,
  type AngularProject,
} from '../../utils/workspace';
import type { MobilePlatform } from '../../api';

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
      appScripts(name),
      options.e2e === 'playwright' ? e2eConfig(name, port, prefix) : noop(),
      mobile.length > 0 ? schematic('mobile', { app: name, platforms: mobile }) : noop(),
    ]);
  };
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

    const templates = apply(url('./files'), [
      filter((path) => !path.endsWith('.gitkeep')),
      applyTemplates({
        ...strings,
        name,
        port,
        prefix,
        // Config lives at projects/<name>/web/playwright.config.ts; the base is
        // at the workspace root.
        pathToRoot: '../'.repeat(root.split('/').filter(Boolean).length),
      }),
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
