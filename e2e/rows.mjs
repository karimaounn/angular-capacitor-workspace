/**
 * The matrix rows, shared by matrix.mjs and sweep.mjs.
 *
 * One list, because two drift: the sweep once audited a `full` row that had
 * fallen behind the matrix's and never audited `multi-app` at all, so a daily
 * issue could name fewer rows than the advisory actually reached.
 */

/**
 * The matrix.
 *
 * Each row exists because it exercises a policy path the others do not:
 * `minimal` proves the baseline is clean without any of our remedies;
 * `full` is the only row where Storybook forces the devkit peer, Capacitor
 * drags in xcode and orval drags in undici — three different rungs of the
 * ladder at once, and the only row that runs the e2e suites, including the
 * marketing site's AXE crawl. It also carries `--with aria`, which is where a
 * catalog range meets the real resolver: a CDK or an Aria the registry does not
 * have at the Angular line fails the install here rather than in someone's
 * project. Asked for as `aria` alone rather than `cdk,aria` on purpose — that is
 * the path where `requires` has to produce the CDK, and Aria peers it at an
 * exact version, so npm is the judge of whether the two ranges agree. It also
 * carries `--i18n en,fr,ar`, which is the only place the generated translation
 * code is compiled rather than string-matched: ng-packagr builds the service,
 * the pipe and the picker, the app builds against them, the generated spec runs
 * in browser mode, and the marketing site is built three times over — once per
 * language, each prerendered into its own directory — with `verify-prerender`
 * checking `<html lang>`, the hreflang alternates and route parity across all
 * of them. Arabic specifically, because it is the row's only RTL locale and the
 * only one whose plural categories go past `one`/`other`;
 * `multi-app` proves per-project ports and script naming survive more than one
 * app *and* more than one marketing site — two sites are two sets of canonical
 * URLs, a shared postbuild script and two entries in `npm run build` — and that
 * a site generated without an origin still builds; `lib-only`
 * proves the library stands alone, which is what `ng add` into an existing
 * workspace produces.
 */
export const ROWS = {
  minimal: {
    args: ['--app', 'app'],
    checks: ['build', 'test'],
  },
  full: {
    args: [
      '--app',
      'shop',
      '--mobile',
      'android',
      '--marketing',
      'site',
      '--marketing-origin',
      'https://site.example',
      '--ui-lib',
      'ui',
      '--codegen',
      'orval',
      '--e2e',
      'playwright',
      '--with',
      'aria',
      '--i18n',
      'en,fr,ar',
    ],
    checks: [
      'build:libs',
      'contrast',
      'codegen',
      'build',
      'build:marketing',
      'test',
      'storybook',
      'e2e',
    ],
  },
  'multi-app': {
    args: [
      '--app',
      'shop',
      '--mobile',
      'android,ios',
      '--app',
      'admin',
      '--marketing',
      'site',
      '--marketing',
      'docs',
      '--marketing-origin',
      'https://docs.example',
      '--ui-lib',
      'ui',
      '--e2e',
      'playwright',
    ],
    checks: ['build:libs', 'ports', 'build'],
  },
  'lib-only': {
    args: ['--ui-lib', 'ui'],
    checks: ['build:libs', 'contrast', 'test'],
  },
};
