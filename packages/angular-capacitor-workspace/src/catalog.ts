import { latestVersions } from '@schematics/angular/utility/latest-versions';

/**
 * The packages this generator knows how to wire in on request.
 *
 * `npm install @angular/cdk` is one command and needs no generator. What a
 * catalog entry adds is the rest of it: a range chosen against the Angular line
 * rather than `latest`, the peer declaration a library needs before it can
 * publish a component built on the package, the feature token that scopes a
 * future policy remedy to the workspaces that actually carry it, and a section
 * in the generated README saying what the package is for and the one thing that
 * bites people. That is what makes this worth a flag.
 *
 * The list is deliberately short and deliberately curated. Anything here is
 * something the maintainers have resolved against the Angular line and run
 * through the audit gate; a package nobody has done that for belongs on the end
 * of an `npm install`, not in this file.
 *
 * To add one: an entry below, a row in the `--with` help (which renders itself
 * from here), and a test. If it needs an install script, it also needs an
 * `allowScripts` entry in policy/advisories.ts — otherwise npm >= 11.6 blocks
 * the script and the package installs half-configured.
 */

/** Which block of the generated `package.json` a catalog package belongs in. */
export type DependencyBlock = 'dependencies' | 'devDependencies';

export interface CatalogPackage {
  name: string;
  /** The range written into the generated manifest. */
  range: string;
  /**
   * `dependencies` for anything that ends up in the browser bundle,
   * `devDependencies` for build-time and tooling packages.
   */
  block: DependencyBlock;
}

export interface CatalogEntry {
  /** What the user types: `--with cdk`. */
  id: string;
  /** Heading for the generated README section, and the answer the prompt echoes. */
  title: string;
  /**
   * One line, for `--help` and the prompt list. Short: it is printed in a
   * 26-column-indented help row, and `--help` is read in an 80-column terminal.
   */
  summary: string;
  packages: readonly CatalogPackage[];
  /**
   * Also declare the packages as peers of every library in the workspace.
   *
   * For a package a design-system library legitimately builds on. A library
   * that imports `@angular/cdk` without declaring it publishes a package that
   * resolves only by accident of hoisting — ng-packagr warns, and the consumer
   * finds out. Angular's own library schematic declares `@angular/core` and
   * `@angular/common` the same way; this follows it.
   */
  libraryPeer?: boolean;
  /** Markdown for the generated README, under `## <title>`. */
  guidance: string;
}

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'cdk',
    title: 'Angular CDK',
    summary: 'overlays, a11y, drag & drop, virtual scrolling',
    packages: [
      {
        name: '@angular/cdk',
        // The CDK is released in lockstep with the framework, so the range
        // Angular's own schematics write for `@angular/core` is the right range
        // for it too. Delegated rather than pinned in policy/versions.ts for
        // the reason stated at the top of that file: a version Angular has an
        // opinion about is not ours to freeze, and a hand-maintained `^22.x`
        // here would be one more number to remember at every release.
        range: latestVersions.Angular,
        block: 'dependencies',
      },
    ],
    libraryPeer: true,
    guidance: `
[\`@angular/cdk\`](https://material.angular.dev/cdk/categories) is behaviour
without opinions about looks: overlays and positioning, focus management and
live announcements, drag and drop, virtual scrolling, keyboard navigation. It
is the layer a design system is built *on*, which is why it is a runtime
dependency here and a peer of every library in this workspace.

It ships two stylesheets, and neither is loaded for you. Anything that renders
outside its component's DOM — a dialog, a menu, a tooltip, an autocomplete —
needs the overlay one, or it opens unpositioned with no backdrop and looks like
a broken component rather than a missing stylesheet. Add it to the app's
\`styles\` in \`angular.json\`:

\`\`\`json
"styles": [
  "node_modules/@angular/cdk/overlay-prebuilt.css",
  "projects/<app>/web/src/styles.scss"
]
\`\`\`

\`node_modules/@angular/cdk/a11y-prebuilt.css\` is the other one, needed only if
you use \`cdkVisuallyHidden\`.

The CDK's version tracks Angular's: upgrade it in the same step as the
framework, never on its own.
`,
  },
];

/** Catalog ids, in the order they are offered. */
export const CATALOG_IDS: readonly string[] = CATALOG.map((entry) => entry.id);

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/**
 * The message for an id that is not in the catalog.
 *
 * Shared so the CLI and the schematic reject the same typo the same way — one
 * wrapping it in an `ArgError` with the usage attached, the other in a
 * `SchematicsException`.
 */
export function unknownPackageMessage(id: string): string {
  return `"${id}" is not one of the packages this generator wires in. Known: ${CATALOG_IDS.join(', ')}.`;
}

/**
 * Resolves ids to entries, in catalog order, ignoring repeats.
 *
 * Catalog order rather than the order they were typed, so `--with cdk --with x`
 * and `--with x --with cdk` produce byte-identical manifests and READMEs.
 */
export function resolveCatalog(ids: readonly string[]): CatalogEntry[] {
  const wanted = new Set(ids);
  for (const id of wanted) {
    if (!catalogEntry(id)) {
      throw new Error(unknownPackageMessage(id));
    }
  }
  return CATALOG.filter((entry) => wanted.has(entry.id));
}

/** The policy feature token a catalog entry contributes. */
export function packageFeature(id: string): string {
  return `pkg:${id}`;
}
