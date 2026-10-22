import { posix } from 'node:path';
import { type Tree } from '@angular-devkit/schematics';
import { JsonFile, updateJson } from '../utils/json-file';
import { readProject } from '../utils/workspace';

/**
 * The extension point for an application's settings per environment.
 *
 * What differs between `ng serve` and a production build — where the API is,
 * which user pool to sign in against — is a plugin's to declare and the
 * workspace's to set. Both live in Angular's own pair, `environment.ts` and
 * `environment.development.ts`, swapped by `fileReplacements`: each a plain
 * `export const environment = { … }`, as `ng generate environments` writes it,
 * and the workspace's.
 *
 * A plugin that needs settings adds its group to that object, at its defaults
 * and with what it means, in every file that stands in for `environment.ts`,
 * and only where the group is missing. So adding a plugin never breaks the
 * build, and a value someone set is never touched. Nothing else is generated
 * beside them. A group's values are typed by what reads it (the auth binding's
 * `AuthEnvironment`), or, where they have a shape worth checking as they are
 * typed, by a function the design system exports that the group's default
 * calls — `auth: cognito({ … })` — imported at the top of the file. Either
 * way, a group that is missing or misshapen fails the build, on the line that
 * is wrong.
 *
 * An environment this cannot read — not an object literal, or one that spreads
 * another, which may hold the group already — is left as it is, and the plugin
 * is told what to add by hand.
 */

/** Where an app's environments are, relative to its root. */
export const ENVIRONMENTS = 'src/environments';

/** A group of settings, under `key` in each environment. */
export interface EnvironmentGroup {
  /** Its key in the environment: an identifier. */
  readonly key: string;
  /** What the group is for, as the doc comment its key carries. */
  readonly doc: string;
  /** Its defaults, as an expression on one line: an object literal, or a call. */
  readonly defaults: string;
  /**
   * What `defaults` calls, when it calls something: the symbol and the module
   * it is imported from, a function the design system exports. Added to the
   * environment's imports where it is missing.
   */
  readonly import?: { readonly symbol: string; readonly from: string };
}

/**
 * Where the app's API is. Its own group rather than a plugin's, because more
 * than one reads it: the API client sends its requests there, and sign-in
 * sends the session's token to requests under it and to no others.
 */
export const API_SETTINGS: EnvironmentGroup = {
  key: 'api',
  doc:
    "Where the app's API is: '/api' behind a reverse proxy, or a URL such as\n" +
    "'https://api.example.com/v1'. The API client sends its requests here, and\n" +
    "sign-in sends the session's token to requests under it and to no others.",
  defaults: "{ baseUrl: '/api' }",
};

/**
 * Gives the app's environments every one of `groups` they lack, at its
 * defaults, and the environment files if it has none. Returns the manual step
 * for the environments it could not read, and `undefined` when there is none.
 */
export function addEnvironmentGroups(
  tree: Tree,
  project: string,
  groups: readonly EnvironmentGroup[],
): string | undefined {
  const root = readProject(tree, project).root ?? '';
  const dir = posix.join('/', root, ENVIRONMENTS);

  for (const [name, build] of [
    ['environment.ts', 'a production build'],
    ['environment.development.ts', '`ng serve`, which swaps it in for environment.ts'],
  ] as const) {
    if (!tree.exists(`${dir}/${name}`)) {
      tree.create(`${dir}/${name}`, environmentSource(build));
    }
  }
  replaceInDevelopment(tree, project, root);

  const unread: string[] = [];
  for (const path of environmentFiles(tree, project, root)) {
    const source = tree.read(path)?.toString('utf8');
    if (source === undefined) {
      // A replacement angular.json names and nobody has written: the build
      // says so, and there is nothing here to add to.
      continue;
    }
    const literal = environmentLiteral(source);
    const missing = groups.filter((group) => !literal?.keys.has(group.key));
    if (missing.length === 0) {
      continue;
    }
    if (!literal || literal.spreads) {
      unread.push(
        `  ${path.slice(1)}: ${
          literal
            ? 'it spreads another environment'
            : 'it is not `export const environment = { … }`'
        }`,
      );
      continue;
    }
    // The imports first, so the literal's offsets are taken from the source
    // they are in.
    const imported = missing.reduce(
      (text, group) => (group.import ? addImport(text, group.import) : text),
      source,
    );
    tree.overwrite(path, insertGroups(imported, environmentLiteral(imported)!, missing));
  }

  if (unread.length === 0) {
    return undefined;
  }
  const imports = groups.flatMap((group) => (group.import ? [importLine(group.import)] : []));
  return (
    `These environments are left as they are, and may lack the settings the ` +
    `app's plugins read:\n\n${unread.join('\n')}\n\n` +
    `Give \`environment\` in each whichever of these it does not have, directly ` +
    `or through what it spreads:\n\n` +
    groups.map((group) => `  ${group.key}: ${group.defaults},`).join('\n') +
    (imports.length > 0 ? `\n\nwith, at the top of the file:\n\n  ${imports.join('\n  ')}` : '')
  );
}

function importLine({ symbol, from }: NonNullable<EnvironmentGroup['import']>): string {
  return `import { ${symbol} } from '${from}';`;
}

/**
 * `source` importing `symbol` from `from`: into the named import the file has
 * from that module, or as a new line after the last import, or at the top of
 * a file with none, above the comment on `environment`.
 */
function addImport(
  source: string,
  { symbol, from }: NonNullable<EnvironmentGroup['import']>,
): string {
  const module = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const named = new RegExp(`^import \\{([^}]*)\\} from '${module}';`, 'm').exec(source);
  if (named) {
    const symbols = named[1]!.split(',').map((part) => part.trim());
    if (symbols.includes(symbol)) {
      return source;
    }
    return source.replace(
      named[0],
      `import { ${[...symbols, symbol].join(', ')} } from '${from}';`,
    );
  }

  const lines = source.split('\n');
  const last = lines.reduce(
    (found, text, index) => (/^(import\b.*|\} from ['"].*)$/.test(text) ? index : found),
    -1,
  );
  if (last === -1) {
    return `${importLine({ symbol, from })}\n\n${source}`;
  }
  lines.splice(last + 1, 0, importLine({ symbol, from }));
  return lines.join('\n');
}

/** How a file in `fromDir`, relative to the project's root, imports `environment`. */
export function environmentFrom(fromDir: string): string {
  const specifier = posix.relative(fromDir, `${ENVIRONMENTS}/environment`);
  return specifier.startsWith('.') ? specifier : `./${specifier}`;
}

function environmentSource(build: string): string {
  return `/**
 * This app's settings in ${build}.
 *
 * Yours. A plugin that needs a setting adds it here, at its default and with
 * what it means, when it is missing, and changes nothing else: set the values
 * here, and keep settings of your own beside them.
 *
 * Everything here is bundled into the app, so none of it may be a secret.
 */
export const environment = {};
`;
}

/**
 * The files that stand in for the app's `environment.ts`: that one, and every
 * replacement a build configuration swaps in for it.
 */
function environmentFiles(tree: Tree, project: string, root: string): string[] {
  const production = posix.join(root, ENVIRONMENTS, 'environment.ts');
  const configurations =
    new JsonFile(tree, '/angular.json').get<
      Record<string, { fileReplacements?: { replace: string; with: string }[] }>
    >(['projects', project, 'architect', 'build', 'configurations']) ?? {};
  const files = new Set([production]);
  for (const configuration of Object.values(configurations)) {
    for (const replacement of configuration.fileReplacements ?? []) {
      if (posix.normalize(replacement.replace) === production) {
        files.add(posix.normalize(replacement.with));
      }
    }
  }
  return [...files].map((file) => `/${file}`);
}

/** The `fileReplacements` entry `ng generate environments` writes, once. */
function replaceInDevelopment(tree: Tree, project: string, root: string): void {
  const entry = {
    replace: posix.join(root, ENVIRONMENTS, 'environment.ts'),
    with: posix.join(root, ENVIRONMENTS, 'environment.development.ts'),
  };
  updateJson(tree, '/angular.json', (file) => {
    const at = ['projects', project, 'architect', 'build', 'configurations', 'development'];
    file.mustGet(at, `the development configuration of "${project}", which Angular writes`);
    const replacements = file.get<{ replace: string }[]>([...at, 'fileReplacements']) ?? [];
    if (!replacements.some((existing) => existing.replace === entry.replace)) {
      file.modify([...at, 'fileReplacements'], [...replacements, entry]);
    }
  });
}

/** The object literal `environment` is, as far as adding a group to it goes. */
interface EnvironmentLiteral {
  /** Where its `{` is. */
  readonly open: number;
  /** Where its `}` is. */
  readonly close: number;
  /** Where its last member ends: its `{` when it has none. */
  readonly last: number;
  /** Its own keys, not those of the objects in it. */
  readonly keys: ReadonlySet<string>;
  /** Whether it spreads another object, whose keys this cannot see. */
  readonly spreads: boolean;
}

/**
 * Reads `export const environment = { … }` in `source`, or returns `undefined`
 * when it is not there.
 *
 * Brackets are matched by hand, skipping strings and comments, because
 * `typescript` is not a dependency of this package (see `ts-edit.ts`). Only
 * the literal's own keys matter, so a value in it is skipped whole.
 */
function environmentLiteral(source: string): EnvironmentLiteral | undefined {
  const head = /^export\s+const\s+environment\b[^=]*=\s*\{/m.exec(source);
  if (!head) {
    return undefined;
  }
  const open = head.index + head[0].length - 1;
  const keys = new Set<string>();
  let spreads = false;
  let depth = 0;
  let last = open;
  // Whether what comes next at the top level starts a member: after `{` or `,`.
  let member = false;

  for (let at = open; at < source.length; at++) {
    const char = source[at]!;
    if (char === '/' && source[at + 1] === '/') {
      const end = source.indexOf('\n', at);
      at = end === -1 ? source.length : end;
      continue;
    }
    if (char === '/' && source[at + 1] === '*') {
      const end = source.indexOf('*/', at + 2);
      if (end === -1) {
        return undefined;
      }
      at = end + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      const end = stringEnd(source, at);
      if (end === -1) {
        return undefined;
      }
      if (depth === 1 && member) {
        keys.add(source.slice(at + 1, end));
        member = false;
      }
      at = last = end;
      continue;
    }
    if (char === '{' || char === '[' || char === '(') {
      depth++;
      member = depth === 1;
      last = depth === 1 ? at : last;
      continue;
    }
    if (char === '}' || char === ']' || char === ')') {
      if (--depth === 0) {
        return { open, close: at, last, keys, spreads };
      }
      last = at;
      continue;
    }
    if (/\s/.test(char)) {
      continue;
    }
    if (depth === 1) {
      last = at;
      if (char === ',') {
        member = true;
      } else if (member) {
        const name = /^(?:\.\.\.|[\w$]+)/.exec(source.slice(at))?.[0];
        if (name === '...') {
          spreads = true;
        } else if (name) {
          keys.add(name);
        }
        member = false;
      }
    }
  }
  return undefined;
}

/** Where the string opening at `start` closes, or -1 if it does not. */
function stringEnd(source: string, start: number): number {
  const quote = source[start];
  for (let at = start + 1; at < source.length; at++) {
    if (source[at] === '\\') {
      at++;
    } else if (source[at] === quote) {
      return at;
    }
  }
  return -1;
}

/** `source` with `groups` at the end of `environment`, each documented. */
function insertGroups(
  source: string,
  literal: EnvironmentLiteral,
  groups: readonly EnvironmentGroup[],
): string {
  const lineStart = source.lastIndexOf('\n', literal.open) + 1;
  const outer = /^\s*/.exec(source.slice(lineStart))![0];
  const indent = `${outer}  `;
  const members = groups
    .map((group) => {
      const doc = group.doc
        .split('\n')
        .map((line) => `${indent} * ${line}`.trimEnd())
        .join('\n');
      return `${indent}/**\n${doc}\n${indent} */\n${indent}${group.key}: ${group.defaults},`;
    })
    .join('\n');

  // After the last member, behind a comma if it has none, and after whatever
  // comment trails it.
  const comma = literal.last === literal.open || source[literal.last] === ',' ? '' : ',';
  const trailing = source.slice(literal.last + 1, literal.close).trimEnd();
  return (
    `${source.slice(0, literal.last + 1)}${comma}${trailing}\n` +
    `${members}\n${outer}${source.slice(literal.close)}`
  );
}
