import { describe, expect, it } from 'vitest';
import { ArgError, parseArguments } from '../src/args';

describe('--ui-lib-prefix', () => {
  it('rides along with the library it names', () => {
    const { options } = parseArguments([
      'ws',
      '--ui-lib',
      'design-system',
      '--ui-lib-prefix',
      'ds',
    ]);
    expect(options.uiLib).toBe('design-system');
    expect(options.uiLibPrefix).toBe('ds');
  });

  it('is left unset when not given, so the schematic derives it', () => {
    const { options } = parseArguments(['ws', '--ui-lib', 'ui']);
    expect(options.uiLib).toBe('ui');
    expect(options.uiLibPrefix).toBeUndefined();
  });
});

describe('--ui-lib', () => {
  it('takes the documented default when given bare', () => {
    // `[name]` in the usage means optional, and parseArgs disagrees loudly.
    for (const argv of [
      ['ws', '--ui-lib'],
      ['ws', '--ui-lib', '--dry-run'],
      ['ws', '--ui-lib='],
    ]) {
      expect(parseArguments(argv).options.uiLib).toBe('ui');
    }
  });

  it('still takes a name when one follows', () => {
    expect(parseArguments(['ws', '--ui-lib', 'design-system']).options.uiLib).toBe('design-system');
    expect(parseArguments(['ws', '--ui-lib=design-system']).options.uiLib).toBe('design-system');
  });

  it('is absent unless asked for', () => {
    expect(parseArguments(['ws', '--app', 'shop']).options.uiLib).toBeUndefined();
  });

  it('refuses to be a prefix for a library nobody asked for', () => {
    expect(() => parseArguments(['ws', '--ui-lib-prefix', 'ds'])).toThrow(ArgError);
  });

  it('rejects what Angular would reject, before the minutes are spent', () => {
    for (const bad of ['1ds', 'my prefix', 'my_prefix', 'ds!']) {
      expect(() => parseArguments(['ws', '--ui-lib', 'ui', '--ui-lib-prefix', bad])).toThrow(
        /valid element-selector prefix/,
      );
    }
  });
});

describe('--marketing-origin', () => {
  it('rides along with the site it names, trimmed to the origin', () => {
    const { options } = parseArguments([
      'ws',
      '--marketing',
      'site',
      '--marketing-origin',
      'https://Acme.example/',
    ]);
    expect(options.marketingOrigin).toBe('https://acme.example');
  });

  it('is left unset when not given, so the schematic writes its placeholder', () => {
    expect(parseArguments(['ws', '--marketing', 'site']).options.marketingOrigin).toBeUndefined();
  });

  it('refuses to be the address of a site nobody asked for', () => {
    expect(() => parseArguments(['ws', '--marketing-origin', 'https://acme.example'])).toThrow(
      /there is no --marketing/,
    );
  });

  it('rejects a path, and suggests the origin it probably meant', () => {
    expect(() =>
      parseArguments([
        'ws',
        '--marketing',
        'site',
        '--marketing-origin',
        'https://acme.example/site',
      ]),
    ).toThrow(/did you mean https:\/\/acme\.example\?/);
  });

  it('rejects what is not an http(s) URL', () => {
    for (const bad of ['acme.example', 'ftp://acme.example']) {
      expect(() =>
        parseArguments(['ws', '--marketing', 'site', '--marketing-origin', bad]),
      ).toThrow(ArgError);
    }
  });
});
