import {
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fail, workspaceRoot } from './command';

/**
 * The postbuild checks of a prerendered site: `clean-dist`, `sitemap` and
 * `verify-prerender`. A site's `build` and `postbuild` run them.
 *
 * They read our own build output, not arbitrary HTML — Angular's serializer
 * writes attributes in a stable, double-quoted form — so a regex is enough and
 * no parser dependency is needed.
 *
 * LOCALES. A site generated with `--i18n` is built once per language, each into
 * its own directory, and is checked with `--locales en,fr`. Without it, a site
 * has one output, and every check below is the same code for both.
 */

interface Output {
  /** `null` for a site in one language. */
  locale: string | null;
  dir: string;
  /** The path the output is served under: `` or `/fr`. */
  base: string;
}

interface Page {
  file: string;
  /** The route within the app, the same in every language. */
  route: string;
  /** The path it is actually served at, locale prefix and all. */
  path: string;
  locale: string | null;
}

interface Built {
  root: string;
  outputs: Output[];
}

/** `<site> [--locales en,fr]`, and the outputs they name, which must exist. */
function built(command: string, args: readonly string[], cwd: string): Built {
  const site = args[0];
  if (!site || site.startsWith('--')) {
    fail(`usage: angular-capacitor-workspace ${command} <site> [--locales en,fr]`, 2);
  }
  const flag = args.indexOf('--locales');
  const locales =
    flag === -1
      ? []
      : (args[flag + 1] ?? '')
          .split(',')
          .map((tag) => tag.trim())
          .filter(Boolean);

  const workspace = workspaceRoot(cwd);
  const root = join(workspace, 'dist', site);
  const outputs: Output[] = locales.length
    ? locales.map((locale) => ({ locale, dir: join(root, locale), base: `/${locale}` }))
    : [{ locale: null, dir: join(root, 'browser'), base: '' }];

  const missing = outputs.filter((output) => !existsSync(output.dir));
  if (missing.length) {
    fail(
      [
        ...missing.map(
          (output) => `${command}: ${relative(workspace, output.dir)} does not exist.`,
        ),
        `${command}: build ${site} first.`,
      ].join('\n'),
      2,
    );
  }
  return { root, outputs };
}

/**
 * Every prerendered page in one output: each `index.html` under it, with the
 * path it is served at. `index.csr.html` is the client-rendering fallback, not
 * a page, and is skipped by name.
 */
function pages(output: Output): Page[] {
  return (readdirSync(output.dir, { recursive: true }) as string[])
    .filter((file) => basename(file) === 'index.html')
    .map((file) => {
      const rel = dirname(file).split(sep).join('/');
      const route = rel === '.' ? '/' : `/${rel}`;
      return {
        file: join(output.dir, file),
        route,
        path: output.base ? `${output.base}${route === '/' ? '/' : route}` : route,
        locale: output.locale,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

const decode = (value: string) =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const [, name, value] of tag.matchAll(/([\w:-]+)(?:="([^"]*)")?/g)) {
    attrs[name!] = value === undefined ? '' : decode(value);
  }
  return attrs;
}

interface Head {
  html: Record<string, string>;
  titles: string[];
  descriptions: string[];
  robots: string[];
  canonicals: string[];
  alternates: { hreflang: string; href: string }[];
  h1Count: number;
}

/** The parts of a page the SEO checks care about. */
function inspect(html: string): Head {
  const head = html.slice(0, html.indexOf('</head>'));
  const tags = (name: string) =>
    [...head.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((m) => attributes(m[0]));

  const metas = tags('meta');
  const meta = (key: string, value: string) =>
    metas.filter((m) => m[key] === value).map((m) => m['content'] ?? '');
  const links = tags('link');

  return {
    html: attributes(html.match(/<html\b[^>]*>/)?.[0] ?? ''),
    titles: [...head.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => decode(m[1]!)),
    descriptions: meta('name', 'description'),
    robots: meta('name', 'robots'),
    canonicals: links.filter((l) => l['rel'] === 'canonical').map((l) => l['href'] ?? ''),
    alternates: links
      .filter((l) => l['rel'] === 'alternate' && l['hreflang'])
      .map((l) => ({ hreflang: l['hreflang']!, href: l['href'] ?? '' })),
    h1Count: [...html.matchAll(/<h1[\s>]/g)].length,
  };
}

const isNoindex = (head: Head) => head.robots.some((r) => /\bnoindex\b/.test(r));

// ── clean-dist ───────────────────────────────────────────────────────────────

/**
 * `clean-dist <site>` — empties a site's output directory.
 *
 * For a site built once per language. Each `ng build` writes into its own
 * directory under one shared `outputPath.base`, and Angular's own
 * `deleteOutputPath` deletes that BASE — so the second language's build would
 * take the first one's output with it, and only the last language would
 * survive. The locale configurations turn it off, and this runs once before
 * them all instead.
 */
export function cleanDist(args: readonly string[], cwd: string): number {
  const site = args[0];
  if (!site) {
    fail('usage: angular-capacitor-workspace clean-dist <site>', 2);
  }
  // Resolved and checked rather than trusted: this deletes a directory tree,
  // and an argument with a `..` in it would delete one outside the workspace.
  const dist = join(workspaceRoot(cwd), 'dist');
  const target = resolve(dist, site);
  if (target === dist || relative(dist, target).startsWith('..')) {
    fail(`clean-dist: "${site}" is not an app in this workspace.`, 2);
  }
  rmSync(target, { recursive: true, force: true });
  return 0;
}

// ── sitemap ──────────────────────────────────────────────────────────────────

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * `sitemap <site> [--locales en,fr]` — writes `sitemap.xml` from the build
 * output.
 *
 * The prerender output is already the authoritative list of pages, so the
 * sitemap is derived from it rather than maintained by hand — the two cannot
 * drift. Each page contributes its own canonical URL; a page marked noindex
 * (the 404) is left out. Runs in the site's `postbuild`, before
 * `verify-prerender`, which checks that the result matches.
 *
 * LOCALES. One sitemap for the whole site, not one per language: a crawler is
 * given a single file and every page in it carries `xhtml:link` alternates
 * naming the same page in the other languages. It is written at the root of
 * the output, beside the per-language directories, and robots.txt is copied up
 * beside it — a robots.txt inside /en/ is a robots.txt nothing will read.
 */
export function sitemap(args: readonly string[], cwd: string): number {
  const { root, outputs } = built('sitemap', args, cwd);
  const localized = outputs[0]!.locale !== null;

  // route → locale → canonical URL. Keyed by route rather than by served path
  // so the translations of one page find each other.
  const byRoute = new Map<string, Map<string, string>>();

  for (const output of outputs) {
    for (const page of pages(output)) {
      const head = inspect(readFileSync(page.file, 'utf8'));
      if (isNoindex(head)) continue;
      // A page with no canonical is left out rather than failing here, so the
      // build reaches `verify-prerender`, which reports it together with every
      // other problem instead of one at a time.
      const [canonical] = head.canonicals;
      if (!canonical) continue;

      const forRoute = byRoute.get(page.route) ?? new Map<string, string>();
      forRoute.set(page.locale ?? '', canonical);
      byRoute.set(page.route, forRoute);
    }
  }

  const urls: string[] = [];
  for (const [, byLocale] of [...byRoute.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const [, canonical] of byLocale) {
      const alternates = localized
        ? [...byLocale].map(
            ([locale, href]) =>
              `\n    <xhtml:link rel="alternate" hreflang="${escapeXml(locale)}" href="${escapeXml(href)}"/>`,
          )
        : [];
      urls.push(`  <url><loc>${escapeXml(canonical)}</loc>${alternates.join('')}</url>`);
    }
  }

  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    localized
      ? '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">'
      : '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');

  // At the root of the output for a localized site, inside the single output
  // otherwise. Either way it is beside the robots.txt that points at it.
  writeFileSync(join(localized ? root : outputs[0]!.dir, 'sitemap.xml'), xml);

  if (localized) {
    // public/robots.txt is copied into every language's directory by the
    // build. One of them belongs at the root, where a crawler looks for it.
    const source = join(outputs[0]!.dir, 'robots.txt');
    if (existsSync(source)) {
      copyFileSync(source, join(root, 'robots.txt'));
    }
  }

  process.stdout.write(
    `sitemap: ${urls.length} URLs${localized ? ` across ${outputs.length} locales` : ''} → sitemap.xml\n`,
  );
  return 0;
}

// ── verify-prerender ─────────────────────────────────────────────────────────

/** What the generator writes when it is given no origin. RFC 2606 reserves it. */
const PLACEHOLDER_HOST = 'example.com';

/**
 * `verify-prerender <site> [--locales en,fr]` — fails the build if the site
 * would ship pages a crawler cannot use.
 *
 * A failed prerender still produces a build that looks fine — an empty shell
 * per route — and ranks for nothing. And pages that share a title or
 * description get treated as duplicates and ignored. Neither shows up anywhere
 * but a search console, weeks later, so this checks every page now:
 *
 *   • exactly one <h1>         zero means the render fell back to a shell
 *   • no data-theme on <html>  something pinned a colour scheme at build time,
 *                              overriding every visitor's OS setting
 *   • one <title> and one description, neither shared with any other page
 *     IN THE SAME LANGUAGE — two languages saying the same thing is a
 *     translation, not a duplicate
 *   • a canonical pointing at the page's own path — or, for a noindex page,
 *     no canonical at all
 *   • sitemap.xml lists exactly the indexable pages, and robots.txt points at it
 *
 * LOCALES. A localized site is checked once per language, and then across them:
 *   • <html lang> matches the language the directory is for. A prerender that
 *     fell back to the source locale is otherwise invisible — the page renders,
 *     in the wrong language, forever.
 *   • every indexable page names every language in its hreflang alternates,
 *     itself included, plus x-default. A page that lists only the others is
 *     treated as having no alternates at all.
 *   • every language prerendered the same set of routes.
 *
 * It also warns — never fails — when a localized build has nothing at `/`
 * (what serves the bare domain is a host redirect, which this cannot see), and
 * when the canonicals still point at the generator's placeholder origin.
 */
export function verifyPrerender(args: readonly string[], cwd: string): number {
  const { root, outputs } = built('verify-prerender', args, cwd);
  const localized = outputs[0]!.locale !== null;
  const locales = outputs.map((output) => output.locale!);

  const failures: string[] = [];
  const problem = (where: string, message: string) => failures.push(`${where}: ${message}`);

  const indexable: string[] = [];
  const origins = new Set<string>();
  const routesByLocale = new Map<string | null, Set<string>>();
  let xDefault: string | undefined;
  let total = 0;

  for (const output of outputs) {
    // Per language: two pages in different languages legitimately say the
    // same thing, and are not duplicates of each other.
    const seen = { title: new Map<string, string>(), description: new Map<string, string>() };
    const all = pages(output);
    total += all.length;
    routesByLocale.set(output.locale, new Set(all.map((page) => page.route)));

    if (all.length === 0) {
      problem(
        output.locale ?? 'output',
        'no prerendered pages — did every route fall back to the client?',
      );
    }

    for (const page of all) {
      const head = inspect(readFileSync(page.file, 'utf8'));
      const where = page.path;

      if (head.h1Count !== 1) problem(where, `${head.h1Count} <h1> elements, expected 1`);
      if ('data-theme' in head.html) {
        problem(where, `<html data-theme="${head.html['data-theme']}"> is pinned`);
      }

      if (output.locale && head.html['lang'] !== output.locale) {
        // The tell for a prerender that silently fell back to the source locale.
        problem(where, `<html lang="${head.html['lang'] ?? ''}">, expected "${output.locale}"`);
      }

      for (const [key, values] of [
        ['title', head.titles],
        ['description', head.descriptions],
      ] as const) {
        if (values.length !== 1 || !values[0]!.trim()) {
          problem(where, `${values.length} ${key} tags, expected 1 non-empty`);
          continue;
        }
        const other = seen[key].get(values[0]!);
        if (other) problem(where, `same ${key} as ${other}: "${values[0]}"`);
        else seen[key].set(values[0]!, where);
      }

      if (isNoindex(head)) {
        if (head.canonicals.length) problem(where, 'noindex page has a canonical');
        if (head.alternates.length) problem(where, 'noindex page has hreflang alternates');
        continue;
      }

      indexable.push(page.path);
      if (head.canonicals.length !== 1) {
        problem(where, `${head.canonicals.length} canonicals, expected 1`);
        continue;
      }
      const canonical = new URL(head.canonicals[0]!);
      origins.add(canonical.origin);
      if (canonical.pathname !== page.path) {
        problem(where, `canonical points at ${canonical.pathname}`);
      }

      if (localized) {
        const declared = new Set(head.alternates.map((link) => link.hreflang));
        // Kept for the root-redirect warning below: it is exactly the URL the
        // bare domain should fall back to.
        xDefault ??= head.alternates.find((link) => link.hreflang === 'x-default')?.href;
        for (const locale of locales) {
          if (!declared.has(locale)) problem(where, `no hreflang alternate for "${locale}"`);
        }
        if (!declared.has('x-default')) problem(where, 'no x-default hreflang alternate');
      }
    }
  }

  if (localized) {
    // Every language has to have prerendered the same routes, or one of them
    // is quietly missing a page that the others link to from their alternates.
    const [reference, ...rest] = [...routesByLocale.entries()];
    for (const [locale, routes] of rest) {
      for (const route of reference![1]) {
        if (!routes.has(route)) {
          problem(locale!, `did not prerender ${route}, which ${reference![0]} did`);
        }
      }
      for (const route of routes) {
        if (!reference![1].has(route)) {
          problem(reference![0]!, `did not prerender ${route}, which ${locale} did`);
        }
      }
    }
  }

  if (origins.size > 1) problem('canonicals', `span several origins: ${[...origins].join(', ')}`);
  const [origin] = origins;

  const outputRoot = localized ? root : outputs[0]!.dir;
  const sitemapFile = join(outputRoot, 'sitemap.xml');
  if (!existsSync(sitemapFile)) {
    problem('sitemap.xml', 'missing — `angular-capacitor-workspace sitemap` must run first');
  } else {
    const listed = [...readFileSync(sitemapFile, 'utf8').matchAll(/<loc>([^<]*)<\/loc>/g)].map(
      (m) => new URL(m[1]!).pathname,
    );
    const want = new Set(indexable);
    const got = new Set(listed);
    for (const p of want) if (!got.has(p)) problem('sitemap.xml', `missing ${p}`);
    for (const p of got) {
      if (!want.has(p)) problem('sitemap.xml', `lists ${p}, which is not an indexable page`);
    }
  }

  const robotsFile = join(outputRoot, 'robots.txt');
  const robots = existsSync(robotsFile) ? readFileSync(robotsFile, 'utf8') : '';
  if (origin && !robots.includes(`Sitemap: ${origin}/sitemap.xml`)) {
    problem('robots.txt', `no "Sitemap: ${origin}/sitemap.xml" line`);
  }

  if (failures.length) {
    fail(
      `verify-prerender: ${failures.length} problem(s) in ${total} pages\n\n` +
        failures.map((f) => `  ✗ ${f}`).join('\n'),
    );
  }

  // A warning, not a failure: what serves `/` is the host's business, and this
  // cannot see its configuration. But a localized site has no file there —
  // every page lives under a language — so unless something redirects, the
  // bare domain is a 404. That is the URL people type, link to and print.
  if (localized && !existsSync(join(root, 'index.html'))) {
    process.stderr.write(
      `verify-prerender: nothing in this build serves /. Every page is under ` +
        `${locales.map((locale) => `/${locale}/`).join(', ')}. Configure a redirect at your ` +
        `host that sends / to the visitor's language, falling back to ` +
        `${xDefault ?? 'the source locale'} — see the Translation section of the README.\n`,
    );
  }

  // A warning, not a failure: a fresh workspace should build. But a site
  // deployed like this tells every crawler that its pages live on someone
  // else's domain.
  if (origin && new URL(origin).hostname === PLACEHOLDER_HOST) {
    process.stderr.write(
      `verify-prerender: canonical URLs point at ${origin}, the generator's placeholder. ` +
        'Set SITE_ORIGIN in src/app/site.ts and the Sitemap line in public/robots.txt ' +
        'to the production origin before deploying.\n',
    );
  }
  process.stdout.write(
    `verify-prerender: ${total} pages OK (${indexable.length} indexable` +
      `${localized ? `, ${locales.length} locales` : ''})\n`,
  );
  return 0;
}
