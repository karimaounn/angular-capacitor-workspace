/**
 * Terminal styling, in one file and with no dependency.
 *
 * Same argument as the prompt layer in the `create-*` package: a colour library
 * is a handful of transitive packages, and their advisories, in exchange for
 * sixteen escape codes that have not changed since 1979. A generator whose
 * whole claim is a defensible dependency set does not get to import chalk.
 *
 * Every helper degrades to the identity function when the output is not a
 * terminal, so piping to a file, or to a CI log, produces exactly the plain
 * text this tool printed before any of this existed. `NO_COLOR` and
 * `FORCE_COLOR` are honoured ahead of the TTY check.
 */

const ENABLED = detect();

function detect(): boolean {
  const env = process.env;
  // no-color.org: any non-empty value disables, whatever else is set.
  if (env['NO_COLOR']) return false;
  if (env['FORCE_COLOR'] === '0') return false;
  if (env['FORCE_COLOR'] !== undefined) return true;
  if (env['TERM'] === 'dumb') return false;
  return process.stdout.isTTY === true;
}

/** Whether escape codes are being emitted at all. */
export function colorEnabled(): boolean {
  return ENABLED;
}

const wrap =
  (open: number, close: number) =>
  (text: string): string =>
    ENABLED ? `\u001B[${open}m${text}\u001B[${close}m` : text;

// `bold` and `dim` share a reset code, so they cannot be nested in each other.
// Nothing below does; keep it that way.
export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const underline = wrap(4, 24);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const gray = wrap(90, 39);

/** Markers, sized so every one of them occupies a single column. */
export const MARK = {
  ok: green('✓'),
  fail: red('✗'),
  warn: yellow('!'),
  skip: dim('·'),
  bullet: dim('•'),
  prompt: cyan('?'),
  cursor: cyan('›'),
} as const;

/**
 * A section heading, carrying the blank line that separates it from whatever
 * came before. Output is written a line at a time, so the spacing has to
 * travel with the thing it spaces.
 */
export function heading(text: string): string {
  return `\n${bold(text)}`;
}

/** One line of progress. Quiet on purpose — it is scrollback within seconds. */
export function progress(text: string): string {
  return `  ${MARK.skip} ${dim(text)}`;
}

/** A command the reader is meant to type. */
export function command(text: string): string {
  return cyan(text);
}

/** The `# why` that follows one. */
export function note(text: string): string {
  return dim(text);
}

/** Colours a severity by how much it should interrupt the reader. */
export function bySeverity(severity: string): (text: string) => string {
  switch (severity) {
    case 'critical':
    case 'high':
      return red;
    case 'moderate':
      return yellow;
    default:
      return dim;
  }
}
