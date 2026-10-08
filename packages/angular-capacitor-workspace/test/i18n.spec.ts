import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';

const collection = join(__dirname, '..', 'dist', 'collection.json');

if (!existsSync(collection)) {
  throw new Error(
    `${collection} does not exist. Run \`npm run build\` before the tests — ` +
      `the schematic runner loads compiled factories, not sources.`,
  );
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

/** A workspace with a design system and one app — the shape i18n needs. */
async function workspaceWithApp(): Promise<UnitTestTree> {
  const base = await runner().runSchematic('workspace', { uiLib: 'ui' }, await baseWorkspace());
  const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
  return runner().runSchematic('app', { name: 'shop' }, withLib);
}

/** A workspace with a design system, an app and a prerendered site. */
async function workspaceWithSite(): Promise<UnitTestTree> {
  return runner().runSchematic('marketing', { name: 'site' }, await workspaceWithApp());
}

/**
 * Puts a project's scripts back where releases before per-project manifests
 * wrote them: `<verb>:<project>` in the root manifest, with paths from the
 * root. The shape `ng generate` still meets in a workspace from one of those.
 */
function withRootScripts(tree: UnitTestTree, project: string): UnitTestTree {
  const manifest = `/projects/${project}/web/package.json`;
  const own: Record<string, string> = JSON.parse(tree.readContent(manifest)).scripts;
  const root = JSON.parse(tree.readContent('/package.json'));
  const fromRoot = (command: string) =>
    command
      .replaceAll(' --prefix ../../..', '')
      .replaceAll('../../../', '')
      .replace(
        new RegExp(`npm (?:run )?(\\w+) -w @test-ws/${project}`, 'g'),
        `npm run $1:${project}`,
      );

  for (const [name, command] of Object.entries(own)) {
    if (name !== 'watch') {
      root.scripts[`${name}:${project}`] = fromRoot(command);
    }
  }
  for (const [name, command] of Object.entries<string>(root.scripts)) {
    root.scripts[name] = fromRoot(command);
  }
  // Those releases had no project runner: the root scripts named the project.
  const named: Record<string, string> = {
    start: `npm run start:${project}`,
    watch: `ng build ${project} --watch --configuration development`,
    build: `npm run build:${project}`,
    test: 'ng test --no-watch',
    e2e: `npm run e2e:${project}`,
  };
  for (const [verb, command] of Object.entries(named)) {
    if (root.scripts[verb] === `angular-capacitor-workspace run ${verb}`) {
      root.scripts[verb] = command;
    }
  }
  root.workspaces = root.workspaces.filter(
    (member: string) => member !== `projects/${project}/web`,
  );
  tree.overwrite('/package.json', JSON.stringify(root, null, 2));
  tree.delete(manifest);
  return tree;
}

/**
 * Every relative import in the generated TypeScript names a symbol the target
 * module actually exports.
 *
 * A file that exists is not the same as a symbol that is exported: a module
 * that imports a name and re-uses it without re-exporting compiles as a
 * schematic and fails in `ng build`, which is where this was first caught.
 */
function expectImportedSymbolsExist(tree: UnitTestTree): void {
  // A file that exists is not the same as a symbol that is exported: a module
  // that imports a name and re-uses it without re-exporting compiles as a
  // schematic and fails in `ng build`, which is where this was first caught.
  const exported = (file: string): Set<string> => {
    const source = tree.readContent(file);
    const names = new Set<string>();
    for (const [, name] of source.matchAll(
      /export\s+(?:declare\s+)?(?:async\s+)?(?:abstract\s+)?(?:class|function|const|let|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
    )) {
      names.add(name!);
    }
    // `export { a, b } from './x'` and `export { a, b }`.
    for (const [, list] of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
      for (const part of list!.split(',')) {
        const name = part
          .trim()
          .split(/\s+as\s+/)
          .pop()
          ?.trim();
        if (name) names.add(name.replace(/^type\s+/, ''));
      }
    }
    return names;
  };

  for (const file of localTs(tree)) {
    const dir = file.slice(0, file.lastIndexOf('/'));
    const source = tree.readContent(file);

    for (const [, names, specifier] of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.[^']*)'/g,
    )) {
      const target = `${new URL(specifier!, `file://${dir}/`).pathname}.ts`;
      if (!tree.exists(target)) {
        continue; // reported by the resolution test
      }
      const available = exported(target);
      for (const part of names!.split(',')) {
        const name = part
          .trim()
          .replace(/^type\s+/, '')
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (name) {
          expect(available.has(name), `${file} imports ${name} from ${specifier}`).toBe(true);
        }
      }
    }
  }
}

/** The TypeScript this schematic generates or edits, which is what these check. */
function localTs(tree: UnitTestTree): string[] {
  return tree.files.filter(
    (path) =>
      path.endsWith('.ts') &&
      !path.includes('/e2e/') &&
      (path.includes('/i18n/') ||
        path.endsWith('/app/app.config.ts') ||
        path.endsWith('/app/app.routes.ts') ||
        path.endsWith('/app/site.ts') ||
        path.endsWith('/app/site.spec.ts') ||
        path.endsWith('/app/app.spec.ts') ||
        path.endsWith('/seo/page-meta.ts') ||
        path.endsWith('/seo/page-meta.spec.ts') ||
        path.endsWith('/pages/home.page.ts')),
  );
}

describe('i18n', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    tree = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr', 'ar'] },
      await workspaceWithApp(),
    );
  });

  it('puts the mechanism in the design system', () => {
    for (const file of [
      'i18n.tokens.ts',
      'translation.ts',
      'translate-pipe.ts',
      'translation.loader.ts',
      'i18n-providers.ts',
      'language-picker.ts',
    ]) {
      expect(tree.exists(`/projects/ui/src/lib/i18n/${file}`)).toBe(true);
    }
  });

  it('ships no messages in the design system', () => {
    // The whole reason the mechanism and the messages are split: a design
    // system that carries its own copy can only serve apps that want that copy.
    const files = tree.files.filter((path) => path.startsWith('/projects/ui/src/lib/i18n/'));
    expect(files.some((path) => /\/(en|fr|ar)\.ts$/.test(path))).toBe(false);
  });

  it('generates one catalog per locale in the app', () => {
    for (const locale of ['en', 'fr', 'ar']) {
      expect(tree.exists(`/projects/shop/web/src/app/i18n/${locale}.ts`)).toBe(true);
    }
  });

  it("writes the locales into the design system's config, with Arabic right-to-left", () => {
    const config = tree.readContent('/projects/ui/src/config/i18n.ts');

    expect(config).toContain("defaultLocale: 'en',");
    expect(config).toContain("en: { label: 'English', direction: 'ltr' },");
    expect(config).toContain("fr: { label: 'Français', direction: 'ltr' },");
    // "Arabic" is useless to a reader who needs العربية.
    expect(config).toContain("ar: { label: 'العربية', direction: 'rtl' },");
    expect(config).toContain('} as const satisfies I18nConfig;');
  });

  it('derives every locale table from the config, so none needs editing', () => {
    const tokens = tree.readContent('/projects/ui/src/lib/i18n/i18n.tokens.ts');
    expect(tokens).toContain("import { I18N } from '../../config/i18n';");
    expect(tokens).toContain('export type Locale = keyof typeof I18N.locales & string;');
    expect(tokens).not.toMatch(/'(en|fr|ar)'/);
  });

  it('tags every untranslated value, so a placeholder is visible on screen', () => {
    // Without this the generated catalogs are verbatim copies of the source and
    // switching language changes nothing — the showcase would demonstrate a
    // switch that appears not to work, and a real untranslated string would be
    // invisible.
    const source = tree.readContent('/projects/shop/web/src/app/i18n/en.ts');
    const translated = tree.readContent('/projects/shop/web/src/app/i18n/fr.ts');

    expect(source).not.toContain('[en]');
    expect(translated).toContain("'showcase.plain.value': '[fr] ");
    // The app's own name is not a string anyone translates.
    expect(translated).toContain("'app.title': 'Shop'");
  });

  it('types the translated catalogs against the source one', () => {
    // A key added to en.ts has to break fr.ts, or a translator finds out at
    // runtime instead of at build time.
    const fr = tree.readContent('/projects/shop/web/src/app/i18n/fr.ts');
    expect(fr).toContain('LocalizedCatalog');

    const messages = tree.readContent('/projects/shop/web/src/app/i18n/messages.ts');
    expect(messages).toContain('Record<MessageKey, string> & TranslationCatalog');
  });

  it('splits each locale into its own chunk with a static import', () => {
    // A template literal path would defeat the bundler's code splitting.
    const loader = tree.readContent('/projects/shop/web/src/app/i18n/catalog.loader.ts');
    expect(loader).toContain("case 'fr':");
    expect(loader).toContain("await import('./fr')");
    expect(loader).not.toMatch(/import\(`/);
  });

  it('registers the loader in the app config', () => {
    const config = tree.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config).toContain("import { provideTranslations } from 'ui'");
    expect(config).toContain('provideTranslations(loadCatalog)');
  });

  it('imports only symbols the target module actually exports', () => {
    expectImportedSymbolsExist(tree);
  });

  it('writes relative imports that resolve to files that exist', () => {
    // A path that is merely plausible compiles in a string assertion and fails
    // in `ng build`, which is where this was first caught.
    const generated = tree.files.filter(
      (path) =>
        (path.includes('/i18n/') && path.endsWith('.ts')) || path.endsWith('/app/app.config.ts'),
    );
    expect(generated.length).toBeGreaterThan(0);

    for (const file of generated) {
      const dir = file.slice(0, file.lastIndexOf('/'));
      const specifiers = [...tree.readContent(file).matchAll(/from '(\.[^']*)'/g)].map(
        (match) => match[1]!,
      );

      for (const specifier of specifiers) {
        const resolved = new URL(specifier, `file://${dir}/`).pathname;
        expect(tree.exists(`${resolved}.ts`), `${file} → ${specifier}`).toBe(true);
      }
    }
  });

  it('sets lang and dir before first paint', () => {
    // TranslationService sets them in an effect, which runs after bootstrap —
    // one frame of a left-to-right page is a flash an RTL reader would see.
    const html = tree.readContent('/projects/shop/web/src/index.html');
    expect(html).toContain('i18n:no-fouc');
    expect(html).toContain("ar: 'rtl'");
    expect(html).toMatch(/<html[^>]*lang="en"/);
    expect(html).toMatch(/<html[^>]*dir="ltr"/);
    expect(html.indexOf('i18n:no-fouc')).toBeLessThan(html.indexOf('</head>'));
  });

  it('wires the direction stylesheet into the style entry point', () => {
    expect(tree.exists('/projects/ui/src/styles/_direction.scss')).toBe(true);
    expect(tree.readContent('/projects/ui/src/styles/index.scss')).toContain("@use 'direction';");
  });

  it('exports the i18n surface from the library public API', () => {
    const api = tree.readContent('/projects/ui/src/public-api.ts');
    expect(api).toContain('TranslationService');
    expect(api).toContain('TranslatePipe');
    expect(api).toContain('provideTranslations');
    expect(api).toContain('LanguagePicker');
  });

  it('documents the RTL rule when an RTL locale ships', () => {
    const readme = tree.readContent('/README.md');
    expect(readme).toContain('## Translation');
    expect(readme).toContain('logical properties');
  });

  it('writes the house rules that keep the design intact', () => {
    // Every rule here is a mistake that compiles.
    const agents = tree.readContent('/AGENTS.md');

    expect(agents).toContain('## Translation');
    expect(agents).toContain('ships no user-visible strings');
    expect(agents).toContain('DatePipe');
    expect(agents).toContain('`start` and `end`');
    expect(agents.split('\n').every((line) => line.length <= 80)).toBe(true);
  });

  it('leaves the RTL rules out when no RTL locale ships', async () => {
    const ltrOnly = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'] },
      await workspaceWithApp(),
    );

    const agents = ltrOnly.readContent('/AGENTS.md');
    expect(agents).toContain('## Translation');
    expect(agents).not.toContain('flip-inline');
  });

  it('puts the showcase on the starter screen and the picker in the header', () => {
    expect(tree.exists('/projects/shop/web/src/app/i18n/i18n-showcase.ts')).toBe(true);

    const page = tree.readContent('/projects/shop/web/src/app/pages/home.page.ts');
    expect(page).toContain("import { I18nShowcase } from '../i18n/i18n-showcase'");
    expect(page).toMatch(/imports: \[[^\]]*I18nShowcase[^\]]*\]/);
    expect(tree.readContent('/projects/shop/web/src/app/pages/home.page.html')).toContain(
      '<app-i18n-showcase />',
    );

    // And the shell's own spec, whose subject now reaches TranslationService
    // through that picker. A generator that turns a green suite red is one
    // nobody trusts the next time it edits something.
    const spec = tree.readContent('/projects/shop/web/src/app/app.spec.ts');
    expect(spec).toContain("import { TRANSLATION_LOADER } from 'ui'");
    expect(spec).toContain('{ provide: TRANSLATION_LOADER, useValue: () => ({}) }');

    // In the header, through the shell's extension point rather than beside a
    // line of the template it would have to recognise.
    expect(tree.readContent('/projects/shop/web/src/app/app.html')).toMatch(
      /<header>[\s\S]*<ui-language-picker \/>\n<\/header>/,
    );
    // Above the page's closing section, which says what to do next.
    const html = tree.readContent('/projects/shop/web/src/app/pages/home.page.html');
    expect(html.indexOf('<app-i18n-showcase />')).toBeLessThan(html.indexOf('next-heading'));
  });

  it('showcases every kind of lookup the layer does', () => {
    const template = tree.readContent('/projects/shop/web/src/app/i18n/i18n-showcase.html');
    const component = tree.readContent('/projects/shop/web/src/app/i18n/i18n-showcase.ts');

    // A plain key, a placeholder, a plural.
    expect(template).toContain("'showcase.plain.value' | t");
    expect(template).toContain("'showcase.greeting' | t: { name: name() }");
    expect(template).toContain("'showcase.items' | t: { count: count() }");

    // And the formatters, which is the half people reach for a DatePipe for.
    for (const formatter of ['formatNumber', 'formatDate', 'formatRelativeTime']) {
      expect(component, formatter).toContain(`i18n.${formatter}(`);
    }
    expect(component).toContain("style: 'currency'");

    // The direction readout, which is what makes an RTL locale visibly work.
    expect(template).toContain('i18n.isRtl()');
  });

  describe('the e2e suites', () => {
    let withE2e: UnitTestTree;

    beforeAll(async () => {
      const base = await runner().runSchematic('workspace', { uiLib: 'ui' }, await baseWorkspace());
      const lib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
      const app = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, lib);
      const site = await runner().runSchematic(
        'marketing',
        { name: 'site', e2e: 'playwright' },
        app,
      );
      withE2e = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, site);
    });

    it('covers the app', () => {
      expect(withE2e.exists('/projects/shop/web/e2e/translation.spec.ts')).toBe(true);

      const spec = withE2e.readContent('/projects/shop/web/e2e/translation.spec.ts');
      // The one thing the library's own tests cannot reach: the inline script
      // that runs before Angular does. Proven by blocking the bundle.
      expect(spec).toContain("page.route('**/main*.js', (route) => route.abort())");
    });

    it('leaves the site suite alone, which holds in every language', () => {
      // Its canonical check asks for the root of whatever the site is served
      // under, which is `/en/` once it is built per language, under `ng serve`
      // too. Nothing to rewrite.
      const spec = withE2e.readContent('/projects/site/web/e2e/site.spec.ts');
      expect(spec).toContain('expect(new URL(canonical!).pathname).toMatch(/\\/$/);');
      expect(spec).not.toContain("toBe('/en/')");
    });

    it('covers the site, including that the tokens reach it', () => {
      const spec = withE2e.readContent('/projects/site/web/e2e/translation.spec.ts');
      // From the config, so a language added there is a language tested.
      expect(spec).toContain("import { I18N } from '../../../ui/src/config/i18n';");
      expect(spec).toContain('const LOCALES = Object.keys(I18N.locales);');
      expect(spec).toContain('--surface');
      // A prerendered page must never pin a colour scheme.
      expect(spec).toContain("not.toHaveAttribute('data-theme'");
    });

    it('writes no spec into a project that has no Playwright config', () => {
      // A spec in a project with no runner is a file nothing runs.
      expect(tree.exists('/projects/shop/web/e2e/translation.spec.ts')).toBe(false);
    });

    it('switches to whichever locale is not showing, not to a fixed one', () => {
      // The first load negotiates from the browser's languages, so with
      // `fr,en` the last locale is the one already on screen, and a fixed pick
      // would "switch" to it and fail. One locale has nothing to switch to.
      const spec = withE2e.readContent('/projects/shop/web/e2e/translation.spec.ts');
      expect(spec).toContain('const LOCALES = Object.keys(I18N.locales);');
      expect(spec).toContain('LOCALES.find((locale) => locale !== current)');
      expect(spec).toContain('test.skip(LOCALES.length < 2');
      expect(spec).not.toContain('options.length - 1');
    });
  });

  describe('a prerendered site', () => {
    let site: UnitTestTree;

    beforeAll(async () => {
      site = await runner().runSchematic(
        'i18n',
        { locales: ['en', 'fr'] },
        await workspaceWithSite(),
      );
    });

    it('imports only symbols the target module actually exports', () => {
      // The site edits site.ts and page-meta.ts as well as writing its own
      // files, so it has more ways to name something that is not there.
      expectImportedSymbolsExist(site);
    });

    it('keeps the unit specs green', () => {
      // A generator that turns a green suite red is one nobody trusts the next
      // time it edits something. The shell's TestBed is the one whose subject
      // now reaches TranslationService, through the locale links in its header.
      const shell = site.readContent('/projects/site/web/src/app/app.spec.ts');
      expect(shell).toContain("import { TRANSLATION_LOADER } from 'ui'");
      expect(shell).toContain('{ provide: TRANSLATION_LOADER, useValue: () => ({}) }');
      expect(site.exists('/projects/site/web/src/app/i18n/locale-url.spec.ts')).toBe(true);
    });

    it('extends the head through PAGE_META_EXTENSIONS instead of editing the site', async () => {
      // The strategy, `siteUrl` and their specs are the files the marketing
      // schematic wrote, byte for byte: everything translation changes about
      // the head comes in through the strategy's own extension point.
      const plain = await workspaceWithSite();
      for (const file of ['seo/page-meta.ts', 'seo/page-meta.spec.ts', 'site.ts', 'site.spec.ts']) {
        const path = `/projects/site/web/src/app/${file}`;
        expect(site.readContent(path), file).toBe(plain.readContent(path));
      }

      const config = site.readContent('/projects/site/web/src/app/app.config.ts');
      expect(config).toContain(
        '{ provide: PAGE_META_EXTENSIONS, useExisting: LocalizedPageMeta, multi: true }',
      );
      expect(config).toContain(
        "import { PageMetaStrategy, PAGE_META_EXTENSIONS } from './seo/page-meta';",
      );
      expect(config).toContain("import { LocalizedPageMeta } from './i18n/localized-page-meta';");
    });

    it('translates what a crawler reads, not just the body', () => {
      // A French page with an English <title> is the most visible thing a
      // search result can get wrong, so the routes hold keys, not literals.
      const routes = site.readContent('/projects/site/web/src/app/app.routes.ts');
      expect(routes).toContain("title: 'seo.home.title'");
      expect(routes).toContain("description: 'seo.notFound.description'");

      const meta = site.readContent('/projects/site/web/src/app/i18n/localized-page-meta.ts');
      expect(meta).toContain('implements PageMetaExtension');
      expect(meta).toContain('return this.i18n.translate(key);');

      for (const locale of ['en', 'fr']) {
        expect(site.readContent(`/projects/site/web/src/app/i18n/${locale}.ts`), locale).toContain(
          "'seo.home.title'",
        );
      }
    });

    it('is built once per locale, not switched at runtime', () => {
      const build = JSON.parse(site.readContent('/angular.json')).projects.site.architect.build;

      for (const locale of ['en', 'fr']) {
        const config = build.configurations[`locale-${locale}`];
        expect(config, locale).toBeDefined();
        expect(config.baseHref).toBe(`/${locale}/`);
        expect(config.outputPath).toEqual({ base: 'dist/site', browser: locale });
        // The compile-time substitution is what makes the PRERENDER render in
        // this language; an env var would only reach the build, not the bundle.
        expect(config.define).toEqual({ BUILD_LOCALE: `"${locale}"` });
      }

      // Angular deletes `outputPath.base`, which every language shares, so the
      // second build would take the first one's output with it.
      expect(build.configurations['locale-en'].deleteOutputPath).toBe(false);

      // In the site's own manifest, which runs in projects/site/web.
      const scripts = JSON.parse(site.readContent('/projects/site/web/package.json')).scripts;
      expect(scripts['build']).toBe(
        'angular-capacitor-workspace clean-dist site && ' +
          'ng build site --configuration locale-en && ' +
          'ng build site --configuration locale-fr',
      );
      // Told which locales to expect, so a language that failed to build is a
      // failed check rather than a site that quietly ships one language.
      expect(scripts['postbuild']).toBe(
        'angular-capacitor-workspace sitemap site --locales en,fr && ' +
          'angular-capacitor-workspace verify-prerender site --locales en,fr',
      );
      // The checks are the installed package's, so nothing is copied in.
      expect(site.files.some((path) => path.startsWith('/scripts/'))).toBe(false);
    });

    it('pins the locale rather than negotiating it', () => {
      // The prerender runs in Node: there is no navigator to negotiate with,
      // and whatever it renders is what every visitor is served.
      const config = site.readContent('/projects/site/web/src/app/app.config.ts');
      expect(config).toContain('provideTranslations(loadCatalog, { locale: SITE_LOCALE })');
      expect(site.exists('/projects/site/web/src/app/i18n/build-locale.ts')).toBe(true);
    });

    it('has no runtime locale script, unlike an app', () => {
      // A no-FOUC script would fight the build's own locale.
      expect(site.readContent('/projects/site/web/src/index.html')).not.toContain('i18n:no-fouc');
    });

    it('puts the locale in every URL it states about itself', () => {
      // The canonical names the path this build serves the page at, and the
      // sitemap is derived from the canonicals.
      const meta = site.readContent('/projects/site/web/src/app/i18n/localized-page-meta.ts');
      expect(meta).toContain('return localePath(SITE_LOCALE, path);');
      // One module builds every locale URL, on top of `siteUrl`, so the
      // canonical, the alternates and the header's links cannot disagree.
      const urls = site.readContent('/projects/site/web/src/app/i18n/locale-url.ts');
      expect(urls).toContain('return siteUrl(localePath(locale, path));');
      expect(site.readContent('/projects/site/web/src/app/i18n/locale-links.ts')).toContain(
        "import { localePath } from './locale-url';",
      );
    });

    it('links between languages with real hrefs, not routerLink', () => {
      // Separate documents, so a crawler has to be able to follow them and a
      // visitor has to be able to copy the link.
      const links = site.readContent('/projects/site/web/src/app/i18n/locale-links.html');
      expect(links).toContain('[href]="href(locale)"');
      expect(links).toContain('[attr.hreflang]="locale"');
      expect(links).not.toContain('routerLink');
      expect(site.readContent('/projects/site/web/src/app/app.html')).toContain(
        '<site-locale-links />',
      );
    });

    it('writes hreflang alternates into the head, including its own locale', () => {
      const meta = site.readContent('/projects/site/web/src/app/i18n/localized-page-meta.ts');
      // A page that lists only the OTHER languages is treated as having no
      // alternates at all, so the loop covers LOCALES entire.
      expect(meta).toContain('for (const locale of LOCALES)');
      expect(meta).toContain('x-default');
      // Called by the strategy once a page's tags are written, with whether it
      // is indexable: a noindex page gets none.
      expect(meta).toContain('written(path: string, indexable: boolean): void {');
    });

    it('warns that nothing serves the bare domain', () => {
      // Every page lives under a language, so `/` is a 404 until the host
      // redirects it. That cannot be a file — the destination depends on the
      // visitor — so `verify-prerender` warns rather than fails (see
      // cli.spec.ts), and the README says what to do about it.
      const readme = site.readContent('/README.md');
      expect(readme).toContain('redirect `/` yourself');
      expect(readme).toContain('Accept-Language');
    });

    it('tells the reader the npm command that serves the source locale', () => {
      expect(site.readContent('/README.md')).toContain('`npm start site` serves the source locale');
    });

    it('keeps the language links current after a client-side navigation', () => {
      // The links sit in the shell, which nothing re-renders on navigation
      // unless the template reads a signal that changes with it.
      const links = site.readContent('/projects/site/web/src/app/i18n/locale-links.ts');
      expect(links).toContain('toSignal(');
      expect(links).toContain('routePath(this.url())');
    });

    it('leaves the pages alone once the site is localized', async () => {
      // The first run replaces the marketing schematic's single-language files;
      // after that they are the site's own, and every `ng generate` into the
      // workspace runs this schematic again.
      const tuned = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, site);
      tuned.overwrite('/projects/site/web/src/app/pages/home.page.ts', '// edited\n');

      const again = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, tuned);
      expect(again.readContent('/projects/site/web/src/app/pages/home.page.ts')).toBe(
        '// edited\n',
      );
    });

    it('is idempotent, including the scripts it replaces', async () => {
      const twice = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, site);
      const scripts = JSON.parse(twice.readContent('/projects/site/web/package.json')).scripts;

      expect(scripts['build']).toBe(
        'angular-capacitor-workspace clean-dist site && ' +
          'ng build site --configuration locale-en && ' +
          'ng build site --configuration locale-fr',
      );
      expect(
        twice.readContent('/projects/site/web/src/app/app.html').match(/<site-locale-links \/>/g),
      ).toHaveLength(1);
      expect(
        twice
          .readContent('/projects/site/web/src/app/app.config.ts')
          .match(/useExisting: LocalizedPageMeta/g),
      ).toHaveLength(1);
    });

    it('stops, with the change to make, on a site whose head has no extension point', async () => {
      // A site from an earlier 22.x: registering the extension would import a
      // token its page-meta.ts does not export, and its strategy already
      // translates the head itself.
      const older = await workspaceWithSite();
      const path = '/projects/site/web/src/app/seo/page-meta.ts';
      older.overwrite(path, older.readContent(path).replaceAll('PAGE_META_EXTENSIONS', 'GONE'));
      await expect(runner().runSchematic('i18n', { locales: ['en', 'fr'] }, older)).rejects.toThrow(
        /has no PAGE_META_EXTENSIONS/,
      );
    });

    it('rewrites the build of a site whose scripts are still in the root manifest', async () => {
      // What `ng generate i18n` meets in a workspace from an earlier 22.x.
      const legacy = withRootScripts(await workspaceWithSite(), 'site');
      const localized = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, legacy);
      const scripts = JSON.parse(localized.readContent('/package.json')).scripts;

      expect(localized.exists('/projects/site/web/package.json')).toBe(false);
      expect(scripts['build:site']).toBe(
        'angular-capacitor-workspace clean-dist site && ' +
          'ng build site --configuration locale-en && ' +
          'ng build site --configuration locale-fr',
      );
      expect(scripts['postbuild:site']).toContain(
        'angular-capacitor-workspace verify-prerender site --locales en,fr',
      );
    });
  });

  it('defaults the source locale to the first one, and honours an explicit one', async () => {
    const explicit = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'], defaultLocale: 'fr' },
      await workspaceWithApp(),
    );

    expect(explicit.readContent('/projects/ui/src/config/i18n.ts')).toContain(
      "defaultLocale: 'fr',",
    );
    // The source catalog is the one the others are typed against, so it is the
    // one without the annotation.
    expect(explicit.readContent('/projects/shop/web/src/app/i18n/fr.ts')).toContain(
      'export const fr = {',
    );
    expect(explicit.readContent('/projects/shop/web/src/app/i18n/en.ts')).toContain(
      'export const en: LocalizedCatalog = {',
    );
  });

  it('refuses a default locale that is not being generated', async () => {
    // It is what every untranslated key falls back to, so it has to ship.
    await expect(
      runner().runSchematic(
        'i18n',
        { locales: ['en'], defaultLocale: 'fr' },
        await workspaceWithApp(),
      ),
    ).rejects.toThrow(/not one of the locales/);
  });

  it('refuses a tag that is not BCP-47', async () => {
    await expect(
      runner().runSchematic('i18n', { locales: ['english'] }, await workspaceWithApp()),
    ).rejects.toThrow(/BCP-47/);
  });

  it('refuses a workspace with no design system', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);

    await expect(runner().runSchematic('i18n', { locales: ['en'] }, withApp)).rejects.toThrow(
      /design-system library/,
    );
    // Naming a command that works, under the collection's real name.
    await expect(runner().runSchematic('i18n', { locales: ['en'] }, withApp)).rejects.toThrow(
      /ng generate angular-capacitor-workspace:ui-lib/,
    );
  });

  it('keeps edits to what it wrote when a project is generated later', async () => {
    // Generating an app into a translated workspace re-runs this schematic.
    // An endonym someone corrected, or a catalog someone translated, is theirs.
    const localized = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'xx'] },
      await workspaceWithApp(),
    );
    const tokens = '/projects/ui/src/config/i18n.ts';
    const catalog = '/projects/shop/web/src/app/i18n/xx.ts';
    const labelled = localized
      .readContent(tokens)
      .replace(
        /label: 'xx', direction: 'ltr' \},\s*\/\/ TODO[^\n]*/,
        "label: 'Xxish', direction: 'ltr' },",
      );
    expect(labelled).toContain("'Xxish'");
    localized.overwrite(tokens, labelled);
    localized.overwrite(catalog, '// translated by hand\n');

    const later = await runner().runSchematic('app', { name: 'admin' }, localized);
    expect(later.readContent(tokens)).toBe(labelled);
    expect(later.readContent(catalog)).toBe('// translated by hand\n');
    expect(later.exists('/projects/admin/web/src/app/i18n/xx.ts')).toBe(true);

    const again = await runner().runSchematic('i18n', { locales: ['en', 'xx'] }, later);
    expect(again.readContent(tokens)).toBe(labelled);
    expect(again.readContent(catalog)).toBe('// translated by hand\n');
  });

  it('refuses a different set of locales once the library has its own', async () => {
    // The config is the one place a locale lives, so a second way to change
    // the set is refused, naming the first.
    const localized = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'] },
      await workspaceWithApp(),
    );
    await expect(
      runner().runSchematic('i18n', { locales: ['en', 'fr', 'de'] }, localized),
    ).rejects.toThrow(/already translates into en, fr/);
    await expect(
      runner().runSchematic('i18n', { locales: ['en', 'fr', 'de'] }, localized),
    ).rejects.toThrow(/projects\/ui\/src\/config\/i18n\.ts: change them there/);
  });

  describe('a language added to the config', () => {
    let synced: UnitTestTree;

    beforeAll(async () => {
      const localized = await runner().runSchematic(
        'i18n',
        { locales: ['en', 'fr'] },
        await workspaceWithSite(),
      );
      // The source catalog has grown since the first run, as it does.
      const source = '/projects/shop/web/src/app/i18n/en.ts';
      localized.overwrite(
        source,
        localized
          .readContent(source)
          .replace('} as const;', "  'cart.empty': 'Your basket is empty',\n} as const;"),
      );
      const config = '/projects/ui/src/config/i18n.ts';
      localized.overwrite(
        config,
        localized
          .readContent(config)
          .replace('    fr: {', "    he: { label: 'עברית', direction: 'rtl' },\n    fr: {"),
      );
      synced = await runner().runSchematic('i18n', {}, localized);
    });

    it('gets a catalog in every app, copied from the source as it stands', () => {
      const catalog = synced.readContent('/projects/shop/web/src/app/i18n/he.ts');
      expect(catalog).toContain('export const he: LocalizedCatalog = {');
      expect(catalog).toContain("'cart.empty': '[he] Your basket is empty',");
      expect(catalog).toContain("'language.label': '[he] Language',");
      expect(synced.exists('/projects/site/web/src/app/i18n/he.ts')).toBe(true);
    });

    it('reaches the generated loader and the script that runs before the first paint', () => {
      expect(synced.readContent('/projects/shop/web/src/app/i18n/catalog.loader.ts')).toContain(
        "case 'he':\n      return (await import('./he')).he;",
      );
      const html = synced.readContent('/projects/shop/web/src/index.html');
      expect(html).toContain("var dirs = { en: 'ltr', he: 'rtl', fr: 'ltr' };");
      expect(html.match(/<!-- i18n:no-fouc/g)).toHaveLength(1);
    });

    it("reaches every site's per-language builds", () => {
      const build = JSON.parse(synced.readContent('/angular.json')).projects.site.architect.build;
      expect(build.configurations['locale-he'].baseHref).toBe('/he/');
      const scripts = JSON.parse(synced.readContent('/projects/site/web/package.json')).scripts;
      expect(scripts['build']).toContain('--configuration locale-he');
      expect(scripts['postbuild']).toContain('--locales en,he,fr');
    });

    it('leaves the library alone, which derives everything from the config', async () => {
      const before = await runner().runSchematic(
        'i18n',
        { locales: ['en', 'fr'] },
        await workspaceWithSite(),
      );
      const tokens = '/projects/ui/src/lib/i18n/i18n.tokens.ts';
      expect(synced.readContent(tokens)).toBe(before.readContent(tokens));
    });

    it('drops a language the config no longer lists from what the generator owns', async () => {
      const config = '/projects/ui/src/config/i18n.ts';
      synced.overwrite(config, synced.readContent(config).replace(/\n {4}fr: \{[^\n]*/, ''));
      const dropped = await runner().runSchematic('i18n', {}, synced);
      expect(
        dropped.readContent('/projects/shop/web/src/app/i18n/catalog.loader.ts'),
      ).not.toContain("case 'fr'");
      expect(dropped.readContent('/projects/shop/web/src/index.html')).toContain(
        "var dirs = { en: 'ltr', he: 'rtl' };",
      );
      const scripts = JSON.parse(dropped.readContent('/projects/site/web/package.json')).scripts;
      expect(scripts['build']).not.toContain('locale-fr');
      // The catalog itself was somebody's work, and stays.
      expect(dropped.exists('/projects/shop/web/src/app/i18n/fr.ts')).toBe(true);
    });
  });

  it('refuses a config it cannot read, saying what it has to be', async () => {
    const localized = await runner().runSchematic(
      'i18n',
      { locales: ['en'] },
      await workspaceWithApp(),
    );
    const config = '/projects/ui/src/config/i18n.ts';
    localized.overwrite(
      config,
      localized.readContent(config).replace("direction: 'ltr'", "direction: 'up'"),
    );
    await expect(runner().runSchematic('i18n', {}, localized)).rejects.toThrow(
      /must be `\{ label: string, direction: 'ltr' \| 'rtl' \}`/,
    );
  });

  it('reaches a project generated after it', async () => {
    // A workspace is generated once and grown for years, so `ng generate` has
    // to produce a project that matches the ones beside it.
    const localized = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'] },
      await workspaceWithApp(),
    );

    const later = await runner().runSchematic('app', { name: 'admin' }, localized);
    expect(later.exists('/projects/admin/web/src/app/i18n/fr.ts')).toBe(true);
    expect(later.readContent('/projects/admin/web/src/app/app.config.ts')).toContain(
      'provideTranslations(loadCatalog)',
    );

    // And a site generated later gets the other half — the per-locale builds,
    // not the runtime picker.
    const site = await runner().runSchematic('marketing', { name: 'site' }, localized);
    expect(site.exists('/projects/site/web/src/app/i18n/build-locale.ts')).toBe(true);
    expect(
      JSON.parse(site.readContent('/angular.json')).projects.site.architect.build.configurations[
        'locale-fr'
      ],
    ).toBeDefined();
    expect(
      JSON.parse(site.readContent('/projects/site/web/package.json')).scripts['build'],
    ).toContain('--configuration locale-fr');
  });

  it('is idempotent', async () => {
    const once = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'] },
      await workspaceWithApp(),
    );
    const twice = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, once);

    const config = twice.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config.match(/provideTranslations\(loadCatalog\)/g)).toHaveLength(1);

    const html = twice.readContent('/projects/shop/web/src/index.html');
    expect(html.match(/<!-- i18n:no-fouc/g)).toHaveLength(1);

    expect(
      twice.readContent('/projects/ui/src/styles/index.scss').match(/@use 'direction';/g),
    ).toHaveLength(1);
  });

  it('handles a region subtag', async () => {
    const out = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'pt-BR'] },
      await workspaceWithApp(),
    );

    // The const has to be a valid identifier, and the direction inherits from
    // the base language.
    expect(out.exists('/projects/shop/web/src/app/i18n/pt-BR.ts')).toBe(true);
    expect(out.readContent('/projects/shop/web/src/app/i18n/pt-BR.ts')).toContain(
      'export const ptBR',
    );
    // Quoted, because `{ pt-BR: 'ltr' }` is a subtraction.
    expect(out.readContent('/projects/ui/src/config/i18n.ts')).toContain(
      "'pt-BR': { label: 'Português', direction: 'ltr' },",
    );
    expect(out.readContent('/projects/shop/web/src/index.html')).toContain("'pt-BR': 'ltr'");
  });
});
