import { chain, noop, schematic, type Rule, type Tree } from '@angular-devkit/schematics';
import type { GenerateOptions } from '../api';
import { treeView, type WorkspaceView } from '../utils/workspace-view';
import { codegenPlugin } from './codegen/plugin';
import { i18nPlugin } from './i18n/plugin';
import { packagesPlugin } from './packages/plugin';
import { themingPlugin } from './theming/plugin';
import type { WorkspacePlugin } from './types';

/**
 * Every plugin, in the order they run.
 *
 * One order for both of the times a plugin runs — after the hosts during
 * `create`, and at the end of a host schematic for a project generated later —
 * so a workspace grown one `ng generate` at a time comes out the same as one
 * generated in a single run. It is visible in the files: two plugins that both
 * add a control to an app's header leave them in this order.
 *
 *   • theming first, so the theme toggle is the header's first control.
 *   • codegen before i18n, which is the order they always ran in.
 *   • i18n before packages, so `provideTranslations` lands in `app.config.ts`
 *     above `provideServiceWorker`.
 *   • packages last, so every library a catalog package declares itself a peer
 *     of already exists. Nothing depends on it having run.
 */
export const PLUGINS: readonly WorkspacePlugin[] = [
  themingPlugin,
  codegenPlugin,
  i18nPlugin,
  packagesPlugin,
];

export function pluginById(id: string): WorkspacePlugin | undefined {
  return PLUGINS.find((plugin) => plugin.id === id);
}

/** The plugin schematics a `create` request runs, after the hosts, in registry order. */
export function requestedPlugins(
  options: GenerateOptions,
): Array<{ schematic: string; options: Record<string, unknown> }> {
  return PLUGINS.flatMap((plugin) => {
    const requested = plugin.requested(options);
    return requested ? [{ schematic: plugin.id, options: requested }] : [];
  });
}

/** The feature tokens the plugins in a `create` request contribute. */
export function requestedFeatures(options: GenerateOptions): Set<string> {
  return new Set(PLUGINS.flatMap((plugin) => plugin.features(options)));
}

/** The feature tokens the plugins installed in a workspace contribute. */
export function detectedFeatures(workspace: WorkspaceView): Set<string> {
  return new Set(PLUGINS.flatMap((plugin) => plugin.detect(workspace)));
}

/**
 * Gives a project generated after the plugins the per-project half of each one
 * the workspace has.
 *
 * Every host schematic ends with this. A workspace is generated once and grown
 * for years, so `ng generate app` has to produce a project that matches the ones
 * beside it rather than one missing a layer everything else has — translation,
 * the theme toggle, a catalog package's stylesheet.
 *
 * Each plugin is asked against the tree as the previous one left it, and each
 * runs through its own schematic (see `WorkspacePlugin.forProject`).
 */
export function extendWithPlugins(project: string): Rule {
  return chain(
    PLUGINS.map((plugin) => (tree: Tree) => {
      const options = plugin.forProject?.(treeView(tree), project);
      return options ? schematic(plugin.id, options) : noop();
    }),
  );
}
