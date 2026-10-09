import { KNOWN_LOCALES } from '@angular-capacitor-workspace/cli';

/**
 * The languages the locale question lists, in the order it lists them.
 *
 * A short list rather than every locale the generator knows: a checklist taller
 * than the terminal cannot be redrawn in place, and the digits only reach nine.
 * Anything else is one "Other" away, typed as a tag. Two right-to-left scripts
 * are here on purpose, so mirroring is one keypress from being tried.
 */
export const COMMON_LOCALES = [
  'en',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ar',
  'he',
  'hi',
  'ja',
  'ko',
  'zh',
] as const;

/** The checklist row that asks for tags typed by hand. */
export const OTHER_LOCALE = 'other';

/**
 * The language this machine is set to, when the generator knows it.
 *
 * Only the base language: a checklist row reading `en-US` would offer a
 * regional catalog most apps do not want. `Intl` rather than `LANG`, because
 * Node already resolves the environment (and Windows' settings) into it.
 */
export function systemLanguage(
  locale: string = Intl.DateTimeFormat().resolvedOptions().locale,
): string | undefined {
  const base = locale.split('-')[0]!.toLowerCase();
  return KNOWN_LOCALES[base] ? base : undefined;
}

/** `Français (fr)`: the endonym a reader looks for, and the tag the flag takes. */
export function localeLabel(tag: string): string {
  const info = KNOWN_LOCALES[tag] ?? KNOWN_LOCALES[tag.split('-')[0]!.toLowerCase()];
  return info ? `${info.label} (${tag})` : tag;
}

/** The checklist: this machine's language first, the common ones, then "Other". */
export function localeChoices(system: string): { value: string; label: string }[] {
  const tags = [system, ...COMMON_LOCALES.filter((tag) => tag !== system)];
  return [
    ...tags.map((tag) => ({ value: tag, label: localeLabel(tag) })),
    { value: OTHER_LOCALE, label: 'Other… (type BCP-47 tags)' },
  ];
}

/**
 * The tags in the order the language picker will list them: the source locale
 * first, because the schematic takes the first tag as the source, then the
 * rest as they were listed.
 */
export function withSourceFirst(tags: readonly string[], source: string): string[] {
  return [source, ...tags.filter((tag) => tag !== source)];
}
