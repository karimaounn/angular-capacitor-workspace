import { chain, schematic, type Rule, type Tree } from '@angular-devkit/schematics';
import { POLICY } from '../../policy/advisories';
import { applyPolicy, type Manifest } from '../../policy/apply';
import { collectBuilders } from '../../utils/workspace';
import { inferFeatures } from '../../cli/doctor';

export interface NgAddOptions {
  e2e?: 'playwright' | false;
  uiLib?: string;
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
    }),
    options.uiLib ? schematic('ui-lib', { name: options.uiLib }) : noop(),
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
    const { manifest: patched } = applyPolicy(
      manifest,
      {
        features: inferFeatures(process.cwd(), manifest),
        builders: collectBuilders(tree),
      },
      POLICY,
    );

    tree.overwrite('/package.json', `${JSON.stringify(patched, null, 2)}\n`);
    return tree;
  };
}
