/**
 * What the generator knows about a locale: which way it is written, and what
 * its speakers call it.
 *
 * Only these two facts, and only because neither can be derived at generation
 * time. Everything else a locale needs — plural categories, number and date
 * formats, the ordering of a week — comes from `Intl` at runtime, which is
 * exactly why the generated service delegates to it rather than shipping tables.
 *
 * `Intl.Locale.prototype.getTextInfo()` would answer the direction question in
 * a browser, but this runs in Node at generation time to write a static map,
 * and its availability across the Node versions this package supports is not
 * something the generator should be betting a layout on.
 *
 * A locale that is not here still works: `--i18n` accepts it, assumes `ltr`,
 * and labels it with its own tag. The generated file is a normal source file
 * with a comment saying to fix the label by hand. That is the right failure —
 * a missing endonym is a typo someone can see, not a broken build.
 */

export type Direction = 'ltr' | 'rtl';

export interface LocaleInfo {
  /** Endonym: the language's name in that language. */
  label: string;
  direction: Direction;
}

/**
 * Endonyms are lowercase where the language writes them lowercase. French is
 * `Français`, not `français`, because it is a proper noun in a language picker
 * even though French itself lowercases language names in prose; Spanish and
 * Italian do the same. This follows what each language's own UI conventions
 * use for a menu item, which is what a language picker is.
 */
export const KNOWN_LOCALES: Readonly<Record<string, LocaleInfo>> = {
  ar: { label: 'العربية', direction: 'rtl' },
  cs: { label: 'Čeština', direction: 'ltr' },
  da: { label: 'Dansk', direction: 'ltr' },
  de: { label: 'Deutsch', direction: 'ltr' },
  el: { label: 'Ελληνικά', direction: 'ltr' },
  en: { label: 'English', direction: 'ltr' },
  es: { label: 'Español', direction: 'ltr' },
  fa: { label: 'فارسی', direction: 'rtl' },
  fi: { label: 'Suomi', direction: 'ltr' },
  fr: { label: 'Français', direction: 'ltr' },
  he: { label: 'עברית', direction: 'rtl' },
  hi: { label: 'हिन्दी', direction: 'ltr' },
  hu: { label: 'Magyar', direction: 'ltr' },
  id: { label: 'Bahasa Indonesia', direction: 'ltr' },
  it: { label: 'Italiano', direction: 'ltr' },
  ja: { label: '日本語', direction: 'ltr' },
  ko: { label: '한국어', direction: 'ltr' },
  nl: { label: 'Nederlands', direction: 'ltr' },
  no: { label: 'Norsk', direction: 'ltr' },
  pl: { label: 'Polski', direction: 'ltr' },
  pt: { label: 'Português', direction: 'ltr' },
  ro: { label: 'Română', direction: 'ltr' },
  ru: { label: 'Русский', direction: 'ltr' },
  sv: { label: 'Svenska', direction: 'ltr' },
  th: { label: 'ไทย', direction: 'ltr' },
  tr: { label: 'Türkçe', direction: 'ltr' },
  uk: { label: 'Українська', direction: 'ltr' },
  ur: { label: 'اردو', direction: 'rtl' },
  vi: { label: 'Tiếng Việt', direction: 'ltr' },
  zh: { label: '中文', direction: 'ltr' },
};

/** A locale tag the generator will accept: `en`, `pt-BR`, `zh-Hant`. */
const TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export function isLocaleTag(tag: string): boolean {
  return TAG.test(tag);
}

/**
 * What to write into the generated maps for one tag.
 *
 * A region subtag inherits from its base language — `pt-BR` is `Português` and
 * `ltr` from `pt` — because direction is a property of the script, and a
 * regional endonym is close enough to be worth more than the raw tag. The
 * comment the schematic emits tells the reader to refine it.
 */
export function localeInfo(tag: string): LocaleInfo & { known: boolean } {
  const exact = KNOWN_LOCALES[tag];
  if (exact) {
    return { ...exact, known: true };
  }
  const base = KNOWN_LOCALES[tag.split('-')[0]!.toLowerCase()];
  if (base) {
    return { ...base, known: true };
  }
  return { label: tag, direction: 'ltr', known: false };
}

/** Locale tags this workspace's generated code treats as right-to-left. */
export function isRtl(tag: string): boolean {
  return localeInfo(tag).direction === 'rtl';
}
