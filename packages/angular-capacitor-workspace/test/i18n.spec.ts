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

  it('writes an exhaustive direction map, with Arabic right-to-left', () => {
    const tokens = tree.readContent('/projects/ui/src/lib/i18n/i18n.tokens.ts');

    expect(tokens).toContain("export const LOCALES = ['en', 'fr', 'ar'] as const");
    expect(tokens).toContain("ar: 'rtl'");
    expect(tokens).toContain("en: 'ltr'");
    expect(tokens).toContain("fr: 'ltr'");
  });

  it('labels each locale with its own endonym', () => {
    // "Arabic" is useless to a reader who needs العربية.
    const tokens = tree.readContent('/projects/ui/src/lib/i18n/i18n.tokens.ts');
    expect(tokens).toContain('العربية');
    expect(tokens).toContain('Français');
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

    const shell = tree.readContent('/projects/shop/web/src/app/app.html');
    expect(shell).toContain('<ui-language-picker />');
    // Beside the theme toggle, the other control that restyles the whole page.
    expect(shell.indexOf('<ui-language-picker />')).toBeGreaterThan(
      shell.indexOf('<ui-theme-toggle />'),
    );
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

    it('covers the app, beside the theme suite that was already there', () => {
      expect(withE2e.exists('/projects/shop/web/e2e/theme.spec.ts')).toBe(true);
      expect(withE2e.exists('/projects/shop/web/e2e/translation.spec.ts')).toBe(true);

      const spec = withE2e.readContent('/projects/shop/web/e2e/translation.spec.ts');
      // The one thing the library's own tests cannot reach: the inline script
      // that runs before Angular does. Proven by blocking the bundle.
      expect(spec).toContain("page.route('**/main*.js', (route) => route.abort())");
    });

    it('retargets the site suite that predates it', () => {
      // `site.spec.ts` asserts the home page's canonical is `/`. Once the site
      // is built once per language it is `/en/`, under `ng serve` too.
      const spec = withE2e.readContent('/projects/site/web/e2e/site.spec.ts');
      expect(spec).toContain("expect(new URL(canonical!).pathname).toBe('/en/')");
      expect(spec).not.toContain("expect(new URL(canonical!).pathname).toBe('/')");
    });

    it('covers the site, including that the tokens reach it', () => {
      const spec = withE2e.readContent('/projects/site/web/e2e/translation.spec.ts');
      expect(spec).toContain("const LOCALES = ['en', 'fr']");
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
      expect(spec).toContain("const LOCALES = ['en', 'fr'];");
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

    it('keeps the unit specs it breaks green', () => {
      // A generator that turns a green suite red is one nobody trusts the next
      // time it edits something. Each of these asserted on behaviour this
      // schematic changes.

      // Two TestBeds whose subjects now reach TranslationService: the strategy
      // to translate each route's title, the shell through its locale links.
      for (const spec of ['seo/page-meta.spec.ts', 'app.spec.ts']) {
        const source = site.readContent(`/projects/site/web/src/app/${spec}`);
        expect(source, spec).toContain("import { TRANSLATION_LOADER } from 'ui'");
        expect(source, spec).toContain('{ provide: TRANSLATION_LOADER, useValue: () => ({}) }');
      }

      // And the one that asserts the shape of siteUrl, which now carries the
      // locale.
      const urls = site.readContent('/projects/site/web/src/app/site.spec.ts');
      expect(urls).toContain('`${SITE_ORIGIN}/${SITE_LOCALE}/`');
      expect(urls).toContain("localePath('en', '/about')");
    });

    it('translates what a crawler reads, not just the body', () => {
      // A French page with an English <title> is the most visible thing a
      // search result can get wrong, so the routes hold keys, not literals.
      const routes = site.readContent('/projects/site/web/src/app/app.routes.ts');
      expect(routes).toContain("title: 'seo.home.title'");
      expect(routes).toContain("description: 'seo.notFound.description'");

      const meta = site.readContent('/projects/site/web/src/app/seo/page-meta.ts');
      expect(meta).toContain('this.i18n.translate(seo.title)');
      expect(meta).toContain('this.i18n.translate(seo.description)');

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

      const scripts = JSON.parse(site.readContent('/package.json')).scripts;
      expect(scripts['build:site']).toBe(
        'node scripts/clean-dist.mjs site && ' +
          'ng build site --configuration locale-en && ' +
          'ng build site --configuration locale-fr',
      );
      expect(site.exists('/scripts/clean-dist.mjs')).toBe(true);
      expect(scripts['postbuild:site']).toContain('--locales en,fr');
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
      const urls = site.readContent('/projects/site/web/src/app/site.ts');
      expect(urls).toContain('return localeUrl(SITE_LOCALE, path)');
      expect(urls).toContain('export function localePath');
      // Everything downstream — canonical, sitemap, JSON-LD — goes through
      // siteUrl, so rewriting the one function keeps them all in agreement.
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
      const alternates = site.readContent('/projects/site/web/src/app/i18n/locale-alternates.ts');
      // A page that lists only the OTHER languages is treated as having no
      // alternates at all, so the loop covers LOCALES entire.
      expect(alternates).toContain('for (const locale of LOCALES)');
      expect(alternates).toContain('x-default');

      const meta = site.readContent('/projects/site/web/src/app/seo/page-meta.ts');
      expect(meta).toContain('LocaleAlternates');
      expect(meta).toContain('this.alternates.update(path, canonical !== null)');
    });

    it('warns that nothing serves the bare domain', () => {
      // Every page lives under a language, so `/` is a 404 until the host
      // redirects it. That cannot be a file — the destination depends on the
      // visitor — so this warns rather than fails.
      const verify = site.readContent('/scripts/verify-prerender.mjs');
      expect(verify).toContain('nothing in this build serves /');
      expect(verify).toContain("path.join(root, 'index.html')");

      // And the README says what to do about it.
      const readme = site.readContent('/README.md');
      expect(readme).toContain('redirect `/` yourself');
      expect(readme).toContain('Accept-Language');
    });

    it('teaches the postbuild checks about locales', () => {
      const verify = site.readContent('/scripts/verify-prerender.mjs');
      // The tell for a prerender that fell back to the source locale.
      expect(verify).toContain('expected "${output.locale}"');
      expect(verify).toContain('no hreflang alternate for');
      expect(site.readContent('/scripts/generate-sitemap.mjs')).toContain('xhtml:link');
    });

    it('tells the reader the npm command that serves the source locale', () => {
      expect(site.readContent('/README.md')).toContain(
        '`npm run start:site` serves the source locale',
      );
    });

    it('keeps the language links current after a client-side navigation', () => {
      // The links sit in the shell, which nothing re-renders on navigation
      // unless the template reads a signal that changes with it.
      const links = site.readContent('/projects/site/web/src/app/i18n/locale-links.ts');
      expect(links).toContain('toSignal(');
      expect(links).toContain('routePath(this.url())');
    });

    it('leaves the scripts and pages alone once the site is localized', async () => {
      // The first run replaces the marketing schematic's single-language files;
      // after that they are the site's own, and every `ng generate` into the
      // workspace runs this schematic again.
      const tuned = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, site);
      tuned.overwrite('/scripts/verify-prerender.mjs', '// tuned\n');
      tuned.overwrite('/projects/site/web/src/app/pages/home.page.ts', '// edited\n');

      const again = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, tuned);
      expect(again.readContent('/scripts/verify-prerender.mjs')).toBe('// tuned\n');
      expect(again.readContent('/projects/site/web/src/app/pages/home.page.ts')).toBe(
        '// edited\n',
      );
    });

    it('is idempotent, including the scripts it replaces', async () => {
      const twice = await runner().runSchematic('i18n', { locales: ['en', 'fr'] }, site);
      const scripts = JSON.parse(twice.readContent('/package.json')).scripts;

      expect(scripts['build:site']).toBe(
        'node scripts/clean-dist.mjs site && ' +
          'ng build site --configuration locale-en && ' +
          'ng build site --configuration locale-fr',
      );
      expect(
        twice.readContent('/projects/site/web/src/app/app.html').match(/<site-locale-links \/>/g),
      ).toHaveLength(1);
      expect(
        twice.readContent('/projects/site/web/src/app/site.ts').match(/export function localeUrl/g),
      ).toHaveLength(1);
    });
  });

  it('defaults the source locale to the first one, and honours an explicit one', async () => {
    const explicit = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'], defaultLocale: 'fr' },
      await workspaceWithApp(),
    );

    expect(explicit.readContent('/projects/ui/src/lib/i18n/i18n.tokens.ts')).toContain(
      "export const DEFAULT_LOCALE: Locale = 'fr'",
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
    const tokens = '/projects/ui/src/lib/i18n/i18n.tokens.ts';
    const catalog = '/projects/shop/web/src/app/i18n/xx.ts';
    const labelled = localized.readContent(tokens).replace(/'xx',\s*\/\/ TODO[^\n]*/, "'Xxish',");
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
    // Its tables are not rewritten, so catalogs for a locale it does not know
    // would not compile. Adding one is a hand edit the README describes.
    const localized = await runner().runSchematic(
      'i18n',
      { locales: ['en', 'fr'] },
      await workspaceWithApp(),
    );
    await expect(
      runner().runSchematic('i18n', { locales: ['en', 'fr', 'de'] }, localized),
    ).rejects.toThrow(/already translates into en, fr/);
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
    expect(JSON.parse(site.readContent('/package.json')).scripts['build:site']).toContain(
      '--configuration locale-fr',
    );
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
    expect(html.match(/i18n:no-fouc/g)).toHaveLength(1);

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
    expect(out.readContent('/projects/ui/src/lib/i18n/i18n.tokens.ts')).toContain("'pt-BR': 'ltr'");
    expect(out.readContent('/projects/shop/web/src/index.html')).toContain("'pt-BR': 'ltr'");
  });
});
