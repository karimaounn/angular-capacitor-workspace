/** `system` follows the OS; the other two override it in both directions. */
export type ThemeMode = 'system' | 'light' | 'dark';

/** One palette: the name its stylesheet block is keyed by, and what a person picks it by. */
export interface Palette {
  readonly id: string;
  readonly label: string;
}

/**
 * Where a workspace tells this package which palettes it ships, so `PaletteId`
 * is their union rather than `string`:
 *
 *     declare module '@angular-capacitor-workspace/theming' {
 *       interface Register {
 *         palettes: typeof PALETTES;
 *       }
 *     }
 *
 * The design system's generated `theme.ts` does this.
 */
export interface Register {}

/** The registered palettes, or the general shape before anything registers them. */
export type RegisteredPalettes = Register extends {
  palettes: infer Palettes extends readonly Palette[];
}
  ? Palettes
  : readonly Palette[];

/** A palette the workspace ships. */
export type PaletteId = RegisteredPalettes[number]['id'];

/** What `provideTheme()` is given. */
export interface ThemeConfig {
  /** The palettes on offer, in the order a picker offers them. */
  readonly palettes: readonly Palette[];
  /**
   * Namespaces the `localStorage` keys, so two apps on one origin keep their
   * own choices. Whatever applies the stored theme before the first paint — a
   * script in `index.html` — has to read the same keys; see `themeStorageKeys`.
   */
  readonly storagePrefix: string;
  /**
   * The palette before anything is chosen: the one the stylesheet's `:root`
   * carries. `default` unless said otherwise.
   */
  readonly defaultPalette?: string;
}

/**
 * The `localStorage` keys a prefix gives: `ui` → `ui.theme-mode` and
 * `ui.theme-palette`. The one definition of them, which the generator's
 * before-paint script is checked against.
 */
export function themeStorageKeys(prefix: string): {
  readonly mode: string;
  readonly palette: string;
} {
  return { mode: `${prefix}.theme-mode`, palette: `${prefix}.theme-palette` };
}
