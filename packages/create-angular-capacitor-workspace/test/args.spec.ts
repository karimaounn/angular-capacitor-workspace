import { describe, expect, it } from 'vitest';
import { CATALOG_IDS } from 'angular-capacitor-workspace';
import { ArgError, parseArguments, USAGE } from '../src/args';

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

describe('--marketing', () => {
  it('takes the flag repeated, one site per name', () => {
    expect(
      parseArguments(['ws', '--marketing', 'site', '--marketing', 'docs']).options.marketing,
    ).toEqual([{ name: 'site' }, { name: 'docs' }]);
  });

  it('is absent unless asked for', () => {
    expect(parseArguments(['ws', '--app', 'shop']).options.marketing).toBeUndefined();
  });

  it('needs a name, rather than generating a site called the empty string', () => {
    expect(() => parseArguments(['ws', '--marketing='])).toThrow(/--marketing needs a name/);
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
    expect(options.marketing).toEqual([{ name: 'site', origin: 'https://acme.example' }]);
  });

  it('binds to the site before it, not to all of them', () => {
    // The same rule --mobile follows, and the same mistake it would otherwise
    // make: one address on every canonical URL in the workspace.
    const { options } = parseArguments([
      'ws',
      '--marketing',
      'site',
      '--marketing-origin',
      'https://acme.example',
      '--marketing',
      'docs',
      '--marketing-origin',
      'https://docs.acme.example',
    ]);
    expect(options.marketing).toEqual([
      { name: 'site', origin: 'https://acme.example' },
      { name: 'docs', origin: 'https://docs.acme.example' },
    ]);
  });

  it('leaves the sites it does not follow to the schematic placeholder', () => {
    const { options } = parseArguments([
      'ws',
      '--marketing',
      'site',
      '--marketing',
      'docs',
      '--marketing-origin',
      'https://docs.acme.example',
    ]);
    expect(options.marketing).toEqual([
      { name: 'site' },
      { name: 'docs', origin: 'https://docs.acme.example' },
    ]);
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

describe('--report', () => {
  it('carries the path for the harness to read', () => {
    const { reportPath } = parseArguments(['ws', '--report', '/tmp/run.json']);
    expect(reportPath).toBe('/tmp/run.json');
  });

  it('does not by itself count as the user having made choices', () => {
    // Harness plumbing, like --self-spec. If it suppressed the prompts, the
    // matrix would be exercising a path no user ever takes.
    expect(parseArguments(['ws', '--report', '/tmp/run.json']).nonInteractive).toBe(false);
    expect(
      parseArguments(['ws', '--app', 'shop', '--report', '/tmp/run.json']).nonInteractive,
    ).toBe(true);
  });
});

describe('--with', () => {
  it('takes the flag repeated, or one comma-separated list, or both', () => {
    for (const argv of [
      ['ws', '--with', 'cdk'],
      ['ws', '--with=cdk'],
      ['ws', '--with', 'cdk,cdk'],
      ['ws', '--with', 'cdk', '--with', 'cdk'],
    ]) {
      expect(parseArguments(argv).options.packages, argv.join(' ')).toEqual(['cdk']);
    }
  });

  it('is absent unless asked for, so nothing extra is installed', () => {
    expect(parseArguments(['ws', '--app', 'shop']).options.packages).toBeUndefined();
  });

  it('names the catalog when the id is not in it, before the minutes are spent', () => {
    expect(() => parseArguments(['ws', '--with', 'cdkk'])).toThrow(ArgError);
    expect(() => parseArguments(['ws', '--with', 'cdkk'])).toThrow(/Known: cdk/);
  });

  it('rejects an empty entry rather than silently dropping it', () => {
    expect(() => parseArguments(['ws', '--with', 'cdk,'])).toThrow(/needs the name of a package/);
  });
});

describe('the usage text', () => {
  it('lists every catalog package, so --help cannot fall behind the catalog', () => {
    for (const id of CATALOG_IDS) {
      expect(USAGE).toContain(id);
    }
  });

  it('keeps those rows inside an 80-column terminal', () => {
    // They are rendered from the catalog, so a summary written one clause too
    // long wraps `--help` into nonsense. Fail here rather than there. Colour is
    // off when stdout is not a terminal, so these are real columns.
    expect(catalogRows()).toHaveLength(CATALOG_IDS.length);
    expect(catalogRows().filter((row) => row.length > 80)).toEqual([]);
  });

  it('bullets them, so the catalog reads as a list and not as a wrapped line', () => {
    // `--with`'s description is one line and the catalog rows sit under it at
    // the same indent. Unmarked, the first one reads as the description
    // continuing and the rest read as prose; the bullet is what makes them
    // choices. It hangs left of the description column, so the summaries still
    // line up with every other description in the help.
    for (const row of catalogRows()) {
      expect(row).toMatch(/^ {24}• /);
    }
  });
});

/** The `--with` rows, found the way a reader finds them: by the id they offer. */
function catalogRows(): string[] {
  return USAGE.split('\n').filter((line) =>
    CATALOG_IDS.some((id) => line.trimStart().startsWith(`• ${id} `)),
  );
}
