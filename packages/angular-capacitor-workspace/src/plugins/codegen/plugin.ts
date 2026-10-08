import type { WorkspacePlugin } from '../types';

/**
 * OpenAPI client generation with orval, wired into the `pre*` hooks.
 *
 * No `forProject`: a client is generated for the apps it was asked for, and an
 * app added later is given one with `ng generate …:codegen --apps <app>`, since
 * not every app talks to the same API — or to one at all.
 */
export const codegenPlugin: WorkspacePlugin = {
  id: 'codegen',
  requested: (options) =>
    options.codegen ? { apps: (options.apps ?? []).map((app) => app.name) } : undefined,
  features: (options) => (options.codegen ? ['codegen'] : []),
  // The orval entry is safe evidence here: no policy rule scoped to `codegen`
  // decides whether orval itself stays.
  detect: (workspace) => ('orval' in workspace.dependencies ? ['codegen'] : []),
};
