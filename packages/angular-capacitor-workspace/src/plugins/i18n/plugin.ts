import { designSystemIn } from '../../extend/design-system';
import { isLocaleTag } from '../../locales';
import { ConfigError, readConfigLiteral } from '../../utils/config-file';
import type { WorkspaceView } from '../../utils/workspace-view';
import type { WorkspacePlugin } from '../types';

/** The design system's locale config, relative to the library's root. */
export const I18N_CONFIG = 'src/config/i18n.ts';

export interface LocaleEntry {
  readonly tag: string;
  /** The endonym: the language's name in that language. */
  readonly label: string;
  readonly direction: 'ltr' | 'rtl';
}

/** What `src/config/i18n.ts` says, which is everything the schematic needs to know. */
export interface I18nSetup {
  readonly defaultLocale: string;
  /** In the config's order, which is the picker's. */
  readonly locales: readonly LocaleEntry[];
}

/**
 * The workspace's locale config, or `undefined` when it has no translation.
 *
 * Read out of the design system's `src/config/i18n.ts` with
 * `readConfigLiteral`, which evaluates the `I18N` literal alone. The file says
 * at its top that it is the only place a locale lives and that it holds plain
 * values, and this is the code that holds it to both. Throws `ConfigError`,
 * naming what is wrong, when the file is there and cannot be used.
 */
export function installedI18n(workspace: WorkspaceView): I18nSetup | undefined {
  const design = designSystemIn(workspace);
  const file = design && `${design.root}/${I18N_CONFIG}`;
  const source = file && workspace.read(file);
  if (!file || source === undefined) {
    return undefined;
  }

  const config = readConfigLiteral(source, 'I18N', file) as {
    defaultLocale?: unknown;
    locales?: unknown;
  };
  const entries =
    config.locales && typeof config.locales === 'object'
      ? Object.entries(config.locales as Record<string, { label?: unknown; direction?: unknown }>)
      : [];
  if (entries.length === 0) {
    throw new ConfigError(`I18N.locales in ${file} must list at least one locale.`);
  }

  const locales = entries.map(([tag, entry]): LocaleEntry => {
    if (!isLocaleTag(tag)) {
      throw new ConfigError(`"${tag}" in ${file} is not a BCP-47 locale tag.`);
    }
    if (
      typeof entry?.label !== 'string' ||
      (entry.direction !== 'ltr' && entry.direction !== 'rtl')
    ) {
      throw new ConfigError(
        `I18N.locales['${tag}'] in ${file} must be \`{ label: string, direction: 'ltr' | 'rtl' }\`.`,
      );
    }
    return { tag, label: entry.label, direction: entry.direction };
  });

  const defaultLocale = config.defaultLocale;
  if (
    typeof defaultLocale !== 'string' ||
    !locales.some((locale) => locale.tag === defaultLocale)
  ) {
    throw new ConfigError(
      `I18N.defaultLocale in ${file} must be one of its locales ` +
        `(${locales.map((locale) => locale.tag).join(', ')}).`,
    );
  }
  return { defaultLocale, locales };
}

function configured(workspace: WorkspaceView): boolean {
  const design = designSystemIn(workspace);
  return design !== undefined && workspace.exists(`${design.root}/${I18N_CONFIG}`);
}

/**
 * Runtime translation in the apps, and one build per language for the sites.
 *
 * The token is read off the config's presence. A project generated later is
 * wired by running the schematic for it alone, which reads the locales from the
 * config itself.
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
  detect: (workspace) => (configured(workspace) ? ['i18n'] : []),
  // Naming the project re-runs the library half too. That half writes only
  // files that are not there yet, so the library's own — edited or not — are
  // left as they are.
  forProject(workspace, project) {
    if (!configured(workspace) || workspace.projects[project]?.projectType !== 'application') {
      return undefined;
    }
    return { apps: [project] };
  },
};
