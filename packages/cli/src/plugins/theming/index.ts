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
  buildOn,
  exportFromLibrary,
  requireDesignSystem,
  type DesignSystem,
} from '../../extend/design-system';
import {
  addBootScript,
  addHeaderControl,
  addRootProvider,
  addShellTestProvider,
  addStarterSection,
} from '../../extend/shell';
import { RUNTIME_PACKAGES } from '../../utils/own-package';
import { appendSection, readProjects, README_MD } from '../../utils/workspace';
import { isPrerendered } from '../../utils/workspace-view';

export interface ThemingOptions {
  apps?: string[];
  /** What to install `@angular-capacitor-workspace/theming` from, for a build not yet published. */
  runtimeSpec?: string;
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
 *     ng generate @angular-capacitor-workspace/cli:theming
 */
export function theming(options: ThemingOptions = {}): Rule {
  return (tree: Tree) => {
    const design = requireDesignSystem(
      tree,
      'Theme switching lives in the design-system library, beside the tokens it switches',
    );

    return chain([
      library(tree, design, options.runtimeSpec),
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

function library(tree: Tree, design: DesignSystem, runtimeSpec: string | undefined): Rule {
  // `ThemeService` is @angular-capacitor-workspace/theming, installed rather
  // than copied. What lands in the library is the toggle, which is its to
  // restyle and written once, and `lib/theme/theme.ts`, which binds the package
  // to the palettes in `src/config/` and is rewritten on every run.
  const context = { ...strings, prefix: design.prefix, importName: design.name };
  const binding = (path: string) => path.endsWith('/lib/theme/theme.ts.template');

  return chain([
    mergeWith(
      apply(url('./files/lib'), [
        filter((path) => !binding(path)),
        applyTemplates(context),
        move(`/${design.root}`),
        onlyNew(tree),
      ]),
      MergeStrategy.Overwrite,
    ),
    mergeWith(
      apply(url('./files/lib'), [
        filter(binding),
        applyTemplates(context),
        move(`/${design.root}`),
      ]),
      MergeStrategy.Overwrite,
    ),
    (host: Tree) => {
      buildOn(host, design, RUNTIME_PACKAGES.theming, runtimeSpec);
      exportFromLibrary(host, design, './lib/theme/theme', [
        "export * from './lib/theme/theme';",
        "export * from './lib/theme/theme-toggle';",
      ]);
    },
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
        addRootProvider(host, name, {
          symbol: 'provideTheme',
          expression: 'provideTheme()',
          imports: [`import { provideTheme } from '${design.name}';`],
        });
        addBootScript(host, name, applyBeforePaint(design));
        const toggle = addHeaderControl(host, name, {
          symbol: 'ThemeToggle',
          from: design.name,
          markup: `<${design.prefix}-theme-toggle />`,
        });
        // Where the shell renders the toggle, so does its spec, which then
        // needs the palettes too.
        if (toggle) {
          addShellTestProvider(host, name, {
            symbol: 'provideTheme',
            expression: 'provideTheme()',
            imports: [`import { provideTheme } from '${design.name}';`],
          });
        }
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
 * Its storage keys are `themeStorageKeys()` in @angular-capacitor-workspace/theming,
 * written out here because the script runs before any module can load;
 * `test/theming.spec.ts` holds the two to each other.
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
  <!-- /theming:before-paint -->
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
dark — and a palette. Behind it is \`ThemeService\`, from the
\`@angular-capacitor-workspace/theming\` package and exported by \`${design.name}\`, which
writes the choice onto \`<html>\` as \`data-theme\` and \`data-palette\` and remembers
it in \`localStorage\`. Each app's \`app.config.ts\` has \`provideTheme()\` for it. The stylesheet already declares every combination, so a switch
is an attribute write: nothing re-renders, and no component needs to know
theming exists.

A small inline script in each app's \`index.html\` applies the stored choice
before the first paint, so you never see a flash of the wrong theme. It and
\`${design.root}/src/lib/theme/theme.ts\` are the generator's, rewritten by
\`ng generate @angular-capacitor-workspace/cli:theming\`; an update of the
package changes how theming works, and nothing in either needs editing.

Marketing sites have neither the toggle nor that script, on purpose: their
pages are prerendered once and served to everyone, so nothing may bake one
visitor's choice into the HTML.

The toggle offers the palettes in \`${design.root}/src/config/palettes.ts\`, the
design system's own list, so adding one is the two steps under Theming above;
nothing in \`${design.root}/src/lib/theme/\` needs editing.

An app generated later gets the toggle too. To give it to an app that predates
it, or to one you left out:

\`\`\`bash
ng generate @angular-capacitor-workspace/cli:theming --apps <app>
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
- **Configure; leave the machinery to the generator.** Palettes are
  \`src/config/palettes.ts\` (with their colours in \`_ref.scss\`).
  \`ThemeService\` comes from \`@angular-capacitor-workspace/theming\`, and
  \`src/lib/theme/theme.ts\` and the script in each app's \`index.html\` are
  rewritten by \`ng generate @angular-capacitor-workspace/cli:theming\`, so an
  edit to them is lost. \`npm run check:contrast\` fails until the config and
  the stylesheet agree.
`,
  );
}
