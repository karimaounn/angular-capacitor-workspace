import { SchematicsException, type Tree } from '@angular-devkit/schematics';
import {
  addFrameworkImport,
  addNamedImport,
  appendProvider,
  declareBeforeConfig,
} from '../utils/ts-edit';
import { readProject } from '../utils/workspace';

/**
 * The extension points of an application's shell.
 *
 * Every app and every prerendered site this collection generates has the same
 * frame: `app.ts` with a `<header>` in its template, a spec for it,
 * `app.config.ts`, Angular's `index.html`, and — in an app with a design system
 * — a starter page. This is the one module that knows how those files are laid
 * out. A plugin says what it adds ("a control in the header", "a provider at
 * the root") and never which line of which file, so when a template changes
 * shape this file changes with it and no plugin does.
 *
 * Every anchor is structural — the `<header>` landmark, the `providers` array,
 * `</head>` — rather than a line a template happens to contain. Each insertion
 * is keyed on the symbol or id it adds, so a re-run, or a project someone wired
 * by hand, is left alone.
 *
 * The app and marketing templates, and their specs in `test/schematics.spec.ts`,
 * keep these anchors. Change one there and the tests here say which plugin
 * broke.
 */

/** A standalone component a plugin adds to a page. */
export interface ShellComponent {
  /** The exported class, added to the host component's `imports`. */
  readonly symbol: string;
  /**
   * Its module specifier. A relative one is written from `src/app/` and
   * re-based for the file it lands in, so a plugin never needs to know that
   * the starter page sits one directory deeper than the shell.
   */
  readonly from: string;
  /** The element, as it goes into the template. */
  readonly markup: string;
}

/** A provider a plugin adds to `app.config.ts`. */
export interface RootProvider {
  /** The idempotency key: a config that mentions it is left as it is. */
  readonly symbol: string;
  /** The entry, as it is written into `providers`. Comments included. */
  readonly expression: string;
  /** Import lines, in the order they should appear. */
  readonly imports?: readonly string[];
  /** Symbols to add to an import the config already has, such as `isDevMode`. */
  readonly named?: readonly { readonly symbol: string; readonly from: string }[];
  /** A declaration the provider reads, put above `export const appConfig`. */
  readonly declaration?: string;
}

/** A provider a plugin adds to the shell's own spec, whose subject now needs it. */
export interface TestProvider {
  /** The idempotency key, and what the import brings in. */
  readonly symbol: string;
  /** The entry, as it is written into the TestBed's `providers`. Comments included. */
  readonly expression: string;
  /** Import lines it needs. */
  readonly imports: readonly string[];
}

/**
 * An inline script that has to run before Angular does.
 *
 * The generator's, not the workspace's: it is derived from configuration —
 * the theme's storage keys, the config's locales — and rewritten whole on every
 * run, so a change to what it is derived from reaches every app. It sits
 * between `<!-- id … -->` and `<!-- /id -->`, and those two lines are how it is
 * found again.
 */
export interface BootScript {
  readonly id: string;
  /**
   * The markup, indented for `<head>`: opening with a comment that starts
   * `<!-- id`, closing with the line `<!-- /id -->`, and ending in a newline.
   */
  readonly html: string;
  /** Attributes for `<html>`, the values a page gets with scripting off. Replaced if present. */
  readonly attributes?: Readonly<Record<string, string>>;
}

function projectRoot(tree: Tree, project: string): string {
  const root = readProject(tree, project).root;
  if (root === undefined) {
    throw new SchematicsException(`Project "${project}" has no root in angular.json.`);
  }
  return root;
}

function read(tree: Tree, path: string): string | undefined {
  return tree.read(path)?.toString('utf8');
}

/** Whether `source` names `key` as a whole word: `TestBed` does not mention `Bed`. */
function mentions(source: string, key: string): boolean {
  return new RegExp(`(?<![\\w$])${escape(key)}(?![\\w$])`).test(source);
}

/**
 * Puts a control at the end of the shell's `<header>`: a theme toggle, a
 * language picker, links to the site in other languages.
 *
 * In the order the plugins run, which is the registry's. A shell with no
 * `<header>` has been rewritten by someone, and is left alone rather than
 * having a control dropped somewhere it was not designed for.
 */
export function addHeaderControl(tree: Tree, project: string, component: ShellComponent): void {
  const root = projectRoot(tree, project);
  const componentPath = `/${root}/src/app/app.ts`;
  const templatePath = `/${root}/src/app/app.html`;
  const template = read(tree, templatePath);
  if (template === undefined || !template.includes('</header>')) {
    return;
  }
  if (!addToComponent(tree, componentPath, component, './')) {
    return;
  }

  // Indented like the header's other children, read off the closing tag's own
  // indentation plus one step.
  const at = template.indexOf('</header>');
  const lineStart = template.lastIndexOf('\n', at) + 1;
  const indent = `${template.slice(lineStart, at)}  `;
  tree.overwrite(
    templatePath,
    `${template.slice(0, lineStart)}${indent}${component.markup}\n${template.slice(lineStart)}`,
  );
}

/**
 * Adds a section to the starter page, above the page's last one.
 *
 * The starter page ends with what to do next, and a plugin's section is
 * something to look at before that. Above the last `<section>` rather than
 * after a heading the template happens to have: the page is the user's to
 * rewrite, and a section added later lands in a sensible place on any page
 * that is still a list of sections. A project without a starter page — a site,
 * an app generated without a design system — is left alone.
 */
export function addStarterSection(tree: Tree, project: string, component: ShellComponent): void {
  const root = projectRoot(tree, project);
  const componentPath = `/${root}/src/app/pages/home.page.ts`;
  const templatePath = `/${root}/src/app/pages/home.page.html`;
  const template = read(tree, templatePath);
  if (template === undefined) {
    return;
  }
  if (!addToComponent(tree, componentPath, component, '../')) {
    return;
  }

  const last = template.lastIndexOf('\n<section');
  if (last === -1) {
    tree.overwrite(templatePath, `${template.replace(/\n*$/, '\n')}\n${component.markup}\n`);
    return;
  }
  tree.overwrite(
    templatePath,
    `${template.slice(0, last + 1)}${component.markup}\n\n${template.slice(last + 1)}`,
  );
}

/**
 * Adds a provider to the application's root `providers`.
 *
 * `app.config.ts` is Angular's, or the marketing template's, and every
 * application has one, so a missing file is an error rather than a skip.
 */
export function addRootProvider(tree: Tree, project: string, provider: RootProvider): void {
  const path = `/${projectRoot(tree, project)}/src/app/app.config.ts`;
  const source = read(tree, path);
  if (source === undefined) {
    throw new SchematicsException(
      `Expected "${project}" to have ${path}, which the Angular application ` +
        `schematic writes for a standalone app.`,
    );
  }
  if (mentions(source, provider.symbol)) {
    return;
  }

  let next = source;
  for (const { symbol, from } of provider.named ?? []) {
    next = addNamedImport(next, path, from, symbol);
  }
  next = addImports(next, provider.imports ?? []);
  if (provider.declaration) {
    next = declareBeforeConfig(next, path, provider.declaration);
  }
  next = appendProvider(next, path, provider.expression);
  tree.overwrite(path, next);
}

/**
 * Adds a provider to the TestBed in the shell's spec.
 *
 * For a plugin whose control in the header needs something the spec's TestBed
 * does not provide: without it, every test in the file fails on a null
 * injector, and a generator that turns a green suite red is one nobody trusts
 * the next time it edits something. A shell without its spec is left alone.
 */
export function addShellTestProvider(tree: Tree, project: string, provider: TestProvider): void {
  const path = `/${projectRoot(tree, project)}/src/app/app.spec.ts`;
  const source = read(tree, path);
  if (source === undefined || mentions(source, provider.symbol)) {
    return;
  }
  if (!source.includes('providers: [')) {
    throw new SchematicsException(
      `Could not find the TestBed providers in ${path}. Add ` +
        `\`${provider.expression}\` to them by hand: the shell now needs it.`,
    );
  }
  tree.overwrite(
    path,
    addImports(appendTo(source, path, 'providers: [', provider.expression), provider.imports),
  );
}

/**
 * Adds an inline script to `<head>`, or replaces the one already there, and
 * sets attributes on `<html>`.
 *
 * For what has to happen before the first paint, which no Angular code can
 * reach: by the time the framework runs, the first frame is on screen. Last in
 * `<head>`, in the order the plugins run.
 *
 * A block whose opening comment is there without its closing one was not
 * written this way — an earlier release's, or someone's own — and is left
 * alone, since there is no telling where it ends.
 */
export function addBootScript(tree: Tree, project: string, script: BootScript): void {
  const open = `<!-- ${script.id}`;
  const close = `<!-- /${script.id} -->`;
  if (!script.html.trimStart().startsWith(open) || !script.html.trimEnd().endsWith(close)) {
    throw new Error(`A boot script must open with "${open}" and close with "${close}".`);
  }
  const path = `/${projectRoot(tree, project)}/src/index.html`;
  const source = read(tree, path);
  if (source === undefined) {
    throw new SchematicsException(`Expected Angular to have written ${path}.`);
  }

  let next: string;
  const start = source.indexOf(open);
  if (start !== -1) {
    const end = source.indexOf(close, start);
    if (end === -1) {
      return;
    }
    const from = source.lastIndexOf('\n', start) + 1;
    const to = source.indexOf('\n', end) + 1 || source.length;
    next = `${source.slice(0, from)}${script.html}${source.slice(to)}`;
  } else {
    const head = source.indexOf('</head>');
    if (head === -1) {
      throw new SchematicsException(
        `${path} has no </head> to put the ${script.id} script before. Add it by hand:\n\n${script.html}`,
      );
    }
    next = `${source.slice(0, head)}${script.html}${source.slice(head)}`;
  }

  for (const [name, value] of Object.entries(script.attributes ?? {})) {
    next = next.replace(/<html([^>]*)>/, (tag, attrs: string) =>
      new RegExp(`\\b${name}="`).test(attrs)
        ? tag.replace(new RegExp(`\\b${name}="[^"]*"`), `${name}="${value}"`)
        : `<html${attrs} ${name}="${value}">`,
    );
  }
  if (next !== source) {
    tree.overwrite(path, next);
  }
}

/**
 * Imports a component into a standalone component and adds it to `imports`.
 * False when the file is missing or already has it, so the caller leaves the
 * template alone too.
 */
function addToComponent(
  tree: Tree,
  path: string,
  component: ShellComponent,
  base: './' | '../',
): boolean {
  const source = read(tree, path);
  if (source === undefined || mentions(source, component.symbol)) {
    return false;
  }
  const from = component.from.startsWith('./')
    ? `${base}${component.from.slice(2)}`
    : component.from;
  tree.overwrite(
    path,
    addToImportsArray(
      addImports(source, [`import { ${component.symbol} } from '${from}';`]),
      path,
      component.symbol,
    ),
  );
  return true;
}

/**
 * Inserts import lines after the last `@angular/*` one, in the order given.
 *
 * Each one lands directly after that line, so they go in reversed: the one
 * inserted last ends up first. A named import from a module the file already
 * imports from joins that import instead, so two plugins adding a control each
 * from the design system leave one `import { ThemeToggle, LanguagePicker }`.
 */
function addImports(source: string, imports: readonly string[]): string {
  return [...imports].reverse().reduce((next, line) => {
    const named = line.match(/^import \{ ([^}]+) \} from '([^']+)';$/);
    const from = named?.[2];
    if (
      named &&
      from &&
      new RegExp(`^import \\{[^}]*\\} from '${escape(from)}';$`, 'm').test(next)
    ) {
      return named[1]!
        .split(',')
        .map((symbol) => symbol.trim())
        .reduce((merged, symbol) => addNamedImport(merged, '', from, symbol), next);
    }
    return addFrameworkImport(next, line);
  }, source);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Appends an entry to the array that opens with `opening`, matching brackets to
 * find its end, one entry per line.
 *
 * An array written on one line is spread over several first, the way a
 * formatter would once it gained an entry with a comment. One already spread
 * keeps its layout, comments included, and gains a line before its closing
 * bracket.
 */
function appendTo(source: string, path: string, opening: string, entry: string): string {
  const start = source.indexOf(opening);
  const from = start + opening.length;
  let depth = 1;
  let end = -1;
  for (let index = from; start !== -1 && index < source.length; index++) {
    const char = source[index];
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      end = index;
      break;
    }
  }
  if (start === -1 || end === -1) {
    throw new SchematicsException(`Could not find the end of \`${opening}\` in ${path}.`);
  }

  const lineStart = source.lastIndexOf('\n', start) + 1;
  const outer = source.slice(lineStart).match(/^[ \t]*/)![0];
  const inner = `${outer}  `;
  const indented = (text: string) =>
    text
      .split('\n')
      .map((line) => (line === '' ? line : `${inner}${line.trimStart()}`))
      .join('\n');

  const content = source.slice(from, end);
  if (!content.includes('\n')) {
    const items = content.trim().replace(/,$/, '');
    const existing = items === '' ? [] : splitTopLevel(items);
    return (
      `${source.slice(0, from)}\n` +
      [...existing, entry].map((item) => `${indented(item)},`).join('\n') +
      `\n${outer}${source.slice(end)}`
    );
  }

  const kept = content.replace(/\s+$/, '');
  const comma = kept.trim() === '' || kept.endsWith(',') ? '' : ',';
  return `${source.slice(0, from)}${kept}${comma}\n${indented(entry)},\n${outer}${source.slice(end)}`;
}

/**
 * Splits a one-line array literal's contents on its top-level commas, so
 * `provideRouter([]), x` is two entries and not three.
 */
function splitTopLevel(items: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const char of items) {
    if ('([{'.includes(char)) depth++;
    if (')]}'.includes(char)) depth--;
    if (char === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim() !== '') out.push(current.trim());
  return out;
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
