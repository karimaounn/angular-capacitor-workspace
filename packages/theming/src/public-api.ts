/*
 * Theme switching for an angular-capacitor-workspace.
 *
 * A colour scheme and a palette, as signals, written onto `<html>` as
 * `data-theme` and `data-palette` and remembered. The design system's
 * stylesheet declares every combination, so switching restyles the page
 * without a component re-rendering. The workspace's design system binds this to
 * its `src/config/palettes.ts` and re-exports it, so applications import from
 * there.
 */

export { themeStorageKeys } from './config';
export type {
  Palette,
  PaletteId,
  Register,
  RegisteredPalettes,
  ThemeConfig,
  ThemeMode,
} from './config';
export { THEME_CONFIG } from './tokens';
export { provideTheme } from './providers';
export { ThemeService } from './theme';
