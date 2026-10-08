/** How a language is written. Drives `<html dir>`. */
export type Direction = 'ltr' | 'rtl';

/**
 * A workspace's locales: the shape of `src/config/i18n.ts` in its design
 * system.
 *
 *     export const I18N = {
 *       defaultLocale: 'en',
 *       locales: {
 *         en: { label: 'English', direction: 'ltr' },
 *         ar: { label: 'العربية', direction: 'rtl' },
 *       },
 *     } as const satisfies I18nConfig;
 */
export interface I18nConfig {
  /** The source language: what every untranslated key falls back to. */
  readonly defaultLocale: string;
  /**
   * In the order a language picker offers them. `label` is the language's name
   * in that language — someone who cannot read the active one still has to
   * find their own.
   */
  readonly locales: Readonly<
    Record<string, { readonly label: string; readonly direction: Direction }>
  >;
}

/**
 * Where a workspace tells this package which locales it ships, so `Locale` is
 * their union rather than `string`:
 *
 *     declare module '@angular-capacitor-workspace/i18n' {
 *       interface Register {
 *         i18n: typeof I18N;
 *       }
 *     }
 *
 * The design system's generated `i18n.ts` does this. With it, every
 * `Record<Locale, …>` is exhaustive and the compiler points at whatever does
 * not cover a locale yet.
 */
export interface Register {}

/** The registered config, or the general shape before anything registers one. */
export type RegisteredI18n = Register extends { i18n: infer Config extends I18nConfig }
  ? Config
  : I18nConfig;

/** A locale the workspace ships. */
export type Locale = Extract<keyof RegisteredI18n['locales'], string>;

/** A flat, dot-keyed message table. Values may contain `{placeholder}` slots. */
export type TranslationCatalog = Readonly<Record<string, string>>;

/** Values substituted into a message's `{placeholder}` slots. */
export type TranslationParams = Readonly<Record<string, string | number>>;

/** The tables derived from a config, typed by its own locales. */
export interface LocaleTables<Config extends I18nConfig> {
  /** Every locale, in the config's order, which is a picker's. */
  readonly LOCALES: readonly LocaleOf<Config>[];
  readonly DEFAULT_LOCALE: LocaleOf<Config>;
  /** Writing direction per locale. */
  readonly LOCALE_DIRECTION: Readonly<Record<LocaleOf<Config>, Direction>>;
  /** Endonyms: each language named in itself. */
  readonly LOCALE_LABELS: Readonly<Record<LocaleOf<Config>, string>>;
  isLocale(value: unknown): value is LocaleOf<Config>;
  directionOf(locale: LocaleOf<Config>): Direction;
  /**
   * Best-effort BCP-47 → supported locale: `ar-EG` → `ar`, `fr-CA` → `fr`,
   * `pt-br` → `pt-BR`. `null` when nothing matches, so callers decide their
   * own fallback.
   *
   * Case-insensitively, and returning the CANONICAL tag rather than what was
   * passed in. BCP-47 case is conventional, not significant — a browser may
   * send `pt-BR`, a stored value may be `pt-br`, and `Intl` accepts either —
   * but every table here is keyed by the tag as the config spells it.
   */
  matchLocale(tag: string | null | undefined): LocaleOf<Config> | null;
  /**
   * The first supported locale in an ordered preference list, such as
   * `navigator.languages`: the user's first choice that can be served wins.
   */
  negotiateLocale(preferred: readonly string[] | undefined): LocaleOf<Config> | null;
}

type LocaleOf<Config extends I18nConfig> = Extract<keyof Config['locales'], string>;

/**
 * The locale tables of a config. Pure, and the same for the server and the
 * browser, so a prerender and the app it hydrates into agree.
 *
 * A `defaultLocale` the config does not list is a compile error here, and a
 * thrown one for a config that reaches this untyped.
 */
export function localeTables<const Config extends I18nConfig>(
  config: Config & { readonly defaultLocale: LocaleOf<Config> },
): LocaleTables<Config> {
  type L = LocaleOf<Config>;
  const locales = Object.keys(config.locales) as L[];
  if (!locales.includes(config.defaultLocale)) {
    throw new Error(
      `The default locale "${config.defaultLocale}" is not one of the locales the ` +
        `config lists (${locales.join(', ')}).`,
    );
  }
  const entry = (locale: L) => config.locales[locale]!;
  const table = <T>(value: (locale: L) => T) =>
    Object.fromEntries(locales.map((locale) => [locale, value(locale)])) as Record<L, T>;

  const matchLocale = (tag: string | null | undefined): L | null => {
    if (!tag) {
      return null;
    }
    const lower = tag.toLowerCase();
    const exact = locales.find((locale) => locale.toLowerCase() === lower);
    if (exact) {
      return exact;
    }
    const base = lower.split('-')[0]!;
    return locales.find((locale) => locale.toLowerCase() === base) ?? null;
  };

  return {
    LOCALES: locales,
    DEFAULT_LOCALE: config.defaultLocale,
    LOCALE_DIRECTION: table((locale) => entry(locale).direction),
    LOCALE_LABELS: table((locale) => entry(locale).label),
    isLocale: (value: unknown): value is L =>
      typeof value === 'string' && (locales as readonly string[]).includes(value),
    directionOf: (locale) => entry(locale).direction,
    matchLocale,
    negotiateLocale(preferred) {
      for (const tag of preferred ?? []) {
        const match = matchLocale(tag);
        if (match) {
          return match;
        }
      }
      return null;
    },
  };
}
