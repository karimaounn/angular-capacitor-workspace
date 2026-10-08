import { designSystemIn } from '../../extend/design-system';
import type { WorkspaceView } from '../../utils/workspace-view';
import type { WorkspacePlugin } from '../types';

/** The design system's locale table, relative to the library's root. */
export const LOCALE_TABLE = 'src/lib/i18n/i18n.tokens.ts';

/**
 * Parses `LOCALES` and `DEFAULT_LOCALE` back out of the design system's locale
 * table.
 *
 * Read back rather than recorded anywhere, because that file says it is the
 * only place a locale name lives and this is the code that has to believe it.
 * The regexes match the declarations as `files/lib/.../i18n.tokens.ts.template`
 * writes them; a table someone has reshaped reads as no translation, and the
 * projects generated after that get none.
 */
export function installedLocales(
  workspace: WorkspaceView,
): { locales: string[]; defaultLocale: string } | undefined {
  const design = designSystemIn(workspace);
  const source = design && workspace.read(`${design.root}/${LOCALE_TABLE}`);
  if (source === undefined) {
    return undefined;
  }

  const list = source.match(/export const LOCALES = \[([^\]]*)\] as const;/)?.[1];
  const fallback = source.match(/export const DEFAULT_LOCALE: Locale = '([^']+)';/)?.[1];
  if (list === undefined || fallback === undefined) {
    return undefined;
  }

  const locales = [...list.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
  return locales.length > 0 ? { locales, defaultLocale: fallback } : undefined;
}

/**
 * Runtime translation in the apps, and one build per language for the sites.
 *
 * The token is read off the locale table's presence, the witness the schematic
 * itself trusts; the parse is needed only where the locales are, to wire a
 * project generated later into the same set.
 */
export const i18nPlugin: WorkspacePlugin = {
  id: 'i18n',
  requested: (options) =>
    (options.i18n ?? []).length > 0
      ? {
          locales: options.i18n,
          ...(options.defaultLocale ? { defaultLocale: options.defaultLocale } : {}),
        }
      : undefined,
  features: (options) => ((options.i18n ?? []).length > 0 ? ['i18n'] : []),
  detect(workspace) {
    const design = designSystemIn(workspace);
    return design && workspace.exists(`${design.root}/${LOCALE_TABLE}`) ? ['i18n'] : [];
  },
  // Naming the project re-runs the library half too. That half writes only
  // files that are not there yet, so the library's own — edited or not — are
  // left as they are, and the alternative is a second entry point that exists
  // only to skip it.
  forProject(workspace, project) {
    const installed = installedLocales(workspace);
    if (!installed || workspace.projects[project]?.projectType !== 'application') {
      return undefined;
    }
    return { ...installed, apps: [project] };
  },
};
