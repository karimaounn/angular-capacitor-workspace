import { InjectionToken } from '@angular/core';
import type { I18nConfig, Locale, TranslationCatalog } from './config';

/**
 * Supplies the messages for one locale. Returning a promise is the normal case:
 * a `() => import('./fr')` loader gives every locale its own lazily fetched
 * chunk, so a user who only ever reads one language never downloads the rest.
 *
 * Sync returns are allowed for tests and for tiny embedded catalogs.
 */
export type TranslationLoader = (
  locale: Locale,
) => Promise<TranslationCatalog> | TranslationCatalog;

/** What `provideI18n()` was given, which `TranslationService` reads. */
export interface I18nSetup {
  readonly config: I18nConfig;
  /**
   * The `localStorage` key the active locale is kept under. Whatever applies
   * the locale before the first paint — a script in `index.html` — has to read
   * the same one.
   */
  readonly storageKey: string;
}

export const I18N_SETUP = new InjectionToken<I18nSetup>('@angular-capacitor-workspace/i18n setup', {
  factory: () => {
    throw new Error(
      'TranslationService has no locales. Call provideTranslations() in the ' +
        "application's providers, or provideI18n() where there is no design system " +
        'to do it for you.',
    );
  },
});

/** The app's message source. The design system itself never ships messages. */
export const TRANSLATION_LOADER = new InjectionToken<TranslationLoader>(
  '@angular-capacitor-workspace/i18n loader',
);

/**
 * A locale the build has already chosen, which suppresses negotiation and
 * persistence. Absent in an app that switches language at runtime.
 */
export const FIXED_LOCALE: InjectionToken<Locale> = new InjectionToken<Locale>(
  '@angular-capacitor-workspace/i18n fixed locale',
);
