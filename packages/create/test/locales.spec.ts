import { describe, expect, it } from 'vitest';
import {
  COMMON_LOCALES,
  localeChoices,
  localeLabel,
  OTHER_LOCALE,
  systemLanguage,
  withSourceFirst,
} from '../src/locales';

describe('the locale question', () => {
  it("reads this machine's base language, when the generator knows it", () => {
    expect(systemLanguage('fr-CA')).toBe('fr');
    expect(systemLanguage('en-US')).toBe('en');
    expect(systemLanguage('tlh')).toBeUndefined();
  });

  it('labels each tag with its endonym and the tag the flag takes', () => {
    expect(localeLabel('fr')).toBe('Français (fr)');
    expect(localeLabel('pt-BR')).toBe('Português (pt-BR)');
    expect(localeLabel('tlh')).toBe('tlh');
  });

  it('lists the system language first, once, and ends with Other', () => {
    const fr = localeChoices('fr').map((choice) => choice.value);
    expect(fr[0]).toBe('fr');
    expect(fr.filter((tag) => tag === 'fr')).toHaveLength(1);
    expect(fr.at(-1)).toBe(OTHER_LOCALE);

    const sv = localeChoices('sv').map((choice) => choice.value);
    expect(sv).toEqual(['sv', ...COMMON_LOCALES, OTHER_LOCALE]);
  });

  it('stays short enough to redraw in place', () => {
    // A known language outside the common list adds a row of its own.
    expect(localeChoices('sv').length).toBeLessThanOrEqual(14);
  });

  it('puts the source locale first, since the schematic takes the first tag', () => {
    expect(withSourceFirst(['en', 'fr', 'ar'], 'fr')).toEqual(['fr', 'en', 'ar']);
    expect(withSourceFirst(['en', 'fr'], 'en')).toEqual(['en', 'fr']);
  });
});
