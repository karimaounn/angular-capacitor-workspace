import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provideTheme, themeStorageKeys, ThemeService } from '../src/public-api';

/** A workspace's palettes, as its design system's `src/config/palettes.ts` lists them. */
const PALETTES = [
  { id: 'default', label: 'Slate' },
  { id: 'sand', label: 'Sand' },
] as const;

const KEYS = themeStorageKeys('test');

describe('themeStorageKeys', () => {
  it('namespaces both keys by the prefix', () => {
    expect(themeStorageKeys('ui')).toEqual({ mode: 'ui.theme-mode', palette: 'ui.theme-palette' });
  });
});

describe('ThemeService', () => {
  const root = document.documentElement;

  function configure(): void {
    TestBed.configureTestingModule({
      providers: [provideTheme({ palettes: PALETTES, storagePrefix: 'test' })],
    });
  }

  beforeEach(() => {
    localStorage.removeItem(KEYS.mode);
    localStorage.removeItem(KEYS.palette);
    root.removeAttribute('data-theme');
    root.removeAttribute('data-palette');
  });

  afterEach(() => {
    // The service writes to the real document, which every other test in this
    // file shares.
    root.removeAttribute('data-theme');
    root.removeAttribute('data-palette');
    TestBed.resetTestingModule();
  });

  function service(): ThemeService {
    const instance = TestBed.inject(ThemeService);
    TestBed.tick();
    return instance;
  }

  it('says what to call when nothing gave it palettes', () => {
    expect(() => TestBed.inject(ThemeService)).toThrow(/provideTheme\(\)/);
  });

  it('leaves data-theme off while the mode is system', () => {
    configure();
    service();
    // Absent, not "light": the stylesheet's prefers-color-scheme block only
    // governs when nothing has overridden it.
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('writes the chosen mode onto the document element', () => {
    configure();
    const theme = service();

    theme.mode.set('dark');
    TestBed.tick();
    expect(root.getAttribute('data-theme')).toBe('dark');

    theme.mode.set('light');
    TestBed.tick();
    expect(root.getAttribute('data-theme')).toBe('light');
  });

  it('returns to the system preference when the override is cleared', () => {
    configure();
    const theme = service();

    theme.mode.set('dark');
    TestBed.tick();
    theme.mode.set('system');
    TestBed.tick();

    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('writes the palette, including the default one', () => {
    configure();
    const theme = service();
    expect(root.getAttribute('data-palette')).toBe('default');

    theme.palette.set('sand');
    TestBed.tick();
    expect(root.getAttribute('data-palette')).toBe('sand');
  });

  it('persists the choice under the prefix it was given, and restores it', () => {
    configure();
    const theme = service();
    theme.mode.set('dark');
    theme.palette.set('sand');
    TestBed.tick();

    expect(localStorage.getItem(KEYS.mode)).toBe('dark');
    expect(localStorage.getItem(KEYS.palette)).toBe('sand');

    TestBed.resetTestingModule();
    configure();
    const restored = service();
    expect(restored.mode()).toBe('dark');
    expect(restored.palette()).toBe('sand');
  });

  it('ignores a stored value that is no longer a valid choice', () => {
    // A palette someone removed, or a key another app on this origin owns.
    localStorage.setItem(KEYS.palette, 'chartreuse');
    localStorage.setItem(KEYS.mode, 'sepia');
    configure();

    const theme = service();
    expect(theme.palette()).toBe('default');
    expect(theme.mode()).toBe('system');
  });

  it('resolves system to whatever the engine reports, and follows it', () => {
    const listeners: ((event: MediaQueryListEvent) => void)[] = [];
    const query = {
      matches: true,
      addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) =>
        listeners.push(listener),
      removeEventListener: () => undefined,
    };
    const original = window.matchMedia;
    window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
    try {
      configure();
      const theme = service();
      expect(theme.resolvedMode()).toBe('dark');

      listeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent));
      expect(theme.resolvedMode()).toBe('light');
    } finally {
      window.matchMedia = original;
    }
  });

  it('cycles system → light → dark → system', () => {
    configure();
    const theme = service();

    theme.next();
    expect(theme.mode()).toBe('light');
    theme.next();
    expect(theme.mode()).toBe('dark');
    theme.next();
    expect(theme.mode()).toBe('system');
  });
});
