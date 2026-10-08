import type { GenerateOptions } from '../../api';
import { designSystemIn } from '../../extend/design-system';
import { isPrerendered, type WorkspaceView } from '../../utils/workspace-view';
import type { WorkspacePlugin } from '../types';

/** The file that makes a design system a themed one, relative to the library's root. */
export const THEME_SERVICE = 'src/lib/theme/theme.ts';

/** On by default wherever there is a design system to theme; `theming: false` turns it off. */
function wanted(options: GenerateOptions): boolean {
  return Boolean(options.uiLib) && options.theming !== false;
}

function installed(workspace: WorkspaceView): boolean {
  const design = designSystemIn(workspace);
  return design !== undefined && workspace.exists(`${design.root}/${THEME_SERVICE}`);
}

/**
 * Theme switching: a colour-scheme and palette toggle in every app's header.
 *
 * The design system already declares every palette in light and dark, keyed
 * off two attributes on `<html>`. This is the runtime that lets a visitor
 * choose — `ThemeService`, the toggle, and the inline script that applies the
 * stored choice before the first paint. Apps only: a prerendered site's HTML is
 * served to everyone, so nothing may write one visitor's theme into it.
 */
export const themingPlugin: WorkspacePlugin = {
  id: 'theming',
  requested: (options) => (wanted(options) ? {} : undefined),
  features: (options) => (wanted(options) ? ['theming'] : []),
  detect: (workspace) => (installed(workspace) ? ['theming'] : []),
  forProject(workspace, project) {
    const target = workspace.projects[project];
    if (!installed(workspace) || target?.projectType !== 'application' || isPrerendered(target)) {
      return undefined;
    }
    return { apps: [project] };
  },
};
