import { isDeepStrictEqual } from 'node:util';
import type { logging } from '@angular-devkit/core';
import type { Tree } from '@angular-devkit/schematics';
import type { JSONPath } from 'jsonc-parser';
import { JsonFile } from '../utils/json-file';

/**
 * The edits an `ng update` migration makes to files a release generated.
 *
 * A migration runs in a workspace that may have lived for months, so the file
 * it came to fix may have been edited since. These helpers change a file only
 * where it still holds exactly what a release wrote. Anywhere else they log the
 * step to take by hand and carry on.
 *
 * Carrying on is the point. When a migration throws, `ng update` reports it as
 * failed and runs nothing after it, including Angular's own migrations when
 * both were updated in one command, while the new versions stay installed. One
 * edited file would leave the whole workspace half-migrated.
 */

/** What an edit did, so a migration can make one edit depend on another. */
export type EditOutcome =
  /** The file held what a release wrote, and now holds the fix. */
  | 'applied'
  /** The fix was already there: a second run, or a workspace generated after it. */
  | 'current'
  /**
   * The file is not there. A workspace without the feature and a file someone
   * moved look the same from here, so whether to warn is the migration's call.
   */
  | 'absent'
  /** The file has been edited. It was left alone and the manual step logged. */
  | 'skipped';

export interface GeneratedEdit<T> {
  /** Exactly what a release wrote. */
  generated: T;
  /**
   * What replaces it. Finding it is how a second run knows the edit is done,
   * so a text replacement has to be specific enough to appear nowhere else in
   * the file.
   */
  replacement: T;
  /** What to do by hand when the file no longer matches, in full sentences. */
  manual: string;
}

/** Replaces one run of text a release wrote. */
export function replaceGeneratedText(
  tree: Tree,
  logger: logging.LoggerApi,
  path: string,
  edit: GeneratedEdit<string>,
): EditOutcome {
  const buffer = tree.read(path);
  if (buffer === null) {
    return 'absent';
  }

  const text = buffer.toString('utf8');
  const found = occurrences(text, edit.generated);

  // The fix may contain the generated text (a line added after it) or sit
  // inside it (a line taken out), so finding the fix is not enough on its own:
  // no copy of the generated text may be left beyond the ones the fix holds.
  if (text.includes(edit.replacement) && found === occurrences(edit.replacement, edit.generated)) {
    return 'current';
  }

  // Two copies are as suspect as none: there is no telling which one is ours.
  if (found !== 1) {
    return skip(logger, path, edit.manual);
  }

  // A function, so a `$` in the replacement is not read as a pattern.
  tree.overwrite(
    path,
    text.replace(edit.generated, () => edit.replacement),
  );
  return 'applied';
}

/**
 * Replaces one value a release wrote into a JSON file: an npm script, a builder
 * option, a tsconfig setting.
 *
 * `generated: undefined` adds a key no release wrote, and `replacement:
 * undefined` removes one. Formatting and comments survive, as with every
 * `JsonFile` edit.
 */
export function replaceGeneratedValue(
  tree: Tree,
  logger: logging.LoggerApi,
  path: string,
  at: JSONPath,
  edit: GeneratedEdit<unknown>,
): EditOutcome {
  if (!tree.exists(path)) {
    return 'absent';
  }

  const where = `${path} at "${at.join('.')}"`;
  let file: JsonFile;
  try {
    file = new JsonFile(tree, path);
  } catch {
    // `JsonFile` throws on a file that does not parse. In a migration that is
    // one more way a user's edit looks, not a reason to stop.
    return skip(logger, where, edit.manual);
  }

  const current = file.get(at);
  if (isDeepStrictEqual(current, edit.replacement)) {
    return 'current';
  }
  if (!isDeepStrictEqual(current, edit.generated)) {
    return skip(logger, where, edit.manual);
  }

  if (edit.replacement === undefined) {
    file.remove(at);
  } else {
    file.modify(at, edit.replacement);
  }
  file.save();
  return 'applied';
}

function skip(logger: logging.LoggerApi, where: string, manual: string): 'skipped' {
  logger.warn(
    `Left ${where} as it is: it no longer holds what angular-capacitor-workspace ` +
      `wrote there. ${manual}`,
  );
  return 'skipped';
}

function occurrences(text: string, part: string): number {
  return text.split(part).length - 1;
}
