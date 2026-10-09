import { SchematicsException } from '@angular-devkit/schematics';

/**
 * String surgery on the TypeScript files this collection generates.
 *
 * String surgery rather than the TypeScript AST: `typescript` is not a
 * dependency of this package, and reaching for the copy that
 * `@schematics/angular` happens to hoist is the accident this workspace refuses
 * everywhere else. The shapes these have to handle are the `app.config.ts`
 * files this collection produces — Angular's, and the marketing template's —
 * and they fail by name rather than guessing when they meet a third.
 *
 * Shared by the schematics that add a provider to an application: `packages`
 * (the service worker) and `i18n` (the translation loader).
 */

/**
 * Puts a declaration above `export const appConfig`.
 *
 * The platform check is hoisted rather than inlined into `enabled` so that the
 * comment explaining it has somewhere to live that is not four levels deep in an
 * object literal.
 */
export function declareBeforeConfig(source: string, path: string, declaration: string): string {
  const anchor = 'export const appConfig';
  const at = source.indexOf(anchor);
  if (at === -1) {
    throw new SchematicsException(
      `Could not find \`${anchor}\` in ${path}, which is what the service worker ` +
        `registration is added to.`,
    );
  }
  return `${source.slice(0, at)}${declaration}\n\n${source.slice(at)}`;
}

/** Adds one symbol to an existing named import, at the end of the list. */
export function addNamedImport(
  source: string,
  path: string,
  module: string,
  symbol: string,
): string {
  const pattern = new RegExp(`import \\{([^}]*)\\} from '${module}';`);
  const match = source.match(pattern);
  if (!match) {
    throw new SchematicsException(
      `Expected ${path} to import from '${module}', which is where \`${symbol}\` comes from.`,
    );
  }

  const named = match[1]!.split(',').map((part) => part.trim());
  if (named.includes(symbol)) {
    return source;
  }
  return source.replace(match[0], `import { ${[...named, symbol].join(', ')} } from '${module}';`);
}

/**
 * Inserts an import line after the last `@angular/*` one.
 *
 * After the framework imports rather than after all of them, so the new line
 * lands in the group it belongs to instead of below the relative imports.
 */
export function addFrameworkImport(source: string, line: string): string {
  if (source.includes(line)) {
    return source;
  }

  const lines = source.split('\n');
  const last = lines.reduce(
    (found, text, index) => (/^import .* from '@angular\//.test(text) ? index : found),
    -1,
  );
  lines.splice(last + 1, 0, line);
  return lines.join('\n');
}

/**
 * Appends a provider to the `providers` array of an `ApplicationConfig`.
 *
 * The array's end is found by matching brackets from its opening one rather than
 * by a regex, because the providers already there contain brackets of their own.
 * A bracket inside a string or a comment would fool it; none of the configs this
 * collection writes has one, and the alternative is the AST dependency this
 * package does not have.
 */
export function appendProvider(source: string, path: string, provider: string): string {
  const opening = 'providers: [';
  const start = source.indexOf(opening);
  if (start === -1) {
    throw new SchematicsException(`Could not find the providers array in ${path}.`);
  }

  const from = start + opening.length;
  let depth = 1;
  let end = -1;
  for (let index = from; index < source.length; index++) {
    const char = source[index];
    if (char === '[') depth++;
    else if (char === ']' && --depth === 0) {
      end = index;
      break;
    }
  }
  if (end === -1) {
    throw new SchematicsException(`The providers array in ${path} is not closed.`);
  }

  // Angular's template leaves the last provider without a trailing comma.
  const existing = source.slice(from, end).replace(/\s+$/, '');
  const comma = existing === '' || existing.endsWith(',') ? '' : ',';
  return `${source.slice(0, from)}${existing}${comma}\n    ${provider},\n  ${source.slice(end)}`;
}
