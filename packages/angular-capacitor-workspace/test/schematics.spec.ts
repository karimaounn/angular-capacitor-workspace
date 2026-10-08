import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { HostTree } from '@angular-devkit/schematics';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { latestVersions } from '@schematics/angular/utility/latest-versions';
import { beforeAll, describe, expect, it } from 'vitest';
import { assertKnownProviders } from '../src/schematics/marketing';
import { VERSIONS } from '../src/policy/versions';

// The schematic engine `require()`s factories by path, so it needs the compiled
// collection — the same artefact published to npm, which is the right thing to
// be testing. `npm test` builds first.
const collection = join(__dirname, '..', 'dist', 'collection.json');

if (!existsSync(collection)) {
  throw new Error(
    `${collection} does not exist. Run \`npm run build\` before the tests — ` +
      `the schematic runner loads compiled factories, not sources.`,
  );
}

/**
 * The schematics are exercised against a real `@schematics/angular` workspace
 * rather than a hand-built tree. The whole design is an overlay on Angular's
 * output, so a fixture we wrote ourselves would test the overlay against our
 * own idea of that output — and pass on exactly the day Angular changes it.
 */
function runner(): SchematicTestRunner {
  return new SchematicTestRunner('acw', collection);
}

async function baseWorkspace(): Promise<UnitTestTree> {
  return runner().runExternalSchematic('@schematics/angular', 'workspace', {
    name: 'test-ws',
    version: '22.0.0',
    newProjectRoot: 'projects',
  });
}

/**
 * The scripts table from the generated README, checked to be one unbroken
 * table — a blank line or stray text inside would split it when rendered.
 */
function scriptsTable(tree: UnitTestTree): string {
  const match = tree
    .readContent('/README.md')
    .match(
      /<!-- angular-capacitor-workspace:scripts -->\n\n([\s\S]*?)\n\n<!-- \/angular-capacitor-workspace:scripts -->/,
    );
  if (!match) {
    throw new Error('The README has no scripts table.');
  }
  const table = match[1]!;
  expect(table.split('\n').every((line) => line.startsWith('|'))).toBe(true);
  return table;
}

/** The scripts in a project's own manifest, `projects/<project>/<half>/package.json`. */
function ownScripts(
  tree: UnitTestTree,
  project: string,
  half: 'web' | 'mobile' = 'web',
): Record<string, string> {
  return JSON.parse(tree.readContent(`/projects/${project}/${half}/package.json`)).scripts;
}

/** The scripts in the root manifest. */
function rootScripts(tree: UnitTestTree): Record<string, string> {
  return JSON.parse(tree.readContent('/package.json')).scripts;
}

/**
 * Puts a project's scripts back where releases before per-project manifests
 * wrote them: `<verb>:<project>` in the root manifest, with paths from the
 * root. The shape `ng generate` still meets in a workspace from one of those.
 */
function withRootScripts(tree: UnitTestTree, project: string): UnitTestTree {
  const manifest = `/projects/${project}/web/package.json`;
  const own: Record<string, string> = JSON.parse(tree.readContent(manifest)).scripts;
  const root = JSON.parse(tree.readContent('/package.json'));
  const fromRoot = (command: string) =>
    command
      .replaceAll(' --prefix ../../..', '')
      .replaceAll('../../../', '')
      .replace(
        new RegExp(`npm (?:run )?(\\w+) -w @test-ws/${project}`, 'g'),
        `npm run $1:${project}`,
      );

  for (const [name, command] of Object.entries(own)) {
    if (name !== 'watch') {
      root.scripts[`${name}:${project}`] = fromRoot(command);
    }
  }
  for (const [name, command] of Object.entries<string>(root.scripts)) {
    root.scripts[name] = fromRoot(command);
  }
  // Those releases had no project runner: the root scripts named the project.
  const named: Record<string, string> = {
    start: `npm run start:${project}`,
    watch: `ng build ${project} --watch --configuration development`,
    build: `npm run build:${project}`,
    test: 'ng test --no-watch',
    e2e: `npm run e2e:${project}`,
  };
  for (const [verb, command] of Object.entries(named)) {
    if (root.scripts[verb] === `node scripts/project.mjs ${verb}`) {
      root.scripts[verb] = command;
    }
  }
  tree.delete('/scripts/project.mjs');
  root.workspaces = root.workspaces.filter(
    (member: string) => member !== `projects/${project}/web`,
  );
  tree.overwrite('/package.json', JSON.stringify(root, null, 2));
  tree.delete(manifest);
  return tree;
}

/** A project's global `styles`, as plain paths. */
function buildStyles(tree: UnitTestTree, project: string): string[] {
  const options = JSON.parse(tree.readContent('/angular.json')).projects[project].architect.build
    .options;
  return (options.styles as Array<string | { input: string }>).map((style) =>
    typeof style === 'string' ? style : style.input,
  );
}

describe('workspace overlay', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    tree = await runner().runSchematic('workspace', { e2e: 'playwright' }, await baseWorkspace());
  });

  it('emits the shared Playwright base, the house rules and a README', () => {
    expect(tree.files).toContain('/playwright.base.ts');
    expect(tree.files).toContain('/AGENTS.md');
    expect(tree.files).toContain('/README.md');
  });

  it('declares the same runtime floor this package declares', () => {
    // Read, not hard-coded. The assertion is that the two agree, so a floor
    // raised in one place and not the other fails here rather than in a
    // generated workspace whose `allowScripts` silently does nothing.
    const own = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      engines: Record<string, string>;
    };
    const generated = JSON.parse(tree.readContent('/package.json')) as {
      engines?: Record<string, string>;
    };

    expect(generated.engines).toEqual(own.engines);
    // Guards the assertion above against passing because both are empty.
    expect(own.engines.npm).toBeDefined();
    expect(own.engines.node).toBeDefined();
  });

  it('emits a CI workflow that enforces the install-script allowlist', () => {
    const workflow = tree.readContent('/.github/workflows/ci.yml');
    expect(workflow).toContain('npm ci --strict-allow-scripts');
    expect(workflow).toContain('npm run audit:policy');
  });

  it('renders the CI workflow to valid YAML in every feature combination', async () => {
    // The workflow template has EJS conditionals around whole jobs, and YAML is
    // indentation-sensitive: a conditional that leaves a stray blank line or an
    // unrendered tag produces a file GitHub rejects, which nobody discovers
    // until they push.
    for (const options of [
      { e2e: 'playwright', uiLib: 'ui' },
      { e2e: 'playwright' },
      { uiLib: 'ui' },
      {},
    ]) {
      const rendered = await runner().runSchematic('workspace', options, await baseWorkspace());
      const yaml = rendered.readContent('/.github/workflows/ci.yml');

      expect(yaml, `options=${JSON.stringify(options)}`).not.toMatch(/<%|%>/);

      // Two-space-indented keys *after* `jobs:` — the `on:` block above it has
      // the same indentation and would otherwise be counted as jobs.
      const jobsBlock = yaml.slice(yaml.indexOf('\njobs:'));
      const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][\w-]*):$/gm)].map(([, job]) => job);
      expect(jobs, `options=${JSON.stringify(options)}`).toContain('dependencies');
      expect(jobs).toContain('build');

      if (options.e2e === 'playwright') {
        expect(jobs, `options=${JSON.stringify(options)}`).toContain('e2e');
      } else {
        expect(jobs, `options=${JSON.stringify(options)}`).not.toContain('e2e');
      }

      // Contrast and library builds only make sense with a library.
      expect(yaml.includes('check:contrast')).toBe(Boolean(options.uiLib));

      // Every job must declare a runner; a conditional that swallowed one would
      // still look plausible.
      expect(yaml.match(/runs-on:/g)?.length).toBe(jobs.length);
    }
  });

  it('omits the Playwright base when e2e is off', async () => {
    const without = await runner().runSchematic('workspace', {}, await baseWorkspace());
    expect(without.files).not.toContain('/playwright.base.ts');
    expect(JSON.parse(without.readContent('/package.json')).devDependencies['@types/node']).toBe(
      undefined,
    );
  });

  it('adds @types/node for the Playwright base, at our range and not Angular’s', () => {
    // The base reads process.env and the e2e scripts type-check it. Angular
    // only adds @types/node with a server target, so an app-only workspace
    // would otherwise fail its first `npm run e2e` on a missing type.
    //
    // The range is pinned rather than taken from `latestVersions`, which writes
    // the floor Angular's own tooling supports: below the Node this workspace
    // declares, and below the one vitest 5 peers. Delegating it failed the
    // install ERESOLVE.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;
    expect(devDependencies['@types/node']).toBe(VERSIONS['@types/node'].range);
    expect(devDependencies['@types/node']).not.toBe(latestVersions['@types/node']);
  });

  it('creates an empty paths map for libraries to fill', () => {
    expect(tree.readContent('/tsconfig.json')).toContain('"paths"');
  });

  it('adds the policy commands', () => {
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['audit:policy']).toBe('angular-capacitor-workspace audit');
    expect(scripts['doctor']).toBe('angular-capacitor-workspace doctor');
  });

  it('describes only the features it was asked for in the README', async () => {
    const minimal = await runner().runSchematic('workspace', {}, await baseWorkspace());
    // With no library there is no build:libs to run, and telling someone to
    // run it is the first command in the README failing.
    expect(minimal.readContent('/README.md')).not.toContain('build:libs');
    expect(minimal.readContent('/README.md')).not.toContain('playwright.base.ts');
    expect(tree.readContent('/README.md')).toContain('playwright.base.ts');

    const withLib = await runner().runSchematic(
      'workspace',
      { uiLib: 'ui' },
      await baseWorkspace(),
    );
    expect(withLib.readContent('/README.md')).toContain(
      'npm run build:libs   # before the first serve',
    );
  });

  it('states the Node and npm floor it declares, without restating it', () => {
    // Below the npm floor `allowScripts` is accepted and ignored, so a reader
    // on an older npm has a workspace that looks gated and is not. The numbers
    // come from the same manifest `engines` does — a template literal here
    // could disagree with what the workspace actually requires.
    const engines = JSON.parse(tree.readContent('/package.json')).engines;
    const readme = tree.readContent('/README.md');
    expect(readme).toContain(`Node ${engines.node.replace('>=', '')}+`);
    expect(readme).toContain(`npm ${engines.npm.replace('>=', '')}+`);
  });

  it('shows how to add to the workspace, since the table promises rows will appear', () => {
    expect(tree.readContent('/README.md')).toContain(
      'ng generate angular-capacitor-workspace:app <name>',
    );
  });

  it('starts the README scripts table with the policy commands', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run audit:policy` |');
    expect(table).toContain('| `npm run doctor` |');
  });

  it('puts the Scripts table after everything else in the README', () => {
    const readme = tree.readContent('/README.md');
    expect(readme.indexOf('## Scripts')).toBeGreaterThan(readme.indexOf('## Dependency policy'));
  });

  it('does not invent a build:libs script before any library exists', () => {
    // An empty `build:libs` that exits 0 would make the README's "run this
    // first" instruction a lie.
    const scripts = JSON.parse(tree.readContent('/package.json')).scripts;
    expect(scripts['build:libs']).toBeUndefined();
  });
});

describe('ng-add', () => {
  it("leaves the project's own README, house rules and CI alone", async () => {
    // Into a workspace that already exists, these files are somebody's.
    // Generation overwrites Angular's stock README; adoption must not.
    const existing = await baseWorkspace();
    existing.overwrite('/README.md', '# My project\n\nHand-written.\n');
    existing.create('/AGENTS.md', '# Our rules\n');
    existing.create('/.github/workflows/ci.yml', 'name: ours\n');

    const tree = await runner().runSchematic('ng-add', {}, existing);

    expect(tree.readContent('/README.md')).toBe('# My project\n\nHand-written.\n');
    expect(tree.readContent('/AGENTS.md')).toBe('# Our rules\n');
    expect(tree.readContent('/.github/workflows/ci.yml')).toBe('name: ours\n');
    // And still adds what it brings that was not there.
    expect(JSON.parse(tree.readContent('/package.json')).scripts['audit:policy']).toBeDefined();
  });

  it('writes the files a project does not have yet', async () => {
    const tree = await runner().runSchematic('ng-add', {}, await baseWorkspace());
    expect(tree.files).toContain('/AGENTS.md');
    expect(tree.files).toContain('/.github/workflows/ci.yml');
  });
});

describe('app', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    tree = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, base);
  });

  it('generates into a web/ subdirectory, leaving room for a mobile sibling', () => {
    const project = JSON.parse(tree.readContent('/angular.json')).projects['shop'];
    expect(project.root).toBe('projects/shop/web');
    expect(project.sourceRoot).toBe('projects/shop/web/src');
    expect(tree.files).toContain('/projects/shop/web/src/main.ts');
  });

  it('lets Angular compute the tsconfig extends for the deeper root', () => {
    // Delegated, not patched: the whole point of passing `projectRoot` rather
    // than relocating afterwards.
    expect(tree.readContent('/projects/shop/web/tsconfig.app.json')).toContain(
      '"extends": "../../../tsconfig.json"',
    );
  });

  it('uses only @angular/build builders', () => {
    const architect = JSON.parse(tree.readContent('/angular.json')).projects['shop'].architect;
    for (const target of Object.values<{ builder: string }>(architect)) {
      expect(target.builder).toMatch(/^@angular\/build:/);
    }
  });

  it('is client-rendered — no server entry point', () => {
    const options = JSON.parse(tree.readContent('/angular.json')).projects['shop'].architect.build
      .options;
    expect(options.server).toBeUndefined();
    expect(options.outputMode).toBeUndefined();
  });

  it('names no app in the root scripts, which take the app as an argument', () => {
    // No default app: `npm start shop`, through the project runner.
    const scripts = rootScripts(tree);
    for (const verb of ['start', 'watch', 'build', 'test', 'e2e']) {
      expect(scripts[verb]).toBe(`node scripts/project.mjs ${verb}`);
    }
    expect(tree.exists('/scripts/project.mjs')).toBe(true);
    expect(ownScripts(tree, 'shop')['watch']).toBe(
      'ng build shop --watch --configuration development',
    );
  });

  it('keeps its own scripts in its own manifest, as a workspace member', () => {
    // So the root manifest stays the same size however many apps there are.
    expect(JSON.parse(tree.readContent('/projects/shop/web/package.json'))).toMatchObject({
      name: '@test-ws/shop',
      private: true,
      scripts: { start: 'ng serve shop', build: 'ng build shop', test: 'ng test shop' },
    });
    expect(JSON.parse(tree.readContent('/package.json')).workspaces).toContain('projects/shop/web');
    expect(Object.keys(rootScripts(tree)).filter((name) => name.includes('shop'))).toEqual([]);
  });

  it('runs dependencies from the root manifest, not its own', () => {
    // The audit gate and doctor read the root. A project manifest with
    // dependencies would be a second install nothing audits.
    const manifest = JSON.parse(tree.readContent('/projects/shop/web/package.json'));
    expect(manifest.dependencies).toBeUndefined();
    expect(manifest.devDependencies).toBeUndefined();
  });

  it('delegates the per-app Playwright config to the workspace base', () => {
    const config = tree.readContent('/projects/shop/web/playwright.config.ts');
    expect(config).toContain("from '../../../playwright.base'");
    expect(config).toContain("project: 'shop'");
  });

  it('lists its scripts in the README', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm start <app>` |');
    expect(table).toContain('| `npm start shop` |');
    expect(table).toContain('| `npm run e2e shop` |');
  });

  it('adds each README row once, however many apps share the script', async () => {
    // Its own workspace: running a schematic mutates the tree it is given, and
    // `tree` is shared with the tests after this one.
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const one = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, base);
    const two = await runner().runSchematic('app', { name: 'admin', e2e: 'playwright' }, one);
    const table = scriptsTable(two);
    expect(table.match(/\| `npm run e2e \[<project>\]` \|/g)).toHaveLength(1);
    expect(table).toContain('| `npm run e2e admin` |');
  });

  it('leaves a README without the scripts table alone', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    base.overwrite('/README.md', '# Ours\n');
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    expect(withApp.readContent('/README.md')).toBe('# Ours\n');
  });

  it('gives a second app a different port', async () => {
    const two = await runner().runSchematic('app', { name: 'admin', e2e: 'playwright' }, tree);
    const shop = two.readContent('/projects/shop/web/playwright.config.ts');
    const admin = two.readContent('/projects/admin/web/playwright.config.ts');
    const portOf = (text: string) => text.match(/port: (\d+)/)?.[1];
    expect(portOf(shop)).not.toBe(portOf(admin));
  });

  /** A workspace of its own, with `shop` in it: `tree` has already gained an `admin`. */
  async function withShop(): Promise<UnitTestTree> {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    return runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, base);
  }

  it('writes the port into angular.json, where ng serve and Playwright agree on it', async () => {
    const two = await runner().runSchematic(
      'app',
      { name: 'admin', e2e: 'playwright' },
      await withShop(),
    );
    const projects = JSON.parse(two.readContent('/angular.json')).projects;
    expect(projects['shop'].architect.serve.options.port).toBe(4200);
    expect(projects['admin'].architect.serve.options.port).toBe(4201);
    expect(two.readContent('/projects/admin/web/playwright.config.ts')).toContain('port: 4201');
  });

  it('takes the lowest free port, so a deleted app does not hand its number on twice', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('app', { name: 'shop', port: 4205 }, base);
    const two = await runner().runSchematic('app', { name: 'admin' }, one);
    const three = await runner().runSchematic('app', { name: 'docs' }, two);
    const projects = JSON.parse(three.readContent('/angular.json')).projects;
    expect(projects['admin'].architect.serve.options.port).toBe(4200);
    expect(projects['docs'].architect.serve.options.port).toBe(4201);
  });

  it('builds and tests every app from npm run build and npm test', async () => {
    const two = await runner().runSchematic('app', { name: 'admin' }, await withShop());
    // The runner finds every app in angular.json, so a second one changes
    // nothing at the root.
    expect(rootScripts(two)).toEqual(rootScripts(await withShop()));
    expect(rootScripts(two)['build']).toBe('node scripts/project.mjs build');
  });

  it('keeps building the apps a workspace already had', async () => {
    // What `ng add` meets: an app Angular generated, and its project-less
    // `ng build`. Starting the chain from the new app alone would silently stop
    // building the old one.
    const existing = await runner().runExternalSchematic(
      '@schematics/angular',
      'application',
      { name: 'legacy', skipInstall: true },
      await baseWorkspace(),
    );
    const added = await runner().runSchematic('app', { name: 'shop' }, existing);
    expect(JSON.parse(added.readContent('/package.json')).scripts['build']).toBe(
      'ng build legacy && npm run build -w @test-ws/shop',
    );
  });

  it('joins the build chain of a workspace whose apps keep their scripts at the root', async () => {
    // An earlier 22.x wrote `build:<app>` into the root manifest.
    const legacy = withRootScripts(await withShop(), 'shop');
    const added = await runner().runSchematic('app', { name: 'admin', e2e: 'playwright' }, legacy);
    expect(rootScripts(added)['build']).toBe(
      'npm run build:shop && npm run build -w @test-ws/admin',
    );
    expect(rootScripts(added)['e2e']).toBe('npm run e2e:shop && npm run e2e -w @test-ws/admin');
  });

  it('type-checks its e2e specs before running them', () => {
    // From the app's own directory, where npm runs its scripts.
    expect(ownScripts(tree, 'shop')['e2e']).toBe(
      'tsc -p e2e/tsconfig.json && playwright test --config playwright.config.ts',
    );
    expect(rootScripts(tree)['e2e']).toBe('node scripts/project.mjs e2e');
    expect(tree.readContent('/projects/shop/web/e2e/tsconfig.json')).toContain(
      '"extends": "../../../../tsconfig.json"',
    );
    // Referenced, so an editor checks the specs against this config.
    expect(tree.readContent('/tsconfig.json')).toContain('./projects/shop/web/e2e/tsconfig.json');
  });

  it('replaces the Angular welcome page with a shell and a starter route', () => {
    const shell = tree.readContent('/projects/shop/web/src/app/app.html');
    expect(shell).toContain('<router-outlet />');
    expect(shell).toContain('Skip to content');
    // Angular's splash, and the spec that asserts on it, are both gone.
    expect(shell).not.toContain('Hello,');
    expect(tree.files).toContain('/projects/shop/web/src/app/pages/home.page.ts');
    expect(tree.readContent('/projects/shop/web/src/app/app.routes.ts')).toContain(
      "import('./pages/home.page')",
    );
  });

  it('titles the shell from the app name', () => {
    expect(tree.readContent('/projects/shop/web/src/app/app.ts')).toContain("signal('Shop')");
  });

  it('emits no theme suite when there is no theme', () => {
    expect(tree.files).not.toContain('/projects/shop/web/e2e/theme.spec.ts');
  });

  it('leaves the plain shell alone when there is no design system to show', () => {
    const shell = tree.readContent('/projects/shop/web/src/app/app.ts');
    expect(shell).not.toContain('theme-toggle');
    // Nothing to import, so nothing is written into the global stylesheet.
    expect(tree.readContent('/projects/shop/web/src/styles.scss')).not.toContain('@use');
    expect(tree.readContent('/projects/shop/web/src/index.html')).not.toContain('data-theme');
  });

  it('looks for the root component under the prefix it was generated with', async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const prefixed = await runner().runSchematic(
      'app',
      { name: 'shop', prefix: 'acme', e2e: 'playwright' },
      base,
    );
    expect(prefixed.readContent('/projects/shop/web/e2e/smoke.spec.ts')).toContain(
      "page.locator('acme-root')",
    );
  });
});

describe('app, in a workspace that already has a design system', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
    tree = await runner().runSchematic('app', { name: 'shop' }, withLib);
  });

  it('loads the design tokens from the app stylesheet', () => {
    // Without this line the tokens are built, published and never loaded —
    // every var() in the library resolves to nothing.
    expect(tree.readContent('/projects/shop/web/src/styles.scss')).toContain(
      "@use 'ui/styles' as *;",
    );
  });

  it('builds the libraries before every entry point of its own, which npm cannot hook', () => {
    // npm hooks each script under its own name, so on a fresh clone each of
    // the app's scripts fails without its own hook: `build` and `watch` in
    // Sass, the rest on an import that resolves to a directory nothing has
    // created. A project's scripts run in its own directory, so the hook
    // reaches the root script through --prefix.
    const scripts = ownScripts(tree, 'shop');
    for (const hook of ['prestart', 'prewatch', 'prebuild', 'pretest']) {
      expect(scripts[hook]).toBe('npm run build:libs --prefix ../../..');
    }
    // This app has no e2e suite, and a hook for a script nobody can run is a
    // key that only ever has to be explained.
    expect(scripts['pree2e']).toBeUndefined();
  });

  it('hooks the e2e script too, when the app has one', async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
    const withApp = await runner().runSchematic(
      'app',
      { name: 'shop', e2e: 'playwright' },
      withLib,
    );
    expect(ownScripts(withApp, 'shop')['pree2e']).toBe('npm run build:libs --prefix ../../..');
  });

  it('adds no library hooks to a workspace that has no libraries', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    // There is no `build:libs` to call, so a hook calling it would fail on the
    // first `npm start -w @test-ws/shop`.
    expect(ownScripts(withApp, 'shop')['prestart']).toBeUndefined();
  });

  it('retrofits the hooks onto apps that predate the library', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
    expect(ownScripts(withLib, 'shop')['prestart']).toBe('npm run build:libs --prefix ../../..');
  });

  it('retrofits the hooks onto apps that keep their scripts at the root', async () => {
    // An app from an earlier 22.x, before apps had a manifest of their own.
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const legacy = withRootScripts(
      await runner().runSchematic('app', { name: 'shop' }, base),
      'shop',
    );
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, legacy);

    expect(withLib.exists('/projects/shop/web/package.json')).toBe(false);
    expect(rootScripts(withLib)['prestart:shop']).toBe('npm run build:libs');
    expect(rootScripts(withLib)['prebuild:shop']).toBe('npm run build:libs');
  });

  it('leaves theme switching to the theming plugin', () => {
    // The library declares light and dark; without the plugin nothing in the
    // app picks between them, and the page follows the system colour scheme.
    expect(tree.readContent('/projects/shop/web/src/app/app.ts')).not.toContain('ThemeToggle');
    expect(tree.readContent('/projects/shop/web/src/index.html')).not.toContain('data-theme');
    expect(tree.readContent('/projects/shop/web/src/app/pages/home.page.ts')).not.toContain(
      'ThemeService',
    );
  });

  it('keeps the anchors the plugins extend it through', () => {
    // See src/extend/shell.ts: a header for controls, TestBed providers in the
    // spec, and a starter page that is a list of sections ending in "Next".
    expect(tree.readContent('/projects/shop/web/src/app/app.html')).toContain('</header>');
    expect(tree.readContent('/projects/shop/web/src/app/app.spec.ts')).toContain('providers: [');
    const page = tree.readContent('/projects/shop/web/src/app/pages/home.page.html');
    expect(page.lastIndexOf('\n<section')).toBe(
      page.indexOf('\n<section aria-labelledby="next-heading"'),
    );
  });

  it('demonstrates the library on the starter page', () => {
    const page = tree.readContent('/projects/shop/web/src/app/pages/home.page.html');
    expect(page).toContain('<ui-button');
    expect(page).toContain('<ui-field');
  });
});

describe('mobile', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    tree = await runner().runSchematic('app', { name: 'shop', mobile: ['android'] }, base);
  });

  it('adds a Capacitor sibling beside web/, as its own npm workspace member', () => {
    expect(tree.files).toContain('/projects/shop/mobile/capacitor.config.ts');
    expect(tree.files).toContain('/projects/shop/mobile/package.json');
    expect(JSON.parse(tree.readContent('/package.json')).workspaces).toContain(
      'projects/shop/mobile',
    );
  });

  it('points webDir at the app build output, relative to the mobile package', () => {
    expect(tree.readContent('/projects/shop/mobile/capacitor.config.ts')).toContain(
      "webDir: '../../../dist/shop/browser'",
    );
  });

  it('builds before syncing, because cap copies whatever is already in dist', () => {
    const scripts = ownScripts(tree, 'shop', 'mobile');
    const build = 'npm run build -w @test-ws/shop --prefix ../../..';
    expect(scripts['sync']).toBe(`${build} && cap sync`);
    expect(scripts['sync:android']).toBe(`${build} && cap sync android`);
    expect(scripts['run:android']).toBe(`${build} && cap run android`);
    expect(scripts['open:android']).toBe('cap open android');
  });

  it('adds nothing to the root scripts', () => {
    expect(Object.keys(rootScripts(tree)).filter((name) => name.includes('shop'))).toEqual([]);
  });

  it('builds a web app that keeps its scripts at the root', async () => {
    // `ng generate mobile` for an app from an earlier 22.x.
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const legacy = withRootScripts(
      await runner().runSchematic('app', { name: 'shop' }, base),
      'shop',
    );
    const withMobile = await runner().runSchematic('mobile', { app: 'shop' }, legacy);
    expect(ownScripts(withMobile, 'shop', 'mobile')['sync']).toBe(
      'npm run build:shop --prefix ../../.. && cap sync',
    );
  });

  it('lists the native scripts in the README', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run sync:android -w @test-ws/shop-mobile` |');
    expect(table).toContain(
      '| `npm run open:android -w @test-ws/shop-mobile` | opens the Android project in Android Studio |',
    );
    expect(table).toContain('| `npm run preflight -w @test-ws/shop-mobile` |');
    expect(table).not.toContain(':ios');
  });

  it("documents the app's mobile setup in the README, not in a separate file", () => {
    expect(tree.files).not.toContain('/projects/shop/mobile/README.md');

    const readme = tree.readContent('/README.md');
    expect(readme).toContain('## Mobile');
    expect(readme).toContain('### Shop');
    expect(readme).toContain('npm run cap -w @test-ws/shop-mobile -- add android');
    expect(readme).toContain('npm run run:android -w @test-ws/shop-mobile');
    expect(readme).toContain('npm run preflight -w @test-ws/shop-mobile');
    expect(readme).toContain('`com.testws.shop`');
  });

  it('puts the web build before `cap add`, which syncs it into the platform it adds', () => {
    // `cap add` ends in a copy from webDir. Told to add a platform first, a
    // reader on a fresh clone gets "Could not find the web assets directory"
    // as the very first native command they run.
    const readme = tree.readContent('/README.md');
    const build = 'npm run build shop';
    expect(readme.indexOf(build)).toBeLessThan(
      readme.indexOf('cap -w @test-ws/shop-mobile -- add'),
    );
    expect(readme.indexOf('npm run preflight -w')).toBeLessThan(readme.indexOf(build));
  });

  it('reads the requirements as a list, however many platforms there are', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const both = await runner().runSchematic(
      'app',
      { name: 'shop', mobile: ['android', 'ios'] },
      base,
    );
    // Three requirements joined by `and` alone reads as two — "the Android SDK
    // and Xcode" is one item to anybody skimming.
    const readme = both.readContent('/README.md').replace(/\n\s+/g, ' ');
    expect(readme).toContain('a JDK (17+), the Android SDK and Xcode');

    // The preflight script looks for Xcode on macOS only, so an Android-only
    // app is neither told to have it nor told why it went unchecked.
    const android = tree.readContent('/README.md').replace(/\n\s+/g, ' ');
    expect(android).toContain('a JDK (17+) and the Android SDK');
    expect(android).not.toContain('Xcode (the iOS');
  });

  it('wraps the steps it writes, like the prose it writes them into', () => {
    // Every lead line carries an interpolated path or app id, so nothing about
    // its length is knowable when it is written.
    const section = tree
      .readContent('/README.md')
      .split('<!-- angular-capacitor-workspace:mobile -->')[1]!
      .split('<!-- /angular-capacitor-workspace:mobile -->')[0]!;
    expect(section.split('\n').filter((line) => line.length > 80)).toEqual([]);
  });

  it('adds one Mobile section however many apps have a native target', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('app', { name: 'shop', mobile: ['android'] }, base);
    const two = await runner().runSchematic('app', { name: 'admin', mobile: ['android'] }, one);
    const readme = two.readContent('/README.md');
    expect(readme.match(/## Mobile/g)).toHaveLength(1);
    expect(readme).toContain('### Shop');
    expect(readme).toContain('### Admin');
  });

  it('adds no Mobile section when no app has a native target', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    expect(withApp.readContent('/README.md')).not.toContain('## Mobile');
  });

  it('gives every mobile app the preflight its README block tells you to run', async () => {
    // The script is shared; the npm script is per app, and names that app's
    // platforms, so each checks only what its own build needs.
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('app', { name: 'shop', mobile: ['android'] }, base);
    const two = await runner().runSchematic('app', { name: 'admin', mobile: ['ios'] }, one);

    expect(ownScripts(two, 'shop', 'mobile')['preflight']).toBe(
      'bash ../../../scripts/cap-preflight.sh android',
    );
    expect(ownScripts(two, 'admin', 'mobile')['preflight']).toBe(
      'bash ../../../scripts/cap-preflight.sh ios',
    );
    expect(two.readContent('/README.md')).toContain('npm run preflight -w @test-ws/admin-mobile');
  });

  it('checks only the platforms it is asked about', () => {
    // An Android-only app on a Mac without Xcode is not a failed preflight.
    const script = tree.readContent('/scripts/cap-preflight.sh');
    const run = (...platforms: string[]) =>
      spawnSync('bash', ['-c', script, 'preflight', ...platforms], {
        encoding: 'utf8',
        env: { PATH: process.env['PATH'] ?? '' },
      }).stdout;

    const android = run('android');
    expect(android).toContain('android sdk');
    expect(android).not.toContain('xcode');

    const ios = run('ios');
    expect(ios).toContain('xcode');
    expect(ios).not.toContain('java');
    expect(ios).not.toContain('android sdk');
  });

  it('gitignores the native build output, from whichever run adds the target', () => {
    // Written by this schematic rather than the workspace overlay, so a target
    // added with `ng generate` after generation is covered too.
    expect(tree.readContent('/.gitignore')).toContain('/projects/*/mobile/android/app/build/');
  });
});

describe('marketing', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    tree = await runner().runSchematic(
      'marketing',
      { name: 'site', origin: 'https://Acme.example/', e2e: 'playwright' },
      base,
    );
  });

  const scripts = (t: UnitTestTree) => JSON.parse(t.readContent('/package.json')).scripts;

  it('keeps the anchors the plugins extend it through', () => {
    // See src/extend/shell.ts and src/extend/site.ts.
    expect(tree.readContent('/projects/site/web/src/app/app.html')).toContain('</header>');
    expect(tree.readContent('/projects/site/web/src/app/app.spec.ts')).toContain('providers: [');
    const meta = tree.readContent('/projects/site/web/src/app/seo/page-meta.ts');
    expect(meta).toContain('export const PAGE_META_EXTENSIONS');
    expect(tree.readContent('/projects/site/web/src/app/app.config.ts')).toContain(
      "import { PageMetaStrategy } from './seo/page-meta';",
    );
    expect(ownScripts(tree, 'site')['build']).toBe('ng build site');
    expect(ownScripts(tree, 'site')['postbuild']).toBe(
      'node ../../../scripts/generate-sitemap.mjs site && ' +
        'node ../../../scripts/verify-prerender.mjs site',
    );
  });

  it('runs every head extension it is given, and none when it is given none', () => {
    const meta = tree.readContent('/projects/site/web/src/app/seo/page-meta.ts');
    expect(meta).toContain('private readonly extensions = inject(PAGE_META_EXTENSIONS);');
    expect(meta).toContain('{ factory: () => [] }');
    expect(meta).toContain('siteUrl(this.servedPath(path))');
    expect(meta).toContain('extension.written?.(path, canonical !== null);');
    // And its spec covers an extension, so the seam is exercised in the
    // generated workspace before any plugin uses it.
    expect(tree.readContent('/projects/site/web/src/app/seo/page-meta.spec.ts')).toContain(
      "describe('PageMetaStrategy with an extension'",
    );
  });

  it('switches the build to static output', () => {
    const options = JSON.parse(tree.readContent('/angular.json')).projects['site'].architect.build
      .options;
    expect(options.outputMode).toBe('static');
    // main.server.ts stays — prerendering runs the app on the server.
    expect(options.server).toBe('projects/site/web/src/main.server.ts');
    // The request handler goes.
    expect(options.ssr).toBeUndefined();
  });

  it('deletes the Express server entry point and the script that ran it', () => {
    expect(tree.files).not.toContain('/projects/site/web/src/server.ts');
    expect(scripts(tree)['serve:ssr:site']).toBeUndefined();
  });

  it('keeps the prerender route configuration Angular already emits', () => {
    const routes = tree.readContent('/projects/site/web/src/app/app.routes.server.ts');
    expect(routes).toContain('RenderMode.Prerender');
  });

  it('builds canonical URLs and robots.txt from the origin, trimmed to the origin', () => {
    expect(tree.readContent('/projects/site/web/src/app/site.ts')).toContain(
      "export const SITE_ORIGIN = 'https://acme.example';",
    );
    expect(tree.readContent('/projects/site/web/public/robots.txt')).toContain(
      'Sitemap: https://acme.example/sitemap.xml',
    );
    // Written once: the sitewide JSON-LD is built from site.ts, not repeated
    // in index.html where it could drift.
    expect(tree.readContent('/projects/site/web/src/index.html')).not.toContain('ld+json');
  });

  it('falls back to a placeholder origin, and says so where it is set', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const placeholder = await runner().runSchematic('marketing', { name: 'site' }, base);
    const site = placeholder.readContent('/projects/site/web/src/app/site.ts');
    expect(site).toContain("export const SITE_ORIGIN = 'https://example.com';");
    expect(site).toContain('example.com is a placeholder');
    expect(tree.readContent('/projects/site/web/src/app/site.ts')).not.toContain('placeholder');
  });

  it('rejects an origin with a path, whose canonicals would all sit one level deep', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    await expect(
      runner().runSchematic(
        'marketing',
        { name: 'site', origin: 'https://acme.example/site' },
        base,
      ),
    ).rejects.toThrow();
  });

  it('writes head tags through PageMetaStrategy, keeping every provider Angular emits', () => {
    const config = tree.readContent('/projects/site/web/src/app/app.config.ts');
    expect(config).toContain('{ provide: TitleStrategy, useClass: PageMetaStrategy }');
    for (const provider of [
      'provideBrowserGlobalErrorListeners()',
      'provideClientHydration()',
      "provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'enabled' }))",
    ]) {
      expect(config).toContain(provider);
    }
    expect(tree.files).toContain('/projects/site/web/src/app/seo/page-meta.spec.ts');
  });

  it('prerenders a noindex 404 page for the host to serve', () => {
    const routes = tree.readContent('/projects/site/web/src/app/app.routes.ts');
    expect(routes).toContain("path: '404'");
    expect(routes).toContain("path: '**'");
    expect(routes).toContain('noindex: true');
    expect(tree.files).toContain('/projects/site/web/src/app/pages/not-found.page.ts');
  });

  it("replaces Angular's welcome page, so each page owns its one <h1>", () => {
    const shell = tree.readContent('/projects/site/web/src/app/app.html');
    expect(shell).not.toContain('<h1');
    expect(shell).toContain('<router-outlet />');
    expect(tree.readContent('/projects/site/web/src/app/app.spec.ts')).not.toContain('Hello,');
  });

  it('mounts the root component its index.html names, under the chosen prefix', async () => {
    expect(tree.readContent('/projects/site/web/src/index.html')).toContain(
      '<site-root></site-root>',
    );

    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const prefixed = await runner().runSchematic('marketing', { name: 'site', prefix: 'mk' }, base);
    expect(prefixed.readContent('/projects/site/web/src/index.html')).toContain(
      '<mk-root></mk-root>',
    );
    expect(prefixed.readContent('/projects/site/web/src/app/app.ts')).toContain(
      "selector: 'mk-root'",
    );
    expect(prefixed.readContent('/projects/site/web/src/app/pages/home.page.ts')).toContain(
      "selector: 'mk-home-page'",
    );
  });

  it('writes the sitemap and checks every page after each build', () => {
    // The site's own postbuild, which npm runs after its build, reaching the
    // shared scripts at the root from projects/site/web.
    expect(ownScripts(tree, 'site')['postbuild']).toBe(
      'node ../../../scripts/generate-sitemap.mjs site && ' +
        'node ../../../scripts/verify-prerender.mjs site',
    );
    for (const script of ['prerendered', 'generate-sitemap', 'verify-prerender']) {
      expect(tree.files).toContain(`/scripts/${script}.mjs`);
    }
    // Adapted to the attribute this generator's design system uses.
    expect(tree.readContent('/scripts/verify-prerender.mjs')).toContain(
      "'data-theme' in head.html",
    );
  });

  it('shares the check scripts with a second site, leaving edited copies alone', async () => {
    const edited = await runner().runSchematic(
      'marketing',
      { name: 'site' },
      await runner().runSchematic('workspace', {}, await baseWorkspace()),
    );
    edited.overwrite('/scripts/verify-prerender.mjs', '// tuned\n');
    const two = await runner().runSchematic('marketing', { name: 'docs' }, edited);
    expect(two.readContent('/scripts/verify-prerender.mjs')).toBe('// tuned\n');
    expect(ownScripts(two, 'docs')['postbuild']).toContain('verify-prerender.mjs docs');
  });

  it('holds a page to a page budget, not an app one', () => {
    const budgets = JSON.parse(tree.readContent('/angular.json')).projects['site'].architect.build
      .configurations.production.budgets;
    expect(budgets.find((budget: { type: string }) => budget.type === 'initial')).toMatchObject({
      maximumWarning: '380kB',
      maximumError: '450kB',
    });
  });

  it('is built by npm run build, and served by name like any app', () => {
    // The runner finds the site like any app, and serves it only by name.
    expect(scripts(tree)['build']).toBe('node scripts/project.mjs build');
    expect(scripts(tree)['start']).toBe('node scripts/project.mjs start');
    expect(ownScripts(tree, 'site')['build']).toBe('ng build site');
  });

  it('takes the next port when an app is already there', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const both = await runner().runSchematic('marketing', { name: 'site' }, withApp);
    expect(scripts(both)['start']).toBe('node scripts/project.mjs start');
    expect(
      JSON.parse(both.readContent('/angular.json')).projects['site'].architect.serve.options.port,
    ).toBe(4201);
  });

  it('runs site-specific e2e specs in place of the app smoke test', () => {
    expect(tree.files).toContain('/projects/site/web/e2e/site.spec.ts');
    expect(tree.files).toContain('/projects/site/web/e2e/a11y.spec.ts');
    expect(tree.files).not.toContain('/projects/site/web/e2e/smoke.spec.ts');
    expect(ownScripts(tree, 'site')['e2e']).toMatch(/^tsc -p e2e\/tsconfig.json && /);
    expect(JSON.parse(tree.readContent('/package.json')).devDependencies['axe-core']).toBeDefined();
  });

  it('documents the site beside it, hosting included', () => {
    const readme = tree.readContent('/projects/site/web/README.md');
    expect(readme).toContain('npm run e2e site');
    expect(readme).toContain('404/index.html');
  });

  it('gives a second site its own port, scripts and place in the build', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('marketing', { name: 'site' }, base);
    const two = await runner().runSchematic('marketing', { name: 'docs' }, one);

    const ports = (t: UnitTestTree) =>
      Object.fromEntries(
        Object.entries(JSON.parse(t.readContent('/angular.json')).projects).map(
          ([name, project]) => [
            name,
            (project as { architect: { serve: { options: { port: number } } } }).architect.serve
              .options.port,
          ],
        ),
      );
    expect(ports(two)).toEqual({ site: 4200, docs: 4201 });

    expect(ownScripts(two, 'docs')['start']).toBe('ng serve docs');
    expect(ownScripts(two, 'docs')['build']).toBe('ng build docs');
    expect(scripts(two)['build']).toBe('node scripts/project.mjs build');
  });

  it('gives each site its own origin, so their canonicals do not collide', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic(
      'marketing',
      { name: 'site', origin: 'https://acme.example' },
      base,
    );
    const two = await runner().runSchematic(
      'marketing',
      { name: 'docs', origin: 'https://docs.acme.example' },
      one,
    );

    expect(two.readContent('/projects/site/web/src/app/site.ts')).toContain(
      "export const SITE_ORIGIN = 'https://acme.example';",
    );
    expect(two.readContent('/projects/docs/web/src/app/site.ts')).toContain(
      "export const SITE_ORIGIN = 'https://docs.acme.example';",
    );
  });

  it('adds the prerendered-site rules to AGENTS.md once, however many sites there are', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const one = await runner().runSchematic('marketing', { name: 'site' }, base);
    const two = await runner().runSchematic('marketing', { name: 'docs' }, one);
    expect(two.readContent('/AGENTS.md').match(/^## Prerendered sites$/gm)).toHaveLength(1);
  });
});

describe('the app.config.ts the marketing template replaces', () => {
  const treeWith = (providers: string) => {
    const host = new HostTree();
    host.create('/app.config.ts', `export const appConfig = {\n  providers: [${providers}]\n};\n`);
    return host;
  };

  it("accepts Angular's providers, however they are laid out", () => {
    expect(() =>
      assertKnownProviders(
        treeWith(
          'provideBrowserGlobalErrorListeners(),\n    provideRouter(routes), provideClientHydration()',
        ),
        '/app.config.ts',
      ),
    ).not.toThrow();
  });

  it('fails by name on a provider a later Angular adds, instead of dropping it', () => {
    expect(() =>
      assertKnownProviders(
        treeWith(
          'provideBrowserGlobalErrorListeners(), provideRouter(routes), provideClientHydration(), provideZoneless()',
        ),
        '/app.config.ts',
      ),
    ).toThrow(/Unexpected: provideZoneless\(\)/);
  });
});

describe('ui-lib', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    tree = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
  });

  it('emits the SCSS layering under src/styles, where the components import it', () => {
    for (const file of ['_ref', '_semantic', '_layers', '_components', 'index']) {
      expect(tree.files).toContain(`/projects/ui/src/styles/${file}.scss`);
    }
  });

  it('maps the SCSS into the package output at the path consumers @use', () => {
    // `output`, so the sheet lands at dist/ui/styles and the import is
    // `@use 'ui/styles'` — not `ui/src/styles`, which leaks the source layout.
    expect(JSON.parse(tree.readContent('/projects/ui/ng-package.json')).assets).toEqual([
      { glob: '**/*.scss', input: './src/styles', output: './styles' },
    ]);
  });

  it('runs component tests in a real browser engine, not jsdom', () => {
    const test = JSON.parse(tree.readContent('/angular.json')).projects['ui'].architect.test;
    expect(test.options.browsers).toEqual(['chromium']);
    expect(test.options.headless).toBe(true);
  });

  it('registers Storybook through its Angular builder, not the CLI', () => {
    const architect = JSON.parse(tree.readContent('/angular.json')).projects['ui'].architect;
    expect(architect['build-storybook'].builder).toBe('@storybook/angular-vite:build-storybook');
    expect(architect['storybook'].builder).toBe('@storybook/angular-vite:start-storybook');
    expect(JSON.parse(tree.readContent('/package.json')).scripts['build-storybook']).toBe(
      'ng run ui:build-storybook',
    );
  });

  it('loads the tokens into Storybook as a global sheet, as an app does', () => {
    // The webpack framework could not take a global sheet, and the workaround —
    // a separately compiled tokens.css linked from preview-head.html — is gone.
    const options = JSON.parse(tree.readContent('/angular.json')).projects['ui'].architect[
      'build-storybook'
    ].options;
    expect(options.styles).toEqual(['projects/ui/src/styles/index.scss']);
    expect(options.stylePreprocessorOptions.includePaths).toEqual(['projects/ui/src/styles']);
    expect(tree.exists('/projects/ui/.storybook/preview-head.html')).toBe(false);
  });

  it('documents components from source, without a Compodoc step', () => {
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.scripts['docs:compodoc']).toBeUndefined();
    expect(manifest.scripts['styles:tokens']).toBeUndefined();
    expect(manifest.devDependencies['@compodoc/compodoc']).toBeUndefined();
    expect(tree.readContent('/projects/ui/.storybook/preview.ts')).not.toContain('setCompodocJson');
  });

  it('themes Storybook itself from the same colour-scheme toolbar as the stories', () => {
    // Without these the toolbar restyled only the story: the manager followed
    // the OS and docs pages stayed light whatever was chosen.
    const preview = tree.readContent('/projects/ui/.storybook/preview.ts');
    expect(preview).toContain("defaultValue: 'system'");
    expect(preview).toContain('container: ThemedDocsContainer');
    expect(tree.readContent('/projects/ui/.storybook/manager.ts')).toContain('api.setOptions');
  });

  it('gives applications a dist include path so @use resolves through dist/', () => {
    const options = JSON.parse(tree.readContent('/angular.json')).projects['shop'].architect.build
      .options;
    expect(options.stylePreprocessorOptions.includePaths).toContain('dist');
  });

  it('replaces the placeholder component with the real exports', () => {
    expect(tree.files).not.toContain('/projects/ui/src/lib/ui.ts');
    const api = tree.readContent('/projects/ui/src/public-api.ts');
    expect(api).toContain("export * from './lib/button/button'");
    expect(api).toContain("export * from './lib/field/field'");
    // The theme service is the theming plugin's, which adds its own exports.
    expect(api).not.toContain('./lib/theme/');
    expect(tree.files.some((path) => path.startsWith('/projects/ui/src/lib/theme/'))).toBe(false);
  });

  it('ships more than one palette, all with the same steps', () => {
    const ref = tree.readContent('/projects/ui/src/styles/_ref.scss');
    const palettes = [...ref.matchAll(/^\s{2}'([^']+)': \($/gm)].map(([, name]) => name);
    expect(palettes.length).toBeGreaterThan(1);
    expect(palettes).toContain('default');
  });

  it('emits each palette under the attribute anything may set to choose it', () => {
    const index = tree.readContent('/projects/ui/src/styles/index.scss');
    expect(index).toContain("[data-palette='#{$name}']");
  });

  it('retrofits the token import onto an app that predates the library', () => {
    expect(tree.readContent('/projects/shop/web/src/styles.scss')).toContain(
      "@use 'ui/styles' as *;",
    );
  });

  it('leaves an existing app shell alone — only the stylesheet is retrofitted', () => {
    // The app was generated before the library, so its shell is the plain one
    // and rewriting it would destroy whatever had been written there since.
    expect(tree.readContent('/projects/shop/web/src/app/app.ts')).not.toContain('ThemeToggle');
  });

  it('builds libraries once per build, from the projects rather than the root as well', () => {
    // The runner's `npm run build` and `npm start` call the projects' own
    // scripts, each of which builds the libraries first. A root hook would
    // build them again.
    expect(rootScripts(tree)['prebuild']).toBeUndefined();
    expect(rootScripts(tree)['prestart']).toBeUndefined();
    expect(ownScripts(tree, 'shop')['prebuild']).toBe('npm run build:libs --prefix ../../..');
  });

  it('leaves the root hooks to the project runner, which builds the libraries itself', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const libOnly = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
    for (const hook of ['prestart', 'prebuild', 'pretest']) {
      expect(rootScripts(libOnly)[hook]).toBeUndefined();
    }
  });

  it('hooks the root entry points while they run something with no hooks of its own', async () => {
    // A workspace without the runner, which is what `ng generate` meets in
    // one from an earlier 22.x: a library before any app leaves `npm start`
    // as Angular's project-less `ng serve`, which nothing else builds the
    // libraries for.
    const libOnly = await runner().runSchematic('ui-lib', { name: 'ui' }, await baseWorkspace());
    expect(rootScripts(libOnly)['prestart']).toBe('npm run build:libs');
    expect(rootScripts(libOnly)['prebuild']).toBe('npm run build:libs');

    // The first app takes start over, and its own hooks make the root's
    // redundant. `npm test` is still a project-less `ng test`.
    const withApp = await runner().runSchematic('app', { name: 'shop' }, libOnly);
    expect(rootScripts(withApp)['start']).toBe('npm start -w @test-ws/shop');
    expect(rootScripts(withApp)['prestart']).toBeUndefined();
    expect(rootScripts(withApp)['prebuild']).toBeUndefined();
    expect(rootScripts(withApp)['pretest']).toBe('npm run build:libs');
  });

  it('keeps the root prebuild for an app Angular generated, which has no hooks', async () => {
    // What `ng add` meets. The library's stylesheet import goes into that app
    // too, so its `ng build` fails in Sass unless the root builds the library.
    const existing = await runner().runExternalSchematic(
      '@schematics/angular',
      'application',
      { name: 'legacy', skipInstall: true },
      await baseWorkspace(),
    );
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, existing);
    const withApp = await runner().runSchematic('app', { name: 'shop' }, withLib);
    expect(rootScripts(withApp)['build']).toBe('ng build legacy && npm run build -w @test-ws/shop');
    expect(rootScripts(withApp)['prebuild']).toBe('npm run build:libs');
  });

  it('ships components with tests and stories, so the wiring is exercised', () => {
    expect(tree.files).toContain('/projects/ui/src/lib/button/button.spec.ts');
    expect(tree.files).toContain('/projects/ui/src/lib/button/button.stories.ts');
  });

  it('draws focus rings and errors in the steps check:contrast holds to the page', () => {
    // `--accent` and `--danger` are fill steps, picked to carry white, and fall
    // under 3:1 against a dark surface. Their `-strong` partners are checked.
    const sources = [
      '/projects/ui/src/styles/_components.scss',
      '/projects/ui/src/lib/field/field.scss',
    ].map((path) => tree.readContent(path));
    for (const source of sources) {
      expect(source).not.toMatch(/outline:[^;]*var\(--accent\)/);
      expect(source).not.toMatch(/(?:^|[^-])color:\s*var\(--danger\)/m);
    }
    expect(tree.readContent('/projects/ui/src/styles/_components.scss')).toContain(
      'outline: 2px solid var(--accent-strong)',
    );

    const check = tree.readContent('/projects/ui/scripts/check-contrast.mjs');
    expect(check).toContain("fg: 'danger-strong', bg: 'surface'");
    expect(check).toContain("fg: 'accent-strong', bg: 'surface'");
  });

  it('runs its tests through the project runner, with no root script of its own', () => {
    expect(rootScripts(tree)['test']).toBe('node scripts/project.mjs test');
    expect(rootScripts(tree)['test:ui']).toBeUndefined();
    expect(scriptsTable(tree)).toContain('| `npm test ui` |');
  });

  it('hooks build:libs into prestart, because ng serve does not build libraries', () => {
    const scripts = rootScripts(tree);
    expect(scripts['build:libs']).toContain('ng build ui');
    // `npm start shop` reaches it through the app's own prestart. The runner
    // runs it itself before a project-less `npm test`, so the root has no hook.
    expect(ownScripts(tree, 'shop')['prestart']).toBe('npm run build:libs --prefix ../../..');
    expect(scripts['pretest']).toBeUndefined();
  });

  it('lists the library scripts in the README', () => {
    const table = scriptsTable(tree);
    expect(table).toContain('| `npm run build:libs` |');
    expect(table).toContain('| `npm run check:contrast` |');
    expect(table).toContain('| `npm run storybook` |');
  });

  it('uses the Vite Storybook framework, with none of the webpack one', () => {
    // @storybook/angular required @angular-devkit/build-angular, and with it
    // webpack-dev-server and an unfixable braces advisory. The Vite framework
    // requires neither that nor platform-browser-dynamic.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;

    expect(devDependencies['@storybook/angular-vite']).toBe(
      VERSIONS['@storybook/angular-vite'].range,
    );
    expect(devDependencies['@analogjs/vite-plugin-angular']).toBe(
      VERSIONS['@analogjs/vite-plugin-angular'].range,
    );
    expect(devDependencies['@storybook/angular']).toBeUndefined();
    expect(devDependencies['@angular-devkit/build-angular']).toBeUndefined();
    expect(devDependencies['@angular/platform-browser-dynamic']).toBeUndefined();
  });

  it('declares the required devkit peers but not the deprecated one', () => {
    // core and architect are REQUIRED peers of @storybook/angular-vite: left
    // implicit, npm backtracks them off the Angular line. @angular/animations
    // is a required peer too, but npm installs it either way; declaring it
    // would make a deprecated package one this generator chose.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;

    expect(devDependencies['@angular-devkit/core']).toBeDefined();
    expect(devDependencies['@angular-devkit/architect']).toBeDefined();
    expect(devDependencies['@angular/animations']).toBeUndefined();
  });

  it('overwrites the vitest range Angular emitted, so the browser provider matches', () => {
    // @vitest/browser-playwright peers vitest at an exact version. @angular/cli
    // 22.2 emits `vitest: ^5.0.0`, and any CLI release can move that range
    // again; deferring to it resolved vitest above the provider's peer and the
    // install died on ERESOLVE before anything was written.
    const devDependencies = JSON.parse(tree.readContent('/package.json')).devDependencies;

    expect(devDependencies['vitest']).toBe(VERSIONS['vitest'].range);
    expect(devDependencies['@vitest/browser-playwright']).toBe(
      VERSIONS['@vitest/browser-playwright'].range,
    );
    expect(devDependencies['vitest']).not.toBe(latestVersions['vitest']);
  });

  it('emits no source that imports the deprecated animations package', () => {
    // The prune rule's guard reads the source, so a story or component that
    // imported @angular/animations would quietly re-legitimise the dependency.
    const importers = tree.files.filter(
      (file) => file.endsWith('.ts') && tree.readContent(file).includes('@angular/animations'),
    );
    expect(importers).toEqual([]);
  });

  it('derives the selector prefix from the library name', async () => {
    // Regression: schema defaults are applied before the factory runs, so a
    // `"default"` on `prefix` silently shadows the derivation and every
    // library ships `ui-` selectors no matter what it is called.
    const derived = await runner().runSchematic(
      'ui-lib',
      { name: 'design-system' },
      await runner().runSchematic('workspace', {}, await baseWorkspace()),
    );
    expect(derived.readContent('/projects/design-system/src/lib/button/button.ts')).toContain(
      "selector: 'design-system-button'",
    );
  });

  it('takes an explicit prefix, down to the ids the field generates', async () => {
    const prefixed = await runner().runSchematic(
      'ui-lib',
      { name: 'ui', prefix: 'acme' },
      await runner().runSchematic('workspace', {}, await baseWorkspace()),
    );
    expect(prefixed.readContent('/projects/ui/src/lib/button/button.ts')).toContain(
      "selector: 'acme-button'",
    );
    expect(prefixed.readContent('/projects/ui/src/lib/field/field.ts')).toContain('`acme-field-');
    expect(prefixed.readContent('/projects/ui/src/lib/button/button.stories.ts')).toContain(
      '<acme-button',
    );
    expect(JSON.parse(prefixed.readContent('/angular.json')).projects['ui'].prefix).toBe('acme');
  });
});

describe('codegen', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    tree = await runner().runSchematic('codegen', { apps: ['shop'] }, withApp);
  });

  it('emits an orval config and a per-app client seam', () => {
    expect(tree.files).toContain('/orval.config.ts');
    expect(tree.files).toContain('/projects/shop/web/src/api/api-client.ts');
  });

  it('reads the spec location from the environment rather than committing it', () => {
    expect(tree.readContent('/orval.config.ts')).toContain("process.env['OPENAPI_SPEC']");
  });

  it('regenerates before every entry point that compiles the app', () => {
    // Not from the root: the runner runs it before a project-less `npm test`,
    // and `npm start` and `npm run build` go through the app's own hooks.
    const scripts = rootScripts(tree);
    for (const hook of ['prebuild', 'prestart', 'pretest']) {
      expect(scripts[hook]).toBeUndefined();
    }
    // The app's own entry points, which npm hooks under their own names — and
    // only the ones it has.
    const own = ownScripts(tree, 'shop');
    for (const hook of ['prebuild', 'prestart', 'prewatch', 'pretest']) {
      expect(own[hook]).toContain('npm run codegen:optional --prefix ../../..');
    }
    expect(own['pree2e']).toBeUndefined();
  });

  it('says in the README where the spec comes from', () => {
    expect(scriptsTable(tree)).toMatch(/\| `npm run codegen` \| .*`\$OPENAPI_SPEC`/);
  });

  it('gitignores the generated client', () => {
    expect(tree.readContent('/.gitignore')).toContain('**/src/api/generated/');
  });

  /** A workspace whose one app, `shop`, has been through codegen once. */
  async function codegenOnce(options: Record<string, unknown> = {}): Promise<UnitTestTree> {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    return runner().runSchematic('codegen', { apps: ['shop'], ...options }, withApp);
  }

  /** `tree` with one string in one file replaced, failing if it was not there. */
  function edit(tree: UnitTestTree, path: string, from: string, to: string): string {
    const before = tree.readContent(path);
    expect(before, `${path} has no "${from}"`).toContain(from);
    const after = before.replace(from, to);
    tree.overwrite(path, after);
    return after;
  }

  it('leaves an api-client.ts that exists alone when it runs again', async () => {
    // Its header promises regeneration never touches it, and running the
    // schematic again — for an app added later — is regeneration too.
    const first = await codegenOnce();
    const path = '/projects/shop/web/src/api/api-client.ts';
    const edited = edit(first, path, "'/api'", "'https://api.acme.example'");
    const config = first.readContent('/orval.config.ts');

    const again = await runner().runSchematic('codegen', { apps: ['shop'] }, first);
    expect(again.readContent(path)).toBe(edited);
    expect(again.readContent('/orval.config.ts')).toBe(config);
  });

  it('adds an app to the config, keeping the entries and edits already there', async () => {
    // `--apps admin` names the app being added, not the whole set. Rendering the
    // config from it alone took every earlier client away, and a setting
    // someone had changed went with it.
    const first = await codegenOnce();
    edit(first, '/orval.config.ts', "mode: 'tags-split'", "mode: 'split'");

    const admin = await runner().runSchematic('app', { name: 'admin' }, first);
    const again = await runner().runSchematic('codegen', { apps: ['admin'] }, admin);
    const config = again.readContent('/orval.config.ts');

    expect(config).toContain("target: 'projects/shop/web/src/api/generated/index.ts'");
    expect(config).toContain("target: 'projects/admin/web/src/api/generated/index.ts'");
    expect(config).toContain("mode: 'split'");
    expect(config.match(/^ {2}shop: \{/gm)).toHaveLength(1);
    expect(again.files).toContain('/projects/admin/web/src/api/api-client.ts');
  });

  it('keeps the spec variable the first run chose', async () => {
    // A second run without --spec-env-var gets the schema default, and used to
    // write it over the variable the workspace was set up with.
    const first = await codegenOnce({ specEnvVar: 'API_SPEC' });
    const again = await runner().runSchematic('codegen', { apps: ['shop'] }, first);

    expect(again.readContent('/orval.config.ts')).toContain("process.env['API_SPEC']");
    expect(again.readContent('/scripts/codegen.mjs')).toContain("process.env['API_SPEC']");
  });

  it('says what to add by hand when the config no longer has the shape it writes', async () => {
    const first = await codegenOnce();
    first.overwrite('/orval.config.ts', 'export default { shop: {} };\n');
    const admin = await runner().runSchematic('app', { name: 'admin' }, first);

    await expect(runner().runSchematic('codegen', { apps: ['admin'] }, admin)).rejects.toThrow(
      /Add the entry by hand:[\s\S]*projects\/admin\/web\/src\/api\/api-client\.ts/,
    );
  });

  it('refuses to run with no application to generate into', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    await expect(runner().runSchematic('codegen', {}, base)).rejects.toThrow(
      /needs at least one application/,
    );
  });
});

describe('packages', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
    tree = await runner().runSchematic('packages', { packages: ['cdk'] }, withLib);
  });

  it('installs the CDK as a runtime dependency, not a dev one', () => {
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.dependencies['@angular/cdk']).toBeDefined();
    expect(manifest.devDependencies?.['@angular/cdk']).toBeUndefined();
  });

  it('takes the range Angular writes for its own packages, not `latest`', () => {
    // Read from @schematics/angular rather than hard-coded: the CDK ships in
    // lockstep with the framework, and the assertion is that the two agree.
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.dependencies['@angular/cdk']).toBe(latestVersions.Angular);
  });

  it('declares it as a peer of the library, which is what publishes', () => {
    // A component library built on the CDK that does not declare it ships a
    // package resolving only by accident of hoisting.
    const library = JSON.parse(tree.readContent('/projects/ui/package.json'));
    expect(library.peerDependencies['@angular/cdk']).toBe(latestVersions.Angular);
    // Angular's own peers are still there — the block was added to, not rewritten.
    expect(library.peerDependencies['@angular/core']).toBeDefined();
  });

  it('says in the README what it is for and which stylesheet it needs', () => {
    const readme = tree.readContent('/README.md');
    expect(readme).toContain('## Angular CDK');
    expect(readme).toContain('overlay-prebuilt.css');
  });

  it('wires the overlay stylesheet into the application', () => {
    // Without it an overlay opens unpositioned and with no backdrop, and
    // nothing anywhere reports a problem.
    const styles = buildStyles(tree, 'shop');
    expect(styles).toContain('node_modules/@angular/cdk/overlay-prebuilt.css');
  });

  it('puts it ahead of the application stylesheet, so the app can override it', () => {
    // `styles` is concatenated in order: appended last, the vendor sheet beats
    // every rule the app wrote to override it, at equal specificity.
    const styles = buildStyles(tree, 'shop');
    const vendor = styles.indexOf('node_modules/@angular/cdk/overlay-prebuilt.css');
    const own = styles.findIndex((style) => style.endsWith('styles.scss'));
    expect(own).toBeGreaterThan(-1);
    expect(vendor).toBeLessThan(own);
  });

  it('leaves the library alone — it has no global stylesheet to prepend to', () => {
    // ng-packagr's build target carries a `project`, not `options.styles`, so
    // a rule that reached libraries would have to invent the block to write
    // into. It does not: only `projectType: application` is touched.
    const project = JSON.parse(tree.readContent('/angular.json')).projects.ui;
    expect(project.architect.build.options?.styles).toBeUndefined();
    expect(JSON.stringify(project)).not.toContain('overlay-prebuilt.css');
  });

  it('is idempotent, so running it again in a live workspace changes nothing', async () => {
    const again = await runner().runSchematic('packages', { packages: ['cdk'] }, tree);
    expect(again.readContent('/README.md')).toBe(tree.readContent('/README.md'));
    expect(again.readContent('/package.json')).toBe(tree.readContent('/package.json'));
    // A second run must not stack a second copy of the stylesheet.
    expect(again.readContent('/angular.json')).toBe(tree.readContent('/angular.json'));
  });

  it('wires an app generated after the package was added', async () => {
    // The schematic runs once, over the projects that exist at that moment. An
    // app added later must not come up missing the stylesheet every other app
    // in the workspace has.
    const later = await runner().runSchematic('app', { name: 'admin' }, tree);
    expect(buildStyles(later, 'admin')).toContain('node_modules/@angular/cdk/overlay-prebuilt.css');
  });

  it('declares the peer on a library generated after the package was added', async () => {
    const later = await runner().runSchematic('ui-lib', { name: 'later' }, tree);
    const library = JSON.parse(later.readContent('/projects/later/package.json'));
    expect(library.peerDependencies['@angular/cdk']).toBe(latestVersions.Angular);
  });

  it('does nothing at all when nothing was asked for', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const untouched = await runner().runSchematic('packages', {}, base);
    expect(untouched.readContent('/package.json')).toBe(base.readContent('/package.json'));
  });

  it('names the alternatives when an id is not in the catalog', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    await expect(runner().runSchematic('packages', { packages: ['cdk-x'] }, base)).rejects.toThrow(
      /"cdk-x" is not one of the packages .* Known: cdk/s,
    );
  });
});

describe('packages aria', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
    // Asked for on its own, which is the interesting case: it has to arrive
    // with the CDK.
    tree = await runner().runSchematic('packages', { packages: ['aria'] }, withLib);
  });

  it('brings the CDK, whose peer range Aria names exactly', () => {
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.dependencies['@angular/aria']).toBe(latestVersions.Angular);
    expect(manifest.dependencies['@angular/cdk']).toBe(latestVersions.Angular);
  });

  it('declares both as peers of the library, which is what publishes', () => {
    const library = JSON.parse(tree.readContent('/projects/ui/package.json'));
    expect(library.peerDependencies['@angular/aria']).toBe(latestVersions.Angular);
    expect(library.peerDependencies['@angular/cdk']).toBe(latestVersions.Angular);
  });

  it('documents both, in catalog order rather than the order they were typed', () => {
    const readme = tree.readContent('/README.md');
    expect(readme).toContain('## Angular Aria');
    expect(readme.indexOf('## Angular CDK')).toBeLessThan(readme.indexOf('## Angular Aria'));
  });

  it('wires the CDK overlay sheet, which is what positions an Aria popup', () => {
    // Aria ships no stylesheet of its own, and nothing it renders is positioned
    // for you — an unstyled combobox popup sits in flow under its trigger.
    expect(buildStyles(tree, 'shop')).toContain('node_modules/@angular/cdk/overlay-prebuilt.css');
  });

  it('produces the same workspace whether or not the CDK was asked for too', async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, withApp);
    const both = await runner().runSchematic('packages', { packages: ['aria', 'cdk'] }, withLib);
    expect(both.readContent('/package.json')).toBe(tree.readContent('/package.json'));
    expect(both.readContent('/README.md')).toBe(tree.readContent('/README.md'));
    expect(both.readContent('/angular.json')).toBe(tree.readContent('/angular.json'));
  });
});

describe('packages service-worker', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    const base = await runner().runSchematic('workspace', {}, await baseWorkspace());
    const withApp = await runner().runSchematic('app', { name: 'shop' }, base);
    // A marketing site as well: it is an application too, so it gets the same
    // wiring, and its `app.config.ts` is the marketing template's rather than
    // Angular's — the second shape the provider insertion has to handle.
    const withSite = await runner().runSchematic(
      'marketing',
      { name: 'site', origin: 'https://acme.example' },
      withApp,
    );
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, withSite);
    tree = await runner().runSchematic('packages', { packages: ['service-worker'] }, withLib);
  });

  it('installs the package at the framework range, which it peers exactly', () => {
    const manifest = JSON.parse(tree.readContent('/package.json'));
    expect(manifest.dependencies['@angular/service-worker']).toBe(latestVersions.Angular);
  });

  it('writes an ngsw-config.json per project, not one for the workspace', () => {
    // `serviceWorker` is a per-target option, and two applications do not cache
    // the same set of files.
    expect(tree.files).toContain('/projects/shop/web/ngsw-config.json');
    expect(tree.files).not.toContain('/ngsw-config.json');
  });

  it('gives the config a $schema that resolves from where it sits', () => {
    const config = JSON.parse(tree.readContent('/projects/shop/web/ngsw-config.json'));
    expect(config.$schema).toBe('../../../node_modules/@angular/service-worker/config/schema.json');
  });

  it('still matches the default Angular itself would have written', () => {
    // The content is a copy, so this is the guard on it: when a later Angular
    // minor changes its own default, this fails in CI rather than quietly
    // leaving every generated workspace on the old one. Update both together.
    const template = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'node_modules',
        '@schematics',
        'angular',
        'service-worker',
        'files',
        'ngsw-config.json.template',
      ),
      'utf8',
    );
    const angular = JSON.parse(template.replace('<%= relativePathToWorkspaceRoot %>', '../../..'));
    expect(JSON.parse(tree.readContent('/projects/shop/web/ngsw-config.json'))).toEqual(angular);
  });

  it('enables it on the production configuration only, so `ng serve` is untouched', () => {
    const build = JSON.parse(tree.readContent('/angular.json')).projects.shop.architect.build;
    expect(build.configurations.production.serviceWorker).toBe(
      'projects/shop/web/ngsw-config.json',
    );
    expect(build.options?.serviceWorker).toBeUndefined();
    expect(build.configurations.development?.serviceWorker).toBeUndefined();
  });

  it('registers it, gated on dev mode and on the Capacitor shell', () => {
    // The mobile sibling ships whatever the web build emitted, so a worker that
    // registered on device would serve the shell it cached before the last
    // native update.
    const config = tree.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config).toContain("provideServiceWorker('ngsw-worker.js'");
    expect(config).toContain('enabled: !isDevMode() && !inNativeShell');
    expect(config).toContain("registrationStrategy: 'registerWhenStable:30000'");
  });

  it('asks the platform rather than whether the Capacitor global exists', () => {
    // `@capacitor/core` assigns `globalThis.Capacitor` from its module
    // initialiser on every platform, browser included — so a plugin with a web
    // implementation imported into shared code would make a presence check true
    // in the browser and silently stop registering the worker on the web.
    const config = tree.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config).toContain('Capacitor?.isNativePlatform() ===');
    expect(config).not.toContain("'Capacitor' in globalThis");
  });

  it('does not import @capacitor/core, which the web app never declared', () => {
    // It is a dependency of the `mobile/` sibling, and a web-only app has no
    // mobile sibling at all. The comment above the constant names the package —
    // an import statement is the thing that would not resolve.
    const config = tree.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config).not.toMatch(/^import .*'@capacitor\/core';$/m);
  });

  it('imports what it added, into the groups those imports belong to', () => {
    const config = tree.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config).toMatch(
      /import \{ ApplicationConfig, provideBrowserGlobalErrorListeners, isDevMode \} from '@angular\/core';/,
    );
    expect(config).toContain("import { provideServiceWorker } from '@angular/service-worker';");
    // Above the relative imports, not below them.
    expect(config.indexOf("from '@angular/service-worker'")).toBeLessThan(
      config.indexOf("from './app.routes'"),
    );
  });

  it('keeps every provider that was already there', () => {
    const config = tree.readContent('/projects/shop/web/src/app/app.config.ts');
    expect(config).toContain('provideBrowserGlobalErrorListeners()');
    expect(config).toContain('provideRouter(routes)');
  });

  it('skips a prerendered site, which wants to be current more than cached', () => {
    // Crawlers do not run a service worker, and a returning visitor would keep
    // getting the previous deploy. The README section says how to add it to a
    // docs site, where it does pay.
    expect(tree.files).not.toContain('/projects/site/web/ngsw-config.json');
    expect(tree.readContent('/projects/site/web/src/app/app.config.ts')).not.toContain(
      'provideServiceWorker',
    );
    const site = JSON.parse(tree.readContent('/angular.json')).projects.site;
    expect(site.architect.build.configurations.production.serviceWorker).toBeUndefined();
  });

  it('leaves the skipped site otherwise untouched', () => {
    const config = tree.readContent('/projects/site/web/src/app/app.config.ts');
    expect(config).toContain('{ provide: TitleStrategy, useClass: PageMetaStrategy }');
    expect(config).not.toContain('isDevMode');
  });

  it('recognises the site by outputMode, not by name or path', () => {
    // The same signal `inferFeatures` reads. An app someone configures to
    // prerender is a prerendered site, whatever it is called.
    const site = JSON.parse(tree.readContent('/angular.json')).projects.site;
    expect(site.architect.build.options.outputMode).toBe('static');
    const shop = JSON.parse(tree.readContent('/angular.json')).projects.shop;
    expect(shop.architect.build.options.outputMode).toBeUndefined();
  });

  it('leaves the library alone — registration belongs to an application', () => {
    expect(tree.files).not.toContain('/projects/ui/ngsw-config.json');
    const project = JSON.parse(tree.readContent('/angular.json')).projects.ui;
    expect(JSON.stringify(project)).not.toContain('serviceWorker');
  });

  it('is idempotent, so running it again in a live workspace changes nothing', async () => {
    const again = await runner().runSchematic('packages', { packages: ['service-worker'] }, tree);
    for (const path of [
      '/package.json',
      '/angular.json',
      '/README.md',
      '/projects/shop/web/ngsw-config.json',
      '/projects/shop/web/src/app/app.config.ts',
    ]) {
      expect(again.readContent(path), path).toBe(tree.readContent(path));
    }
  });

  it('wires an app generated after the package was added', async () => {
    const later = await runner().runSchematic('app', { name: 'admin' }, tree);
    expect(later.files).toContain('/projects/admin/web/ngsw-config.json');
    expect(later.readContent('/projects/admin/web/src/app/app.config.ts')).toContain(
      'provideServiceWorker',
    );
    expect(
      JSON.parse(later.readContent('/angular.json')).projects.admin.architect.build.configurations
        .production.serviceWorker,
    ).toBe('projects/admin/web/ngsw-config.json');
  });
});

describe('the project runner', () => {
  let dir: string;

  /**
   * The generated workspace's manifests and runner on disk, with `npm` and
   * `ng` replaced by stubs that log what they were asked to run.
   */
  beforeAll(async () => {
    const base = await runner().runSchematic(
      'workspace',
      { e2e: 'playwright' },
      await baseWorkspace(),
    );
    const withLib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
    const withApp = await runner().runSchematic(
      'app',
      { name: 'shop', e2e: 'playwright' },
      withLib,
    );
    const tree = await runner().runSchematic(
      'marketing',
      { name: 'site', e2e: 'playwright' },
      withApp,
    );

    dir = mkdtempSync(join(tmpdir(), 'acw-runner-'));
    for (const file of [
      '/scripts/project.mjs',
      '/angular.json',
      '/package.json',
      '/projects/shop/web/package.json',
      '/projects/site/web/package.json',
    ]) {
      mkdirSync(join(dir, dirname(file)), { recursive: true });
      writeFileSync(join(dir, file), tree.readContent(file));
    }
    mkdirSync(join(dir, 'bin'));
    for (const stub of ['npm', 'ng']) {
      writeFileSync(join(dir, 'bin', stub), `#!/bin/sh\necho "${stub} $*" >> "$RUNNER_LOG"\n`);
      chmodSync(join(dir, 'bin', stub), 0o755);
    }
  });

  function run(...args: string[]): { status: number | null; ran: string[]; stderr: string } {
    const log = join(dir, `log-${Math.random().toString(36).slice(2)}`);
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['scripts/project.mjs', ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { PATH: `${join(dir, 'bin')}:${dirname(process.execPath)}`, RUNNER_LOG: log },
    });
    return {
      status: result.status,
      ran: readFileSync(log, 'utf8').split('\n').filter(Boolean),
      stderr: result.stderr,
    };
  }

  it('serves only the app it is told to, through its own scripts and hooks', () => {
    expect(run('start', 'shop').ran).toEqual(['npm start -w @test-ws/shop']);

    const unnamed = run('start');
    expect(unnamed.status).toBe(1);
    expect(unnamed.stderr).toContain('Apps: shop, site.');
    expect(unnamed.ran).toEqual([]);
  });

  it('passes flags after the name to the project', () => {
    expect(run('start', 'site', '--port', '4300').ran).toEqual([
      'npm start -w @test-ws/site -- --port 4300',
    ]);
  });

  it('builds every app and site without a name, in angular.json order', () => {
    expect(run('build').ran).toEqual([
      'npm run build -w @test-ws/shop',
      'npm run build -w @test-ws/site',
    ]);
  });

  it('tests every project in one ng test, after the libraries are built', () => {
    // One process, not one per project, so the libraries build once.
    expect(run('test').ran).toEqual(['npm run build:libs', 'ng test --no-watch']);
  });

  it('runs a library, which has no manifest of its own, with ng', () => {
    expect(run('test', 'ui').ran).toEqual(['ng test ui']);
  });

  it('runs every e2e suite, and names the projects when given one it does not know', () => {
    expect(run('e2e').ran).toEqual([
      'npm run e2e -w @test-ws/shop',
      'npm run e2e -w @test-ws/site',
    ]);

    const unknown = run('build', 'shopp');
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('There is no project "shopp". Projects: ui, shop, site.');
  });
});
