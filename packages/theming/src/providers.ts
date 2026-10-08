import { makeEnvironmentProviders, type EnvironmentProviders } from '@angular/core';
import type { ThemeConfig } from './config';
import { THEME_CONFIG } from './tokens';

/**
 * Theme switching for an application: the workspace's palettes, and where the
 * choice is stored.
 *
 *     provideTheme({ palettes: PALETTES, storagePrefix: 'ui' })
 *
 * A workspace's design system wraps this as `provideTheme()`, with its
 * palettes and prefix filled in, so an app never repeats them.
 */
export function provideTheme(config: ThemeConfig): EnvironmentProviders {
  return makeEnvironmentProviders([{ provide: THEME_CONFIG, useValue: config }]);
}
