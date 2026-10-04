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
  schematic,
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import { isLocaleTag, localeInfo } from '../../locales';
import { addFrameworkImport, appendProvider } from '../../utils/ts-edit';
import { updateJson } from '../../utils/json-file';
import {
  ANGULAR_JSON,
  appendSection,
  documentScripts,
  findDesignSystem,
  PACKAGE_JSON,
  readProjects,
  README_MD,
  titleFromName,
  type AngularProject,
  type DesignSystem,
} from '../../utils/workspace';

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
 */
export function i18n(options: I18nOptions = {}): Rule {
  return (tree: Tree) => {
    const locales = normalizeLocales(options.locales ?? ['en']);
    const defaultLocale = resolveDefault(locales, options.defaultLocale);

    const design = findDesignSystem(tree);
    if (!design) {
      throw new SchematicsException(
        'The i18n schematic wires the translation machinery into the ' +
          'design-system library, and this workspace has none. Generate one ' +
          'first (`ng generate angular-capacitor-workspace:ui-lib`), or pass ' +
          '--ui-lib when creating the workspace.',
      );
    }

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

/**
 * Wires an app generated later into the translation the workspace already has.
 *
 * The counterpart to `installedPackages`, and for the same reason: a workspace
 * is generated once and grown for years, so `ng generate app` — or
 * `ng generate marketing` — has to produce a project that matches the ones
 * beside it rather than one missing a layer everything else has.
 *
 * The locales are read back out of the design system's `i18n.tokens.ts` rather
 * than passed in, because that file says it is the only place a locale name
 * lives and this is the code that has to believe it. A workspace with no
 * translation returns a no-op, so the app schematic can call this
 * unconditionally.
 */
export function installedI18n(name: string): Rule {
  return (tree: Tree) => {
    const design = findDesignSystem(tree);
    if (!design) {
      return;
    }

    const installed = readInstalledLocales(tree, design);
    if (!installed) {
      return;
    }

    // Through `schematic()` rather than by calling the rules directly, and this
    // is not a style choice: `url()` resolves against the schematic that is
    // EXECUTING, not the one whose module the call is written in. Called
    // straight from the app schematic's chain, every `url('./files/…')` in here
    // would resolve under `schematics/app/` instead, find nothing, and wire the
    // project up with no files in it — silently, because an empty source tree
    // is not an error.
    //
    // Naming the project re-runs the library half too. That half writes only
    // files that are not there yet, so the library's own — edited or not — are
    // left as they are, and the alternative is a second entry point that exists
    // only to skip it.
    return schematic('i18n', {
      locales: installed.locales,
      defaultLocale: installed.defaultLocale,
      apps: [name],
    });
  };
}

/** Parses `LOCALES` and `DEFAULT_LOCALE` back out of the generated tokens file. */
function readInstalledLocales(
  tree: Tree,
  design: DesignSystem,
): { locales: string[]; defaultLocale: string } | undefined {
  const root = readProjects(tree)[design.name]?.root;
  if (root === undefined) {
    return undefined;
  }

  const source = tree.read(`/${root}/src/lib/i18n/i18n.tokens.ts`)?.toString('utf8');
  if (source === undefined) {
    return undefined;
  }

  const list = source.match(/export const LOCALES = \[([^\]]*)\] as const;/)?.[1];
  const fallback = source.match(/export const DEFAULT_LOCALE: Locale = '([^']+)';/)?.[1];
  if (list === undefined || fallback === undefined) {
    return undefined;
  }

  const locales = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  return locales.length > 0 ? { locales, defaultLocale: fallback } : undefined;
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
 * A prerendered site, recognised by the build option that makes it one.
 *
 * Which is the whole reason a site is wired differently from an app. A
 * crawler wants `/en/` and `/fr/` — separate documents with their own canonical
 * URLs and hreflang alternates — not one document that rewrites itself after a
 * script runs. So a site is built once per language, and the language lives in
 * the URL rather than in a signal.
 */
function isPrerendered(project: AngularProject): boolean {
  return project.architect?.['build']?.options?.['outputMode'] === 'static';
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
  const root = requireRoot(readProjects(tree), design.name);
  assertSameLocales(tree, design, locales, defaultLocale);

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
    move(`/${root}`),
    onlyNew(tree),
  ]);

  return chain([
    mergeWith(templates, MergeStrategy.Overwrite),
    (host: Tree) => {
      useDirectionStyles(host, root);
      exportFromPublicApi(host, root);
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
  design: DesignSystem,
  locales: readonly string[],
  defaultLocale: string,
): void {
  const installed = readInstalledLocales(tree, design);
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

/**
 * Adds `@use 'direction';` to the design system's stylesheet entry point.
 *
 * After the other partials, so it lands in the same group. The file it adds is
 * mostly documentation — logical properties do the layout work — but it has to
 * be reachable from the entry point or the two rules it does carry never ship.
 */
function useDirectionStyles(tree: Tree, root: string): void {
  const path = `/${root}/src/styles/index.scss`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected the design system to have ${path}, which is the file that ` +
        `identifies it as one.`,
    );
  }
  if (source.includes("@use 'direction'")) {
    return;
  }

  const lines = source.split('\n');
  const last = lines.reduce((found, text, index) => (/^@use '/.test(text) ? index : found), -1);
  lines.splice(last + 1, 0, "@use 'direction';");
  tree.overwrite(path, lines.join('\n'));
}

/**
 * Re-exports the i18n surface from the library's public API.
 *
 * Everything an app needs and nothing it does not: the service, the pipe, the
 * picker, the provider function and the loader token, plus the locale tables a
 * language picker of someone's own would need. The internals — the placeholder
 * regex, the plural cache — stay unexported.
 */
function exportFromPublicApi(tree: Tree, root: string): void {
  const path = `/${root}/src/public-api.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected the design system to have ${path}, which is what \`ng-packagr\` ` +
        `builds its entry point from.`,
    );
  }
  if (source.includes('./lib/i18n/translation')) {
    return;
  }

  const block = [
    '',
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
    '',
  ].join('\n');

  tree.overwrite(path, `${source.replace(/\n*$/, '\n')}${block}`);
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

    return chain([
      messages(tree, name, root, design, locales, defaultLocale, false),
      showcase(tree, root, prefix, design),
      e2eSuite(tree, root, './files/app-e2e', locales, defaultLocale, name),
      (host: Tree) => {
        registerTranslations(host, name, root, design.name);
        addNoFoucScript(host, root, locales, defaultLocale, design.prefix);
        addToStarterShell(host, root, prefix, design);
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
 * Adds `provideTranslations(loadCatalog)` to the application's root providers.
 *
 * Keyed off the symbol, so an app someone has already wired by hand is left
 * exactly as it is.
 */
function registerTranslations(tree: Tree, name: string, root: string, library: string): void {
  const path = `/${root}/src/app/app.config.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected application "${name}" to have ${path}, which the Angular ` +
        `application schematic writes for a standalone app.`,
    );
  }
  if (source.includes('provideTranslations')) {
    return;
  }

  // The relative import first: both land directly after the last `@angular/*`
  // line, so the one inserted second ends up above the one inserted first.
  let next = addFrameworkImport(source, "import { loadCatalog } from './i18n/catalog.loader';");
  next = addFrameworkImport(next, `import { provideTranslations } from '${library}';`);
  next = appendProvider(next, path, 'provideTranslations(loadCatalog)');
  tree.overwrite(path, next);
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
 */
/**
 * Puts the language picker in the app's header and the showcase on its starter
 * screen.
 *
 * Both are insertions into files the app schematic wrote, not replacements of
 * them: the starter screen demonstrates the theme as well, and a translation
 * schematic that shipped its own copy of that page would be a second copy to
 * keep in step. A workspace generated without a design system has no starter
 * shell — and no i18n either, since the mechanism lives in the library — so the
 * files are simply absent and this does nothing.
 */
function addToStarterShell(tree: Tree, root: string, prefix: string, design: DesignSystem): void {
  addComponent(tree, `/${root}/src/app/app.ts`, `/${root}/src/app/app.html`, {
    symbol: 'LanguagePicker',
    from: design.name,
    // Beside the theme toggle, which is the other control that restyles the
    // whole page from the header.
    anchor: `<${design.prefix}-theme-toggle />`,
    markup: `<${design.prefix}-language-picker />`,
  });

  addComponent(
    tree,
    `/${root}/src/app/pages/home.page.ts`,
    `/${root}/src/app/pages/home.page.html`,
    {
      symbol: 'I18nShowcase',
      from: '../i18n/i18n-showcase',
      markup: `<${prefix}-i18n-showcase />`,
    },
  );

  // The shell's own spec builds a TestBed with just a router, and the shell now
  // reaches TranslationService through the picker in its header.
  provideLoaderToShellSpec(tree, root, design.name);
}

/**
 * Gives a shell's `app.spec.ts` the translation loader its subject now needs.
 *
 * Shared by an app and a prerendered site: both put a language control in the
 * header — a picker in one, links in the other — and both specs open with the
 * same `providers: [provideRouter([])]`.
 */
function provideLoaderToShellSpec(tree: Tree, root: string, library: string): void {
  provideLoader(tree, `/${root}/src/app/app.spec.ts`, library, [
    {
      find: '      providers: [provideRouter([])],',
      replace:
        '      providers: [\n' +
        '        provideRouter([]),\n' +
        '        // The header carries a language control, which translates its\n' +
        '        // own label. An empty catalog is enough to render it.\n' +
        '        { provide: TRANSLATION_LOADER, useValue: () => ({}) },\n' +
        '      ],',
    },
  ]);
}

interface ComponentInsertion {
  /** The exported class to import and add to the component's `imports`. */
  readonly symbol: string;
  /** Module specifier for it. */
  readonly from: string;
  /** Markup to add to the template. */
  readonly markup: string;
  /** Put the markup straight after this line; appended at the end without one. */
  readonly anchor?: string;
}

/**
 * Adds one standalone component to another's imports and template.
 *
 * Idempotent on the symbol, so a re-run — or an `ng generate app` in a
 * workspace that already has i18n — leaves a file that already has it alone.
 * Silent when either file is missing: not every app has a starter shell.
 */
function addComponent(
  tree: Tree,
  componentPath: string,
  templatePath: string,
  insertion: ComponentInsertion,
): void {
  const component = tree.read(componentPath)?.toString('utf8');
  const template = tree.read(templatePath)?.toString('utf8');
  if (component === undefined || template === undefined) {
    return;
  }
  if (component.includes(insertion.symbol)) {
    return;
  }

  tree.overwrite(
    componentPath,
    addToImportsArray(
      addFrameworkImport(component, `import { ${insertion.symbol} } from '${insertion.from}';`),
      componentPath,
      insertion.symbol,
    ),
  );

  const at = insertion.anchor ? template.indexOf(insertion.anchor) : -1;
  if (at === -1) {
    tree.overwrite(templatePath, `${template.replace(/\n*$/, '\n')}\n${insertion.markup}\n`);
    return;
  }

  // Matched on the line, so the inserted element inherits its indentation
  // rather than landing at column zero inside a header.
  const lineStart = template.lastIndexOf('\n', at) + 1;
  const indent = template.slice(lineStart, at);
  const lineEnd = at + insertion.anchor!.length;
  tree.overwrite(
    templatePath,
    `${template.slice(0, lineEnd)}\n${indent}${insertion.markup}${template.slice(lineEnd)}`,
  );
}

/**
 * Adds a symbol to a standalone component's `imports: [...]`.
 *
 * A component with no `imports` at all gets one, after its `selector`, which
 * every component this collection generates has.
 */
function addToImportsArray(source: string, path: string, symbol: string): string {
  const match = source.match(/imports:\s*\[([^\]]*)\]/);
  if (match) {
    const existing = match[1]!.trim().replace(/,$/, '');
    const names = existing === '' ? [] : existing.split(',').map((part) => part.trim());
    if (names.includes(symbol)) {
      return source;
    }
    return source.replace(match[0], `imports: [${[...names, symbol].join(', ')}]`);
  }

  const selector = source.match(/(\n\s*)selector:\s*'[^']*',/);
  if (!selector) {
    throw new SchematicsException(
      `Could not find \`imports\` or \`selector\` in ${path}, which is where ` +
        `\`${symbol}\` has to be declared.`,
    );
  }
  return source.replace(selector[0], `${selector[0]}${selector[1]}imports: [${symbol}],`);
}

function addNoFoucScript(
  tree: Tree,
  root: string,
  locales: readonly string[],
  defaultLocale: string,
  prefix: string,
): void {
  const path = `/${root}/src/index.html`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(`Expected ${path} to exist.`);
  }
  if (source.includes('i18n:no-fouc')) {
    return;
  }

  const directions = locales.map((tag) => `${key(tag)}: '${localeInfo(tag).direction}'`).join(', ');
  const script = `  <!-- i18n:no-fouc — set lang/dir before first paint. Mirrors
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
`;

  // Into <head>, before </head>: the attributes have to be on <html> before the
  // first stylesheet resolves a logical property against them.
  const anchor = '</head>';
  const at = source.indexOf(anchor);
  if (at === -1) {
    throw new SchematicsException(`Could not find </head> in ${path}.`);
  }

  // The static values on <html> are the default-locale fallback for a visitor
  // with scripting off; the script replaces them.
  const withAttributes = source.replace(/<html([^>]*)>/, (match, attrs: string) =>
    /\blang=/.test(attrs)
      ? match.replace(/lang="[^"]*"/, `lang="${defaultLocale}"`)
      : `<html${attrs} lang="${defaultLocale}">`,
  );
  const withDir = /\bdir=/.test(withAttributes.match(/<html[^>]*>/)?.[0] ?? '')
    ? withAttributes
    : withAttributes.replace(
        /<html([^>]*)>/,
        `<html$1 dir="${localeInfo(defaultLocale).direction}">`,
      );

  const head = withDir.indexOf(anchor);
  tree.overwrite(path, `${withDir.slice(0, head)}${script}${withDir.slice(head)}`);
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
        localizeSiteUrls(host, root, design.name);
        writeAlternates(host, root, design.name);
        registerSiteTranslations(host, name, root, design.name);
        addComponent(host, `/${root}/src/app/app.ts`, `/${root}/src/app/app.html`, {
          symbol: 'LocaleLinks',
          from: './i18n/locale-links',
          anchor: `<a routerLink="/">{{ siteName }}</a>`,
          markup: `<${prefix}-locale-links />`,
        });
        retargetSiteSpec(host, root, defaultLocale);
        fixSiteSpecs(host, root, design.name, defaultLocale);
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
 * Puts the locale in every URL the site states about itself.
 *
 * `siteUrl` is rewritten rather than left alone and worked around, because
 * everything downstream already goes through it — the canonical, the JSON-LD,
 * and the sitemap that is derived from the canonical. Change the one function
 * and they cannot disagree.
 */
function localizeSiteUrls(tree: Tree, root: string, library: string): void {
  const path = `/${root}/src/app/site.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected the site to have ${path}, which is where its origin and its ` +
        `canonical URLs come from.`,
    );
  }
  if (source.includes('localeUrl')) {
    return;
  }

  const original = `export function siteUrl(path: string): string {
  return path === '/' ? \`\${SITE_ORIGIN}/\` : \`\${SITE_ORIGIN}\${path}\`;
}`;
  if (!source.includes(original)) {
    throw new SchematicsException(
      `Could not find \`siteUrl\` in ${path} in the form this schematic rewrites. ` +
        `It has been edited by hand; add the locale prefix to it yourself, the ` +
        `way \`localeUrl\` below would have.`,
    );
  }

  const replacement = `export function siteUrl(path: string): string {
  return localeUrl(SITE_LOCALE, path);
}

/** \`/about\` in \`fr\` → \`/fr/about\`. What a link between languages points at. */
export function localePath(locale: Locale, path: string): string {
  return path === '/' ? \`/\${locale}/\` : \`/\${locale}\${path}\`;
}

/**
 * \`/about\` in \`fr\` → the absolute URL of the French copy of that page.
 *
 * The site is built once per language into its own directory, so the language
 * is part of every path. The canonical, the sitemap, the JSON-LD and the
 * hreflang alternates all come through here, which is why none of them has to
 * know a locale exists.
 */
export function localeUrl(locale: Locale, path: string): string {
  return \`\${SITE_ORIGIN}\${localePath(locale, path)}\`;
}`;

  let next = source.replace(original, replacement);
  next = `import type { Locale } from '${library}';\n\nimport { SITE_LOCALE } from './i18n/build-locale';\n\n${next}`;
  tree.overwrite(path, next);
}

/**
 * Hooks the hreflang alternates into the strategy that already writes the head.
 *
 * Three insertions rather than a replacement of `page-meta.ts`: the rest of that
 * file is the same whether the site is translated or not, and a second copy of
 * it here would be a second copy to keep in step.
 */
function writeAlternates(tree: Tree, root: string, library: string): void {
  const path = `/${root}/src/app/seo/page-meta.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(
      `Expected the site to have ${path}, which is what writes each page's head.`,
    );
  }
  if (source.includes('LocaleAlternates')) {
    return;
  }

  let next = source.replace(
    "import { SITE_JSON_LD, SITE_NAME, siteUrl } from '../site';",
    `import { TranslationService } from '${library}';\n\n` +
      "import { LocaleAlternates } from '../i18n/locale-alternates';\n" +
      "import { SITE_JSON_LD, SITE_NAME, siteUrl } from '../site';",
  );
  next = next.replace(
    '  private readonly document = inject(DOCUMENT);',
    '  private readonly document = inject(DOCUMENT);\n' +
      '  private readonly alternates = inject(LocaleAlternates);\n' +
      '  private readonly i18n = inject(TranslationService);',
  );

  // `data.seo` holds message keys on a localized site, so what goes in the head
  // is their translation. A French page with an English <title> is the most
  // visible thing a search result can get wrong.
  next = next.replace(
    "    const path = state.url.split(/[?#]/)[0] || '/';\n" +
      "    const title = path === '/' ? seo.title : `${seo.title} | ${SITE_NAME}`;",
    "    const path = state.url.split(/[?#]/)[0] || '/';\n" +
      '    const heading = this.i18n.translate(seo.title);\n' +
      "    const title = path === '/' ? heading : `${heading} | ${SITE_NAME}`;",
  );
  next = next.replace(
    "    this.meta.updateTag({ name: 'description', content: seo.description });\n" +
      "    this.meta.updateTag({ property: 'og:title', content: seo.title });\n" +
      "    this.meta.updateTag({ property: 'og:description', content: seo.description });",
    '    const description = this.i18n.translate(seo.description);\n' +
      "    this.meta.updateTag({ name: 'description', content: description });\n" +
      "    this.meta.updateTag({ property: 'og:title', content: heading });\n" +
      "    this.meta.updateTag({ property: 'og:description', content: description });",
  );
  next = next.replace(
    '    this.setCanonical(canonical);',
    '    this.setCanonical(canonical);\n    // This page in every language, including this one. A noindex page gets\n    // none: inviting a crawler to index its translations is worse than silence.\n    this.alternates.update(path, canonical !== null);',
  );

  if (next === source) {
    throw new SchematicsException(
      `Could not hook the hreflang alternates into ${path}; it has been edited ` +
        `by hand. Call \`LocaleAlternates.update(path, indexable)\` from ` +
        `\`updateTitle\` yourself.`,
    );
  }
  tree.overwrite(path, next);
}

/** `provideTranslations(loadCatalog, { locale: SITE_LOCALE })` in the site's config. */
function registerSiteTranslations(tree: Tree, name: string, root: string, library: string): void {
  const path = `/${root}/src/app/app.config.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    throw new SchematicsException(`Expected site "${name}" to have ${path}.`);
  }
  if (source.includes('provideTranslations')) {
    return;
  }

  let next = addFrameworkImport(source, "import { SITE_LOCALE } from './i18n/build-locale';");
  next = addFrameworkImport(next, "import { loadCatalog } from './i18n/catalog.loader';");
  next = addFrameworkImport(next, `import { provideTranslations } from '${library}';`);
  next = appendProvider(
    next,
    path,
    `// Pinned, not negotiated: this build IS one language, and the prerendered
    // HTML is already in it. Negotiating would swap the text under a visitor
    // whose browser prefers another — and the other language has its own URL.
    provideTranslations(loadCatalog, { locale: SITE_LOCALE })`,
  );
  tree.overwrite(path, next);
}

/**
 * Points the marketing site's own e2e suite at the localized canonical.
 *
 * `site.spec.ts` asserts that the home page's canonical is `/`. Once the site is
 * built once per language it is `/en/` — including under `ng serve`, which
 * applies no `define` and so renders the source locale rather than no locale.
 * One assertion, written before this schematic existed, and left wrong it would
 * fail every run.
 */
function retargetSiteSpec(tree: Tree, root: string, defaultLocale: string): void {
  const path = `/${root}/e2e/site.spec.ts`;
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined) {
    return;
  }

  const original = "  expect(new URL(canonical!).pathname).toBe('/');";
  if (!source.includes(original)) {
    return;
  }

  tree.overwrite(
    path,
    source.replace(
      original,
      '  // The locale is in the path: the site is built once per language, and\n' +
        '  // `ng serve` renders the source one rather than none.\n' +
        `  expect(new URL(canonical!).pathname).toBe('/${defaultLocale}/');`,
    ),
  );
}

/**
 * Keeps the site's own unit specs green.
 *
 * Three of them were written before this schematic existed and assert on things
 * it changes:
 *
 *   • `page-meta.spec.ts` and `app.spec.ts` build their own TestBeds, and their
 *     subjects now reach a `TranslationService` — `PageMetaStrategy` to translate
 *     each route's title, `App` through the locale links in its header. That
 *     service needs a `TRANSLATION_LOADER`, and without one every test in those
 *     files fails on a null injector. An app's shell spec has the same problem
 *     and the same fix; see `provideLoaderToShellSpec`.
 *   • `site.spec.ts` asserts the shape of `siteUrl`, which now carries the
 *     locale.
 *
 * Patched rather than left to fail: a generator that turns a green suite red is
 * a generator nobody trusts the next time it edits something. An empty catalog
 * is enough for the first two — a key with no translation renders as itself, so
 * the plain titles they already assert on keep working.
 */
function fixSiteSpecs(tree: Tree, root: string, library: string, defaultLocale: string): void {
  provideLoader(tree, `/${root}/src/app/seo/page-meta.spec.ts`, library, [
    {
      find: '      providers: [provideRouter(routes), { provide: TitleStrategy, useClass: PageMetaStrategy }],',
      replace:
        '      providers: [\n' +
        '        provideRouter(routes),\n' +
        '        { provide: TitleStrategy, useClass: PageMetaStrategy },\n' +
        "        // The strategy translates each route's title, and an empty\n" +
        '        // catalog renders every key as itself — which is what the plain\n' +
        '        // titles below assert on.\n' +
        '        { provide: TRANSLATION_LOADER, useValue: () => ({}) },\n' +
        '      ],',
    },
  ]);

  provideLoaderToShellSpec(tree, root, library);

  localizeSiteUrlSpec(tree, `/${root}/src/app/site.spec.ts`, defaultLocale);
}

/** Adds a `TRANSLATION_LOADER` provider to a spec's TestBed, and imports it. */
function provideLoader(
  tree: Tree,
  path: string,
  library: string,
  edits: readonly { find: string; replace: string }[],
): void {
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined || source.includes('TRANSLATION_LOADER')) {
    return;
  }

  let next = source;
  for (const edit of edits) {
    if (!next.includes(edit.find)) {
      throw new SchematicsException(
        `Could not find the TestBed providers in ${path}. Add ` +
          `\`{ provide: TRANSLATION_LOADER, useValue: () => ({}) }\` to them by ` +
          `hand: its subject now reaches TranslationService.`,
      );
    }
    next = next.replace(edit.find, edit.replace);
  }

  // After the last framework import, which is where the other library imports
  // in these files sit.
  next = addFrameworkImport(next, `import { TRANSLATION_LOADER } from '${library}';`);
  tree.overwrite(path, next);
}

/** Points `site.spec.ts` at the locale-prefixed URLs `siteUrl` now builds. */
function localizeSiteUrlSpec(tree: Tree, path: string, defaultLocale: string): void {
  const source = tree.read(path)?.toString('utf8');
  if (source === undefined || source.includes('SITE_LOCALE')) {
    return;
  }

  const original = `    expect(siteUrl('/')).toBe(\`\${SITE_ORIGIN}/\`);
    expect(siteUrl('/about')).toBe(\`\${SITE_ORIGIN}/about\`);`;
  if (!source.includes(original)) {
    throw new SchematicsException(
      `Could not find the \`siteUrl\` assertions in ${path}. They now have to ` +
        `expect the locale in the path, because the site is built once per language.`,
    );
  }

  let next = source.replace(
    original,
    `    // The locale is in every path: the site is built once per language, and
    // \`siteUrl\` builds this build's own URLs.
    expect(siteUrl('/')).toBe(\`\${SITE_ORIGIN}/\${SITE_LOCALE}/\`);
    expect(siteUrl('/about')).toBe(\`\${SITE_ORIGIN}/\${SITE_LOCALE}/about\`);
  });

  it('builds the URL of the same page in another language', () => {
    // What the hreflang alternates and the header's language links are made of,
    // so they cannot point at different places.
    expect(localePath('${defaultLocale}', '/about')).toBe('/${defaultLocale}/about');
    expect(localeUrl('${defaultLocale}', '/')).toBe(\`\${SITE_ORIGIN}/${defaultLocale}/\`);`,
  );
  next = next.replace(
    "import { SITE_JSON_LD, SITE_ORIGIN, siteUrl } from './site';",
    "import { SITE_LOCALE } from './i18n/build-locale';\n" +
      "import { localePath, localeUrl, SITE_JSON_LD, SITE_ORIGIN, siteUrl } from './site';",
  );
  tree.overwrite(path, next);
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
 * `build:<site>` becomes one `ng build` per language.
 *
 * Sequential rather than parallel: they write into one output tree, and the
 * postbuild step that follows reads all of it. The postbuild scripts are told
 * which languages to expect, so a build whose second language failed to produce
 * a directory fails the check rather than quietly shipping one language.
 */
function localizeSiteScripts(tree: Tree, name: string, locales: readonly string[]): void {
  const list = locales.join(',');
  const build = [
    // Once, before the first language: the locale configurations turn Angular's
    // own output cleaning off, because it would delete the shared base each of
    // them writes into.
    `node scripts/clean-dist.mjs ${name}`,
    ...locales.map((locale) => `ng build ${name} --configuration ${localeConfiguration(locale)}`),
  ].join(' && ');
  const postbuild =
    `node scripts/generate-sitemap.mjs ${name} --locales ${list} && ` +
    `node scripts/verify-prerender.mjs ${name} --locales ${list}`;

  // Replaced, not added: `addScripts` preserves whatever is already there, and
  // what is already there is the single-language build that this supersedes.
  // Replacing only the exact command the marketing schematic wrote, so a script
  // somebody has tuned is a failure here rather than a silent overwrite.
  replaceScript(tree, `build:${name}`, `ng build ${name}`, build);
  replaceScript(
    tree,
    `postbuild:${name}`,
    `node scripts/generate-sitemap.mjs ${name} && node scripts/verify-prerender.mjs ${name}`,
    postbuild,
  );

  documentScripts(tree, {
    [`build:${name}`]:
      `prerenders \`${name}\` once per language into \`dist/${name}/<locale>\`, writes one ` +
      `sitemap with hreflang alternates, and fails on any page a crawler could not use`,
  });
}

/**
 * Swaps one generated script for another, refusing to clobber a third thing.
 *
 * Idempotent: a re-run finds the replacement already in place and stops.
 */
function replaceScript(tree: Tree, name: string, expected: string, replacement: string): void {
  updateJson(tree, PACKAGE_JSON, (file) => {
    const current = file.get<string>(['scripts', name]);
    if (current === replacement) {
      return;
    }
    if (current !== undefined && current !== expected) {
      throw new SchematicsException(
        `\`${name}\` in package.json is not the command this schematic replaces. ` +
          `Expected "${expected}", found "${current}". Add the per-locale builds ` +
          `to it by hand: "${replacement}".`,
      );
    }
    file.modify(['scripts', name], replacement);
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
\`locale-*\` configuration. \`npm run build:${sites[0]}\` runs all of them.

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

\`npm run start:${sites[0]}\` serves the source locale: \`ng serve\` applies no
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
