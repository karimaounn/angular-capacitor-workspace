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
   * Other catalog ids this entry cannot work without.
   *
   * For a package whose own peer range names another catalog package — not for
   * "these two go nicely together". `@angular/aria` peers `@angular/cdk` at an
   * *exact* version, so an `aria` that did not bring `cdk` would either leave
   * the peer to npm's auto-install, which writes no range anyone chose, or fail
   * ERESOLVE the first time the two drifted apart.
   *
   * Resolved transitively by `resolveCatalog`, so every consumer — the
   * manifest, the library peers, the README, the feature tokens — sees the
   * whole set rather than the part that was typed.
   */
  requires?: readonly string[];
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
  /**
   * Global stylesheets to put at the front of every application's `styles`.
   *
   * This is the half of `ng add` worth having. A vendor `ng-add` is two things
   * welded together — install the package, then run its setup schematic — and
   * the install half is not ours to give away: the gate resolves a lockfile and
   * audits it *before* anything reaches disk, which is the opposite of what
   * `ng add` does. The setup half is worth having, and for a workspace like
   * this one we can do it better than the vendor can: an `ng-add` resolves
   * against the default project, and a `--no-create-application` workspace
   * carrying several apps plus a marketing site has no meaningful default.
   * Here we know every application by name.
   *
   * Paths are workspace-relative, which is how the Angular builder resolves a
   * `styles` entry.
   */
  appStyles?: readonly string[];
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
    // The overlay sheet, wired for you. Anything that renders outside its own
    // component's DOM needs it, and without it the component does not fail —
    // it opens unpositioned with no backdrop, which reads as a broken component
    // rather than a missing stylesheet. 703 bytes gzipped is not a trade worth
    // making someone debug. `a11y-prebuilt.css` is left out: it is needed only
    // by `cdkVisuallyHidden`, so it is opt-in, and the README says so.
    appStyles: ['node_modules/@angular/cdk/overlay-prebuilt.css'],
    guidance: `
[\`@angular/cdk\`](https://material.angular.dev/cdk/categories) is behaviour
without opinions about looks: overlays and positioning, focus management and
live announcements, drag and drop, virtual scrolling, keyboard navigation. It
is the layer a design system is built *on*, which is why it is a runtime
dependency here and a peer of every library in this workspace.

It ships two stylesheets. The overlay one is already wired into every
application's \`styles\` in \`angular.json\`, ahead of the app's own
\`styles.scss\` so your rules still win:

\`\`\`json
"styles": [
  "node_modules/@angular/cdk/overlay-prebuilt.css",
  "projects/<app>/web/src/styles.scss"
]
\`\`\`

Anything that renders outside its component's DOM — a dialog, a menu, a
tooltip, an autocomplete — needs it, and without it nothing throws: the overlay
opens unpositioned with no backdrop, which reads as a broken component rather
than a missing stylesheet. That is why it is not left to you.

\`node_modules/@angular/cdk/a11y-prebuilt.css\` is the other one, and it is not
wired up: it is needed only if you use \`cdkVisuallyHidden\`. Add it the same
way, in front of the app's stylesheet.

**In Storybook**, neither sheet is loaded. The Storybook builder here runs with
no \`styles\` option on purpose — \`@storybook/angular\` routes a global sheet
into the component-style pipeline, where it never reaches css-loader — so
global CSS arrives through \`preview-head.html\` instead. A library component
built on an overlay will look unpositioned in Storybook while working in the
app. To fix it, serve the sheet and link it:

\`\`\`ts
// <lib>/.storybook/main.ts
staticDirs: ['./static', { from: '../../../node_modules/@angular/cdk', to: '/cdk' }],
\`\`\`

\`\`\`html
<!-- <lib>/.storybook/preview-head.html -->
<link rel="stylesheet" href="./cdk/overlay-prebuilt.css" />
\`\`\`

The CDK's version tracks Angular's: upgrade it in the same step as the
framework, never on its own.
`,
  },
  {
    id: 'aria',
    title: 'Angular Aria',
    summary: 'WAI-ARIA patterns as headless directives',
    packages: [
      {
        name: '@angular/aria',
        // Released in lockstep with the framework, like the CDK, and delegated
        // to `latestVersions` for the same reason. It is stricter than the CDK
        // about it: its `@angular/cdk` peer is an exact version rather than a
        // range, so both must come from the same resolution.
        range: latestVersions.Angular,
        block: 'dependencies',
      },
    ],
    // Not a convenience. `@angular/aria` peers `@angular/cdk` exactly, and its
    // directives import `@angular/cdk/a11y`, `/bidi` and `/platform` at
    // runtime.
    requires: ['cdk'],
    libraryPeer: true,
    // No stylesheet of its own: headless is the whole point, and the popup
    // patterns leave positioning to your CSS or to the CDK overlay, whose sheet
    // the `cdk` entry above already wires in.
    guidance: `
[\`@angular/aria\`](https://angular.dev/guide/aria/overview) is the
[WAI-ARIA patterns](https://www.w3.org/WAI/ARIA/apg/patterns/) as directives:
listbox, combobox, select, multiselect, autocomplete, menu, menubar, toolbar,
accordion, tabs, tree, grid. Each brings the keyboard model, the ARIA
attributes, focus management and right-to-left handling. Each brings no markup
and no CSS.

Where the CDK gives you mechanics — an overlay, a focus trap, a virtual
viewport — Aria gives you a pattern's behaviour. \`[ngListbox]\` over a list of
\`[ngOption]\`s is a conformant listbox with typeahead, arrow navigation and a
correct \`aria-activedescendant\`, and it looks like an unstyled \`<ul>\` until
you style it. That is the deal, not a bug — it is why this is the layer to build
a design system on, and why it is a peer of every library in this workspace
alongside the CDK.

**Nothing positions a popup for you.** The combobox family and the menus wire
the trigger to the popup — \`aria-expanded\`, \`aria-controls\`, the open and
close contract, focus return — and leave the popup wherever your CSS puts it.
Unstyled, it renders in flow, below the trigger, clipped by the first ancestor
with \`overflow: hidden\`, which reads as a broken dropdown rather than as one
nobody has positioned yet. Use the CDK overlay — installed with this entry, its
stylesheet already in every application's \`styles\` — or CSS anchor
positioning if your browser targets allow it.

**Test harnesses ship per pattern**, as CDK component harnesses:

\`\`\`ts
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { ListboxHarness } from '@angular/aria/listbox/testing';

const listbox = await TestbedHarnessEnvironment.harnessForFixture(fixture, ListboxHarness);
\`\`\`

They belong in the library's browser-mode Vitest specs rather than in jsdom: a
keyboard contract asserted against a fake event loop is a test of the fake.

**\`@angular/aria\` peers \`@angular/cdk\` at an exact version**, not a range.
Both track the framework, so upgrade all three in one step; \`npm update
@angular/aria\` on its own is an \`ERESOLVE\` waiting for the next CDK patch.

Angular Material is the other end of this trade: use it when you want
components that look finished without styling them. Aria is for when the visual
design is yours and only the accessibility is not.
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
 * The ids a request expands to: those asked for, plus whatever they `requires`,
 * transitively.
 *
 * Lenient about ids it does not know, so the caller gets to report a typo in its
 * own words — `resolveCatalog` with the catalog attached, the CLI with the usage
 * attached — rather than having this throw first with neither.
 */
export function withRequired(ids: readonly string[]): Set<string> {
  const wanted = new Set<string>();
  const queue = [...ids];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (wanted.has(id)) continue;
    wanted.add(id);
    queue.push(...(catalogEntry(id)?.requires ?? []));
  }
  return wanted;
}

/**
 * Resolves ids to entries, in catalog order, ignoring repeats.
 *
 * Catalog order rather than the order they were typed, so `--with cdk --with x`
 * and `--with x --with cdk` produce byte-identical manifests and READMEs.
 *
 * Only the ids that were asked for are checked against the catalog: a bad
 * `requires` is a bug in this file, and the shipped-catalog test is what catches
 * it.
 */
export function resolveCatalog(ids: readonly string[]): CatalogEntry[] {
  for (const id of new Set(ids)) {
    if (!catalogEntry(id)) {
      throw new Error(unknownPackageMessage(id));
    }
  }
  const wanted = withRequired(ids);
  return CATALOG.filter((entry) => wanted.has(entry.id));
}

/**
 * The catalog entries a workspace already carries, by id.
 *
 * The manifest is the only evidence there is, and unlike the policy's prune
 * guards that is not circular here: nothing removes a package the user asked
 * for by name, so reading it back cannot make it un-removable.
 *
 * `deps` is the merged dependency blocks — a catalog package is matched
 * wherever it was declared, since a range someone moved by hand is still a
 * package the workspace has.
 */
export function installedCatalogIds(deps: Record<string, unknown>): string[] {
  return CATALOG.filter((entry) => entry.packages.some((pkg) => pkg.name in deps)).map(
    (entry) => entry.id,
  );
}

/** The policy feature token a catalog entry contributes. */
export function packageFeature(id: string): string {
  return `pkg:${id}`;
}
