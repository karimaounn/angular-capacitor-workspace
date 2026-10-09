import type { Rule } from '@angular-devkit/schematics';
import { PREPARE, ROOT_PREREQUISITES } from '../../utils/commands';
import { JsonFile } from '../../utils/json-file';
import { upToRoot } from '../../utils/project-scripts';
import { replaceGeneratedValue } from '../edit';

/** The verbs 22.6 and 22.7 hooked in a project's own manifest. */
const ENTRY_POINTS = ['start', 'watch', 'build', 'test', 'e2e'];

/**
 * Points each app's and site's `pre*` hooks at `angular-capacitor-workspace
 * prepare`, so `npm run build` and `npm run e2e` build the libraries once
 * rather than once per project.
 *
 * 22.6 and 22.7 wrote each hook as `npm run <prerequisite> --prefix <root>`,
 * one per prerequisite, in the order the schematics that added them ran.
 * `prepare` runs the same scripts, in `ROOT_PREREQUISITES` order, and nothing
 * under the project runner, which has run them already.
 *
 * Only the manifests those releases gave each project. A workspace from an
 * earlier 22.x keeps its hooks in the root as `pre<verb>:<project>` behind a
 * root `build` that chains the projects, where no hook can know another ran.
 */
export function prepareOnce(): Rule {
  return (tree, context) => {
    let projects: Record<string, { root?: string; projectType?: string }>;
    try {
      projects = new JsonFile(tree, '/angular.json').get(['projects']) ?? {};
    } catch {
      context.logger.warn(
        'Left the project hooks as they are: angular.json does not parse. In each ' +
          "app's and site's package.json, replace the `npm run codegen:optional` and " +
          `\`npm run build:libs\` in its pre* hooks with \`${PREPARE}\`.`,
      );
      return;
    }

    for (const { root, projectType } of Object.values(projects)) {
      if (projectType !== 'application' || !root) {
        continue;
      }
      const manifest = `/${root}/package.json`;
      const commands = ROOT_PREREQUISITES.map(
        (script) => `npm run ${script} --prefix ${upToRoot(root)}`,
      );
      // One prerequisite, or both in either order.
      const written = [...commands, commands.join(' && '), [...commands].reverse().join(' && ')];

      const manual =
        `Replace \`${commands.join('` and `')}\` in it with \`${PREPARE}\`, ` +
        'so `npm run build` builds the libraries once rather than once per project.';

      // An app from before 22.6 has no manifest of its own.
      if (!tree.exists(manifest)) {
        continue;
      }
      let scripts: Record<string, string>;
      try {
        scripts = new JsonFile(tree, manifest).get<Record<string, string>>(['scripts']) ?? {};
      } catch {
        context.logger.warn(`Left ${manifest} as it is: it does not parse. ${manual}`);
        continue;
      }

      for (const verb of ENTRY_POINTS) {
        const hook = scripts[`pre${verb}`];
        if (hook === undefined) {
          continue;
        }
        replaceGeneratedValue(tree, context.logger, manifest, ['scripts', `pre${verb}`], {
          // The shape this hook has, when it is one a release wrote. Anything
          // else is an edit, which is left alone with the manual step.
          generated: written.includes(hook) ? hook : commands.join(' && '),
          replacement: PREPARE,
          manual,
        });
      }
    }
  };
}
