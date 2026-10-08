import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  filter,
  MergeStrategy,
  mergeWith,
  move,
  noop,
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import { isLocaleTag, localeInfo } from '../../locales';
import {
  exportFromLibrary,
  requireDesignSystem,
  useLibraryStyles,
  type DesignSystem,
} from '../../extend/design-system';
import {
  addBootScript,
  addHeaderControl,
  addRootProvider,
  addShellTestProvider,
  addStarterSection,
} from '../../extend/shell';
import { addPageMetaExtension, replaceSiteBuild } from '../../extend/site';
import { updateJson } from '../../utils/json-file';
import { documentProjectScripts, projectScripts } from '../../utils/project-scripts';
import {
  ANGULAR_JSON,
  appendSection,
  readProjects,
  README_MD,
  titleFromName,
  type AngularProject,
} from '../../utils/workspace';
import { isPrerendered, treeView } from '../../utils/workspace-view';
import { installedLocales } from './plugin';

export interface I18nOptions {
  locales?: string[];
  defaultLocale?: string;
  apps?: string[];
}

/**
 * Runtime translation, writing direction and a language picker.
 *
 * Runtime rather than `@angular/localize`, and that is the whole decision this
 * schematic encodes. Compile-time i18n emits one bundle per locale, which for
 * an app that ships inside a Capacitor shell means one binary per language:
 * `webDir` points at a single directory with a single `index.html`, so there is
 * nowhere for a second locale to live. A marketing site is the opposite case —
 * per-locale URLs are the entire point of prerendering for a crawler — which is
 * why prerendered sites are left alone here and translated at build time if
 * they are translated at all.
 *
 * The mechanism goes in the design-system library and the MESSAGES go in each
 * app. That split is the reason this is worth generating rather than installing:
 * a design system that carries its own copy can only ever be used by apps that
 * want that copy, and one that takes strings as inputs serves every locale its
 * consumers ship without an extraction step.
 *
 * A plugin (see `plugin.ts`): a project generated later is wired into the same
 * locales, and every edit to a host's files goes through `src/extend/`.
 */
export function i18n(options: I18nOptions = {}): Rule {
  return (tree: Tree) => {
    const locales = normalizeLocales(options.locales ?? ['en']);
    const defaultLocale = resolveDefault(locales, options.defaultLocale);

    const design = requireDesignSystem(
      tree,
      'The i18n schematic wires the translation machinery into the design-system library',
    );

    const { apps, sites } = targets(tree, options.apps);
    if (apps.length === 0 && sites.length === 0) {
      throw new SchematicsException(
        'The i18n schematic needs at least one application to wire messages ' +
          'into, and this workspace has none.',
      );
    }

    return chain([
      library(tree, design, locales, defaultLocale),
      ...apps.map((app) => application(app, design, locales, defaultLocale)),
      ...sites.map((site) => localizedSite(site, design, locales, defaultLocale)),
      (host: Tree) => {
        documentI18n(host, design, locales, defaultLocale, sites);
        houseRules(host, design, locales, sites);
      },
    ]);
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Deduplicates and checks the tags, preserving the order they were given in.
 *
 * Order is preserved rather than sorted because it is the order the language
 * picker renders, and "the languages we care most about first" is a real
 * editorial choice that alphabetical order would silently discard.
 */
function normalizeLocales(locales: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const raw of locales) {
    const tag = raw.trim();
    if (tag === '') {
      continue;
    }
    if (!isLocaleTag(tag)) {
      throw new SchematicsException(
        `"${tag}" is not a BCP-47 locale tag. Expected something like ` +
          `"en", "fr", "pt-BR" or "zh-Hant".`,
      );
    }
    if (seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    result.push(tag);
  }

  if (result.length === 0) {
    throw new SchematicsException('--i18n needs at least one locale.');
  }
  return result;
}

function resolveDefault(locales: readonly string[], requested: string | undefined): string {
  if (requested === undefined) {
    return locales[0]!;
  }
  const tag = requested.trim();
  if (!locales.includes(tag)) {
    throw new SchematicsException(
      `The default locale "${tag}" is not one of the locales being generated ` +
        `(${locales.join(', ')}). The source locale has to ship, because it is ` +
        `what every untranslated key falls back to.`,
    );
  }
  return tag;
}

/**
 * Which projects get wired, split by how they have to be.
 *
 * An app negotiates its locale at runtime and switches in place. A prerendered
 * site cannot: the prerender runs in Node, where there is no `navigator` and no
 * `localStorage`, and whatever it renders is the HTML every visitor and every
 * crawler is served. So a site is built once per language instead, each into
 * its own URL, and the two halves of this schematic are different because the
 * two situations are.
 */
function targets(tree: Tree, requested: string[] | undefined): { apps: string[]; sites: string[] } {
  const projects = readProjects(tree);

  const names = requested?.length
    ? requested.map((raw) => {
        const name = strings.dasherize(raw);
        const project = projects[name];
        if (!project) {
          throw new SchematicsException(`Project "${name}" is not in this workspace.`);
        }
        if (project.projectType !== 'application') {
          throw new SchematicsException(`Project "${name}" is a library, not an application.`);
        }
        return name;
      })
    : Object.entries(projects)
        .filter(([, project]) => project.projectType === 'application')
        .map(([name]) => name);

  const apps: string[] = [];
  const sites: string[] = [];
  for (const name of names) {
    (isPrerendered(projects[name]!) ? sites : apps).push(name);
  }
  return { apps, sites };
}

function requireRoot(projects: Record<string, AngularProject>, name: string): string {
  const root = projects[name]?.root;
  if (root === undefined) {
    throw new SchematicsException(`Project "${name}" has no root in angular.json.`);
  }
  return root;
}

/**
 * Leaves files that already exist alone.
 *
 * What this schematic writes is handed over the moment it is written — a
 * catalog somebody has translated, an endonym somebody corrected — and the
 * schematic runs again every time a project is generated into a translated
 * workspace. A re-run that rewrote those files would quietly undo that work.
 */
function onlyNew(tree: Tree): Rule {
  return filter((path) => !tree.exists(path));
}

// ── The library half: the mechanism ──────────────────────────────────────────

function library(
  tree: Tree,
  design: DesignSystem,
  locales: readonly string[],
  defaultLocale: string,
): Rule {
  assertSameLocales(tree, locales, defaultLocale, design);

  const templates = apply(url('./files/lib'), [
    applyTemplates({
      ...strings,
      prefix: design.prefix,
      defaultLocale,
      defaultLabel: localeInfo(defaultLocale).label,
      localeList: locales.map((tag) => `'${tag}'`).join(', '),
      directionEntries: mapEntries(locales, (tag) => `'${localeInfo(tag).direction}'`),
      labelEntries: mapEntries(locales, (tag) => labelLiteral(tag)),
    }),
    move(`/${design.root}`),
    onlyNew(tree),
  ]);

  return chain([
    mergeWith(templates, MergeStrategy.Overwrite),
    (host: Tree) => {
      // Mostly documentation — logical properties do the layout work — but it
      // has to be reachable from the entry point or the two rules it does
      // carry never ship.
      useLibraryStyles(host, design, 'direction');
      // Everything an app needs and nothing it does not: the service, the
      // pipe, the picker, the provider function and the loader token, plus the
      // locale tables a language picker of someone's own would need. The
      // internals — the placeholder regex, the plural cache — stay unexported.
      exportFromLibrary(host, design, './lib/i18n/translation', [
        "export { TranslationService, LOCALE_KEY } from './lib/i18n/translation';",
        "export { TranslatePipe } from './lib/i18n/translate-pipe';",
        "export { LanguagePicker } from './lib/i18n/language-picker';",
        "export { provideTranslations } from './lib/i18n/i18n-providers';",
        "export { TRANSLATION_LOADER } from './lib/i18n/translation.loader';",
        "export type { TranslationLoader } from './lib/i18n/translation.loader';",
        'export {',
        '  LOCALES,',
        '  LOCALE_DIRECTION,',
        '  LOCALE_LABELS,',
        '  DEFAULT_LOCALE,',
        '  directionOf,',
        '  isLocale,',
        '  matchLocale,',
        '  negotiateLocale,',
        "} from './lib/i18n/i18n.tokens';",
        'export type {',
        '  Direction,',
        '  Locale,',
        '  TranslationCatalog,',
        '  TranslationParams,',
        "} from './lib/i18n/i18n.tokens';",
      ]);
    },
  ]);
}

/**
 * Refuses a locale set that differs from the one the library already has.
 *
 * The library's locale tables are not rewritten once they exist, so a run asking
 * for other locales would generate catalogs the library does not know about.
 * Adding a locale is a hand edit the compiler then walks you through, and the
 * README's Translation section says how.
 */
function assertSameLocales(
  tree: Tree,
  locales: readonly string[],
  defaultLocale: string,
  design: DesignSystem,
): void {
  const installed = installedLocales(treeView(tree));
  if (!installed) {
    return;
  }
  const same =
    installed.defaultLocale === defaultLocale &&
    installed.locales.length === locales.length &&
    installed.locales.every((tag) => locales.includes(tag));
  if (!same) {
    throw new SchematicsException(
      `${design.name} already translates into ${installed.locales.join(', ')} ` +
        `(source: ${installed.defaultLocale}), and this schematic does not rewrite ` +
        `files it has handed over. To change the set, edit LOCALES and the two maps ` +
        `beside it in i18n.tokens.ts by hand — the compiler then points at every ` +
        `catalog and loader that needs the change. See the Translation section of ` +
        `the README.`,
    );
  }
}

/** `  en: 'ltr',` — one indented entry per locale, for an exhaustive map. */
function mapEntries(locales: readonly string[], value: (tag: string) => string): string {
  return locales.map((tag) => `  ${key(tag)}: ${value(tag)},`).join('\n');
}

/**
 * A locale tag as an object key: bare when it is a valid identifier, quoted
 * when it is not. `pt-BR` has a hyphen in it, and `{ pt-BR: 'ltr' }` is a
 * subtraction.
 */
function key(tag: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(tag) ? tag : `'${tag}'`;
}

/**
 * The endonym, or the tag itself with a note when the generator does not know
 * one.
 *
 * A wrong label is worse than an obviously missing one: a picker that offers
 * "pt-BR" is asking to be fixed, while one that offers "Portuguese" to a
 * Brazilian reader looks finished and is not.
 */
function labelLiteral(tag: string): string {
  const info = localeInfo(tag);
  return info.known
    ? `'${info.label}'`
    : `'${info.label}', // TODO: replace with the endonym — the language's name in that language`;
}

// ── The application half: the messages ───────────────────────────────────────

function application(
  name: string,
  design: DesignSystem,
  locales: readonly string[],
  defaultLocale: string,
): Rule {
  return (tree: Tree) => {
    const root = requireRoot(readProjects(tree), name);
    const prefix = prefixOf(tree, name);
    const starterPage = tree.exists(`/${root}/src/app/pages/home.page.html`);

    return chain([
      messages(tree, name, root, design, locales, defaultLocale, false),
      starterPage ? showcase(tree, root, prefix, design) : noop(),
      e2eSuite(tree, root, './files/app-e2e', locales, defaultLocale, name),
      (host: Tree) => {
        addRootProvider(host, name, {
          symbol: 'provideTranslations',
          expression: 'provideTranslations(loadCatalog)',
          imports: [
            `import { provideTranslations } from '${design.name}';`,
            "import { loadCatalog } from './i18n/catalog.loader';",
          ],
        });
        addBootScript(host, name, noFoucScript(locales, defaultLocale, design.prefix));
        addHeaderControl(host, name, {
          symbol: 'LanguagePicker',
          from: design.name,
          markup: `<${design.prefix}-language-picker />`,
        });
        addStarterSection(host, name, {
          symbol: 'I18nShowcase',
          from: './i18n/i18n-showcase',
          markup: `<${prefix}-i18n-showcase />`,
        });
        addShellTestProvider(host, name, loaderForShellSpec(design));
      },
    ]);
  };
}

/**
 * The catalogs, the typed message map and the loader — the part an app and a
 * site have in common. Written only where missing: a catalog that exists has
 * been, or is being, translated.
 */
function messages(
  tree: Tree,
  name: string,
  root: string,
  design: DesignSystem,
  locales: readonly string[],
  defaultLocale: string,
  isSite: boolean,
): Rule {
  const defaultConstName = constName(defaultLocale);
  const shared = {
    ...strings,
    importName: design.name,
    title: titleFromName(name),
    defaultLocale,
    defaultConstName,
    defaultLabel: localeInfo(defaultLocale).label,
    isSite,
    loaderCases: locales
      .map(
        (tag) => `    case '${tag}':\n      return (await import('./${tag}')).${constName(tag)};`,
      )
      .join('\n'),
  };

  // One pass per locale: the catalogs differ in content, not just in name — the
  // source one carries the real strings and the documentation, the others carry
  // placeholders and the type annotation that keeps them in step. A single
  // templating pass cannot produce both.
  const catalogs = locales.map((tag) =>
    mergeWith(
      apply(url('./files/app'), [
        filter((path) => path.endsWith('__locale__.ts.template')),
        applyTemplates({
          ...shared,
          locale: tag,
          constName: constName(tag),
          localeLabel: localeInfo(tag).label,
          isDefault: tag === defaultLocale,
          // Tags every placeholder value in a catalog nobody has translated
          // yet, so an untranslated string is impossible to miss on screen —
          // the same reason a missing key renders as the key. Empty for the
          // source catalog, whose values are the real ones.
          mark: tag === defaultLocale ? '' : `[${tag}] `,
        }),
        move(`/${root}`),
        onlyNew(tree),
      ]),
      MergeStrategy.Overwrite,
    ),
  );

  const support = mergeWith(
    apply(url('./files/app'), [
      filter((path) => !path.endsWith('__locale__.ts.template')),
      applyTemplates(shared),
      move(`/${root}`),
      onlyNew(tree),
    ]),
    MergeStrategy.Overwrite,
  );

  return chain([...catalogs, support]);
}

/**
 * The Playwright suite, where the project has one.
 *
 * Only where it has one: `--e2e` is optional, and a spec file in a project with
 * no Playwright config is a file nothing runs. Detected by the config the app
 * and marketing schematics write, rather than by an option, because this
 * schematic can be run long after them.
 *
 * What these suites cover is the part the unit tests cannot reach — for an app,
 * the inline script that sets `lang` and `dir` before Angular boots, and the
 * lazy catalog chunks that only exist once a bundler has split them.
 */
function e2eSuite(
  tree: Tree,
  root: string,
  from: string,
  locales: readonly string[],
  defaultLocale: string,
  name: string,
): Rule {
  if (!tree.exists(`/${root}/playwright.config.ts`)) {
    return noop();
  }

  return mergeWith(
    apply(url(from), [
      applyTemplates({
        ...strings,
        name,
        defaultLocale,
        localeList: locales.map((tag) => `'${tag}'`).join(', '),
      }),
      move(`/${root}`),
      onlyNew(tree),
    ]),
    MergeStrategy.Overwrite,
  );
}

/** The starter screen's translation section, which an app and a site both carry. */
function showcase(tree: Tree, root: string, prefix: string, design: DesignSystem): Rule {
  return mergeWith(
    apply(url('./files/showcase'), [
      applyTemplates({ ...strings, importName: design.name, prefix }),
      move(`/${root}`),
      onlyNew(tree),
    ]),
    MergeStrategy.Overwrite,
  );
}

/**
 * A project's component selector prefix.
 *
 * From `angular.json` rather than from the project name: the app schematic lets
 * one be chosen, and a showcase whose selector guessed would not match the page
 * it is inserted into.
 */
function prefixOf(tree: Tree, name: string): string {
  return readProjects(tree)[name]?.prefix ?? 'app';
}

/** `pt-BR` → `ptBR`, so the catalog's exported const is a valid identifier. */
function constName(tag: string): string {
  return strings.camelize(tag.replace(/-/g, '_'));
}

/**
 * The no-FOUC script: `lang` and `dir` before Angular boots.
 *
 * It exists because `dir` is a layout property. `TranslationService` sets it in
 * an effect, which runs after bootstrap — so an Arabic reader would get one
 * frame of a left-to-right page before it flipped. A theme can afford that; a
 * mirrored layout cannot.
 *
 * It duplicates `initialLocale()` deliberately, and the comment in both places
 * says so. The alternative is shipping the negotiation in a module the document
 * head can load, which costs a request on every cold start to save eight lines
 * that change about once a year.
 *
 * `<html lang dir>` carry the default locale's values too, for a visitor with
 * scripting off; the script replaces them.
 */
function noFoucScript(locales: readonly string[], defaultLocale: string, prefix: string) {
  const directions = locales.map((tag) => `${key(tag)}: '${localeInfo(tag).direction}'`).join(', ');
  return {
    id: 'i18n:no-fouc',
    attributes: { lang: defaultLocale, dir: localeInfo(defaultLocale).direction },
    html: `  <!-- i18n:no-fouc — set lang/dir before first paint. Mirrors
       TranslationService.initialLocale(): a stored choice wins, else the
       browser's languages, else the default. Change one, change the other. -->
  <script>
    (function () {
      var dirs = { ${directions} };
      // Case-insensitive, returning the canonical spelling: a browser may send
      // pt-BR and a stored value may be pt-br, but \`dirs\` is keyed the way
      // LOCALES spells it. Mirrors matchLocale().
      function supported(tag) {
        if (!tag) return null;
        var lower = String(tag).toLowerCase();
        var base = lower.split('-')[0];
        var exact = null;
        var prefix = null;
        for (var key in dirs) {
          var k = key.toLowerCase();
          if (k === lower) exact = key;
          else if (k === base && !prefix) prefix = key;
        }
        return exact || prefix;
      }
      var locale = null;
      try {
        locale = supported(localStorage.getItem('${prefix}.locale'));
      } catch (e) {
        /* private mode, blocked storage */
      }
      if (!locale) {
        var preferred = navigator.languages || [navigator.language];
        for (var i = 0; i < preferred.length && !locale; i++) {
          locale = supported(preferred[i]);
        }
      }
      locale = locale || '${defaultLocale}';
      document.documentElement.setAttribute('lang', locale);
      document.documentElement.setAttribute('dir', dirs[locale]);
    })();
  </script>
`,
  };
}

/**
 * The provider the shell's spec needs once a language control is in its
 * header: that control translates its own label. An empty catalog is enough to
 * render it. Shared by an app, whose header gets a picker, and a site, whose
 * header gets links.
 */
function loaderForShellSpec(design: DesignSystem) {
  return {
    symbol: 'TRANSLATION_LOADER',
    expression:
      '// The header carries a language control, which translates its\n' +
      '// own label. An empty catalog is enough to render it.\n' +
      '{ provide: TRANSLATION_LOADER, useValue: () => ({}) }',
    imports: [`import { TRANSLATION_LOADER } from '${design.name}';`],
  };
}

// ── The site half: one build per language ────────────────────────────────────

/**
 * A prerendered site, translated the only way a prerendered site can be:
 * built once per language, each into its own directory and its own URL.
 *
 * The runtime machinery is the same — the same catalogs, the same `| t` pipe —
 * but the locale is chosen by the build rather than negotiated, through a
 * `define` on one configuration per language. That is what makes the static
 * HTML come out already translated, which is the entire point: a crawler is
 * served `/fr/about` in French, with its own canonical and its own hreflang
 * alternates, instead of a copy of the source language that swaps its text
 * after hydration.
 */
function localizedSite(
  name: string,
  design: DesignSystem,
  locales: readonly string[],
  defaultLocale: string,
): Rule {
  return (tree: Tree) => {
    const root = requireRoot(readProjects(tree), name);
    const prefix = prefixOf(tree, name);

    // The first time, these replace pages the marketing schematic wrote in the
    // source language. After that they are the site's own, and a re-run — which
    // every `ng generate` into a translated workspace is — leaves them be.
    const localized = tree.exists(`/${root}/src/app/i18n/build-locale.ts`);
    const siteFiles = mergeWith(
      apply(url('./files/site'), [
        applyTemplates({
          ...strings,
          name,
          prefix,
          importName: design.name,
          libPrefix: design.prefix,
        }),
        move(`/${root}`),
        localized ? onlyNew(tree) : noop(),
      ]),
      MergeStrategy.Overwrite,
    );

    return chain([
      messages(tree, name, root, design, locales, defaultLocale, true),
      showcase(tree, root, prefix, design),
      siteFiles,
      e2eSuite(tree, root, './files/site-e2e', locales, defaultLocale, name),
      localizedPostbuild(tree),
      (host: Tree) => {
        addRootProvider(host, name, {
          symbol: 'provideTranslations',
          expression:
            '// Pinned, not negotiated: this build IS one language, and the prerendered\n' +
            '    // HTML is already in it. Negotiating would swap the text under a visitor\n' +
            '    // whose browser prefers another — and the other language has its own URL.\n' +
            '    provideTranslations(loadCatalog, { locale: SITE_LOCALE })',
          imports: [
            `import { provideTranslations } from '${design.name}';`,
            "import { loadCatalog } from './i18n/catalog.loader';",
            "import { SITE_LOCALE } from './i18n/build-locale';",
          ],
        });
        // What the site says about each page in its head — the translated
        // title and description, the language in the canonical, the hreflang
        // alternates — through the strategy's own extension point rather than
        // by rewriting it. The strategy, `siteUrl` and their specs are the
        // same files they are on a site in one language.
        addPageMetaExtension(host, name, {
          symbol: 'LocalizedPageMeta',
          from: './i18n/localized-page-meta',
          comment: [
            "Translates each page's title and description, puts this build's",
            'language in its canonical, and writes its hreflang alternates.',
          ],
        });
        addHeaderControl(host, name, {
          symbol: 'LocaleLinks',
          from: './i18n/locale-links',
          markup: `<${prefix}-locale-links />`,
        });
        addShellTestProvider(host, name, loaderForShellSpec(design));
        addLocaleConfigurations(host, name, locales);
        localizeSiteScripts(host, name, locales);
      },
    ]);
  };
}

/**
 * Replaces the postbuild scripts with locale-aware versions.
 *
 * The first time, overwritten rather than merged, unlike the marketing
 * schematic's own copy which leaves an existing file alone: these are the same
 * scripts with the locale dimension added, and a site built once per language
 * against the single-output versions would report every page as missing. They
 * still handle a site with no locales, so a workspace with one localized site
 * and one without is not a broken combination.
 *
 * Once `clean-dist.mjs` is there the locale-aware set is too, and from then on
 * a copy someone has tuned is theirs.
 */
function localizedPostbuild(tree: Tree): Rule {
  const installed = tree.exists('/scripts/clean-dist.mjs');
  return mergeWith(
    apply(url('./files/scripts'), [
      applyTemplates({}),
      move('/scripts'),
      installed ? onlyNew(tree) : noop(),
    ]),
    MergeStrategy.Overwrite,
  );
}

/**
 * One build configuration per language, and the `define` that makes each one
 * that language.
 *
 * `define` is a compile-time substitution: every occurrence of the identifier
 * `BUILD_LOCALE` in the bundle becomes the string literal, so `build-locale.ts`
 * resolves to a constant and the prerender — which runs that bundle in Node —
 * renders in it. An environment variable could not do this: the prerender reads
 * it at build time, but the browser bundle would have nothing to read.
 *
 * `outputPath` puts each language in a directory named after it, beside the
 * others, so `dist/<site>` is the web root and `/fr/about` is a real path. The
 * `baseHref` has to agree, or every asset on a French page is requested from
 * the root and 404s.
 */
function addLocaleConfigurations(tree: Tree, name: string, locales: readonly string[]): void {
  updateJson(tree, ANGULAR_JSON, (file) => {
    const base = ['projects', name, 'architect', 'build'];
    const production = file.get<Record<string, unknown>>([...base, 'configurations', 'production']);

    for (const locale of locales) {
      const path = [...base, 'configurations', localeConfiguration(locale)];
      if (file.get(path) !== undefined) {
        continue;
      }
      file.modify(path, {
        // Extends production by repeating it: `ng build` takes one
        // configuration name, and the alternative — `--configuration
        // production,locale-fr` — is a second thing to get right in every
        // script that builds the site.
        ...(production ?? {}),
        baseHref: `/${locale}/`,
        outputPath: { base: `dist/${name}`, browser: locale },
        define: { BUILD_LOCALE: JSON.stringify(locale) },
        // Angular deletes `outputPath.base`, not the browser directory under
        // it — so the second language's build would take the first one's output
        // with it and only the last would survive. `clean-dist.mjs` runs once
        // before them all instead.
        deleteOutputPath: false,
      });
    }
  });
}

/** `fr` → `locale-fr`. The configuration name, which the build script repeats. */
function localeConfiguration(locale: string): string {
  return `locale-${locale.toLowerCase()}`;
}

/**
 * A site's `build` becomes one `ng build` per language.
 *
 * Sequential rather than parallel: they write into one output tree, and the
 * postbuild step that follows reads all of it. The postbuild scripts are told
 * which languages to expect, so a build whose second language failed to produce
 * a directory fails the check rather than quietly shipping one language.
 */
function localizeSiteScripts(tree: Tree, name: string, locales: readonly string[]): void {
  const list = locales.join(',');
  replaceSiteBuild(tree, name, (scripts) => {
    const script = (file: string) => `node ${scripts.rootPath(`scripts/${file}`)} ${name}`;
    return {
      build: [
        // Once, before the first language: the locale configurations turn
        // Angular's own output cleaning off, because it would delete the shared
        // base each of them writes into.
        script('clean-dist.mjs'),
        ...locales.map(
          (locale) => `ng build ${name} --configuration ${localeConfiguration(locale)}`,
        ),
      ].join(' && '),
      postbuild:
        `${script('generate-sitemap.mjs')} --locales ${list} && ` +
        `${script('verify-prerender.mjs')} --locales ${list}`,
    };
  });

  documentProjectScripts(tree, projectScripts(tree, name), {
    build:
      `prerenders \`${name}\` once per language into \`dist/${name}/<locale>\`, writes one ` +
      `sitemap with hreflang alternates, and fails on any page a crawler could not use`,
  });
}

// ── Documentation ────────────────────────────────────────────────────────────

function documentI18n(
  tree: Tree,
  design: DesignSystem,
  locales: readonly string[],
  defaultLocale: string,
  sites: readonly string[],
): void {
  const others = locales.filter((tag) => tag !== defaultLocale);
  const rtl = locales.filter((tag) => localeInfo(tag).direction === 'rtl');

  const body = `The apps translate at runtime: every locale is in one build and switches
without a reload. That is deliberate, and it is a Capacitor constraint —
\`@angular/localize\` emits one bundle per locale, and a mobile \`webDir\` has room
for exactly one \`index.html\`, so compile-time i18n would mean one binary per
language.

**The mechanism lives in \`${design.name}\`, the messages live in each app.** The
design system ships \`TranslationService\`, the \`| t\` pipe and
\`<${design.prefix}-language-picker>\`; it ships no strings of its own. Components take
their copy as inputs. That is what lets one design system serve every locale its
consumers ship without an extraction step — keep it that way.

\`\`\`html
{{ 'home.heading' | t }}
{{ 'home.greeting' | t: { name: person() } }}
{{ 'home.items' | t: { count: items().length } }}
\`\`\`

Add a string: put it in \`src/app/i18n/${defaultLocale}.ts\`${
    others.length > 0
      ? `, then in ${others.map((tag) => `\`${tag}.ts\``).join(' and ')} — the
compiler will not let you forget, because a translated catalog is typed
\`Record<keyof typeof ${constName(defaultLocale)}, string>\``
      : ''
  }.

Add a locale: one entry in \`LOCALES\` and one line in each of the two maps beside
it, in \`${design.name}\`. Both maps are exhaustive \`Record<Locale, …>\`, so the
compiler then points at the loader, the picker and every catalog that is now
missing.

Plurals come from \`Intl.PluralRules\`, not from a \`count === 1\` test. Write
\`key.one\` and \`key.other\` and pass \`{ count }\`; a locale that needs \`zero\`,
\`two\`, \`few\` or \`many\` gets them by adding those keys to its own catalog.

Numbers and dates go through \`TranslationService.formatNumber\` / \`formatDate\`,
not through Angular's \`DecimalPipe\` or \`DatePipe\`: those read the build-time
\`LOCALE_ID\`, which cannot follow a runtime switch.
${
  rtl.length > 0
    ? `
**${rtl.map((tag) => localeInfo(tag).label).join(' and ')} ${rtl.length > 1 ? 'are' : 'is'} right-to-left**, so the layout mirrors. Write
CSS logical properties only — \`margin-inline-start\`, \`inset-inline-end\`,
\`text-align: start\` — and never \`left\` or \`right\`. The browser does the rest from
\`<html dir>\`. The two things logical properties cannot do, mirroring a
direction-encoding icon and pinning a URL or a phone number against the bidi
algorithm, have a class each in \`styles/_direction.scss\`.
`
    : ''
}
${
  sites.length > 0
    ? `**${sites.map((site) => `\`${site}\``).join(' and ')} ${sites.length > 1 ? 'are' : 'is'} prerendered, so ${sites.length > 1 ? 'they are' : 'it is'} translated differently** — built
once per language into \`dist/<site>/<locale>\`, one \`ng build\` per
\`locale-*\` configuration. \`${projectScripts(tree, sites[0]!).command('build')}\` runs all of them.

A prerender happens in Node, where there is no \`navigator\` and no
\`localStorage\`, and what it writes is what every visitor and every crawler is
served. So the language is the build's, pinned through
\`provideTranslations(loadCatalog, { locale: SITE_LOCALE })\`, and it lives in the
URL: \`/en/about\` and \`/fr/about\` are separate documents with their own
canonical, their own \`<html lang>\` and hreflang alternates naming each other.
The header's language links are real \`<a href>\`s for that reason — a crawler
follows them, and a visitor can share the page in the language they read it in.

One sitemap covers every language, with \`xhtml:link\` alternates per URL.
\`verify-prerender.mjs\` fails the build if a language rendered in the wrong one,
skipped a route the others have, or left out an hreflang.

\`${projectScripts(tree, sites[0]!).command('start')}\` serves the source locale: \`ng serve\` applies no
\`define\`, and \`build-locale.ts\` falls back to \`DEFAULT_LOCALE\`.

**Deploy \`dist/${sites[0]}\` as the web root, and redirect \`/\` yourself.** Every page
lives under a language, so the build puts nothing at \`/\` — the bare domain is a
404 until the host sends it somewhere. That cannot be a file, because the right
destination depends on the visitor: it is a 302 on \`Accept-Language\`, falling
back to \`/${defaultLocale}/\`, which is what the pages' \`x-default\` already
advertises. \`verify-prerender.mjs\` warns on every build until you have one.

- Cloudflare, Netlify, Vercel — a redirect rule on \`/\` with language matching
- S3 + CloudFront — a CloudFront Function on viewer-request
- nginx — \`map $http_accept_language\` and a \`location = /\` redirect

On a host that cannot redirect at all, put an \`index.html\` at \`dist/${sites[0]}/\`
that redirects in the page. It costs a round trip and search engines treat it as
a weaker signal than a 302, but it beats a 404.`
    : `A prerendered marketing site would be translated differently — built once per
language, so each has its own crawlable URL — but this workspace has none.`
}`;

  appendSection(tree, README_MD, 'Translation', body);
}

/**
 * The rules translation adds to AGENTS.md.
 *
 * Shorter than the README section and differently aimed: the README explains
 * why the design is what it is, and this is the list of things that silently
 * break it. Every entry here is a mistake that compiles.
 */
function houseRules(
  tree: Tree,
  design: DesignSystem,
  locales: readonly string[],
  sites: readonly string[],
): void {
  const rtl = locales.filter((tag) => localeInfo(tag).direction === 'rtl');

  const rules = [
    `- **\`${design.name}\` ships no user-visible strings.** Components take their copy` +
      `\n  as inputs. A string baked into a design-system component is a string every` +
      `\n  consumer of that component is stuck with, in one language.`,
    `- **Add a string to \`src/app/i18n/\` first, then use it.** Keys are` +
      `\n  dot-namespaced by feature (\`cart.checkout\`), never by their English wording,` +
      `\n  so rephrasing a string is not a rename.`,
    `- **Never \`DatePipe\`, \`DecimalPipe\`, \`CurrencyPipe\` or \`PercentPipe\`.** They` +
      `\n  read the build-time \`LOCALE_ID\`, which cannot follow a runtime switch, so they` +
      `\n  keep formatting in the locale the bundle was built in. Use` +
      `\n  \`TranslationService.formatNumber\` / \`formatDate\` / \`formatRelativeTime\`.`,
    `- **Plurals are \`key.one\` / \`key.other\` plus \`{ count }\`**, never a` +
      `\n  \`count === 1\` ternary. The category comes from \`Intl.PluralRules\` for the` +
      `\n  active locale.`,
    `- **A value tagged \`[fr]\` has not been translated.** The generated catalogs` +
      `\n  start as tagged copies of the source so the app runs; drop the tag as you` +
      `\n  translate. Anything still carrying one on screen is a string nobody has` +
      `\n  looked at.`,
  ];

  if (sites.length > 0) {
    rules.push(
      `- **A prerendered site's language is the build's, not the visitor's.** It is` +
        `\n  built once per language and pinned with` +
        `\n  \`provideTranslations(loadCatalog, { locale: SITE_LOCALE })\`. Never call` +
        `\n  \`setLocale\` there, and never link between languages with \`routerLink\` —` +
        `\n  they are separate documents, so they need a real \`href\`.`,
      `- **A new route on a site is a new route in every language.** They are` +
        `\n  prerendered from the same \`app.routes.ts\`, and \`verify-prerender.mjs\`` +
        `\n  fails the build if one language rendered a route another did not.`,
    );
  }

  if (rtl.length > 0) {
    rules.push(
      `- **Never \`left\` or \`right\` in CSS. Only \`start\` and \`end\`.** ` +
        `${rtl.map((tag) => localeInfo(tag).label).join(' and ')} ${rtl.length > 1 ? 'are' : 'is'}` +
        `\n  right-to-left, and the layout mirrors from \`<html dir>\` alone — but only for` +
        `\n  properties that have a logical form: \`margin-inline-start\`,` +
        `\n  \`inset-inline-end\`, \`text-align: start\`, \`border-start-start-radius\`. The` +
        `\n  exception is \`env(safe-area-inset-*)\`, which is physical by definition — a` +
        `\n  notch is on the device's left whichever way the text runs.`,
      `- **An icon that encodes direction needs \`.flip-inline\`.** A logical property` +
        `\n  moves a box; it cannot redraw a chevron. Tag only the icons that carry` +
        `\n  direction — search, close, play and every brand mark must NOT flip.`,
      `- **Wrap a URL, path, phone number or version in \`.ltr\`.** The bidi algorithm` +
        `\n  reorders neutral characters to match the paragraph, which mangles anything` +
        `\n  whose order is structural. Put the class on an inline element, not its block.`,
    );
  }

  appendSection(
    tree,
    '/AGENTS.md',
    'Translation',
    `\nThe apps translate at runtime. Every locale is in one build; the active one is\n` +
      `a signal, and \`<html lang>\` and \`<html dir>\` follow it.\n\n` +
      rules.join('\n') +
      `\n`,
  );
}
