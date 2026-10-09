import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';
// The runtime package's own source: no Angular in it, so a Node test can load
// it, and the generator's script is held to the keys the package reads.
import { themeStorageKeys } from '../../theming/src/config';

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

/** A design system, an app with Playwright, and a prerendered site — before theming. */
async function workspace(prefix?: string): Promise<UnitTestTree> {
  const base = await runner().runSchematic(
    'workspace',
    { uiLib: 'ui', e2e: 'playwright' },
    await baseWorkspace(),
  );
  const lib = await runner().runSchematic(
    'ui-lib',
    { name: 'ui', ...(prefix ? { prefix } : {}) },
    base,
  );
  const app = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, lib);
  return runner().runSchematic('marketing', { name: 'site' }, app);
}

describe('theming', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    tree = await runner().runSchematic('theming', {}, await workspace());
  });

  describe('in the design system', () => {
    it('installs the service as a package, and adds the toggle, with its test and story', () => {
      const own = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
      expect(JSON.parse(tree.readContent('/package.json')).dependencies).toMatchObject({
        '@angular-capacitor-workspace/theming': `^${own}`,
      });
      expect(
        JSON.parse(tree.readContent('/projects/ui/package.json')).peerDependencies,
      ).toMatchObject({ '@angular-capacitor-workspace/theming': `^${own}` });
      for (const file of [
        'theme.ts',
        'theme-toggle.ts',
        'theme-toggle.html',
        'theme-toggle.spec.ts',
        'theme-toggle.stories.ts',
      ]) {
        expect(tree.exists(`/projects/ui/src/lib/theme/${file}`), file).toBe(true);
      }
      expect(tree.exists('/projects/ui/src/lib/theme/theme.spec.ts')).toBe(false);
    });

    it('binds the package to the palettes, and types PaletteId by them', () => {
      const binding = tree.readContent('/projects/ui/src/lib/theme/theme.ts');
      expect(binding).toContain('rewritten by every run');
      expect(binding).toContain("import { PALETTES } from '../../config/palettes';");
      expect(binding).toContain("declare module '@angular-capacitor-workspace/theming' {");
      expect(binding).toContain(
        "return provideThemeConfig({ palettes: PALETTES, storagePrefix: 'ui' });",
      );
      expect(tree.readContent('/projects/ui/src/lib/theme/theme-toggle.spec.ts')).toContain(
        'providers: [provideTheme()]',
      );
    });

    it('exports them from the public API', () => {
      const api = tree.readContent('/projects/ui/src/public-api.ts');
      expect(api).toContain("export * from './lib/theme/theme';");
      expect(api).toContain("export * from './lib/theme/theme-toggle';");
    });

    it('offers exactly the palettes the stylesheet declares', () => {
      // The same invariant `npm run check:contrast` enforces in the generated
      // workspace, asserted here so a template edit cannot ship broken.
      const ref = tree.readContent('/projects/ui/src/styles/_ref.scss');
      const declared = [...ref.matchAll(/^\s{2}'([^']+)': \($/gm)].map(([, name]) => name);
      // The design system's own config, which the service and the toggle read.
      const offered = [
        ...tree.readContent('/projects/ui/src/config/palettes.ts').matchAll(/id: '([^']+)'/g),
      ].map(([, id]) => id);
      expect(offered).toEqual(declared);
      expect(tree.readContent('/projects/ui/src/lib/theme/theme-toggle.ts')).toContain(
        "import { PALETTES } from '../../config/palettes';",
      );
      // `angular-capacitor-workspace check-contrast` compares the two in the
      // generated workspace, when there is a picker; see cli.spec.ts.
    });

    it('namespaces the stored preference by the library prefix, as the package spells it', () => {
      // The script before the first paint is written by the generator, and the
      // keys it reads are the package's: one function, held to the other here.
      const keys = themeStorageKeys('ui');
      const html = tree.readContent('/projects/shop/web/src/index.html');
      expect(html).toContain(`localStorage.getItem('${keys.mode}')`);
      expect(html).toContain(`localStorage.getItem('${keys.palette}')`);
      expect(tree.readContent('/projects/ui/src/lib/theme/theme.ts')).toContain(
        "const KEYS = themeStorageKeys('ui');",
      );
    });

    it('draws the toggle focus ring in the step check:contrast holds to the page', () => {
      const scss = tree.readContent('/projects/ui/src/lib/theme/theme-toggle.scss');
      expect(scss).not.toMatch(/outline:[^;]*var\(--accent\)/);
    });
  });

  describe('in an app', () => {
    it('puts the toggle at the end of the header, so every route has it', () => {
      expect(tree.readContent('/projects/shop/web/src/app/app.ts')).toContain(
        "import { ThemeToggle } from 'ui';",
      );
      expect(tree.readContent('/projects/shop/web/src/app/app.ts')).toMatch(
        /imports: \[RouterOutlet, ThemeToggle\]/,
      );
      expect(tree.readContent('/projects/shop/web/src/app/app.html')).toContain(
        '  <span class="brand">{{ title() }}</span>\n  <ui-theme-toggle />\n</header>',
      );
    });

    it('applies the saved theme before the first paint', () => {
      const html = tree.readContent('/projects/shop/web/src/index.html');
      // Before </head>, and reading the keys ThemeService writes.
      expect(html).toContain('theming:before-paint');
      expect(html).toContain("localStorage.getItem('ui.theme-mode')");
      expect(html).toContain("localStorage.getItem('ui.theme-palette')");
      expect(html.indexOf('data-theme')).toBeLessThan(html.indexOf('</head>'));
    });

    it('shows the choice on the starter page, above its closing section', () => {
      expect(tree.exists('/projects/shop/web/src/app/theme/theme-showcase.ts')).toBe(true);
      const page = tree.readContent('/projects/shop/web/src/app/pages/home.page.ts');
      expect(page).toContain("import { ThemeShowcase } from '../theme/theme-showcase';");
      expect(page).toMatch(/imports: \[[^\]]*ThemeShowcase[^\]]*\]/);

      const html = tree.readContent('/projects/shop/web/src/app/pages/home.page.html');
      expect(html).toContain('<app-theme-showcase />');
      expect(html.indexOf('<app-theme-showcase />')).toBeLessThan(html.indexOf('next-heading'));
    });

    it('e2e-tests the part that runs before Angular does', () => {
      expect(tree.exists('/projects/shop/web/e2e/theme.spec.ts')).toBe(true);
    });
  });

  it('leaves a prerendered site following the system colour scheme', () => {
    // Its pages are prerendered once and served to everyone.
    expect(tree.readContent('/projects/site/web/src/app/app.ts')).not.toContain('ThemeToggle');
    expect(tree.readContent('/projects/site/web/src/index.html')).not.toContain('theming:');
  });

  it('refuses a prerendered site by name', async () => {
    await expect(
      runner().runSchematic('theming', { apps: ['site'] }, await workspace()),
    ).rejects.toThrow(/prerendered site/);
  });

  it('refuses a workspace with no design system', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const app = await runner().runSchematic('app', { name: 'shop' }, base);
    await expect(runner().runSchematic('theming', {}, app)).rejects.toThrow(/ui-lib/);
  });

  it('documents itself in the README and the house rules', () => {
    expect(tree.readContent('/README.md')).toContain('## Theme switching');
    expect(tree.readContent('/README.md')).toContain('`@angular-capacitor-workspace/theming`');
    expect(tree.readContent('/AGENTS.md')).toContain('## Theme switching');
  });

  it('takes the selector prefix and the storage keys from the library', async () => {
    const themed = await runner().runSchematic('theming', {}, await workspace('acme'));
    expect(themed.readContent('/projects/shop/web/src/app/app.html')).toContain(
      '<acme-theme-toggle />',
    );
    expect(themed.readContent('/projects/shop/web/src/index.html')).toContain("'acme.theme-mode'");
  });

  it('is idempotent', async () => {
    const twice = await runner().runSchematic('theming', {}, tree);
    for (const [path, text] of [
      ['/projects/shop/web/src/app/app.html', '<ui-theme-toggle />'],
      ['/projects/shop/web/src/index.html', '<!-- theming:before-paint'],
      ['/projects/shop/web/src/app/pages/home.page.html', '<app-theme-showcase />'],
      ['/projects/ui/src/public-api.ts', "'./lib/theme/theme'"],
      ['/README.md', '## Theme switching'],
    ] as const) {
      expect(twice.readContent(path).split(text).length - 1, path).toBe(1);
    }
  });

  it('keeps edits to the toggle, and rewrites the binding, which is its own', async () => {
    const edited = await runner().runSchematic('theming', {}, tree);
    edited.overwrite('/projects/ui/src/lib/theme/theme-toggle.ts', '// restyled\n');
    edited.overwrite('/projects/ui/src/lib/theme/theme.ts', '// edited\n');
    const again = await runner().runSchematic('theming', {}, edited);
    expect(again.readContent('/projects/ui/src/lib/theme/theme-toggle.ts')).toBe('// restyled\n');
    expect(again.readContent('/projects/ui/src/lib/theme/theme.ts')).toBe(
      tree.readContent('/projects/ui/src/lib/theme/theme.ts'),
    );
  });

  it('provides the palettes to each app, and to the shell spec that renders the toggle', () => {
    expect(tree.readContent('/projects/shop/web/src/app/app.config.ts')).toContain(
      'provideTheme(),',
    );
    const spec = tree.readContent('/projects/shop/web/src/app/app.spec.ts');
    expect(spec).toContain("import { provideTheme } from 'ui';");
    expect(spec).toContain('provideTheme(),');
  });

  it('reaches an app generated after it', async () => {
    const later = await runner().runSchematic('app', { name: 'admin' }, tree);
    expect(later.readContent('/projects/admin/web/src/app/app.html')).toContain(
      '<ui-theme-toggle />',
    );
    expect(later.readContent('/projects/admin/web/src/index.html')).toContain(
      'theming:before-paint',
    );
    // And not a site generated after it.
    const site = await runner().runSchematic('marketing', { name: 'docs' }, tree);
    expect(site.readContent('/projects/docs/web/src/app/app.ts')).not.toContain('ThemeToggle');
  });

  it('leaves an app without the generated shell alone, apart from the script', async () => {
    // What `ng add` meets: an app Angular generated, with no header to put a
    // control in. Its template is the user's, so nothing is dropped into it.
    const existing = await runner().runExternalSchematic(
      '@schematics/angular',
      'application',
      { name: 'legacy', skipInstall: true },
      await baseWorkspace(),
    );
    const lib = await runner().runSchematic('ui-lib', { name: 'ui' }, existing);
    const before = lib.readContent('/projects/legacy/src/app/app.html');
    const themed = await runner().runSchematic('theming', {}, lib);
    expect(themed.readContent('/projects/legacy/src/app/app.html')).toBe(before);
    expect(themed.readContent('/projects/legacy/src/app/app.ts')).not.toContain('ThemeToggle');
    expect(themed.readContent('/projects/legacy/src/index.html')).toContain('theming:before-paint');
  });
});
