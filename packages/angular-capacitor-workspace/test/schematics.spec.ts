import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostTree } from '@angular-devkit/schematics';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { latestVersions } from '@schematics/angular/utility/latest-versions';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertKnownProviders } from '../src/schematics/marketing';
import { VERSIONS } from '../src/policy/versions';

// The schematic engine `require()`s factories by path, so it needs the compiled
// collection — the same artefact published to npm, which is the right thing to
// be testing. `npm test` builds first.
const collection = join(__dirname, '..', 'dist', 'collection.json');

if (!existsSync(collection)) {
  throw new Error(
    `${collection} does not exist. Run \`npm run build\` before the tests — ` +
      `the schematic runner loads compiled factories, not sources.`,
  );
}

/**
 * The schematics are exercised against a real `@schematics/angular` workspace
 * rather than a hand-built tree. The whole design is an overlay on Angular's
 * output, so a fixture we wrote ourselves would test the overlay against our
 * own idea of that output — and pass on exactly the day Angular changes it.
 */
function runner(): SchematicTestRunner {
  return new SchematicTestRunner('acw', collection);
}

async function baseWorkspace(): Promise<UnitTestTree> {
  return runner().runExternalSchematic('@schematics/angular', 'workspace', {
    name: 'test-ws',
    version: '22.0.0',
    newProjectRoot: 'projects',
  });
}

/**
 * The scripts table from the generated README, checked to be one unbroken
 * table — a blank line or stray text inside would split it when rendered.
 */
function scriptsTable(tree: UnitTestTree): string {
  const match = tree
    .readContent('/README.md')
    .match(
      /<!-- angular-capacitor-workspace:scripts -->\n\n([\s\S]*?)\n\n<!-- \/angular-capacitor-workspace:scripts -->/,
    );
  if (!match) {
    throw new Error('The README has no scripts table.');
  }
  const table = match[1]!;
  expect(table.split('\n').every((line) => line.startsWith('|'))).toBe(true);
  return table;
}

/** A project's global `styles`, as plain paths. */
function buildStyles(tree: UnitTestTree, project: string): string[] {
  const options = JSON.parse(tree.readContent('/angular.json')).projects[project].architect.build
    .options;
  return (options.styles as Array<string | { input: string }>).map((style) =>
    typeof style === 'string' ? style : style.input,
  );
}

describe('workspace overlay', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    tree = await runner().runSchematic('workspace', { e2e: 'playwright' }, await baseWorkspace());
  });

  it('emits the shared Playwright base, the house rules and a README', () => {
    expect(tree.files).toContain('/playwright.base.ts');
    expect(tree.files).toContain('/AGENTS.md');
    expect(tree.files).toContain('/README.md');
  });

  it('declares the same runtime floor this package declares', () => {
    // Read, not hard-coded. The assertion is that the two agree, so a floor
    // raised in one place and not the other fails here rather than in a
    // generated workspace whose `allowScripts` silently does nothing.
    const own = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      engines: Record<string, string>;
    };
    const generated = JSON.parse(tree.readContent('/package.json')) as {
      engines?: Record<string, string>;
    };

    expect(generated.engines).toEqual(own.engines);
    // Guards the assertion above against passing because both are empty.
    expect(own.engines.npm).toBeDefined();
    expect(own.engines.node).toBeDefined();
  });

  it('emits a CI workflow that enforces the install-script allowlist', () => {
    const workflow = tree.readContent('/.github/workflows/ci.yml');
    expect(workflow).toContain('npm ci --strict-allow-scripts');
    expect(workflow).toContain('npm run audit:policy');
  });

  it('renders the CI workflow to valid YAML in every feature combination', async () => {
    // The workflow template has EJS conditionals around whole jobs, and YAML is
    // indentation-sensitive: a conditional that leaves a stray blank line or an
    // unrendered tag produces a file GitHub rejects, which nobody discovers
    // until they push.
    for (const options of [
      { e2e: 'playwright', uiLib: 'ui' },
      { e2e: 'playwright' },
      { uiLib: 'ui' },
      {},
    ]) {
      const rendered = await runner().runSchematic('workspace', options, await baseWorkspace());
      const yaml = rendered.readContent('/.github/workflows/ci.yml');

      expect(yaml, `options=${JSON.stringify(options)}`).not.toMatch(/<%|%>/);

      // Two-space-indented keys *after* `jobs:` — the `on:` block above it has
      // the same indentation and would otherwise be counted as jobs.
      const jobsBlock = yaml.slice(yaml.indexOf('\njobs:'));
      const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map(([, job]) => job);
      expect(jobs, `options=${JSON.stringify(options)}`).toContain('dependencies');
      expect(jobs).toContain('build');

      if (options.e2e === 'playwright') {
        expect(jobs, `options=${JSON.stringify(options)}`).toContain('e2e');
      } else {
        expect(jobs, `options=${JSON.stringify(options)}`).not.toContain('e2e');
      }

      // Contrast and library builds only make sense with a library.
      expect(yaml.includes('check:contrast')).toBe(Boolean(options.uiLib));

      // Every job must declare a runner; a conditional that swallowed one would
      // still look plausible.
      expect(yaml.match(/runs-on:/g)?.length).toBe(jobs.length);
    }
  });

  it('omits the Playwright base when e2e is off', async () => {
    const without = await runner().runSchematic('workspace', {}, await baseWorkspace());
    expect(without.files).not.toContain('/playwright.base.ts');
    expect(JSON.parse(without.readContent('/package.json')).devDependencies['@types/node']).toBe(
      undefined,
    );
  });

  it('adds @types/node for the Playwright base, at our range and not Angular’s', () => {
    // The base reads process.env and the e2e scripts type-check it. Angular
    // only adds @types/node with a server target, so an app-only workspace
    // would otherwise fail its first `npm run e2e` on a missing type.
    //
    // The range is pinned rather than taken from `latestVersions`, which writes
    // the floor Angular's own tooling supports: below the Node this workspace
    // declares, and below the one vitest 5 peers. Delegating it failed the
    // install ERESOLVE.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;
    expect(devDependencies['@types/node']).toBe(VERSIONS['@types/node'].range);
    expect(devDependencies['@types/node']).not.toBe(latestVersions['@types/node']);
  });

  it('creates an empty paths map for libraries to fill', () => {
    expect(tree.readContent('/tsconfig.json')).toContain('"paths"');
  });

  it('adds the policy commands', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['audit:policy']).toBe('angular-capacitor-workspace audit');
    expect(scripts['doctor']).toBe('angular-capacitor-workspace doctor');
  });

  it('describes only the features it was asked for in the README', async () => {
    const minimal = await runner().runSchematic('workspace', {}, await baseWorkspace());
    // With no library there is no build:libs to run, and telling someone to
    // run it is the first command in the README failing.
    expect(minimal.readContent('/README.md')).not.toContain('build:libs');
    expect(minimal.readContent('/README.md')).not.toContain('playwright.base.ts');
    expect(tree.readContent('/README.md')).toContain('playwright.base.ts');

    const withLib = await runner().runSchematic(
      'workspace',
      { uiLib: 'ui' },
      await baseWorkspace(),
    );
    expect(withLib.readContent('/README.md')).toContain('npm run build:libs   # required once');
  });

  it('starts the README scripts table with the policy commands', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run audit:policy` |');
    expect(table).toContain('| `npm run doctor` |');
  });

  it('does not invent a build:libs script before any library exists', () => {
    // An empty `build:libs` that exits 0 would make the README's "run this
    // first" instruction a lie.
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['build:libs']).toBeUndefined();
  });
});

describe('app', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    tree = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, base);
  });

  it('generates into a web/ subdirectory, leaving room for a mobile sibling', () => {
    const project = JSON.parse(tree.readContent('/angular.json')).projects['shop'];
    expect(project.root).toBe('projects/shop/web');
    expect(project.sourceRoot).toBe('projects/shop/web/src');
    expect(tree.files).toContain('/projects/shop/web/src/main.ts');
  });

  it('lets Angular compute the tsconfig extends for the deeper root', () => {
    // Delegated, not patched: the whole point of passing `projectRoot` rather
    // than relocating afterwards.
    expect(tree.readContent('/projects/shop/web/tsconfig.app.json')).toContain(
      '"extends": "../../../tsconfig.json"',
    );
  });

  it('uses only @angular/build builders', () => {
    const architect = JSON.parse(tree.readContent('/angular.json')).projects['shop'].architect;
    for (const target of Object.values<{ builder: string }>(architect)) {
      expect(target.builder).toMatch(/^@angular\/build:/);
    }
  });

  it('is client-rendered — no server entry point', () => {
    const options = JSON.parse(tree.readContent('/angular.json')).projects['shop'].architect.build
      .options;
    expect(options.server).toBeUndefined();
    expect(options.outputMode).toBeUndefined();
  });

  it('points npm start at the first app rather than a project-less ng serve', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['start']).toBe('npm run start:shop');
    expect(scripts['watch']).toContain('shop');
  });

  it('delegates the per-app Playwright config to the workspace base', () => {
    const config = tree.readContent('/projects/shop/web/playwright.config.ts');
    expect(config).toContain("from '../../../playwright.base'");
    expect(config).toContain("project: 'shop'");
  });

  it('lists its scripts in the README', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run start:shop` |');
    expect(table).toContain('| `npm start` | `npm run start:shop`');
    expect(table).toContain('| `npm run e2e:shop` |');
  });

  it('adds each README row once, however many apps share the script', async () => {
    // Its own workspace: running a schematic mutates the tree it is given, and
    // `tree` is shared with the tests after this one.
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const one = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, base);
    const two = await runner().runSchematic('app', { name: 'admin', e2e: 'playwright' }, one);
    const table = scriptsTable(two);
    expect(table.match(/\| `npm run e2e` \|/g)).toHaveLength(1);
    expect(table).toContain('| `npm run e2e:admin` |');
  });

  it('leaves a README without the scripts table alone', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    base.overwrite('/README.md', '# Ours\n');
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    expect(withApp.readContent('/README.md')).toBe('# Ours\n');
  });

  it('gives a second app a different port', async () => {
    const two = await runner().runSchematic('app', { name: 'admin', e2e: 'playwright' }, tree);
    const shop = two.readContent('/projects/shop/web/playwright.config.ts');
    const admin = two.readContent('/projects/admin/web/playwright.config.ts');
    const portOf = (text: string) => text.match(/port: (\d+)/)?.[1];
    expect(portOf(shop)).not.toBe(portOf(admin));
  });

  /** A workspace of its own, with `shop` in it: `tree` has already gained an `admin`. */
  async function withShop(): Promise<UnitTestTree> {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    return runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, base);
  }

  it('writes the port into angular.json, where ng serve and Playwright agree on it', async () => {
    const two = await runner().runSchematic(
      'app',
      { name: 'admin', e2e: 'playwright' },
      await withShop(),
    );
    const projects = JSON.parse(two.readContent('/angular.json')).projects;
    expect(projects['shop'].architect.serve.options.port).toBe(4200);
    expect(projects['admin'].architect.serve.options.port).toBe(4201);
    expect(two.readContent('/projects/admin/web/playwright.config.ts')).toContain('port: 4201');
  });

  it('takes the lowest free port, so a deleted app does not hand its number on twice', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('app', { name: 'shop', port: 4205 }, base);
    const two = await runner().runSchematic('app', { name: 'admin' }, one);
    const three = await runner().runSchematic('app', { name: 'docs' }, two);
    const projects = JSON.parse(three.readContent('/angular.json')).projects;
    expect(projects['admin'].architect.serve.options.port).toBe(4200);
    expect(projects['docs'].architect.serve.options.port).toBe(4201);
  });

  it('builds and tests every app from npm run build and npm test', async () => {
    const two = await runner().runSchematic('app', { name: 'admin' }, await withShop());
    const scripts = JSON.parse(two.readContent('/package.json')).scripts;
    expect(scripts['build']).toBe('npm run build:shop && npm run build:admin');
    // Project-less `ng test` already runs every project. Without --no-watch the
    // first would watch in a terminal and never hand over to the second.
    expect(scripts['test']).toBe('ng test --no-watch');
    // One command serves one app, so start stays with the first.
    expect(scripts['start']).toBe('npm run start:shop');
  });

  it('keeps building the apps a workspace already had', async () => {
    // What `ng add` meets: an app Angular generated, and its project-less
    // `ng build`. Starting the chain from the new app alone would silently stop
    // building the old one.
    const existing = await runner().runExternalSchematic(
      '@schematics/angular',
      'application',
      { name: 'legacy', skipInstall: true },
      await baseWorkspace(),
    );
    const added = await runner().runSchematic('app', { name: 'shop' }, existing);
    expect(JSON.parse(added.readContent('/package.json')).scripts['build']).toBe(
      'ng build legacy && npm run build:shop',
    );
  });

  it('type-checks its e2e specs before running them', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['e2e:shop']).toBe(
      'tsc -p projects/shop/web/e2e/tsconfig.json && ' +
        'playwright test --config projects/shop/web/playwright.config.ts',
    );
    expect(tree.readContent('/projects/shop/web/e2e/tsconfig.json')).toContain(
      '"extends": "../../../../tsconfig.json"',
    );
    // Referenced, so an editor checks the specs against this config.
    expect(tree.readContent('/tsconfig.json')).toContain('./projects/shop/web/e2e/tsconfig.json');
  });

  it('replaces the Angular welcome page with a shell and a starter route', () => {
    const shell = tree.readContent('/projects/shop/web/src/app/app.html');
    expect(shell).toContain('<router-outlet />');
    expect(shell).toContain('Skip to content');
    // Angular's splash, and the spec that asserts on it, are both gone.
    expect(shell).not.toContain('Hello,');
    expect(tree.files).toContain('/projects/shop/web/src/app/pages/home.page.ts');
    expect(tree.readContent('/projects/shop/web/src/app/app.routes.ts')).toContain(
      "import('./pages/home.page')",
    );
  });

  it('titles the shell from the app name', () => {
    expect(tree.readContent('/projects/shop/web/src/app/app.ts')).toContain("signal('Shop')");
  });

  it('emits no theme suite when there is no theme', () => {
    expect(tree.files).not.toContain('/projects/shop/web/e2e/theme.spec.ts');
  });

  it('leaves the plain shell alone when there is no design system to show', () => {
    const shell = tree.readContent('/projects/shop/web/src/app/app.ts');
    expect(shell).not.toContain('theme-toggle');
    // Nothing to import, so nothing is written into the global stylesheet.
    expect(tree.readContent('/projects/shop/web/src/styles.scss')).not.toContain('@use');
    expect(tree.readContent('/projects/shop/web/src/index.html')).not.toContain('data-theme');
  });

  it('looks for the root component under the prefix it was generated with', async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const prefixed = await runner().runSchematic(
      'app',
      { name: 'shop', prefix: 'acme', e2e: 'playwright' },
      base,
    );
    expect(prefixed.readContent('/projects/shop/web/e2e/smoke.spec.ts')).toContain(
      "page.locator('acme-root')",
    );
  });
});

describe('app, in a workspace that already has a design system', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
    tree = await runner().runSchematic('app', { name: 'shop' }, withLib);
  });

  it('loads the design tokens from the app stylesheet', () => {
    // Without this line the tokens are built, published and never loaded —
    // every var() in the library resolves to nothing.
    expect(tree.readContent('/projects/shop/web/src/styles.scss')).toContain(
      "@use 'ui/styles' as *;",
    );
  });

  it('builds the libraries before a per-app build, which npm cannot hook', () => {
    // `prebuild` only covers the script named `build`; `npm run build:shop` on a
    // fresh clone would otherwise fail in Sass on a path under dist/.
    expect(JSON.parse(tree.readContent('/package.json')).scripts['prebuild:shop']).toContain(
      'npm run build:libs',
    );
  });

  it('puts the theme toggle in the shell, so every route has it', () => {
    expect(tree.readContent('/projects/shop/web/src/app/app.ts')).toContain(
      "import { ThemeToggle } from 'ui';",
    );
    expect(tree.readContent('/projects/shop/web/src/app/app.html')).toContain(
      '<ui-theme-toggle />',
    );
  });

  it('e2e-tests the part that runs before Angular does', async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
    const app = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, withLib);

    expect(app.files).toContain('/projects/shop/web/e2e/theme.spec.ts');
  });

  it('demonstrates the library on the starter page', () => {
    const page = tree.readContent('/projects/shop/web/src/app/pages/home.page.html');
    expect(page).toContain('<ui-button');
    expect(page).toContain('<ui-field');
  });

  it('applies the saved theme before the first paint', () => {
    const html = tree.readContent('/projects/shop/web/src/index.html');
    // Before </head>, and reading the keys ThemeService writes.
    expect(html).toContain("localStorage.getItem('ui.theme-mode')");
    expect(html).toContain("localStorage.getItem('ui.theme-palette')");
    expect(html.indexOf('data-theme')).toBeLessThan(html.indexOf('</head>'));
  });

  it('takes the selector prefix from the library, not from the app', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withLib = await runner().runSchematic('ui-lib', { name: 'design', prefix: 'acme' }, base);
    const app = await runner().runSchematic('app', { name: 'shop', prefix: 'shop' }, withLib);

    expect(app.readContent('/projects/shop/web/src/app/app.html')).toContain(
      '<acme-theme-toggle />',
    );
    expect(app.readContent('/projects/shop/web/src/index.html')).toContain("'acme.theme-mode'");
  });
});

describe('mobile', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    tree = await runner().runSchematic('app', { name: 'shop', mobile: ['android'] }, base);
  });

  it('adds a Capacitor sibling beside web/, as its own npm workspace member', () => {
    expect(tree.files).toContain('/projects/shop/mobile/capacitor.config.ts');
    expect(tree.files).toContain('/projects/shop/mobile/package.json');
    expect(JSON.parse(tree.readContent('/package.json')).workspaces).toContain(
      'projects/shop/mobile',
    );
  });

  it('points webDir at the app build output, relative to the mobile package', () => {
    expect(tree.readContent('/projects/shop/mobile/capacitor.config.ts')).toContain(
      "webDir: '../../../dist/shop/browser'",
    );
  });

  it('builds before syncing, because cap copies whatever is already in dist', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['sync:shop']).toMatch(/^npm run build:shop &&/);
  });

  it('lists the native scripts in the README', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run sync:shop:android` |');
    expect(table).toContain(
      '| `npm run open:shop:android` | opens the Android project in Android Studio |',
    );
    expect(table).toContain('| `npm run preflight:shop` |');
    expect(table).not.toContain(':ios');
  });
});

describe('marketing', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    tree = await runner().runSchematic(
      'marketing',
      { name: 'site', origin: 'https://Acme.example/', e2e: 'playwright' },
      base,
    );
  });

  const scripts = (t: UnitTestTree) => JSON.parse(t.readContent('/package.json')).scripts;

  it('switches the build to static output', () => {
    const options = JSON.parse(tree.readContent('/angular.json')).projects['site'].architect.build
      .options;
    expect(options.outputMode).toBe('static');
    // main.server.ts stays — prerendering runs the app on the server.
    expect(options.server).toBe('projects/site/web/src/main.server.ts');
    // The request handler goes.
    expect(options.ssr).toBeUndefined();
  });

  it('deletes the Express server entry point and the script that ran it', () => {
    expect(tree.files).not.toContain('/projects/site/web/src/server.ts');
    expect(scripts(tree)['serve:ssr:site']).toBeUndefined();
  });

  it('keeps the prerender route configuration Angular already emits', () => {
    const routes = tree.readContent('/projects/site/web/src/app/app.routes.server.ts');
    expect(routes).toContain('RenderMode.Prerender');
  });

  it('builds canonical URLs and robots.txt from the origin, trimmed to the origin', () => {
    expect(tree.readContent('/projects/site/web/src/app/site.ts')).toContain(
      "export const SITE_ORIGIN = 'https://acme.example';",
    );
    expect(tree.readContent('/projects/site/web/public/robots.txt')).toContain(
      'Sitemap: https://acme.example/sitemap.xml',
    );
    // Written once: the sitewide JSON-LD is built from site.ts, not repeated
    // in index.html where it could drift.
    expect(tree.readContent('/projects/site/web/src/index.html')).not.toContain('ld+json');
  });

  it('falls back to a placeholder origin, and says so where it is set', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const placeholder = await runner().runSchematic('marketing', { name: 'site' }, base);
    const site = placeholder.readContent('/projects/site/web/src/app/site.ts');
    expect(site).toContain("export const SITE_ORIGIN = 'https://example.com';");
    expect(site).toContain('example.com is a placeholder');
    expect(tree.readContent('/projects/site/web/src/app/site.ts')).not.toContain('placeholder');
  });

  it('rejects an origin with a path, whose canonicals would all sit one level deep', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    await expect(
      runner().runSchematic(
        'marketing',
        { name: 'site', origin: 'https://acme.example/site' },
        base,
      ),
    ).rejects.toThrow();
  });

  it('writes head tags through PageMetaStrategy, keeping every provider Angular emits', () => {
    const config = tree.readContent('/projects/site/web/src/app/app.config.ts');
    expect(config).toContain('{ provide: TitleStrategy, useClass: PageMetaStrategy }');
    for (const provider of [
      'provideBrowserGlobalErrorListeners()',
      'provideClientHydration()',
      "provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }))",
    ]) {
      expect(config).toContain(provider);
    }
    expect(tree.files).toContain('/projects/site/web/src/app/seo/page-meta.spec.ts');
  });

  it('prerenders a noindex 404 page for the host to serve', () => {
    const routes = tree.readContent('/projects/site/web/src/app/app.routes.ts');
    expect(routes).toContain("path: '404'");
    expect(routes).toContain("path: '**'");
    expect(routes).toContain('noindex: true');
    expect(tree.files).toContain('/projects/site/web/src/app/pages/not-found.page.ts');
  });

  it("replaces Angular's welcome page, so each page owns its one <h1>", () => {
    const shell = tree.readContent('/projects/site/web/src/app/app.html');
    expect(shell).not.toContain('<h1');
    expect(shell).toContain('<router-outlet />');
    expect(tree.readContent('/projects/site/web/src/app/app.spec.ts')).not.toContain('Hello,');
  });

  it('mounts the root component its index.html names, under the chosen prefix', async () => {
    expect(tree.readContent('/projects/site/web/src/index.html')).toContain(
      '<site-root></site-root>',
    );

    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const prefixed = await runner().runSchematic('marketing', { name: 'site', prefix: 'mk' }, base);
    expect(prefixed.readContent('/projects/site/web/src/index.html')).toContain(
      '<mk-root></mk-root>',
    );
    expect(prefixed.readContent('/projects/site/web/src/app/app.ts')).toContain(
      "selector: 'mk-root'",
    );
    expect(prefixed.readContent('/projects/site/web/src/app/pages/home.page.ts')).toContain(
      "selector: 'mk-home-page'",
    );
  });

  it('writes the sitemap and checks every page after each build', () => {
    expect(scripts(tree)['postbuild:site']).toBe(
      'node scripts/generate-sitemap.mjs site && node scripts/verify-prerender.mjs site',
    );
    for (const script of ['prerendered', 'generate-sitemap', 'verify-prerender']) {
      expect(tree.files).toContain(`/scripts/${script}.mjs`);
    }
    // Adapted to the attribute this generator's design system uses.
    expect(tree.readContent('/scripts/verify-prerender.mjs')).toContain(
      "'data-theme' in head.html",
    );
  });

  it('shares the check scripts with a second site, leaving edited copies alone', async () => {
    const edited = await runner().runSchematic(
      'marketing',
      { name: 'site' },
      await runner().runSchematic('workspace', {}, await baseWorkspace()),
    );
    edited.overwrite('/scripts/verify-prerender.mjs', '// tuned\n');
    const two = await runner().runSchematic('marketing', { name: 'docs' }, edited);
    expect(two.readContent('/scripts/verify-prerender.mjs')).toBe('// tuned\n');
    expect(scripts(two)['postbuild:docs']).toContain('verify-prerender.mjs docs');
  });

  it('holds a page to a page budget, not an app one', () => {
    const budgets = JSON.parse(tree.readContent('/angular.json')).projects['site'].architect.build
      .configurations.production.budgets;
    expect(budgets.find((budget: { type: string }) => budget.type === 'initial')).toMatchObject({
      maximumWarning: '380kB',
      maximumError: '450kB',
    });
  });

  it('joins npm run build and npm test, and takes npm start when there is no app', () => {
    expect(scripts(tree)['build']).toBe('npm run build:site');
    expect(scripts(tree)['test']).toBe('ng test --no-watch');
    expect(scripts(tree)['start']).toBe('npm run start:site');
  });

  it('leaves npm start with the app, and takes the next port, when there is one', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const both = await runner().runSchematic('marketing', { name: 'site' }, withApp);
    expect(scripts(both)['start']).toBe('npm run start:shop');
    expect(scripts(both)['build']).toBe('npm run build:shop && npm run build:site');
    expect(
      JSON.parse(both.readContent('/angular.json')).projects['site'].architect.serve.options.port,
    ).toBe(4201);
  });

  it('runs site-specific e2e specs in place of the app smoke test', () => {
    expect(tree.files).toContain('/projects/site/web/e2e/site.spec.ts');
    expect(tree.files).toContain('/projects/site/web/e2e/a11y.spec.ts');
    expect(tree.files).not.toContain('/projects/site/web/e2e/smoke.spec.ts');
    expect(scripts(tree)['e2e:site']).toMatch(
      /^tsc -p projects\/site\/web\/e2e\/tsconfig.json && /,
    );
    expect(JSON.parse(tree.readContent('/package.json')).devDependencies['axe-core']).toBeDefined();
  });

  it('documents the site beside it, hosting included', () => {
    const readme = tree.readContent('/projects/site/web/README.md');
    expect(readme).toContain('npm run e2e:site');
    expect(readme).toContain('404/index.html');
  });

  it('adds the prerendered-site rules to AGENTS.md once, however many sites there are', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('marketing', { name: 'site' }, base);
    const two = await runner().runSchematic('marketing', { name: 'docs' }, one);
    expect(two.readContent('/AGENTS.md').match(/^## Prerendered sites$/gm)).toHaveLength(1);
  });
});

describe('the app.config.ts the marketing template replaces', () => {
  const treeWith = (providers: string) => {
    const host = new HostTree();
    host.create('/app.config.ts', `export const appConfig = {\n  providers: [${providers}]\n};\n`);
    return host;
  };

  it("accepts Angular's providers, however they are laid out", () => {
    expect(() =>
      assertKnownProviders(
        treeWith(
          'provideBrowserGlobalErrorListeners(),\n    provideRouter(routes), provideClientHydration()',
        ),
        '/app.config.ts',
      ),
    ).not.toThrow();
  });

  it('fails by name on a provider a later Angular adds, instead of dropping it', () => {
    expect(() =>
      assertKnownProviders(
        treeWith(
          'provideBrowserGlobalErrorListeners(), provideRouter(routes), provideClientHydration(), provideZoneless()',
        ),
        '/app.config.ts',
      ),
    ).toThrow(/Unexpected: provideZoneless\(\)/);
  });
});

describe('ui-lib', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    tree = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
  });

  it('emits the SCSS layering under src/styles, where the components import it', () => {
    for (const file of ['_ref', '_semantic', '_layers', '_components', 'index']) {
      expect(tree.files).toContain(`/projects/ui/src/styles/${file}.scss`);
    }
  });

  it('maps the SCSS into the package output at the path consumers @use', () => {
    // `output`, so the sheet lands at dist/ui/styles and the import is
    // `@use 'ui/styles'` — not `ui/src/styles`, which leaks the source layout.
    expect(JSON.parse(tree.readContent('/projects/ui/ng-package.json')).assets).toEqual([
      { glob: '**/*.scss', input: './src/styles', output: './styles' },
    ]);
  });

  it('runs component tests in a real browser engine, not jsdom', () => {
    const test = JSON.parse(tree.readContent('/angular.json')).projects['ui'].architect.test;
    expect(test.options.browsers).toEqual(['chromium']);
    expect(test.options.headless).toBe(true);
  });

  it('registers Storybook through its Angular builder, not the CLI', () => {
    const architect = JSON.parse(tree.readContent('/angular.json')).projects['ui'].architect;
    expect(architect['build-storybook'].builder).toBe('@storybook/angular:build-storybook');
    expect(JSON.parse(tree.readContent('/package.json')).scripts['build-storybook']).toContain(
      'ng run ui:build-storybook',
    );
  });

  it('gives applications a dist include path so @use resolves through dist/', () => {
    const options = JSON.parse(tree.readContent('/angular.json')).projects['shop'].architect.build
      .options;
    expect(options.stylePreprocessorOptions.includePaths).toContain('dist');
  });

  it('replaces the placeholder component with the real exports', () => {
    expect(tree.files).not.toContain('/projects/ui/src/lib/ui.ts');
    const api = tree.readContent('/projects/ui/src/public-api.ts');
    expect(api).toContain("export * from './lib/button/button'");
    expect(api).toContain("export * from './lib/field/field'");
    expect(api).toContain("export * from './lib/theme/theme'");
    expect(api).toContain("export * from './lib/theme/theme-toggle'");
  });

  it('ships more than one palette, all with the same steps', () => {
    const ref = tree.readContent('/projects/ui/src/styles/_ref.scss');
    const palettes = [...ref.matchAll(/^\s{2}'([^']+)': \($/gm)].map(([, name]) => name);
    expect(palettes.length).toBeGreaterThan(1);
    expect(palettes).toContain('default');
  });

  it('offers exactly the palettes the stylesheet declares', () => {
    // The same invariant `npm run check:contrast` enforces in the generated
    // workspace, asserted here so a template edit cannot ship broken.
    const ref = tree.readContent('/projects/ui/src/styles/_ref.scss');
    const declared = [...ref.matchAll(/^\s{2}'([^']+)': \($/gm)].map(([, name]) => name);
    const offered = [
      ...tree.readContent('/projects/ui/src/lib/theme/theme.ts').matchAll(/id: '([^']+)'/g),
    ].map(([, id]) => id);
    expect(offered).toEqual(declared);
  });

  it('emits each palette under the attribute the theme service writes', () => {
    const index = tree.readContent('/projects/ui/src/styles/index.scss');
    expect(index).toContain("[data-palette='#{$name}']");
  });

  it('namespaces the stored preference by the library prefix', () => {
    const theme = tree.readContent('/projects/ui/src/lib/theme/theme.ts');
    expect(theme).toContain("THEME_MODE_KEY = 'ui.theme-mode'");
    expect(theme).toContain("THEME_PALETTE_KEY = 'ui.theme-palette'");
  });

  it('retrofits the token import onto an app that predates the library', () => {
    expect(tree.readContent('/projects/shop/web/src/styles.scss')).toContain(
      "@use 'ui/styles' as *;",
    );
  });

  it('leaves an existing app shell alone — only the stylesheet is retrofitted', () => {
    // The app was generated before the library, so its shell is the plain one
    // and rewriting it would destroy whatever had been written there since.
    expect(tree.readContent('/projects/shop/web/src/app/app.ts')).not.toContain('ThemeToggle');
  });

  it('builds libraries before a build, not only before start and test', () => {
    expect(JSON.parse(tree.readContent('/package.json')).scripts['prebuild']).toContain(
      'npm run build:libs',
    );
  });

  it('ships components with tests and stories, so the wiring is exercised', () => {
    expect(tree.files).toContain('/projects/ui/src/lib/button/button.spec.ts');
    expect(tree.files).toContain('/projects/ui/src/lib/button/button.stories.ts');
  });

  it('leaves npm test running every project, its own included, without watching', () => {
    expect(JSON.parse(tree.readContent('/package.json')).scripts['test']).toBe(
      'ng test --no-watch',
    );
  });

  it('hooks build:libs into prestart, because ng serve does not build libraries', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['build:libs']).toContain('ng build ui');
    expect(scripts['prestart']).toContain('npm run build:libs');
    expect(scripts['pretest']).toContain('npm run build:libs');
  });

  it('lists the library scripts in the README', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run build:libs` |');
    expect(table).toContain('| `npm run check:contrast` |');
    expect(table).toContain('| `npm run storybook` |');
  });

  it('declares the required Storybook peers but not the optional deprecated one', () => {
    // The three devkit packages and platform-browser-dynamic are REQUIRED peers
    // of @storybook/angular: left implicit, npm backtracks them onto Angular
    // 20/21 and the install fails ERESOLVE. @angular/animations is an OPTIONAL
    // peer, so declaring it bought nothing but a deprecation warning on every
    // install — Angular 22 deprecated the package.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;

    expect(devDependencies['@angular-devkit/build-angular']).toBeDefined();
    expect(devDependencies['@angular-devkit/core']).toBeDefined();
    expect(devDependencies['@angular-devkit/architect']).toBeDefined();
    expect(devDependencies['@angular/platform-browser-dynamic']).toBeDefined();
    expect(devDependencies['@angular/animations']).toBeUndefined();
  });

  it('overwrites the vitest range Angular emitted, so the browser provider matches', () => {
    // @vitest/browser-playwright peers vitest at an exact version. @angular/cli
    // 22.2 emits `vitest: ^5.0.0`, and any CLI release can move that range
    // again; deferring to it resolved vitest above the provider's peer and the
    // install died on ERESOLVE before anything was written.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;

    expect(devDependencies['vitest']).toBe(VERSIONS['vitest'].range);
    expect(devDependencies['@vitest/browser-playwright']).toBe(
      VERSIONS['@vitest/browser-playwright'].range,
    );
    expect(devDependencies['vitest']).not.toBe(latestVersions['vitest']);
  });

  it('emits no source that imports the deprecated animations package', () => {
    // The prune rule's guard reads the source, so a story or component that
    // imported @angular/animations would quietly re-legitimise the dependency.
    const importers = tree.files.filter(
      (file) => file.endsWith('.ts') && tree.readContent(file).includes('@angular/animations'),
    );
    expect(importers).toEqual([]);
  });

  it('derives the selector prefix from the library name', async () => {
    // Regression: schema defaults are applied before the factory runs, so a
    // `"default"` on `prefix` silently shadows the derivation and every
    // library ships `ui-` selectors no matter what it is called.
    const derived = await runner().runSchematic(
      'ui-lib',
      { name: 'design-system' },
      await runner().runSchematic('workspace', {}, await baseWorkspace()),
    );
    expect(derived.readContent('/projects/design-system/src/lib/button/button.ts')).toContain(
      "selector: 'design-system-button'",
    );
  });

  it('takes an explicit prefix, down to the ids the field generates', async () => {
    const prefixed = await runner().runSchematic(
      'ui-lib',
      { name: 'ui', prefix: 'acme' },
      await runner().runSchematic('workspace', {}, await baseWorkspace()),
    );
    expect(prefixed.readContent('/projects/ui/src/lib/button/button.ts')).toContain(
      "selector: 'acme-button'",
    );
    expect(prefixed.readContent('/projects/ui/src/lib/field/field.ts')).toContain('`acme-field-');
    expect(prefixed.readContent('/projects/ui/src/lib/button/button.stories.ts')).toContain(
      '<acme-button',
    );
    expect(JSON.parse(prefixed.readContent('/angular.json')).projects['ui'].prefix).toBe('acme');
  });
});

describe('codegen', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    tree = await runner().runSchematic('codegen', { apps: ['shop'] }, withApp);
  });

  it('emits an orval config and a per-app client seam', () => {
    expect(tree.files).toContain('/orval.config.ts');
    expect(tree.files).toContain('/projects/shop/web/src/api/api-client.ts');
  });

  it('reads the spec location from the environment rather than committing it', () => {
    expect(tree.readContent('/orval.config.ts')).toContain("process.env['OPENAPI_SPEC']");
  });

  it('regenerates before every entry point that compiles the app', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    for (const hook of ['prebuild', 'prestart', 'pretest']) {
      expect(scripts[hook]).toContain('npm run codegen');
    }
  });

  it('says in the README where the spec comes from', () => {
    expect(scriptsTable(tree)).toMatch(/\| `npm run codegen` \| .*`\$OPENAPI_SPEC`/);
  });

  it('gitignores the generated client', () => {
    expect(tree.readContent('/.gitignore')).toContain('**/src/api/generated/');
  });

  it('refuses to run with no application to generate into', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    await expect(runner().runSchematic('codegen', {}, base)).rejects.toThrow(
      /needs at least one application/,
    );
  });
});

describe('packages', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
    tree = await runner().runSchematic('packages', { packages: ['cdk'] }, withLib);
  });

  it('installs the CDK as a runtime dependency, not a dev one', () => {
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.dependencies['@angular/cdk']).toBeDefined();
    expect(manifest.devDependencies?.['@angular/cdk']).toBeUndefined();
  });

  it('takes the range Angular writes for its own packages, not `latest`', () => {
    // Read from @schematics/angular rather than hard-coded: the CDK ships in
    // lockstep with the framework, and the assertion is that the two agree.
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.dependencies['@angular/cdk']).toBe(latestVersions.Angular);
  });

  it('declares it as a peer of the library, which is what publishes', () => {
    // A component library built on the CDK that does not declare it ships a
    // package resolving only by accident of hoisting.
    const library = JSON.parse(tree.readContent('/projects/ui/package.json'));
    expect(library.peerDependencies['@angular/cdk']).toBe(latestVersions.Angular);
    // Angular's own peers are still there — the block was added to, not rewritten.
    expect(library.peerDependencies['@angular/core']).toBeDefined();
  });

  it('says in the README what it is for and which stylesheet it needs', () => {
    const readme = tree.readContent('/README.md');
    expect(readme).toContain('## Angular CDK');
    expect(readme).toContain('overlay-prebuilt.css');
  });

  it('wires the overlay stylesheet into the application', () => {
    // Without it an overlay opens unpositioned and with no backdrop, and
    // nothing anywhere reports a problem.
    const styles = buildStyles(tree, 'shop');
    expect(styles).toContain('node_modules/@angular/cdk/overlay-prebuilt.css');
  });

  it('puts it ahead of the application stylesheet, so the app can override it', () => {
    // `styles` is concatenated in order: appended last, the vendor sheet beats
    // every rule the app wrote to override it, at equal specificity.
    const styles = buildStyles(tree, 'shop');
    const vendor = styles.indexOf('node_modules/@angular/cdk/overlay-prebuilt.css');
    const own = styles.findIndex((style) => style.endsWith('styles.scss'));
    expect(own).toBeGreaterThan(-1);
    expect(vendor).toBeLessThan(own);
  });

  it('leaves the library alone — it has no global stylesheet to prepend to', () => {
    // ng-packagr's build target carries a `project`, not `options.styles`, so
    // a rule that reached libraries would have to invent the block to write
    // into. It does not: only `projectType: application` is touched.
    const project = JSON.parse(tree.readContent('/angular.json')).projects.ui;
    expect(project.architect.build.options?.styles).toBeUndefined();
    expect(JSON.stringify(project)).not.toContain('overlay-prebuilt.css');
  });

  it('is idempotent, so running it again in a live workspace changes nothing', async () => {
    const again = await runner().runSchematic('packages', { packages: ['cdk'] }, tree);
    expect(again.readContent('/README.md')).toBe(tree.readContent('/README.md'));
    expect(again.readContent('/package.json')).toBe(tree.readContent('/package.json'));
    // A second run must not stack a second copy of the stylesheet.
    expect(again.readContent('/angular.json')).toBe(tree.readContent('/angular.json'));
  });

  it('wires an app generated after the package was added', async () => {
    // The schematic runs once, over the projects that exist at that moment. An
    // app added later must not come up missing the stylesheet every other app
    // in the workspace has.
    const later = await runner().runSchematic('app', { name: 'admin' }, tree);
    expect(buildStyles(later, 'admin')).toContain('node_modules/@angular/cdk/overlay-prebuilt.css');
  });

  it('declares the peer on a library generated after the package was added', async () => {
    const later = await runner().runSchematic('ui-lib', { name: 'later' }, tree);
    const library = JSON.parse(later.readContent('/projects/later/package.json'));
    expect(library.peerDependencies['@angular/cdk']).toBe(latestVersions.Angular);
  });

  it('does nothing at all when nothing was asked for', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const untouched = await runner().runSchematic('packages', {}, base);
    expect(untouched.readContent('/package.json')).toBe(base.readContent('/package.json'));
  });

  it('names the alternatives when an id is not in the catalog', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    await expect(runner().runSchematic('packages', { packages: ['cdk-x'] }, base)).rejects.toThrow(
      /"cdk-x" is not one of the packages .* Known: cdk/s,
    );
  });
});
