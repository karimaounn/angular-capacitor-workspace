import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

/**
 * The workspace scripts, run as a generated workspace runs them: the built CLI,
 * in a directory on disk. They used to be copied into every workspace, where a
 * template test could only check their text; here they run.
 */
const cli = join(__dirname, '..', 'dist', 'cli', 'index.js');

if (!existsSync(cli)) {
  throw new Error(`${cli} does not exist. Run \`npm run build\` before the tests.`);
}

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acw-cli-'));
  write('angular.json', JSON.stringify({ projects: {} }));
});

function write(path: string, content: string): void {
  mkdirSync(join(root, dirname(path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function run(
  args: string[],
  { cwd = root, env = {} }: { cwd?: string; env?: Record<string, string> } = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: 'utf8',
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

const ORIGIN = 'https://site.example';

interface PageSpec {
  lang?: string;
  title: string;
  description?: string;
  /** Served path, for the canonical; omitted on a noindex page. */
  path?: string;
  noindex?: boolean;
  alternates?: Record<string, string>;
  h1?: number;
}

/** A page as Angular's prerender writes it, as far as the checks read it. */
function html(page: PageSpec): string {
  const head = [
    `<title>${page.title}</title>`,
    `<meta name="description" content="${page.description ?? `About ${page.title}.`}">`,
    page.noindex ? '<meta name="robots" content="noindex">' : '',
    page.path && !page.noindex ? `<link rel="canonical" href="${ORIGIN}${page.path}">` : '',
    ...Object.entries(page.alternates ?? {}).map(
      ([hreflang, path]) => `<link rel="alternate" hreflang="${hreflang}" href="${ORIGIN}${path}">`,
    ),
  ].join('');
  return (
    `<!DOCTYPE html><html lang="${page.lang ?? 'en'}"><head>${head}</head>` +
    `<body>${'<h1>Heading</h1>'.repeat(page.h1 ?? 1)}</body></html>`
  );
}

/** A single-language site's build: home, about and the 404. */
function singleSite(): void {
  write('dist/site/browser/index.html', html({ title: 'Home', path: '/' }));
  write('dist/site/browser/about/index.html', html({ title: 'About', path: '/about' }));
  write('dist/site/browser/404/index.html', html({ title: 'Not found', noindex: true }));
  write('dist/site/browser/robots.txt', `Sitemap: ${ORIGIN}/sitemap.xml\n`);
}

/** The same site built once per language, with every page naming every language. */
function localizedSite(overrides: Partial<Record<string, Partial<PageSpec>>> = {}): void {
  for (const locale of ['en', 'fr']) {
    for (const [route, title] of [
      ['/', 'Home'],
      ['/about', 'About'],
    ] as const) {
      const at = (tag: string) => (route === '/' ? `/${tag}/` : `/${tag}${route}`);
      const file = route === '/' ? 'index.html' : `${route.slice(1)}/index.html`;
      write(
        `dist/site/${locale}/${file}`,
        html({
          lang: locale,
          title: `${title} (${locale})`,
          path: at(locale),
          alternates: { en: at('en'), fr: at('fr'), 'x-default': at('en') },
          ...overrides[`${locale}${route}`],
        }),
      );
    }
    write(`dist/site/${locale}/robots.txt`, `Sitemap: ${ORIGIN}/sitemap.xml\n`);
  }
}

describe('sitemap and verify-prerender', () => {
  it('derive the sitemap from the build and pass a site a crawler can use', () => {
    singleSite();

    const sitemap = run(['sitemap', 'site']);
    expect(sitemap.status).toBe(0);
    const xml = readFileSync(join(root, 'dist/site/browser/sitemap.xml'), 'utf8');
    expect(xml).toContain(`<loc>${ORIGIN}/</loc>`);
    expect(xml).toContain(`<loc>${ORIGIN}/about</loc>`);
    expect(xml).not.toContain('404');

    const verify = run(['verify-prerender', 'site']);
    expect(verify.stderr).toBe('');
    expect(verify.status).toBe(0);
    expect(verify.stdout).toContain('3 pages OK (2 indexable)');
  });

  it('run from the site’s own directory, where its postbuild runs', () => {
    singleSite();
    mkdirSync(join(root, 'projects/site/web'), { recursive: true });
    expect(run(['sitemap', 'site'], { cwd: join(root, 'projects/site/web') }).status).toBe(0);
    expect(existsSync(join(root, 'dist/site/browser/sitemap.xml'))).toBe(true);
  });

  it('fail on every page a crawler could not use, and name each', () => {
    singleSite();
    write(
      'dist/site/browser/about/index.html',
      html({ title: 'Home', description: 'About Home.', path: '/elsewhere', h1: 2 }),
    );
    run(['sitemap', 'site']);

    const verify = run(['verify-prerender', 'site']);
    expect(verify.status).toBe(1);
    expect(verify.stderr).toContain('/about: 2 <h1> elements, expected 1');
    expect(verify.stderr).toContain('/about: same title as /: "Home"');
    expect(verify.stderr).toContain('/about: canonical points at /elsewhere');
  });

  it('refuse to check a site that has not been built', () => {
    const verify = run(['verify-prerender', 'site']);
    expect(verify.status).toBe(2);
    expect(verify.stderr).toContain('build site first');
  });

  describe('with --locales', () => {
    it('write one sitemap for every language, with alternates, beside robots.txt', () => {
      localizedSite();
      expect(run(['sitemap', 'site', '--locales', 'en,fr']).status).toBe(0);

      const xml = readFileSync(join(root, 'dist/site/sitemap.xml'), 'utf8');
      expect(xml).toContain(`<loc>${ORIGIN}/fr/about</loc>`);
      expect(xml).toContain(`hreflang="fr" href="${ORIGIN}/fr/"`);
      expect(existsSync(join(root, 'dist/site/robots.txt'))).toBe(true);

      const verify = run(['verify-prerender', 'site', '--locales', 'en,fr']);
      expect(verify.status).toBe(0);
      expect(verify.stdout).toContain('4 pages OK (4 indexable, 2 locales)');
      // A warning, not a failure: what serves the bare domain is the host's.
      expect(verify.stderr).toContain('nothing in this build serves /');
    });

    it('fail a language that rendered in another, or that names no alternate', () => {
      localizedSite({
        'fr/about': { lang: 'en', alternates: { en: '/en/about', 'x-default': '/en/about' } },
      });
      run(['sitemap', 'site', '--locales', 'en,fr']);

      const verify = run(['verify-prerender', 'site', '--locales', 'en,fr']);
      expect(verify.status).toBe(1);
      expect(verify.stderr).toContain('/fr/about: <html lang="en">, expected "fr"');
      expect(verify.stderr).toContain('/fr/about: no hreflang alternate for "fr"');
    });
  });
});

describe('clean-dist', () => {
  it('empties one site’s output, and nothing outside dist/', () => {
    write('dist/site/en/index.html', 'x');
    write('keep.txt', 'x');

    expect(run(['clean-dist', 'site']).status).toBe(0);
    expect(existsSync(join(root, 'dist/site'))).toBe(false);

    const escape = run(['clean-dist', '..']);
    expect(escape.status).toBe(2);
    expect(existsSync(join(root, 'keep.txt'))).toBe(true);
  });
});

describe('codegen', () => {
  it('skips, and says how to configure it, when the spec is not set and that is allowed', () => {
    const optional = run(['codegen', '--optional']);
    expect(optional.status).toBe(0);
    expect(optional.stdout).toContain('codegen: skipped — OPENAPI_SPEC is not set');

    // Asked for directly, the same thing is an error.
    const asked = run(['codegen', '--spec-env', 'API_SPEC']);
    expect(asked.status).toBe(1);
    expect(asked.stderr).toContain('API_SPEC is not set');
  });

  it('names a spec path that does not exist rather than letting orval fail on it', () => {
    const missing = run(['codegen'], { env: { OPENAPI_SPEC: 'api/openapi.yaml' } });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('points at "api/openapi.yaml", which does not exist');
  });
});

describe('check-contrast', () => {
  it('names the config it needs when the library has none', () => {
    write('angular.json', JSON.stringify({ projects: { ui: { root: 'projects/ui' } } }));
    const check = run(['check-contrast', 'ui']);
    expect(check.status).toBe(2);
    expect(check.stderr).toContain('contrast.config.mjs does not exist');
  });

  it('refuses a config that is not a table of pairings', () => {
    write('angular.json', JSON.stringify({ projects: { ui: { root: 'projects/ui' } } }));
    write('projects/ui/contrast.config.mjs', "export default { pairings: [{ fg: 'text' }] };\n");
    const check = run(['check-contrast', 'ui']);
    expect(check.status).toBe(2);
    expect(check.stderr).toContain('must export `default { pairings: [{ fg, bg, min, label }] }`');
  });
});

describe('preflight', () => {
  it('checks only the platforms it is asked about', () => {
    // An Android-only app on a Mac without Xcode is not a failed preflight.
    const android = run(['preflight', 'android']).stdout;
    expect(android).toContain('android sdk');
    expect(android).not.toContain('xcode');

    const ios = run(['preflight', 'ios']).stdout;
    expect(ios).toContain('xcode');
    expect(ios).not.toContain('java');
  });

  it('refuses a platform it does not know', () => {
    expect(run(['preflight', 'windows']).status).toBe(2);
  });
});

describe('the workspace root', () => {
  it('is found from below, and its absence is said plainly', () => {
    const outside = mkdtempSync(join(tmpdir(), 'acw-none-'));
    const lost = run(['verify-prerender', 'site'], { cwd: outside });
    expect(lost.status).toBe(2);
    expect(lost.stderr).toContain('No angular.json');
  });
});
