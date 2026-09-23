import { chain, SchematicsException, type Rule, type Tree } from '@angular-devkit/schematics';
import { resolveCatalog, type CatalogEntry, type DependencyBlock } from '../../catalog';
import { updateJson } from '../../utils/json-file';
import {
  addDependencies,
  appendSection,
  ANGULAR_JSON,
  README_MD,
  readProjects,
} from '../../utils/workspace';

export interface PackagesOptions {
  /** Catalog ids — see src/catalog.ts. */
  packages?: string[];
}

/**
 * Wires curated packages into the workspace.
 *
 * Invoked by the generator for `--with`, and by hand afterwards:
 *
 *     ng generate angular-capacitor-workspace:packages cdk
 *
 * The ids are checked here rather than by an `enum` in schema.json, so the
 * catalog stays the one place the list lives. A second copy in a JSON file
 * would be a list to keep in step, and the day it fell behind the error would
 * be a schema violation naming neither the typo nor the alternatives.
 */
export function packages(options: PackagesOptions = {}): Rule {
  return () => {
    const ids = (options.packages ?? []).map((id) => id.trim()).filter((id) => id !== '');

    let entries: CatalogEntry[];
    try {
      entries = resolveCatalog(ids);
    } catch (error) {
      throw new SchematicsException((error as Error).message);
    }

    return chain(entries.map((entry) => wire(entry)));
  };
}

function wire(entry: CatalogEntry): Rule {
  return (tree: Tree) => {
    for (const block of ['dependencies', 'devDependencies'] as const) {
      const wanted = rangesFor(entry, block);
      if (Object.keys(wanted).length > 0) {
        // Not overwritten: a range someone has raised by hand is a decision,
        // and the policy floors are what exist to raise one back.
        addDependencies(tree, wanted, block);
      }
    }

    if (entry.libraryPeer) {
      declareAsLibraryPeer(tree, entry);
    }

    // Idempotent on the heading, so re-running for a package the workspace
    // already has leaves the section — and any edits to it — alone.
    appendSection(tree, README_MD, entry.title, entry.guidance);
  };
}

function rangesFor(entry: CatalogEntry, block: DependencyBlock): Record<string, string> {
  return Object.fromEntries(
    entry.packages.filter((pkg) => pkg.block === block).map((pkg) => [pkg.name, pkg.range]),
  );
}

/**
 * Declares the entry's packages as peers of every library in the workspace.
 *
 * A library's `package.json` is what ships to a registry, and a peer it does
 * not declare is a dependency its consumers are not asked to provide. The root
 * manifest carries the real installed range; this only says "a consumer needs
 * one too", which is exactly what Angular's library schematic writes for
 * `@angular/core`.
 */
function declareAsLibraryPeer(tree: Tree, entry: CatalogEntry): void {
  if (!tree.exists(ANGULAR_JSON)) {
    return;
  }

  for (const [name, project] of Object.entries(readProjects(tree))) {
    if (project.projectType !== 'library' || !project.root) {
      continue;
    }

    const manifest = `/${project.root}/package.json`;
    if (!tree.exists(manifest)) {
      // A library without its own manifest is not one ng-packagr built, so
      // there is nothing for a peer declaration to travel in.
      continue;
    }

    updateJson(tree, manifest, (file) => {
      file.mustGet(
        ['peerDependencies'],
        `the peerDependencies block of library "${name}", which the Angular ` +
          `library schematic creates`,
      );
      for (const pkg of entry.packages) {
        if (!file.has(['peerDependencies', pkg.name])) {
          file.modify(['peerDependencies', pkg.name], pkg.range);
        }
      }
      file.sortKeys(['peerDependencies']);
    });
  }
}
