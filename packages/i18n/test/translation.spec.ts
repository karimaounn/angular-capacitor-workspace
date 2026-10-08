import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FIXED_LOCALE,
  localeTables,
  provideI18n,
  TranslatePipe,
  TranslationService,
  type TranslationLoader,
} from '../src/public-api';

/** A workspace's config, as its design system's `src/config/i18n.ts` writes one. */
const CONFIG = {
  defaultLocale: 'en',
  locales: {
    en: { label: 'English', direction: 'ltr' },
    ar: { label: 'العربية', direction: 'rtl' },
    'pt-BR': { label: 'Português', direction: 'ltr' },
  },
} as const;

const STORAGE_KEY = 'test.locale';

describe('localeTables', () => {
  const tables = localeTables(CONFIG);

  it('lists the locales in the config’s order, which is the picker’s', () => {
    expect(tables.LOCALES).toEqual(['en', 'ar', 'pt-BR']);
    expect(tables.DEFAULT_LOCALE).toBe('en');
    expect(tables.LOCALE_DIRECTION).toEqual({ en: 'ltr', ar: 'rtl', 'pt-BR': 'ltr' });
    expect(tables.LOCALE_LABELS['ar']).toBe('العربية');
  });

  it('matches an exact tag, case-insensitively, and answers with the config’s spelling', () => {
    expect(tables.matchLocale('ar')).toBe('ar');
    expect(tables.matchLocale('pt-br')).toBe('pt-BR');
  });

  it('falls back from a region subtag to its base language', () => {
    expect(tables.matchLocale('ar-EG')).toBe('ar');
    expect(tables.matchLocale('en-ZZ')).toBe('en');
  });

  it('returns null for a locale the workspace does not ship', () => {
    expect(tables.matchLocale('xx')).toBeNull();
    expect(tables.matchLocale(undefined)).toBeNull();
    expect(tables.isLocale('xx')).toBe(false);
    expect(tables.isLocale('ar')).toBe(true);
  });

  it('takes the first supported entry of a preference list', () => {
    expect(tables.negotiateLocale(['xx', 'ar-SA', 'en'])).toBe('ar');
    expect(tables.negotiateLocale(['xx'])).toBeNull();
  });

  it('refuses a default the config does not list', () => {
    const broken = { defaultLocale: 'fr', locales: { en: { label: 'English', direction: 'ltr' } } };
    // @ts-expect-error — the compiler refuses it too.
    expect(() => localeTables(broken)).toThrow(/"fr" is not one of the locales/);
  });
});

describe('TranslationService', () => {
  const root = document.documentElement;

  // A synchronous loader: the catalogs are the unit under test, not the chunk
  // splitting. `ready()` still awaits it, so the async path is exercised.
  const catalogs: Record<string, Record<string, string>> = {
    en: {
      'app.title': 'Title',
      'home.greeting': 'Hello, {name}!',
      'cart.items.one': '{count} item',
      'cart.items.other': '{count} items',
    },
    ar: {
      'app.title': 'العنوان',
    },
  };

  const loader: TranslationLoader = (locale) => catalogs[locale] ?? {};

  function configure(locale?: string): void {
    TestBed.configureTestingModule({
      providers: [
        provideI18n(CONFIG, loader, {
          storageKey: STORAGE_KEY,
          ...(locale ? { locale } : {}),
        }),
      ],
    });
  }

  beforeEach(() => {
    localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    // The service writes to the real document, which every other test in this
    // file shares.
    root.removeAttribute('lang');
    root.removeAttribute('dir');
    TestBed.resetTestingModule();
  });

  async function service(): Promise<TranslationService> {
    const instance = TestBed.inject(TranslationService);
    await instance.ready();
    TestBed.tick();
    return instance;
  }

  it('says what to call when nothing gave it locales', () => {
    expect(() => TestBed.inject(TranslationService)).toThrow(/provideTranslations\(\)/);
  });

  it('writes lang and dir onto the document element', async () => {
    configure();
    const i18n = await service();

    expect(root.getAttribute('lang')).toBe('en');
    expect(root.getAttribute('dir')).toBe('ltr');

    i18n.setLocale('ar');
    TestBed.tick();
    expect(root.getAttribute('lang')).toBe('ar');
    expect(root.getAttribute('dir')).toBe('rtl');
    expect(i18n.isRtl()).toBe(true);
  });

  it('translates a key, and fills in its placeholders', async () => {
    configure();
    const i18n = await service();
    expect(i18n.translate('app.title')).toBe('Title');
    expect(i18n.translate('home.greeting', { name: 'Sam' })).toBe('Hello, Sam!');
  });

  it('leaves an unmatched placeholder visible rather than blanking it', async () => {
    configure();
    const i18n = await service();
    // A hole in a sentence is a bug worth seeing.
    expect(i18n.translate('home.greeting', { other: 'Sam' })).toContain('{name}');
  });

  it('returns the key itself when nothing translates it', async () => {
    configure();
    const i18n = await service();
    expect(i18n.translate('nothing.here')).toBe('nothing.here');
  });

  it('falls back to the source language for a key a translation lacks', async () => {
    configure();
    const i18n = await service();
    i18n.setLocale('ar');
    TestBed.tick();
    await i18n.ready();

    expect(i18n.translate('app.title')).toBe('العنوان');
    expect(i18n.translate('home.greeting', { name: 'Sam' })).toBe('Hello, Sam!');
  });

  it('selects a plural form from the count param', async () => {
    configure();
    const i18n = await service();

    // The categories come from Intl.PluralRules for the active locale, which is
    // the whole reason the lookup delegates rather than testing `count === 1`.
    expect(i18n.translate('cart.items', { count: 1 })).toBe('1 item');
    expect(i18n.translate('cart.items', { count: 7 })).toBe('7 items');
  });

  it('persists the active locale under the key it was given', async () => {
    configure();
    const i18n = await service();

    i18n.setLocale('ar');
    TestBed.tick();

    expect(localStorage.getItem(STORAGE_KEY)).toBe('ar');
  });

  it('starts from a stored choice, read the way the config spells it', async () => {
    localStorage.setItem(STORAGE_KEY, 'pt-br');
    configure();
    const i18n = await service();
    expect(i18n.locale()).toBe('pt-BR');
  });

  it('keeps a pinned locale, and neither negotiates nor stores one', async () => {
    localStorage.setItem(STORAGE_KEY, 'en');
    configure('ar');
    const i18n = await service();

    expect(i18n.locale()).toBe('ar');
    expect(i18n.switchable).toBe(false);
    i18n.setLocale('en');
    TestBed.tick();
    expect(i18n.locale()).toBe('ar');
    expect(TestBed.inject(FIXED_LOCALE)).toBe('ar');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('en');
  });
});

describe('TranslatePipe', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('lang');
    document.documentElement.removeAttribute('dir');
    TestBed.resetTestingModule();
  });

  it('translates, and follows a switch of locale', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideI18n(CONFIG, (locale) => ({ greeting: locale === 'ar' ? 'مرحبا' : 'Hello' }), {
          storageKey: STORAGE_KEY,
        }),
      ],
    });
    const i18n = TestBed.inject(TranslationService);
    await i18n.ready();
    const pipe = TestBed.runInInjectionContext(() => new TranslatePipe());

    expect(pipe.transform('greeting')).toBe('Hello');

    i18n.setLocale('ar');
    TestBed.tick();
    await i18n.ready();
    expect(pipe.transform('greeting')).toBe('مرحبا');
  });
});
