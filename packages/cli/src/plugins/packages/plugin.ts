import { installedCatalogIds, packageFeature, withRequired } from '../../catalog';
import type { WorkspacePlugin } from '../types';

/**
 * Curated packages from the catalog (`--with`), one feature token each.
 *
 * Tokens are expanded through `requires` rather than taken literally:
 * `--with aria` installs the CDK too, and a remedy scoped to `pkg:cdk` has to
 * reach it. Read back from the manifest, which is circular for a guard whose
 * job is to decide whether a package should be there and is not circular here:
 * nothing prunes a package the user asked for by name.
 */
export const packagesPlugin: WorkspacePlugin = {
  id: 'packages',
  requested: (options) =>
    (options.packages ?? []).length > 0 ? { packages: options.packages } : undefined,
  features: (options) => [...withRequired(options.packages ?? [])].map(packageFeature),
  detect: (workspace) => installedCatalogIds(workspace.dependencies).map(packageFeature),
  // Every package the workspace carries, re-applied: an app gets the
  // stylesheets and the service worker the others have, and a library the
  // peers. Idempotent, so the projects that already have them are untouched.
  forProject(workspace) {
    const ids = installedCatalogIds(workspace.dependencies);
    return ids.length > 0 ? { packages: ids } : undefined;
  },
};
