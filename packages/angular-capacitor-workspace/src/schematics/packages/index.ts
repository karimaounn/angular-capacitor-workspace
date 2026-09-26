import { chain, SchematicsException, type Rule, type Tree } from '@angular-devkit/schematics';
import {
  installedCatalogIds,
  resolveCatalog,
  type CatalogEntry,
  type DependencyBlock,
} from '../../catalog';
import { JsonFile, updateJson } from '../../utils/json-file';
import {
  addDependencies,
  appendSection,
  ANGULAR_JSON,
  PACKAGE_JSON,
  prependStyles,
  README_MD,
  readProjects,
  type AngularProject,
} from '../../utils/workspace';

export interface PackagesOptions {
  /** Catalog ids — see src/catalog.ts. */
  packages?: string[];
}

/**
 * Wires curated packages into the workspace.
 *
 * Invoked by the generator for `--with`, and by hand afterwards:
 *
 *     ng generate angular-capacitor-workspace:packages cdk
 *
 * The ids are checked here rather than by an `enum` in schema.json, so the
 * catalog stays the one place the list lives. A second copy in a JSON file
 * would be a list to keep in step, and the day it fell behind the error would
 * be a schema violation naming neither the typo nor the alternatives.
 */
export function packages(options: PackagesOptions = {}): Rule {
  return () => {
    const ids = (options.packages ?? []).map((id) => id.trim()).filter((id) => id !== '');

    let entries: CatalogEntry[];
    try {
      entries = resolveCatalog(ids);
    } catch (error) {
      throw new SchematicsException((error as Error).message);
    }

    return chain(entries.map((entry) => wire(entry)));
  };
}

/**
 * Re-applies every catalog package the workspace already carries.
 *
 * `packages` is a one-shot over the projects that exist when it runs, so a
 * project generated afterwards comes up without the per-project half of an
 * entry — an app missing the stylesheet every other app has, a library missing
 * a peer it needs before it can publish. Nothing reports either; the app just
 * renders wrong and the library just resolves by accident of hoisting.
 *
 * So the app, marketing and library schematics end by asking what the manifest
 * already carries and re-running it. This is the same reasoning as
 * `addStyleIncludePath`, which is applied to every app whether or not a library
 * exists yet: the cheap unconditional pass is what keeps the order in which
 * someone generated their projects from mattering.
 *
 * Idempotent, because `wire` is — re-running it over projects that already have
 * everything is a no-op, and during initial generation the manifest is still
 * bare when the apps are created, so this does nothing until `packages` itself
 * runs last.
 */
export function installedPackages(): Rule {
  return (tree: Tree) => {
    if (!tree.exists(PACKAGE_JSON)) {
      return;
    }
    const manifest = new JsonFile(tree, PACKAGE_JSON);
    const deps = {
      ...manifest.get<Record<string, unknown>>(['dependencies']),
      ...manifest.get<Record<string, unknown>>(['devDependencies']),
    };
    return packages({ packages: installedCatalogIds(deps) });
  };
}

function wire(entry: CatalogEntry): Rule {
  return (tree: Tree) => {
    for (const block of ['dependencies', 'devDependencies'] as const) {
      const wanted = rangesFor(entry, block);
      if (Object.keys(wanted).length > 0) {
        // Not overwritten: a range someone has raised by hand is a decision,
        // and the policy floors are what exist to raise one back.
        addDependencies(tree, wanted, block);
      }
    }

    if (entry.libraryPeer) {
      declareAsLibraryPeer(tree, entry);
    }

    if (entry.appStyles) {
      wireAppStyles(tree, entry.appStyles);
    }

    if (entry.appSetup === 'service-worker') {
      wireServiceWorker(tree);
    }

    // Idempotent on the heading, so re-running for a package the workspace
    // already has leaves the section — and any edits to it — alone.
    appendSection(tree, README_MD, entry.title, entry.guidance);
  };
}

/**
 * Puts the entry's global stylesheets in front of every application's `styles`.
 *
 * Every application, rather than a default project, because that is the thing
 * a vendor `ng-add` cannot do here: it resolves against `defaultProject`, and a
 * workspace bootstrapped with `--no-create-application` and then filled with
 * several apps and a marketing site does not have one worth guessing at.
 *
 * Libraries are skipped — a library has no global stylesheet to prepend to,
 * and the Storybook target deliberately runs without a `styles` option. The
 * README section says what to do there instead.
 */
function wireAppStyles(tree: Tree, styles: readonly string[]): void {
  if (!tree.exists(ANGULAR_JSON)) {
    return;
  }

  for (const [name, project] of Object.entries(readProjects(tree))) {
    if (project.projectType !== 'application') {
      continue;
    }
    prependStyles(tree, name, styles);
  }
}

function rangesFor(entry: CatalogEntry, block: DependencyBlock): Record<string, string> {
  return Object.fromEntries(
    entry.packages.filter((pkg) => pkg.block === block).map((pkg) => [pkg.name, pkg.range]),
  );
}

/**
 * Declares the entry's packages as peers of every library in the workspace.
 *
 * A library's `package.json` is what ships to a registry, and a peer it does
 * not declare is a dependency its consumers are not asked to provide. The root
 * manifest carries the real installed range; this only says "a consumer needs
 * one too", which is exactly what Angular's library schematic writes for
 * `@angular/core`.
 */
function declareAsLibraryPeer(tree: Tree, entry: CatalogEntry): void {
  if (!tree.exists(ANGULAR_JSON)) {
    return;
  }

  for (const [name, project] of Object.entries(readProjects(tree))) {
    if (project.projectType !== 'library' || !project.root) {
      continue;
    }

    const manifest = `/${project.root}/package.json`;
    if (!tree.exists(manifest)) {
      // A library without its own manifest is not one ng-packagr built, so
      // there is nothing for a peer declaration to travel in.
      continue;
    }

    updateJson(tree, manifest, (file) => {
      file.mustGet(
        ['peerDependencies'],
        `the peerDependencies block of library "${name}", which the Angular ` +
          `library schematic creates`,
      );
      for (const pkg of entry.packages) {
        if (!file.has(['peerDependencies', pkg.name])) {
          file.modify(['peerDependencies', pkg.name], pkg.range);
        }
      }
      file.sortKeys(['peerDependencies']);
    });
  }
}

/** Angular's name for the per-project service worker config. */
const NGSW_CONFIG = 'ngsw-config.json';

/**
 * Whether the app is running inside the Capacitor shell, as it is written above
 * the application's config.
 *
 * `isNativePlatform()` rather than a test for the global: Capacitor injects
 * `window.Capacitor` into the native WebView, but `@capacitor/core` assigns the
 * same global from its module initialiser on *every* platform, browser
 * included. So the day a plugin with a web implementation is imported into
 * shared code — `@capacitor/preferences`, `@capacitor/share` — the global
 * exists in the browser too, and a check for its presence would quietly stop
 * registering the worker on the web. Asking the platform is right in both cases.
 *
 * Read off the global rather than imported, because `@capacitor/core` is
 * declared by the `mobile/` sibling and a web-only app does not have it at all;
 * importing it from `web/` would be a dependency the web app never declared.
 * An app that does declare it can swap this for
 * `import { Capacitor } from '@capacitor/core'` and lose nothing.
 */
const NATIVE_SHELL_CONST = `/**
 * True only inside the Capacitor WebView.
 *
 * Read off the global that Capacitor injects rather than imported from
 * \`@capacitor/core\`, which belongs to the \`mobile/\` sibling. Note that
 * package sets the same global in a browser, where \`isNativePlatform()\` is
 * false — which is why this asks the platform instead of testing that the
 * global exists.
 */
const inNativeShell =
  (globalThis as { Capacitor?: { isNativePlatform(): boolean } }).Capacitor?.isNativePlatform() ===
  true;`;

/**
 * The registration, as it is written into every application's `app.config.ts`.
 *
 * `enabled` carries the two conditions Angular's own `ng add` cannot know about
 * between them:
 *
 * `!isDevMode()` because `serviceWorker` is set on the production build
 * configuration only, so `ngsw-worker.js` does not exist under `ng serve` and
 * registering it there is a 404 in the console on every reload.
 *
 * `!inNativeShell` because the mobile sibling is not a second build.
 * `sync:<app>` runs `build:<app>` and copies `dist/<app>/browser` into the
 * native projects, so the worker would ship on device, where the assets are
 * already local files and the only thing it can do is serve the shell it cached
 * before the last native update.
 */
const SERVICE_WORKER_PROVIDER = `provideServiceWorker('ngsw-worker.js', {
      // Not under \`ng serve\`, where the worker is never emitted, and not on
      // device, where the app is served from the native bundle. See the Service
      // worker section of the README.
      enabled: !isDevMode() && !inNativeShell,
      registrationStrategy: 'registerWhenStable:30000',
    })`;

/**
 * Wires the service worker into every application that is not a prerendered
 * site: config file, build option, provider.
 *
 * Every application rather than a default project, for the reason
 * `wireAppStyles` gives — a vendor `ng add` resolves against `defaultProject`,
 * and a `--no-create-application` workspace carrying several apps has no
 * default worth guessing at. Done by hand rather than by delegating to
 * `@schematics/angular:service-worker`, which would otherwise be the right
 * answer: that schematic adds its dependency through `addDependency`, which
 * queues a `NodePackageInstallTask`, and an install fired from inside the
 * workflow runs before the gate has resolved and audited a lockfile — the one
 * ordering this generator exists to enforce. Its schema has no `skipInstall`.
 *
 * Idempotent at each of the three steps, so the re-application in
 * `installedPackages` reaches an app generated later without disturbing one
 * that was already wired.
 */
function wireServiceWorker(tree: Tree): void {
  if (!tree.exists(ANGULAR_JSON)) {
    return;
  }

  for (const [name, project] of Object.entries(readProjects(tree))) {
    if (project.projectType !== 'application' || !project.root || isPrerendered(project)) {
      continue;
    }
    writeNgswConfig(tree, project.root);
    enableServiceWorkerBuild(tree, name, project.root);
    registerServiceWorker(tree, name, project.root);
  }
}

/**
 * A prerendered site, which does not get a service worker by default.
 *
 * Not a technical limitation — it works there — but the wrong default for what a
 * marketing site is for. Its value is being current and being crawlable, and a
 * worker helps with neither: crawlers do not run one, and a returning visitor
 * keeps getting the previous deploy until the worker has fetched the new version
 * and they navigate again. A price, a launch date or a correction is the worst
 * thing to serve a week late. It also only half works: the default asset group
 * prefetches `/index.html` and the hashed bundles, not the per-route HTML a
 * prerender writes, so a cached navigation loses the prerendered document that
 * was the point of prerendering. And the site is usually behind a CDN already
 * doing the caching, without the staleness.
 *
 * A docs site is the case where it does pay — offline reading, instant repeat
 * navigation — so the README section says how to add it to one site. Off is the
 * safer default of the two: it fails as an optimisation nobody turned on, where
 * on fails as stale copy nobody noticed.
 *
 * `outputMode: 'static'` is the same signal `inferFeatures` reads to recognise a
 * marketing site, rather than a name or a path this schematic would have to be
 * told about.
 */
function isPrerendered(project: AngularProject): boolean {
  return project.architect?.['build']?.options?.['outputMode'] === 'static';
}

/**
 * Writes the project's `ngsw-config.json`, if it does not have one.
 *
 * The content is Angular's default, and this is the one place in the entry
 * where a copy was the lesser evil: the alternative is reading
 * `@schematics/angular/service-worker/files/ngsw-config.json.template` at run
 * time, which is a private path inside another package. A copy in a file the
 * user owns and edits is easier to defend than a private import, and
 * `test/schematics.spec.ts` diffs the two so a change in Angular's defaults
 * fails in CI rather than silently in a generated workspace.
 */
function writeNgswConfig(tree: Tree, root: string): void {
  const path = `/${root}/${NGSW_CONFIG}`;
  if (tree.exists(path)) {
    return;
  }

  const config = {
    // The same relative path Angular's template computes, so an editor resolves
    // the schema and completes the file.
    $schema: `${relativePathToRoot(root)}/node_modules/@angular/service-worker/config/schema.json`,
    index: '/index.html',
    assetGroups: [
      {
        name: 'app',
        installMode: 'prefetch',
        resources: {
          files: [
            '/favicon.ico',
            '/index.csr.html',
            '/index.html',
            '/manifest.webmanifest',
            '/*.css',
            '/*.js',
          ],
        },
      },
      {
        name: 'assets',
        installMode: 'lazy',
        updateMode: 'prefetch',
        resources: {
          files: ['/**/*.(svg|cur|jpg|jpeg|png|apng|webp|avif|gif|otf|ttf|woff|woff2)'],
        },
      },
    ],
  };

  tree.create(path, `${JSON.stringify(config, null, 2)}\n`);
}

/** `projects/shop/web` → `../../..`, the workspace root seen from the project. */
function relativePathToRoot(root: string): string {
  const depth = root.split('/').filter(Boolean).length;
  return depth === 0 ? '.' : Array.from({ length: depth }, () => '..').join('/');
}

/**
 * Points the production build configuration at the config file.
 *
 * Production only, which is where Angular's own schematic puts it: a service
 * worker under `ng serve` would cache a development build and then serve it
 * back over the live rebuilds it is there to replace.
 */
function enableServiceWorkerBuild(tree: Tree, name: string, root: string): void {
  updateJson(tree, ANGULAR_JSON, (file) => {
    const production = ['projects', name, 'architect', 'build', 'configurations', 'production'];
    file.mustGet(
      production,
      `the production build configuration of application "${name}", which the ` +
        `Angular application schematic writes`,
    );

    const option = [...production, 'serviceWorker'];
    // Left alone if it is already set — including when it points somewhere
    // else, which is someone having moved the file on purpose.
    if (!file.has(option)) {
      file.modify(option, `${root}/${NGSW_CONFIG}`);
    }
  });
}

/**
 * Adds `provideServiceWorker` to the application's root providers.
 *
 * String surgery rather than the TypeScript AST: `typescript` is not a
 * dependency of this package, and reaching for the copy that
 * `@schematics/angular` happens to hoist is the accident this workspace refuses
 * everywhere else. The shapes it has to handle are the two `app.config.ts`
 * files this collection produces — Angular's, and the marketing template's —
 * and it fails by name rather than guessing when it meets a third.
 */
function registerServiceWorker(tree: Tree, name: string, root: string): void {
  const path = `/${root}/src/app/app.config.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected application "${name}" to have ${path}, which the Angular ` +
        `application schematic writes for a standalone app.`,
    );
  }

  // The whole rule is keyed off this one symbol, so an app someone has already
  // wired by hand — or by `ng add @angular/pwa` — is left exactly as it is.
  if (source.includes('provideServiceWorker')) {
    return;
  }

  let next = addNamedImport(source, path, '@angular/core', 'isDevMode');
  next = addFrameworkImport(
    next,
    "import { provideServiceWorker } from '@angular/service-worker';",
  );
  next = declareBeforeConfig(next, path, NATIVE_SHELL_CONST);
  next = appendProvider(next, path, SERVICE_WORKER_PROVIDER);
  tree.overwrite(path, next);
}

/**
 * Puts a declaration above `export const appConfig`.
 *
 * The platform check is hoisted rather than inlined into `enabled` so that the
 * comment explaining it has somewhere to live that is not four levels deep in an
 * object literal.
 */
function declareBeforeConfig(source: string, path: string, declaration: string): string {
  const anchor = 'export const appConfig';
  const at = source.indexOf(anchor);
  if (at === -1) {
    throw new SchematicsException(
      `Could not find \`${anchor}\` in ${path}, which is what the service worker ` +
        `registration is added to.`,
    );
  }
  return `${source.slice(0, at)}${declaration}\n\n${source.slice(at)}`;
}

/** Adds one symbol to an existing named import, at the end of the list. */
function addNamedImport(source: string, path: string, module: string, symbol: string): string {
  const pattern = new RegExp(`import \\{([^}]*)\\} from '${module}';`);
  const match = source.match(pattern);
  if (!match) {
    throw new SchematicsException(
      `Expected ${path} to import from '${module}', which is where \`${symbol}\` comes from.`,
    );
  }

  const named = match[1]!.split(',').map((part) => part.trim());
  if (named.includes(symbol)) {
    return source;
  }
  return source.replace(match[0], `import { ${[...named, symbol].join(', ')} } from '${module}';`);
}

/**
 * Inserts an import line after the last `@angular/*` one.
 *
 * After the framework imports rather than after all of them, so the new line
 * lands in the group it belongs to instead of below the relative imports.
 */
function addFrameworkImport(source: string, line: string): string {
  if (source.includes(line)) {
    return source;
  }

  const lines = source.split('\n');
  const last = lines.reduce(
    (found, text, index) => (/^import .* from '@angular\//.test(text) ? index : found),
    -1,
  );
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/**
 * Appends a provider to the `providers` array of an `ApplicationConfig`.
 *
 * The array's end is found by matching brackets from its opening one rather than
 * by a regex, because the providers already there contain brackets of their own.
 * A bracket inside a string or a comment would fool it; none of the configs this
 * collection writes has one, and the alternative is the AST dependency this
 * package does not have.
 */
function appendProvider(source: string, path: string, provider: string): string {
  const opening = 'providers: [';
  const start = source.indexOf(opening);
  if (start === -1) {
    throw new SchematicsException(`Could not find the providers array in ${path}.`);
  }

  const from = start + opening.length;
  let depth = 1;
  let end = -1;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw new SchematicsException(`The providers array in ${path} is not closed.`);
  }

  // Angular's template leaves the last provider without a trailing comma.
  const existing = source.slice(from, end).replace(/\s+$/, '');
  const comma = existing === '' || existing.endsWith(',') ? '' : ',';
  return `${source.slice(0, from)}${existing}${comma}\n    ${provider},\n  ${source.slice(end)}`;
}
