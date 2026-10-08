import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  filter,
  MergeStrategy,
  mergeWith,
  move,
  noop,
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import {
  exportFromLibrary,
  requireDesignSystem,
  type DesignSystem,
} from '../../extend/design-system';
import { addBootScript, addHeaderControl, addStarterSection } from '../../extend/shell';
import { appendSection, readProjects, README_MD } from '../../utils/workspace';
import { isPrerendered } from '../../utils/workspace-view';

export interface ThemingOptions {
  apps?: string[];
}

/**
 * Theme switching: `ThemeService` and a toggle in the design system, and the
 * toggle in every app's header.
 *
 * The library's stylesheet already declares every palette in light and dark,
 * keyed off `data-theme` and `data-palette` on `<html>`; without this plugin
 * nothing in an app sets them, and the page follows the system colour scheme.
 * What this adds is the part a visitor touches: a choice of mode and palette,
 * remembered, and applied before the first paint so it never arrives as a
 * flash.
 *
 *     ng generate angular-capacitor-workspace:theming
 */
export function theming(options: ThemingOptions = {}): Rule {
  return (tree: Tree) => {
    const design = requireDesignSystem(
      tree,
      'Theme switching lives in the design-system library, beside the tokens it switches',
    );

    return chain([
      library(tree, design),
      ...targets(tree, options.apps).map((app) => application(app, design)),
      (host: Tree) => {
        documentTheming(host, design);
        houseRules(host, design);
      },
    ]);
  };
}

/**
 * The applications that get the toggle: every one that is not a prerendered
 * site, or the ones named.
 *
 * A site is refused by name rather than skipped. Its pages are prerendered once
 * and served to everyone, so a theme applied while one visitor's page renders
 * would be baked into the HTML for all of them; asking for one is a mistake
 * worth hearing about.
 */
function targets(tree: Tree, requested: string[] | undefined): string[] {
  const projects = readProjects(tree);
  if (!requested?.length) {
    return Object.entries(projects)
      .filter(([, project]) => project.projectType === 'application' && !isPrerendered(project))
      .map(([name]) => name);
  }
  return requested.map((raw) => {
    const name = strings.dasherize(raw);
    const project = projects[name];
    if (!project) {
      throw new SchematicsException(`Project "${name}" is not in this workspace.`);
    }
    if (project.projectType !== 'application') {
      throw new SchematicsException(`Project "${name}" is a library, not an application.`);
    }
    if (isPrerendered(project)) {
      throw new SchematicsException(
        `"${name}" is a prerendered site. Its HTML is served to every visitor, so it ` +
          `follows the system colour scheme in CSS rather than a stored choice.`,
      );
    }
    return name;
  });
}

/**
 * Leaves files that already exist alone. What this writes is the user's from
 * the moment it is written, and the schematic runs again every time an app is
 * generated into a themed workspace.
 */
function onlyNew(tree: Tree): Rule {
  return filter((path) => !tree.exists(path));
}

// ── The library half ─────────────────────────────────────────────────────────

function library(tree: Tree, design: DesignSystem): Rule {
  const templates = apply(url('./files/lib'), [
    applyTemplates({ ...strings, prefix: design.prefix, importName: design.name }),
    move(`/${design.root}`),
    onlyNew(tree),
  ]);

  return chain([
    mergeWith(templates, MergeStrategy.Overwrite),
    (host: Tree) =>
      exportFromLibrary(host, design, './lib/theme/theme', [
        "export * from './lib/theme/theme';",
        "export * from './lib/theme/theme-toggle';",
      ]),
  ]);
}

// ── The application half ─────────────────────────────────────────────────────

function application(name: string, design: DesignSystem): Rule {
  return (tree: Tree) => {
    const project = readProjects(tree)[name]!;
    const root = project.root ?? '';
    const prefix = project.prefix ?? 'app';
    const starterPage = tree.exists(`/${root}/src/app/pages/home.page.html`);
    const e2e = tree.exists(`/${root}/playwright.config.ts`);
    const context = { ...strings, importName: design.name, prefix };

    return chain([
      // The showcase only where there is a starter page to put it on.
      starterPage
        ? mergeWith(
            apply(url('./files/showcase'), [
              applyTemplates(context),
              move(`/${root}`),
              onlyNew(tree),
            ]),
            MergeStrategy.Overwrite,
          )
        : noop(),
      // The suite only where the project has Playwright. It covers the one
      // thing the library's own tests cannot reach: the script in index.html,
      // which runs before Angular does.
      e2e
        ? mergeWith(
            apply(url('./files/app-e2e'), [
              applyTemplates(context),
              move(`/${root}`),
              onlyNew(tree),
            ]),
            MergeStrategy.Overwrite,
          )
        : noop(),
      (host: Tree) => {
        addBootScript(host, name, applyBeforePaint(design));
        addHeaderControl(host, name, {
          symbol: 'ThemeToggle',
          from: design.name,
          markup: `<${design.prefix}-theme-toggle />`,
        });
        addStarterSection(host, name, {
          symbol: 'ThemeShowcase',
          from: './theme/theme-showcase',
          markup: `<${prefix}-theme-showcase />`,
        });
      },
    ]);
  };
}

/**
 * The script that applies a saved theme before the first paint.
 *
 * Without it the page renders in the OS colour scheme, Angular boots, and the
 * saved preference lands a few hundred milliseconds later — a white flash on
 * every load for the users who most specifically asked not to have one. There
 * is no way to do this from Angular: by the time any framework code runs, the
 * first frame is on screen.
 *
 * Blocking and inline for the same reason: an external file is a round trip
 * that the paint does not wait for. A workspace with a strict Content-Security
 * -Policy needs a hash or nonce for this tag, which is the trade being made and
 * the reason it is one small script rather than a convenience layer.
 *
 * Its storage keys are `THEME_MODE_KEY` and `THEME_PALETTE_KEY` in
 * `files/lib/src/lib/theme/theme.ts.template`, and nothing ties the two
 * together but the theme e2e suite. Change one, change the other.
 */
function applyBeforePaint(design: DesignSystem) {
  return {
    id: 'theming:before-paint',
    html: `  <!-- theming:before-paint — applies the stored theme before the first paint.
       Its keys and values are ThemeService's, in ${design.name}. -->
  <script>
    (function () {
      try {
        var root = document.documentElement;
        var mode = localStorage.getItem('${design.prefix}.theme-mode');
        if (mode === 'light' || mode === 'dark') {
          root.setAttribute('data-theme', mode);
        }
        var palette = localStorage.getItem('${design.prefix}.theme-palette');
        if (palette) {
          root.setAttribute('data-palette', palette);
        }
      } catch (error) {
        // Storage can be blocked outright. The page then renders in the system
        // scheme, which is the right answer when nothing is stored.
      }
    })();
  </script>
`,
  };
}

// ── Documentation ────────────────────────────────────────────────────────────

function documentTheming(tree: Tree, design: DesignSystem): void {
  appendSection(
    tree,
    README_MD,
    'Theme switching',
    `Every app's header carries a theme toggle: a colour scheme — system, light or
dark — and a palette. Behind it is \`ThemeService\` in \`${design.name}\`, which writes
the choice onto \`<html>\` as \`data-theme\` and \`data-palette\` and remembers it in
\`localStorage\`. The stylesheet already declares every combination, so a switch
is an attribute write: nothing re-renders, and no component needs to know
theming exists.

A small inline script in each app's \`index.html\` applies the stored choice
before the first paint, so you never see a flash of the wrong theme. Its keys,
\`${design.prefix}.theme-mode\` and \`${design.prefix}.theme-palette\`, are
\`ThemeService\`'s; change one and change the other.

Marketing sites have neither the toggle nor that script, on purpose: their
pages are prerendered once and served to everyone, so nothing may bake one
visitor's choice into the HTML.

A palette added to \`${design.root}/src/styles/_ref.scss\` also goes in the
\`PALETTES\` array in \`${design.root}/src/lib/theme/theme.ts\`, which is the list
the toggle offers. \`npm run check:contrast\` fails while the two disagree.

An app generated later gets the toggle too. To give it to an app that predates
it, or to one you left out:

\`\`\`bash
ng generate angular-capacitor-workspace:theming --apps <app>
\`\`\``,
  );
}

/** The rules theme switching adds to AGENTS.md. Every one is a mistake that compiles. */
function houseRules(tree: Tree, design: DesignSystem): void {
  appendSection(
    tree,
    '/AGENTS.md',
    'Theme switching',
    `
Apps let the visitor choose a colour scheme and a palette. \`ThemeService\` in
\`${design.name}\` holds the choice as signals and writes it onto \`<html>\`.

- **Never read \`ThemeService\` to pick a colour.** Use the token that already
  means what you want and let the attributes resolve it. Read it only to show
  the choice back to the visitor.
- **The storage keys live in two places**: \`THEME_MODE_KEY\` and
  \`THEME_PALETTE_KEY\` in \`theme.ts\`, and the inline script in every app's
  \`index.html\` that applies them before the first paint. Change both, or the
  theme arrives a moment late, as a flash.
- **A palette is added in two places**: \`$palettes\` in \`_ref.scss\` and
  \`PALETTES\` in \`theme.ts\`. \`npm run check:contrast\` fails until they agree.
`,
  );
}
