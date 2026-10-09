import { runInNewContext } from 'node:vm';

/**
 * Reads a value out of a workspace's TypeScript config file.
 *
 * The files under a design system's `src/config/` are the workspace's to edit,
 * and the generator and the CLI both need what they say: which locales to wire
 * a new app into, which palettes and pairings to check. They are TypeScript,
 * because the library compiles against them and the literal types matter, so
 * they cannot be `JSON.parse`d. Nor is a regex over their text a reader —
 * that is how the generator used to read the locale table, and the first time
 * someone reformatted it the generator silently stopped seeing it.
 *
 * So the file's contract is narrow and stated at its top: `export const NAME =`
 * followed by an object or array literal of plain values. This finds that
 * literal by matching brackets and evaluates it alone, in an empty context.
 * Comments inside it are fine; anything after it, such as `as const` or
 * `satisfies`, is never read. No `typescript` dependency, and no experimental
 * type stripping.
 */
export function readConfigLiteral(source: string, name: string, file: string): unknown {
  const declaration = new RegExp(`export const ${name}\\b[^=]*=\\s*`).exec(source);
  if (!declaration) {
    throw new ConfigError(`${file} does not declare \`export const ${name} = …\`.`);
  }

  const start = declaration.index + declaration[0].length;
  const open = source[start];
  if (open !== '{' && open !== '[') {
    throw new ConfigError(`${name} in ${file} must be an object or array literal.`);
  }
  const end = closingBracket(source, start);
  if (end === -1) {
    throw new ConfigError(`${name} in ${file} is not closed.`);
  }

  try {
    return runInNewContext(`(${source.slice(start, end + 1)})`, Object.create(null), {
      timeout: 1000,
      filename: file,
    });
  } catch (error) {
    throw new ConfigError(
      `${name} in ${file} has to be plain values — strings, numbers, booleans, ` +
        `objects and arrays — for the generator to read it (${(error as Error).message}).`,
    );
  }
}

export class ConfigError extends Error {}

/**
 * The index of the bracket that closes the one at `start`, skipping strings and
 * comments, or -1.
 */
function closingBracket(source: string, start: number): number {
  const stack: string[] = [];
  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  for (let index = start; index < source.length; index++) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === '/' && next === '/') {
      index = source.indexOf('\n', index);
      if (index === -1) return -1;
      continue;
    }
    if (char === '/' && next === '*') {
      index = source.indexOf('*/', index + 2) + 1;
      if (index === 0) return -1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index = closingQuote(source, index);
      if (index === -1) return -1;
      continue;
    }
    if (pairs[char]) {
      stack.push(pairs[char]);
    } else if (char === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return -1;
}

function closingQuote(source: string, start: number): number {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === '\\') {
      index++;
    } else if (source[index] === quote) {
      return index;
    }
  }
  return -1;
}
