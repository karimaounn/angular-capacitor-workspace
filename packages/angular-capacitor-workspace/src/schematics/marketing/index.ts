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
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import { pins } from '../../policy/versions';
import { JsonFile, updateJson } from '../../utils/json-file';
import {
  addDependencies,
  addScripts,
  addStyleIncludePath,
  addToBuild,
  aggregateTests,
  ANGULAR_JSON,
  appendSection,
  claimDefaultStart,
  documentScripts,
  nextFreePort,
  PACKAGE_JSON,
  readProject,
  setDevServerPort,
} from '../../utils/workspace';
import { e2eScripts } from '../app';
import { installedPackages } from '../packages';

export interface MarketingOptions {
  name: string;
  e2e?: 'playwright' | false;
  port?: number;
  prefix?: string;
  /** Production origin, for canonical URLs, the sitemap and robots.txt. */
  origin?: string;
}

/** Written when no origin is given. RFC 2606 reserves it; the postbuild check warns on it. */
export const PLACEHOLDER_ORIGIN = 'https://example.com';

/**
 * A marketing site that is prerendered at build time and served as files.
 *
 * Generated through Angular's SSR application schematic and then converted,
 * because the two are much closer than they look: Angular 22's SSR skeleton
 * already emits `app.routes.server.ts` with `**` → `RenderMode.Prerender` and
 * already calls `provideClientHydration()`. What it also emits is a Node server
 * — `server.ts`, `express`, an `ssr.entry` and a `serve:ssr:*` script — and for
 * a static site every one of those is dead weight that carries its own
 * advisory surface.
 *
 * So the first delta is subtractive: switch `outputMode` to `static`, drop the
 * server entry point, and let the dependency policy prune `express` on the way
 * past, since its `ssr:server` guard is not satisfied by anything left behind.
 *
 * The second is what a site that exists to be found needs and Angular does not
 * emit: per-route head tags written during prerender, a prerendered 404, and a
 * postbuild check that fails the build when a page would be useless to a
 * crawler. Without the check, a prerender that falls back to an empty shell
 * still produces a build that looks fine.
 */
export function marketing(options: MarketingOptions): Rule {
  return (tree: Tree) => {
    const name = strings.dasherize(options.name);
    const port = options.port ?? nextFreePort(tree);
    const prefix = options.prefix ?? 'site';
    const origin = normaliseOrigin(options.origin ?? PLACEHOLDER_ORIGIN);
    const e2e = options.e2e === 'playwright';

    return chain([
      externalSchematic('@schematics/angular', 'application', {
        name,
        style: 'scss',
        ssr: true,
        prefix,
        standalone: true,
        // Same layout as an app, so every project in the workspace is reached
        // the same way — even though a marketing site never gains a `mobile/`
        // sibling.
        projectRoot: `projects/${name}/web`,
        skipInstall: true,
      }),

      makeStatic(name),
      (host: Tree) => {
        addStyleIncludePath(host, name);
        setDevServerPort(host, name, port);
        tightenBudgets(host, name);
      },
      siteScaffold(name, {
        prefix,
        origin,
        siteName: siteName(name),
        placeholderOrigin: origin === PLACEHOLDER_ORIGIN,
        port,
        e2e,
      }),
      marketingScripts(name),
      postbuildChecks(name),
      houseRules(),
      e2e ? e2eConfig(name, port, prefix) : (host: Tree) => host,

      // See the app schematic: a site generated after a catalog package was
      // added still needs that package's per-project half.
      installedPackages(),
    ]);
  };
}

/**
 * `https://Example.com/` → `https://example.com`. The schema pattern already
 * rejects a path; it is checked again here for callers that bypass the schema,
 * since every canonical URL on the site would inherit it.
 */
function normaliseOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SchematicsException(
      `"${raw}" is not a URL. Give the origin, e.g. https://example.org.`,
    );
  }
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new SchematicsException(
      `The origin must not have a path, query or fragment (got "${raw}").`,
    );
  }
  return url.origin;
}

/** `acme-site` → `Acme Site`. A starting point for SITE_NAME, which the user owns from here. */
function siteName(name: string): string {
  return name
    .split('-')
    .filter(Boolean)
    .map((word) => strings.capitalize(word))
    .join(' ');
}

/**
 * Converts the SSR application into a prerendered static one.
 *
 * Every step asserts the anchor it depends on. If a future Angular renames
 * `outputMode` or stops emitting `ssr.entry`, this fails during generation with
 * the name of the thing it could not find — rather than quietly producing a
 * site that still builds a Node server nobody deploys.
 */
function makeStatic(name: string): Rule {
  return (tree: Tree) => {
    const buildOptions = ['projects', name, 'architect', 'build', 'options'];

    // Captured before the option is removed: the file we delete must be the one
    // the config actually pointed at, not the one convention suggests.
    const serverEntry = new JsonFile(tree, ANGULAR_JSON).get<string>([
      ...buildOptions,
      'ssr',
      'entry',
    ]);

    updateJson(tree, ANGULAR_JSON, (file) => {
      const outputMode = file.mustGet<string>(
        [...buildOptions, 'outputMode'],
        `the build target's outputMode for "${name}", which the SSR application ` +
          `schematic sets to "server"`,
      );
      if (outputMode !== 'server') {
        throw new SchematicsException(
          `Expected "${name}" to be generated with outputMode "server" before ` +
            `converting it to "static", but found "${outputMode}".`,
        );
      }

      // Static output prerenders every route at build time. `server`
      // (main.server.ts) stays: prerendering runs the app on the server to
      // produce the HTML. Only the *request handler* goes.
      file.modify([...buildOptions, 'outputMode'], 'static');
      file.remove([...buildOptions, 'ssr']);
    });

    // The Express entry point, now unreferenced.
    if (serverEntry !== undefined && tree.exists(`/${serverEntry}`)) {
      tree.delete(`/${serverEntry}`);
    }

    // The script that would run it. Left in place it is a command that exits
    // with "cannot find module" against a bundle the build no longer emits.
    updateJson(tree, PACKAGE_JSON, (file) => {
      file.remove(['scripts', `serve:ssr:${name}`]);
    });
  };
}

/**
 * Budgets for a page, not an app.
 *
 * Angular's defaults (500 kB warning, 1 MB error) are sized for a client-side
 * app that ships its whole UI up front. A prerendered page has already shown
 * its content before any of that JavaScript runs, so what it ships afterwards
 * is overhead. The site this layout was extracted from — hydration, a design
 * system and two dozen pages — fits under the warning.
 */
function tightenBudgets(tree: Tree, name: string): void {
  updateJson(tree, ANGULAR_JSON, (file) => {
    const path = [
      'projects',
      name,
      'architect',
      'build',
      'configurations',
      'production',
      'budgets',
    ];
    const budgets = file.mustGet<Array<{ type?: string }>>(
      path,
      `the production budgets for "${name}", which the Angular schematic sets`,
    );
    const initial = budgets.findIndex((budget) => budget.type === 'initial');
    if (initial === -1) {
      throw new SchematicsException(
        `Expected an "initial" budget in the production configuration of "${name}".`,
      );
    }
    file.modify([...path, initial, 'maximumWarning'], '380kB');
    file.modify([...path, initial, 'maximumError'], '450kB');
  });
}

interface SiteTemplateOptions {
  prefix: string;
  origin: string;
  siteName: string;
  placeholderOrigin: boolean;
  port: number;
  e2e: boolean;
}

/**
 * The providers Angular's SSR application skeleton puts in `app.config.ts`.
 *
 * The scaffold replaces that file with one that adds the head-tag strategy and
 * scroll restoration. It checks first that it is replacing exactly this list,
 * so a provider a later Angular minor adds fails generation by name instead of
 * disappearing from every new site.
 */
const EXPECTED_PROVIDERS = [
  'provideBrowserGlobalErrorListeners()',
  'provideRouter(routes)',
  'provideClientHydration()',
];

/**
 * Replaces Angular's placeholder page with a site skeleton: a shell with
 * landmarks and a skip link, a home page, a prerendered 404, and the SEO layer
 * (`site.ts`, `seo/page-meta.ts`, `robots.txt`).
 *
 * Overwrites files Angular just wrote: `app.html` is a welcome page meant to
 * be deleted, and its spec asserts on it. `app.config.ts` is the exception
 * that is checked before it is replaced.
 */
function siteScaffold(name: string, options: SiteTemplateOptions): Rule {
  return (tree: Tree) => {
    const root = requireRoot(tree, name);
    assertKnownProviders(tree, `/${root}/src/app/app.config.ts`);

    const templates = apply(url('./files/site'), [
      applyTemplates({ ...strings, name, ...options }),
      move(`/${root}`),
    ]);
    return mergeWith(templates, MergeStrategy.Overwrite);
  };
}

export function assertKnownProviders(tree: Tree, path: string): void {
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(`Expected Angular to have written ${path}.`);
  }
  const block = source.match(/providers:\s*\[([\s\S]*?)\]/)?.[1];
  if (block === undefined) {
    throw new SchematicsException(`Could not find the providers array in ${path}.`);
  }

  const found = block
    .split(',')
    .map((provider) => provider.trim())
    .filter(Boolean);
  const unexpected = found.filter((provider) => !EXPECTED_PROVIDERS.includes(provider));
  const missing = EXPECTED_PROVIDERS.filter((provider) => !found.includes(provider));
  if (unexpected.length > 0 || missing.length > 0) {
    throw new SchematicsException(
      `${path} no longer matches what the marketing template replaces. ` +
        `Unexpected: ${unexpected.join(', ') || 'none'}. Missing: ${missing.join(', ') || 'none'}. ` +
        `Update EXPECTED_PROVIDERS and files/site/src/app/app.config.ts.template together.`,
    );
  }
}

/**
 * The scripts that run after every build of the site: write the sitemap from
 * the prerendered pages, then fail on pages a crawler could not use.
 *
 * They take the app name as an argument and live in the root `scripts/`, so a
 * second marketing site shares them. Existing copies are left alone: a second
 * `ng generate` must not overwrite checks someone has tuned.
 */
function postbuildChecks(name: string): Rule {
  return (tree: Tree) => {
    const scripts = apply(url('./files/scripts'), [
      applyTemplates({}),
      move('/scripts'),
      filter((path) => !tree.exists(path)),
    ]);

    return chain([
      mergeWith(scripts),
      (host: Tree) => {
        addScripts(host, {
          [`postbuild:${name}`]:
            `node scripts/generate-sitemap.mjs ${name} && ` +
            `node scripts/verify-prerender.mjs ${name}`,
        });
      },
    ]);
  };
}

function marketingScripts(name: string): Rule {
  return (tree: Tree) => {
    addScripts(tree, {
      [`start:${name}`]: `ng serve ${name}`,
      [`build:${name}`]: `ng build ${name}`,
      [`test:${name}`]: `ng test ${name}`,
    });
    documentScripts(tree, {
      [`start:${name}`]: `serves \`${name}\``,
      [`build:${name}`]:
        `prerenders \`${name}\` to static HTML, writes its sitemap, and fails on any page ` +
        `a crawler could not use`,
      [`test:${name}`]: `unit tests for \`${name}\``,
    });

    // A workspace whose only app is its marketing site still needs `npm start`.
    claimDefaultStart(tree, name);
    addToBuild(tree, name);
    aggregateTests(tree);
  };
}

/** The rules a prerendered site adds to AGENTS.md, written once however many sites there are. */
function houseRules(): Rule {
  return (tree: Tree) => {
    appendSection(
      tree,
      '/AGENTS.md',
      'Prerendered sites',
      `
A marketing site is rendered to static HTML at build time, and that HTML is
what crawlers and first-time visitors get. \`npm run build:<site>\` fails on
the rules below that the build can see (\`scripts/verify-prerender.mjs\`).

- Every route states \`data.seo\` — a title, and a description no other page
  uses. \`PageMetaStrategy\` turns it into the head tags.
- One \`<h1>\` per page, in the page component. Never in the shell.
- Prerendering runs the app in Node. There is no \`window\`, \`localStorage\` or
  \`matchMedia\`: reach the DOM through \`inject(DOCUMENT)\`, and run
  browser-only code in \`afterNextRender\`.
- Nothing may set a colour scheme (\`data-theme\`) on \`<html>\` during
  prerender. It would be baked into the HTML and override every visitor's OS
  preference; light and dark follow \`prefers-color-scheme\` in CSS.
- A new page needs a link from an existing one. Crawlers find pages that way,
  and so does the e2e accessibility check.
`,
    );
  };
}

/**
 * The e2e suite for a site: the app's Playwright config and tsconfig, with the
 * site's own specs in place of the app smoke test. Those check what a
 * prerendered site specifically gets wrong — hydration mismatches, a 404 that
 * gets indexed, head tags that go stale on client navigation — and run AXE on
 * every page reachable from the home page, in both colour schemes.
 */
function e2eConfig(name: string, port: number, prefix: string): Rule {
  return (tree: Tree) => {
    const root = requireRoot(tree, name);
    const context = {
      ...strings,
      name,
      port,
      prefix,
      pathToRoot: '../'.repeat(root.split('/').filter(Boolean).length),
    };

    const shared = apply(url('../app/files'), [
      filter((path) => !path.endsWith('smoke.spec.ts.template')),
      applyTemplates(context),
      move(`/${root}`),
    ]);
    const specs = apply(url('./files/e2e'), [applyTemplates(context), move(`/${root}`)]);

    return chain([
      mergeWith(shared, MergeStrategy.Overwrite),
      mergeWith(specs, MergeStrategy.Overwrite),
      e2eScripts(name, root),
      (host: Tree) => {
        addDependencies(host, pins(['axe-core']));
      },
    ]);
  };
}

function requireRoot(tree: Tree, name: string): string {
  const root = readProject(tree, name).root;
  if (!root) {
    throw new SchematicsException(`Project "${name}" has no root in angular.json.`);
  }
  return root;
}
