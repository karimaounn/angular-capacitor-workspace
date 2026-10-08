import { SchematicsException, type Tree } from '@angular-devkit/schematics';
import { cli } from '../utils/commands';
import { updateJson } from '../utils/json-file';
import { projectScripts } from '../utils/project-scripts';
import { readProject } from '../utils/workspace';
import { addRootProvider } from './shell';

/**
 * The extension points of a prerendered site, on top of the shell's.
 *
 * What the `marketing` host promises plugins about a site: that each page's
 * head is written by `PageMetaStrategy`, which takes extensions through
 * dependency injection, and that its `build` and `postbuild` are the commands
 * below until someone changes them. A plugin that changes how a site is built
 * or what its head says goes through these, and never edits `page-meta.ts`,
 * `site.ts` or a script it would have to recognise by its text.
 */

/**
 * The commands the marketing host writes into a site's `build` and
 * `postbuild`: one prerendering build, then the sitemap and the crawler checks
 * over its output. One function, so the host that writes them and a plugin that
 * replaces them cannot disagree about what they were.
 *
 * The checks are this package's CLI rather than scripts copied into the
 * workspace, so an update of the package updates them. `locales` is for a site
 * built once per language, whose output is one directory per locale.
 */
export function siteBuild(name: string, locales: readonly string[] = []): SiteBuild {
  const across = locales.length > 0 ? ` --locales ${locales.join(',')}` : '';
  return {
    build: `ng build ${name}`,
    postbuild: `${cli(`sitemap ${name}${across}`)} && ${cli(`verify-prerender ${name}${across}`)}`,
  };
}

export interface SiteBuild {
  readonly build: string;
  readonly postbuild: string;
}

/**
 * Replaces a site's build: one `ng build` per language, say.
 *
 * Only where the scripts are still the host's, and idempotent: a site already
 * built the new way is left alone. A script someone has changed is theirs, so
 * that is a failure naming the command to put in by hand, rather than an
 * overwrite.
 */
export function replaceSiteBuild(tree: Tree, name: string, after: SiteBuild): void {
  const scripts = projectScripts(tree, name);
  const before = siteBuild(name);
  updateJson(tree, scripts.manifest, (file) => {
    for (const verb of ['build', 'postbuild'] as const) {
      const key = scripts.key(verb);
      const current = file.get<string>(['scripts', key]);
      if (current === after[verb]) {
        continue;
      }
      if (current !== undefined && current !== before[verb]) {
        throw new SchematicsException(
          `\`${key}\` in ${scripts.manifest.slice(1)} is not the command the marketing ` +
            `schematic wrote. Expected "${before[verb]}", found "${current}". ` +
            `Make it "${after[verb]}" by hand.`,
        );
      }
      file.modify(['scripts', key], after[verb]);
    }
  });
}

/**
 * Registers an extension of `PageMetaStrategy` in the site's `app.config.ts`.
 *
 * `PAGE_META_EXTENSIONS` is a multi-provider token the marketing template's
 * `seo/page-meta.ts` declares and the strategy reads on every navigation, so a
 * plugin changes what a site says about itself — the text of its titles, the
 * path its canonical names, tags of its own — by providing a class, rather than
 * by rewriting the strategy. See `PageMetaExtension` in that file.
 *
 * `from` is written from `src/app/`, where `app.config.ts` is, and `comment` is
 * the lines that explain the registration to whoever reads the config next.
 */
export function addPageMetaExtension(
  tree: Tree,
  name: string,
  extension: {
    readonly symbol: string;
    readonly from: string;
    readonly comment: readonly string[];
  },
): void {
  const root = readProject(tree, name).root ?? '';
  const strategy = `/${root}/src/app/seo/page-meta.ts`;
  if (!tree.read(strategy)?.toString('utf8').includes('PAGE_META_EXTENSIONS')) {
    throw new SchematicsException(
      `${strategy} has no PAGE_META_EXTENSIONS, so ${extension.symbol} cannot be registered ` +
        `with it. A site from an earlier 22.x writes its head without one: add the token ` +
        `and the three calls to it that the marketing template's page-meta.ts makes, or ` +
        `generate the site again.`,
    );
  }
  addRootProvider(tree, name, {
    symbol: extension.symbol,
    expression:
      extension.comment.map((line) => `// ${line}\n    `).join('') +
      `{ provide: PAGE_META_EXTENSIONS, useExisting: ${extension.symbol}, multi: true }`,
    named: [{ symbol: 'PAGE_META_EXTENSIONS', from: './seo/page-meta' }],
    imports: [`import { ${extension.symbol} } from '${extension.from}';`],
  });
}
