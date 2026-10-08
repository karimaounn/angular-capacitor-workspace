import {
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import type { I18nConfig, Locale } from './config';
import { FIXED_LOCALE, I18N_SETUP, TRANSLATION_LOADER, type TranslationLoader } from './tokens';
import { TranslationService } from './translation';

export interface I18nOptions {
  /**
   * The `localStorage` key the active locale is kept under. A script that
   * applies the locale before the first paint has to read the same one.
   */
  readonly storageKey: string;
  /**
   * Pin the locale instead of negotiating one.
   *
   * For a build that IS one locale — a prerendered site built once per language
   * into `/en/` and `/fr/`, where the URL has already chosen. Negotiating there
   * would be wrong twice: the prerendered HTML is in the build's locale, so a
   * visitor whose browser prefers another would watch the text change under
   * them, and the stored preference from one language's pages would then
   * override the next.
   *
   * A pinned locale is never persisted, for the same reason.
   */
  readonly locale?: Locale;
}

/**
 * Runtime translation for an application: the workspace's locales, the app's
 * messages, and where the choice is stored.
 *
 *     provideI18n(I18N, loadCatalog, { storageKey: 'ui.locale' })
 *
 * A workspace's design system wraps this as `provideTranslations(loader)`, with
 * its config and key filled in, so an app never repeats them.
 *
 * Also registers an app initializer that awaits the first catalog, so bootstrap
 * blocks just long enough to avoid a flash of raw message keys — and, because
 * that instantiates `TranslationService`, `<html lang>` and `<html dir>` are set
 * before the first component renders. During a prerender that initializer is
 * what puts translated text in the static HTML rather than message keys.
 */
export function provideI18n(
  config: I18nConfig,
  loader: TranslationLoader,
  options: I18nOptions,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: I18N_SETUP, useValue: { config, storageKey: options.storageKey } },
    { provide: TRANSLATION_LOADER, useValue: loader },
    ...(options.locale ? [{ provide: FIXED_LOCALE, useValue: options.locale }] : []),
    provideAppInitializer(() => inject(TranslationService).ready()),
  ]);
}
