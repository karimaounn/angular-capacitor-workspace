import { InjectionToken } from '@angular/core';
import type { ThemeConfig } from './config';

export const THEME_CONFIG = new InjectionToken<ThemeConfig>(
  '@angular-capacitor-workspace/theming config',
  {
    factory: () => {
      throw new Error(
        'ThemeService has no palettes. Call provideTheme() in the ' + "application's providers.",
      );
    },
  },
);
