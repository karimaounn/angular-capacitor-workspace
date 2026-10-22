import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostTree } from '@angular-devkit/schematics';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GenerateOptions } from '../src/api';
import {
  addBootScript,
  addHeaderControl,
  addHttpInterceptor,
  addRoute,
  addShellTestProvider,
  addStarterSection,
} from '../src/extend/shell';
import {
  detectedFeatures,
  PLUGINS,
  requestedFeatures,
  requestedPlugins,
} from '../src/plugins/registry';
import { addEnvironmentGroups, API_SETTINGS, environmentFrom } from '../src/extend/environment';
import { treeView } from '../src/utils/workspace-view';

const collection = join(__dirname, '..', 'dist', 'collection.json');

if (!existsSync(collection)) {
  throw new Error(`${collection} does not exist. Run \`npm run build\` before the tests.`);
}

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

/** Runs schematics in order, each on the tree the last one left. */
async function run(
  steps: ReadonlyArray<readonly [string, Record<string, unknown>]>,
): Promise<UnitTestTree> {
  let tree = await baseWorkspace();
  for (const [schematic, options] of steps) {
    tree = await runner().runSchematic(schematic, options, tree);
  }
  return tree;
}

/** Every plugin, asked for. */
const EVERYTHING: GenerateOptions = {
  directory: 'ws',
  apps: [{ name: 'shop' }],
  marketing: [{ name: 'site' }],
  uiLib: 'ui',
  codegen: 'orval',
  i18n: ['en', 'fr'],
  auth: 'cognito',
  authMethods: ['password'],
  packages: ['aria'],
};

describe('the plugin registry', () => {
  it('names a schematic in the collection for every plugin', () => {
    const schematics = JSON.parse(readFileSync(collection, 'utf8')).schematics;
    for (const plugin of PLUGINS) {
      expect(schematics[plugin.id], plugin.id).toBeDefined();
      expect(schematics[plugin.id].factory, plugin.id).toMatch(
        new RegExp(`^\\./plugins/${plugin.id}/index#`),
      );
    }
  });

  it('runs the requested plugins after the hosts, in its own order', () => {
    expect(requestedPlugins(EVERYTHING).map((step) => step.schematic)).toEqual([
      'theming',
      'codegen',
      'i18n',
      'auth',
      'packages',
    ]);
    expect(requestedPlugins({ directory: 'ws', apps: [{ name: 'shop' }] })).toEqual([]);
  });

  it('turns theming on with a design system, and off when asked', () => {
    expect(requestedFeatures({ directory: 'ws', uiLib: 'ui' })).toContain('theming');
    expect(requestedFeatures({ directory: 'ws', uiLib: 'ui', theming: false })).not.toContain(
      'theming',
    );
    // Nothing to theme without one.
    expect(requestedFeatures({ directory: 'ws', theming: true })).not.toContain('theming');
  });

  describe('on a workspace generated with every plugin', () => {
    let tree: UnitTestTree;

    beforeAll(async () => {
      // What `create` runs: the hosts, then `requestedPlugins` in order.
      tree = await run([
        ['workspace', { uiLib: 'ui' }],
        ['ui-lib', { name: 'ui' }],
        ['app', { name: 'shop' }],
        ['marketing', { name: 'site' }],
        ...requestedPlugins(EVERYTHING).map((step) => [step.schematic, step.options] as const),
      ]);
    });

    it('detects every token it was generated with, plugin by plugin', () => {
      // The contract on `WorkspacePlugin.detect`: what generation set is what
      // doctor reads back, or a rule guarded on a token applies at generation
      // and is ignored by `doctor --fix`.
      const view = treeView(tree);
      for (const plugin of PLUGINS) {
        expect([...plugin.detect(view)].sort(), plugin.id).toEqual(
          [...plugin.features(EVERYTHING)].sort(),
        );
      }
      expect(detectedFeatures(view)).toEqual(requestedFeatures(EVERYTHING));
    });

    it('gives the API client and sign-in one API address', () => {
      const app = '/projects/shop/web/src';
      expect(tree.readContent(`${app}/api/api-client.ts`)).toContain(
        '`${environment.api.baseUrl}${request.url}`',
      );
      expect(tree.readContent(`${app}/app/app.config.ts`)).toContain(
        'provideAuthentication(environment)',
      );
      // One group, whichever plugin asked for it first.
      const environment = tree.readContent(`${app}/environments/environment.ts`);
      expect(environment.match(/^  api: /gm)).toHaveLength(1);
      expect(environment).toMatch(/^  auth: cognito\(/m);
      expect(environment).toContain("import { cognito } from 'ui';");
    });

    it('puts the plugins’ header controls in registry order', () => {
      const header = tree.readContent('/projects/shop/web/src/app/app.html');
      expect(header.indexOf('<ui-theme-toggle />')).toBeGreaterThan(-1);
      expect(header.indexOf('<ui-theme-toggle />')).toBeLessThan(
        header.indexOf('<ui-language-picker />'),
      );
      expect(header.indexOf('<ui-language-picker />')).toBeLessThan(
        header.indexOf('<app-account-link />'),
      );
      // One import from the design system, however many plugins import from it.
      expect(tree.readContent('/projects/shop/web/src/app/app.ts')).toContain(
        "import { ThemeToggle, LanguagePicker } from 'ui';",
      );
    });

    it('comes out the same when the app is generated after the plugins', async () => {
      // A workspace grown one `ng generate` at a time has to match one made in
      // a single run, or the order someone added things in shows in the code.
      const grown = await run([
        ['workspace', { uiLib: 'ui' }],
        ['ui-lib', { name: 'ui' }],
        ['marketing', { name: 'site' }],
        ['theming', {}],
        ['i18n', { locales: ['en', 'fr'] }],
        ['auth', { provider: 'cognito' }],
        ['packages', { packages: ['aria'] }],
        ['app', { name: 'shop' }],
      ]);
      for (const file of [
        'app/app.html',
        'app/app.ts',
        'app/app.spec.ts',
        'app/app.config.ts',
        'app/app.routes.ts',
        'app/pages/home.page.html',
        'app/pages/home.page.ts',
        'index.html',
      ]) {
        const path = `/projects/shop/web/src/${file}`;
        expect(grown.readContent(path), file).toBe(tree.readContent(path));
      }
    });
  });
});

describe('the shell extension points', () => {
  /** A tree holding one project, `shop`, at `projects/shop`, with these files under src/. */
  function shell(files: Record<string, string>): HostTree {
    const tree = new HostTree();
    tree.create(
      '/angular.json',
      JSON.stringify({
        projects: { shop: { projectType: 'application', root: 'projects/shop', prefix: 'app' } },
      }),
    );
    for (const [path, content] of Object.entries(files)) {
      tree.create(`/projects/shop/src/${path}`, content);
    }
    return tree;
  }

  const component = (name: string) =>
    `import { Component } from '@angular/core';\n\n@Component({\n  selector: 'app-${name}',\n  imports: [],\n  template: '',\n})\nexport class X {}\n`;

  it('adds a header control at the end of the header, indented like its siblings', () => {
    const tree = shell({
      'app/app.ts': component('root'),
      'app/app.html': '<header>\n  <span>Shop</span>\n</header>\n<main></main>\n',
    });
    addHeaderControl(tree, 'shop', { symbol: 'A', from: 'lib', markup: '<lib-a />' });
    addHeaderControl(tree, 'shop', { symbol: 'B', from: './b/b', markup: '<app-b />' });
    addHeaderControl(tree, 'shop', { symbol: 'A', from: 'lib', markup: '<lib-a />' });

    expect(tree.readText('/projects/shop/src/app/app.html')).toBe(
      '<header>\n  <span>Shop</span>\n  <lib-a />\n  <app-b />\n</header>\n<main></main>\n',
    );
    const ts = tree.readText('/projects/shop/src/app/app.ts');
    expect(ts).toContain('imports: [A, B]');
    expect(ts).toContain("import { B } from './b/b';");
  });

  it('leaves a shell without a header alone', () => {
    const tree = shell({ 'app/app.ts': component('root'), 'app/app.html': '<main></main>\n' });
    addHeaderControl(tree, 'shop', { symbol: 'A', from: 'lib', markup: '<lib-a />' });
    expect(tree.readText('/projects/shop/src/app/app.html')).toBe('<main></main>\n');
    expect(tree.readText('/projects/shop/src/app/app.ts')).not.toContain('A }');
  });

  it('adds starter sections above the last one, re-basing a relative import', () => {
    const tree = shell({
      'app/pages/home.page.ts': component('home-page'),
      'app/pages/home.page.html':
        '<h1>Hi</h1>\n\n<section>one</section>\n\n<section>next</section>\n',
    });
    addStarterSection(tree, 'shop', { symbol: 'A', from: './a/a', markup: '<app-a />' });
    addStarterSection(tree, 'shop', { symbol: 'B', from: './b/b', markup: '<app-b />' });

    expect(tree.readText('/projects/shop/src/app/pages/home.page.html')).toBe(
      '<h1>Hi</h1>\n\n<section>one</section>\n\n<app-a />\n\n<app-b />\n\n<section>next</section>\n',
    );
    expect(tree.readText('/projects/shop/src/app/pages/home.page.ts')).toContain(
      "import { A } from '../a/a';",
    );
  });

  it('spreads a one-line TestBed providers array, and extends a spread one', () => {
    const spec =
      "import { TestBed } from '@angular/core/testing';\n" +
      "import { provideRouter } from '@angular/router';\n\n" +
      'beforeEach(() => {\n' +
      '  TestBed.configureTestingModule({\n' +
      '    providers: [provideRouter([])],\n' +
      '  });\n' +
      '});\n';
    const tree = shell({ 'app/app.spec.ts': spec });
    addShellTestProvider(tree, 'shop', {
      symbol: 'A',
      expression: '// Why.\n{ provide: A, useValue: 1 }',
      imports: ["import { A } from 'lib';"],
    });
    addShellTestProvider(tree, 'shop', {
      symbol: 'B',
      expression: '{ provide: B, useValue: 2 }',
      imports: ["import { B } from 'lib';"],
    });

    expect(tree.readText('/projects/shop/src/app/app.spec.ts')).toContain(
      '    providers: [\n' +
        '      provideRouter([]),\n' +
        '      // Why.\n' +
        '      { provide: A, useValue: 1 },\n' +
        '      { provide: B, useValue: 2 },\n' +
        '    ],\n',
    );
  });

  it('adds a boot script once, and sets the attributes it is the fallback for', () => {
    const tree = shell({
      'index.html': '<!doctype html>\n<html lang="en">\n<head>\n</head>\n<body></body>\n</html>\n',
    });
    const script = (body: string) => ({
      id: 'x:boot',
      html: `  <!-- x:boot -->\n  ${body}\n  <!-- /x:boot -->\n`,
      attributes: { lang: 'fr', dir: 'ltr' },
    });
    addBootScript(tree, 'shop', script('<script>one</script>'));
    addBootScript(tree, 'shop', script('<script>one</script>'));

    let html = tree.readText('/projects/shop/src/index.html');
    expect(html).toContain('<html lang="fr" dir="ltr">');
    expect(html.split('<!-- x:boot').length - 1).toBe(1);
    expect(html.indexOf('x:boot')).toBeLessThan(html.indexOf('</head>'));

    // The generator's block: a later run replaces it whole.
    addBootScript(tree, 'shop', script('<script>two</script>'));
    html = tree.readText('/projects/shop/src/index.html');
    expect(html).toContain('<script>two</script>');
    expect(html).not.toContain('<script>one</script>');
    expect(html.split('<!-- x:boot').length - 1).toBe(1);
  });

  describe('addRoute', () => {
    const route = {
      key: './a/a.routes',
      expression: "{\n  path: 'a',\n  loadChildren: () => import('./a/a.routes'),\n}",
    };

    it("fills Angular's empty table", () => {
      const tree = shell({
        'app/app.routes.ts':
          "import { Routes } from '@angular/router';\n\nexport const routes: Routes = [];\n",
      });
      expect(addRoute(tree, 'shop', route)).toBe(true);
      expect(addRoute(tree, 'shop', route)).toBe(true);
      expect(tree.readText('/projects/shop/src/app/app.routes.ts')).toBe(
        "import { Routes } from '@angular/router';\n\n" +
          'export const routes: Routes = [\n' +
          '  {\n' +
          "    path: 'a',\n" +
          "    loadChildren: () => import('./a/a.routes'),\n" +
          '  },\n' +
          '];\n',
      );
    });

    it('goes after the routes there are, or before a wildcard', () => {
      const filled = shell({
        'app/app.routes.ts':
          "export const routes: Routes = [\n  { path: '', component: Home }\n];\n",
      });
      addRoute(filled, 'shop', route);
      expect(filled.readText('/projects/shop/src/app/app.routes.ts')).toBe(
        'export const routes: Routes = [\n' +
          "  { path: '', component: Home },\n" +
          "  {\n    path: 'a',\n    loadChildren: () => import('./a/a.routes'),\n  },\n" +
          '];\n',
      );

      const wildcard = shell({
        'app/app.routes.ts':
          "export const routes: Routes = [\n  { path: '', component: Home },\n  { path: '**', redirectTo: '' },\n];\n",
      });
      addRoute(wildcard, 'shop', route);
      const routes = wildcard.readText('/projects/shop/src/app/app.routes.ts');
      expect(routes.indexOf("path: 'a'")).toBeLessThan(routes.indexOf("path: '**'"));
      expect(routes.indexOf("path: 'a'")).toBeLessThan(routes.indexOf("path: ''"));
    });

    it('says so when there is no table to add to', () => {
      const tree = shell({ 'app/app.routes.ts': 'export const routes = makeRoutes();\n' });
      expect(addRoute(tree, 'shop', route)).toBe(false);
      expect(addRoute(shell({}), 'shop', route)).toBe(false);
    });
  });

  describe('addHttpInterceptor', () => {
    const interceptor = {
      symbol: 'authInterceptor',
      import: "import { authInterceptor } from 'ui';",
    };
    const config = (providers: string, imports = '') =>
      "import { ApplicationConfig } from '@angular/core';\n" +
      imports +
      "import { provideRouter } from '@angular/router';\n\n" +
      'export const appConfig: ApplicationConfig = {\n' +
      `  providers: [${providers}],\n` +
      '};\n';
    const read = (tree: HostTree) => tree.readText('/projects/shop/src/app/app.config.ts');

    it('provides HttpClient with the interceptor when the app has none', () => {
      const tree = shell({ 'app/app.config.ts': config('provideRouter(routes)') });
      addHttpInterceptor(tree, 'shop', interceptor);
      addHttpInterceptor(tree, 'shop', interceptor);
      const source = read(tree);
      expect(source).toContain('provideHttpClient(withInterceptors([authInterceptor])),');
      expect(source).toContain(
        "import { provideHttpClient, withInterceptors } from '@angular/common/http';",
      );
      expect(source).toContain("import { authInterceptor } from 'ui';");
      expect(source.split('authInterceptor]').length - 1).toBe(1);
    });

    it("adds interceptors to the app's own provideHttpClient, never a second one", () => {
      const http = "import { provideHttpClient, withFetch } from '@angular/common/http';\n";
      const bare = shell({ 'app/app.config.ts': config('provideHttpClient()', http) });
      addHttpInterceptor(bare, 'shop', interceptor);
      expect(read(bare)).toContain('provideHttpClient(withInterceptors([authInterceptor]))');
      expect(read(bare)).toContain(
        "import { provideHttpClient, withFetch, withInterceptors } from '@angular/common/http';",
      );

      const fetch = shell({ 'app/app.config.ts': config('provideHttpClient(withFetch())', http) });
      addHttpInterceptor(fetch, 'shop', interceptor);
      expect(read(fetch)).toContain(
        'provideHttpClient(withFetch(), withInterceptors([authInterceptor]))',
      );
      expect(read(fetch).split('provideHttpClient(').length - 1).toBe(1);

      const listed = shell({
        'app/app.config.ts': config(
          'provideHttpClient(withInterceptors([logging]))',
          "import { provideHttpClient, withInterceptors } from '@angular/common/http';\n",
        ),
      });
      addHttpInterceptor(listed, 'shop', interceptor);
      expect(read(listed)).toContain('withInterceptors([logging, authInterceptor])');
    });
  });
});

describe('the environment extension point', () => {
  const root = '/projects/shop/src/environments';
  const auth = {
    key: 'auth',
    doc: 'Where the app signs people in.',
    defaults: "{ pool: '' }",
  };

  function app(configurations: Record<string, unknown> = {}): HostTree {
    const tree = new HostTree();
    tree.create(
      '/angular.json',
      JSON.stringify({
        projects: {
          shop: {
            projectType: 'application',
            root: 'projects/shop',
            architect: {
              build: { configurations: { production: {}, development: {}, ...configurations } },
            },
          },
        },
      }),
    );
    return tree;
  }

  it('gives the app its environments, and swaps them for ng serve', () => {
    const tree = app();
    expect(addEnvironmentGroups(tree, 'shop', [API_SETTINGS])).toBeUndefined();

    for (const name of ['environment.ts', 'environment.development.ts']) {
      expect(tree.readText(`${root}/${name}`), name).toContain(
        'export const environment = {\n' +
          '  /**\n' +
          "   * Where the app's API is: '/api' behind a reverse proxy, or a URL such as\n" +
          "   * 'https://api.example.com/v1'. The API client sends its requests here, and\n" +
          "   * sign-in sends the session's token to requests under it and to no others.\n" +
          '   */\n' +
          "  api: { baseUrl: '/api' },\n" +
          '};\n',
      );
      // Nothing for the generator to own beside them.
      expect(tree.readText(`${root}/${name}`), name).not.toContain('import');
    }
    expect(tree.getDir(root).subfiles).toEqual(['environment.ts', 'environment.development.ts']);
    const build = JSON.parse(tree.readText('/angular.json')).projects.shop.architect.build;
    expect(build.configurations.development.fileReplacements).toEqual([
      {
        replace: 'projects/shop/src/environments/environment.ts',
        with: 'projects/shop/src/environments/environment.development.ts',
      },
    ]);
    expect(build.configurations.production.fileReplacements).toBeUndefined();
  });

  it('adds a group after what the environment has, and leaves what it has alone', () => {
    const tree = app();
    tree.create(
      `${root}/environment.ts`,
      'export const environment = {\n' +
        "  api: { baseUrl: 'https://api.example.com' }, // ours\n" +
        "  flags: { 'auth': true, nested: { auth: 1 } }\n" +
        '} as const;\n',
    );
    addEnvironmentGroups(tree, 'shop', [API_SETTINGS, auth]);

    // Its own keys only: `auth` inside a value is not the group.
    expect(tree.readText(`${root}/environment.ts`)).toBe(
      'export const environment = {\n' +
        "  api: { baseUrl: 'https://api.example.com' }, // ours\n" +
        "  flags: { 'auth': true, nested: { auth: 1 } },\n" +
        '  /**\n' +
        '   * Where the app signs people in.\n' +
        '   */\n' +
        "  auth: { pool: '' },\n" +
        '} as const;\n',
    );
  });

  it("adds to Angular's own empty environment", () => {
    const tree = app();
    tree.create(`${root}/environment.ts`, 'export const environment = {};\n');
    addEnvironmentGroups(tree, 'shop', [auth]);
    expect(tree.readText(`${root}/environment.ts`)).toBe(
      'export const environment = {\n' +
        '  /**\n' +
        '   * Where the app signs people in.\n' +
        '   */\n' +
        "  auth: { pool: '' },\n" +
        '};\n',
    );
  });

  it('adds to every environment a build configuration swaps in', () => {
    const tree = app({
      staging: {
        fileReplacements: [
          {
            replace: 'projects/shop/src/environments/environment.ts',
            with: 'projects/shop/src/environments/environment.staging.ts',
          },
        ],
      },
    });
    tree.create(`${root}/environment.staging.ts`, 'export const environment = {};\n');
    addEnvironmentGroups(tree, 'shop', [auth]);
    expect(tree.readText(`${root}/environment.staging.ts`)).toContain("auth: { pool: '' },");
  });

  it('changes nothing when run again', () => {
    const tree = app();
    addEnvironmentGroups(tree, 'shop', [API_SETTINGS, auth]);
    const ours = tree
      .readText(`${root}/environment.ts`)
      .replace("baseUrl: '/api'", "baseUrl: 'https://api.example.com'");
    tree.overwrite(`${root}/environment.ts`, ours);
    const development = tree.readText(`${root}/environment.development.ts`);

    expect(addEnvironmentGroups(tree, 'shop', [API_SETTINGS, auth])).toBeUndefined();
    expect(tree.readText(`${root}/environment.ts`)).toBe(ours);
    expect(tree.readText(`${root}/environment.development.ts`)).toBe(development);
    const replacements = JSON.parse(tree.readText('/angular.json')).projects.shop.architect.build
      .configurations.development.fileReplacements;
    expect(replacements).toHaveLength(1);
  });

  it('leaves an environment it cannot read alone, and says what to add', () => {
    const tree = app();
    const own = 'export const environment = loadSettings();\n';
    const spread = "import { base } from './base';\n\nexport const environment = { ...base };\n";
    tree.create(`${root}/environment.ts`, own);
    tree.create(`${root}/environment.development.ts`, spread);

    const manual = addEnvironmentGroups(tree, 'shop', [API_SETTINGS, auth]);
    expect(manual).toContain(
      'projects/shop/src/environments/environment.ts: it is not `export const environment = { … }`',
    );
    expect(manual).toContain(
      'projects/shop/src/environments/environment.development.ts: it spreads another environment',
    );
    expect(manual).toContain("  api: { baseUrl: '/api' },\n  auth: { pool: '' },");
    expect(tree.readText(`${root}/environment.ts`)).toBe(own);
    expect(tree.readText(`${root}/environment.development.ts`)).toBe(spread);
  });

  it('imports what a group’s default calls, once, beside the imports the file has', () => {
    const typed = {
      ...auth,
      defaults: "cognito({ pool: '' })",
      import: { symbol: 'cognito', from: 'ui' },
    };

    // A file with no imports: at the top, above the comment on `environment`.
    const fresh = app();
    addEnvironmentGroups(fresh, 'shop', [API_SETTINGS, typed]);
    addEnvironmentGroups(fresh, 'shop', [typed]);
    for (const name of ['environment.ts', 'environment.development.ts']) {
      const source = fresh.readText(`${root}/${name}`);
      expect(source.startsWith("import { cognito } from 'ui';\n\n/**\n"), name).toBe(true);
      expect(source, name).toContain("  auth: cognito({ pool: '' }),\n");
      expect(source.split("from 'ui'").length - 1, name).toBe(1);
    }

    // After the last import the file has.
    const after = app();
    after.create(
      `${root}/environment.ts`,
      "import { flags } from './flags';\n\nexport const environment = {\n  flags,\n};\n",
    );
    addEnvironmentGroups(after, 'shop', [typed]);
    expect(after.readText(`${root}/environment.ts`)).toBe(
      "import { flags } from './flags';\n" +
        "import { cognito } from 'ui';\n\n" +
        'export const environment = {\n' +
        '  flags,\n' +
        '  /**\n' +
        '   * Where the app signs people in.\n' +
        '   */\n' +
        "  auth: cognito({ pool: '' }),\n" +
        '};\n',
    );

    // Into the import the file already has from that module.
    const shared = app();
    shared.create(
      `${root}/environment.ts`,
      "import { palette } from 'ui';\n\nexport const environment = { palette };\n",
    );
    addEnvironmentGroups(shared, 'shop', [typed]);
    expect(shared.readText(`${root}/environment.ts`)).toContain(
      "import { palette, cognito } from 'ui';",
    );

    // And in the manual step, for an environment it could not read.
    const own = app();
    own.create(`${root}/environment.ts`, 'export const environment = loadSettings();\n');
    expect(addEnvironmentGroups(own, 'shop', [API_SETTINGS, typed])).toContain(
      "  api: { baseUrl: '/api' },\n  auth: cognito({ pool: '' }),\n\n" +
        "with, at the top of the file:\n\n  import { cognito } from 'ui';",
    );
  });

  it('says how to import the environment from anywhere in the app', () => {
    expect(environmentFrom('src/app')).toBe('../environments/environment');
    expect(environmentFrom('src/api')).toBe('../environments/environment');
    expect(environmentFrom('src')).toBe('./environments/environment');
  });
});
