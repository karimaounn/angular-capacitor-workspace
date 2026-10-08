/*
 * Runtime translation for an angular-capacitor-workspace.
 *
 * Every locale is in one build and switches without a reload — the only shape
 * that fits an app shipped inside a Capacitor shell, whose `webDir` has room
 * for one `index.html`. The workspace's design system binds this to its
 * `src/config/i18n.ts` and re-exports it, so applications import from there.
 */

export { localeTables } from './config';
export type {
  Direction,
  I18nConfig,
  Locale,
  LocaleTables,
  Register,
  RegisteredI18n,
  TranslationCatalog,
  TranslationParams,
} from './config';
export { FIXED_LOCALE, I18N_SETUP, TRANSLATION_LOADER } from './tokens';
export type { I18nSetup, TranslationLoader } from './tokens';
export { provideI18n } from './providers';
export type { I18nOptions } from './providers';
export { TranslationService } from './translation';
export { TranslatePipe } from './translate-pipe';
