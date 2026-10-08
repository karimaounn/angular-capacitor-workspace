import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HostTree } from '@angular-devkit/schematics';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import type { GenerateOptions } from '../src/api';
import {
  addBootScript,
  addHeaderControl,
  addShellTestProvider,
  addStarterSection,
} from '../src/extend/shell';
import {
  detectedFeatures,
  PLUGINS,
  requestedFeatures,
  requestedPlugins,
} from '../src/plugins/registry';
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

    it('puts the plugins’ header controls in registry order', () => {
      const header = tree.readContent('/projects/shop/web/src/app/app.html');
      expect(header.indexOf('<ui-theme-toggle />')).toBeGreaterThan(-1);
      expect(header.indexOf('<ui-theme-toggle />')).toBeLessThan(
        header.indexOf('<ui-language-picker />'),
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
        ['packages', { packages: ['aria'] }],
        ['app', { name: 'shop' }],
      ]);
      for (const file of [
        'app/app.html',
        'app/app.ts',
        'app/app.spec.ts',
        'app/app.config.ts',
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
    const script = {
      id: 'x:boot',
      html: '  <!-- x:boot -->\n',
      attributes: { lang: 'fr', dir: 'ltr' },
    };
    addBootScript(tree, 'shop', script);
    addBootScript(tree, 'shop', script);

    const html = tree.readText('/projects/shop/src/index.html');
    expect(html).toContain('<html lang="fr" dir="ltr">');
    expect(html.split('x:boot').length - 1).toBe(1);
    expect(html.indexOf('x:boot')).toBeLessThan(html.indexOf('</head>'));
  });
});
