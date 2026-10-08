import { chain, schematic, type Rule, type Tree } from '@angular-devkit/schematics';
import { POLICY } from '../../policy/advisories';
import { applyPolicy, type Manifest } from '../../policy/apply';
import { collectBuilders } from '../../utils/workspace';
import { treeView } from '../../utils/workspace-view';
import { inferFeatures } from '../../cli/doctor';
import { detectedFeatures } from '../../plugins/registry';

export interface NgAddOptions {
  e2e?: 'playwright' | false;
  uiLib?: string;
  theming?: boolean;
}

/**
 * `ng add angular-capacitor-workspace` — the overlay applied to a workspace
 * that already exists.
 *
 * The same rules `create` runs, minus the `ng new` bootstrap. This is the path
 * for adopting the conventions in a project that predates the generator, and
 * the reason the schematics live in their own package rather than inside the
 * `create-*` shell.
 */
export function ngAdd(options: NgAddOptions = {}): Rule {
  return chain([
    schematic('workspace', {
      e2e: options.e2e ?? false,
      uiLib: options.uiLib,
      mobile: false,
      // The project's README, house rules and CI are its own.
      keepExisting: true,
    }),
    options.uiLib ? schematic('ui-lib', { name: options.uiLib }) : noop(),
    // Into the library only, and into an existing app only where it has the
    // shell this collection generates: a header to put the toggle in.
    options.uiLib && options.theming !== false ? schematic('theming', {}) : noop(),
    applyDependencyPolicy(),
  ]);
}

function noop(): Rule {
  return (tree: Tree) => tree;
}

/**
 * Applies the policy to an existing manifest.
 *
 * Features are inferred from the workspace rather than from the options,
 * because an existing workspace already has opinions — a Storybook someone
 * added by hand still forces the peer that makes pruning impossible, whether or
 * not this invocation asked for one.
 */
function applyDependencyPolicy(): Rule {
  return (tree: Tree) => {
    const raw = tree.read('/package.json');
    if (raw === null) {
      return tree;
    }

    const manifest = JSON.parse(raw.toString('utf8')) as Manifest;
    // The plugins' tokens from the tree as well as from disk: a plugin this
    // run installed is in the tree, and on disk only once the run is over.
    const features = inferFeatures(process.cwd(), manifest);
    for (const feature of detectedFeatures(treeView(tree))) {
      features.add(feature);
    }
    const { manifest: patched } = applyPolicy(
      manifest,
      { features, builders: collectBuilders(tree) },
      POLICY,
    );

    tree.overwrite('/package.json', `${JSON.stringify(patched, null, 2)}\n`);
    return tree;
  };
}
