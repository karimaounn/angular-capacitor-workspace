import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { ConfigError, readConfigLiteral } from '../utils/config-file';
import { fail, workspaceRoot } from './command';

/** The design system's own config, which this reads and never writes. */
export const CONTRAST_CONFIG = 'src/config/contrast.ts';
export const PALETTES_CONFIG = 'src/config/palettes.ts';

interface Pairing {
  fg: string;
  bg: string;
  min: number;
  label: string;
}

interface Sass {
  compileString(source: string, options: { loadPaths: string[] }): { css: string };
}

const MODES = [
  { name: 'light', index: 1 },
  { name: 'dark', index: 2 },
] as const;

/**
 * `check-contrast <library>` — verifies that every pairing the library
 * declares meets WCAG contrast, for every palette, in both light and dark mode.
 *
 * The values are obtained by compiling the real Sass — once per palette per
 * mode — rather than by re-deriving them here. A checker that reimplements the
 * token logic will happily agree with itself while disagreeing with what
 * ships, and the disagreement surfaces as a bug report about text nobody can
 * read.
 *
 * The pairings and the palettes are the library's, in its `src/config/`; the
 * colours are whatever `$palettes` in its `_ref.scss` declares. Sass is the
 * workspace's, resolved from its root, so this package does not carry a second
 * copy of it.
 */
export function checkContrast(args: readonly string[], cwd: string): number {
  const library = args[0];
  if (!library) {
    fail('usage: angular-capacitor-workspace check-contrast <library>', 2);
  }

  const root = workspaceRoot(cwd);
  const projects =
    (
      JSON.parse(readFileSync(join(root, 'angular.json'), 'utf8')) as {
        projects?: Record<string, { root?: string }>;
      }
    ).projects ?? {};
  const libRoot = projects[library]?.root;
  if (libRoot === undefined) {
    fail(`check-contrast: there is no project "${library}" in angular.json.`, 2);
  }
  const stylesDir = join(root, libRoot, 'src', 'styles');
  const pairings = readPairings(join(root, libRoot, CONTRAST_CONFIG));
  const sass = loadSass(root);

  const palettes = paletteNames(stylesDir);
  assertConfigAgrees(join(root, libRoot, PALETTES_CONFIG), palettes);

  const failures: string[] = [];
  const skipped: string[] = [];
  let checked = 0;

  for (const palette of palettes) {
    for (const mode of MODES) {
      const tokens = tokensFor(sass, stylesDir, palette, mode.index);

      for (const pairing of pairings) {
        const fgRaw = tokens[pairing.fg];
        const bgRaw = tokens[pairing.bg];
        const where = `${palette}/${mode.name}: ${pairing.fg} on ${pairing.bg}`;

        if (fgRaw === undefined || bgRaw === undefined) {
          skipped.push(`${where} — token not emitted`);
          continue;
        }

        const fg = parseColor(fgRaw);
        const bg = parseColor(bgRaw);
        if (!fg || !bg) {
          // A non-hex token (a gradient, a colour-mix) cannot be checked this
          // way. Reported rather than dropped: an unchecked pairing that looks
          // checked is the failure mode this whole command exists to prevent.
          skipped.push(`${where} — not a plain colour (${fgRaw} / ${bgRaw})`);
          continue;
        }

        checked++;
        const ratio = contrast(fg, bg);
        if (ratio < pairing.min) {
          failures.push(
            `FAIL  ${palette}/${mode.name}  ${pairing.fg} on ${pairing.bg}\n` +
              `      ${pairing.label}\n` +
              `      ${ratio.toFixed(2)}:1, needs ${pairing.min}:1  (${fgRaw} on ${bgRaw})`,
          );
        }
      }
    }
  }

  for (const failure of failures) {
    process.stderr.write(`${failure}\n`);
  }
  for (const note of skipped) {
    process.stderr.write(`SKIP  ${note}\n`);
  }
  process.stdout.write(
    `\nchecked ${checked} pairing(s) across ${palettes.length} palette(s) × ${MODES.length} mode(s)\n`,
  );

  if (failures.length > 0) {
    process.stderr.write(`\n${failures.length} contrast failure(s).\n`);
    return 1;
  }
  if (skipped.length > 0) {
    // Skips are not failures, but a table that quietly checks nothing is not
    // a passing table.
    process.stderr.write(`${skipped.length} pairing(s) could not be checked.\n`);
  }
  process.stdout.write('All declared pairings meet their contrast requirement.\n');
  return 0;
}

/** The pairings in the library's config, checked for shape before anything is compiled. */
function readPairings(file: string): Pairing[] {
  const config = readConfig(
    file,
    'CONTRAST',
    '`export const CONTRAST = { pairings: [{ fg, bg, min, label }] }`',
  ) as { pairings?: unknown } | undefined;
  const pairings = config?.pairings;
  const valid = (entry: unknown): entry is Pairing => {
    const pairing = entry as Partial<Pairing>;
    return (
      typeof pairing?.fg === 'string' &&
      typeof pairing.bg === 'string' &&
      typeof pairing.min === 'number' &&
      typeof pairing.label === 'string'
    );
  };
  if (!Array.isArray(pairings) || !pairings.every(valid)) {
    fail(
      `check-contrast: CONTRAST in ${file} must be \`{ pairings: [{ fg, bg, min, label }] }\`.`,
      2,
    );
  }
  return pairings;
}

/** A literal from one of the library's config files, or a failure that says what it has to be. */
function readConfig(file: string, name: string, shape: string): unknown {
  if (!existsSync(file)) {
    fail(`check-contrast: ${file} does not exist. It holds ${shape}.`, 2);
  }
  try {
    return readConfigLiteral(readFileSync(file, 'utf8'), name, file);
  } catch (error) {
    if (error instanceof ConfigError) {
      fail(`check-contrast: ${error.message}`, 2);
    }
    throw error;
  }
}

function loadSass(root: string): Sass {
  try {
    return createRequire(join(root, 'package.json'))('sass') as Sass;
  } catch {
    return fail(
      'check-contrast: cannot find `sass` in this workspace. It is a devDependency ' +
        'of the design system; run `npm install`.',
      2,
    );
  }
}

/** Compiles one palette in one mode and returns its custom properties. */
function tokensFor(
  sass: Sass,
  stylesDir: string,
  palette: string,
  modeIndex: number,
): Record<string, string> {
  const source = `
    @use 'semantic';
    .probe { @include semantic.mode('${palette}', ${modeIndex}); }
  `;
  const { css } = sass.compileString(source, { loadPaths: [stylesDir] });

  const tokens: Record<string, string> = {};
  for (const [, name, value] of css.matchAll(/--([\w-]+):\s*([^;]+);/g)) {
    tokens[name!] = value!.trim();
  }
  return tokens;
}

/** Every palette name declared in `_ref.scss`. */
function paletteNames(stylesDir: string): string[] {
  const source = readFileSync(join(stylesDir, '_ref.scss'), 'utf8');
  const block = source.match(/\$palettes:\s*\(([\s\S]*?)\n\);/);
  if (!block) {
    return fail(
      'check-contrast: could not find the $palettes map in _ref.scss. Checking ' +
        'zero palettes silently would be worse than stopping.',
    );
  }
  return [...block[1]!.matchAll(/^\s*'([^']+)':\s*\(/gm)].map(([, name]) => name!);
}

/**
 * The palettes the config lists must be the palettes the styles declare.
 *
 * Two sources of truth, one of them Sass and one of them TypeScript, and
 * nothing in the type system connects them. The failure is quiet in the worst
 * way: a palette in the Storybook toolbar or the theme toggle with no
 * `[data-palette]` block behind it looks like a control that does nothing, and
 * a palette in the styles that the config never lists is one nobody can reach.
 * This is the cheapest place to notice, because this already has to parse the
 * map.
 */
function assertConfigAgrees(file: string, names: readonly string[]): void {
  const config = readConfig(file, 'PALETTES', '`export const PALETTES = [{ id, label }]`');
  const listed = Array.isArray(config)
    ? config.map((entry) => (entry as { id?: unknown }).id)
    : undefined;
  if (!listed?.every((id): id is string => typeof id === 'string')) {
    fail(`check-contrast: PALETTES in ${file} must be \`[{ id, label }]\`.`, 2);
  }

  const missing = names.filter((name) => !listed.includes(name));
  const extra = listed.filter((id) => !names.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    fail(
      'FAIL  src/config/palettes.ts and the stylesheet disagree about which palettes exist\n' +
        `      in _ref.scss but not in PALETTES: ${missing.join(', ') || 'none'}\n` +
        `      in PALETTES but not in _ref.scss: ${extra.join(', ') || 'none'}`,
    );
  }
}

function parseColor(value: string): [number, number, number] | undefined {
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/i.test(hex)) {
    return undefined;
  }
  const full =
    hex.length === 3
      ? hex
          .split('')
          .map((char) => char + char)
          .join('')
      : hex;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.2 relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (value: number) => {
    const srgb = value / 255;
    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}
