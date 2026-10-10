import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { logging } from '@angular-devkit/core';
import { HostTree } from '@angular-devkit/schematics';
import { SchematicTestRunner } from '@angular-devkit/schematics/testing';
import { describe, expect, it } from 'vitest';
import { replaceGeneratedText, replaceGeneratedValue } from '../src/migrations/edit';

// Loaded compiled, like the schematics collection: `ng update` resolves the
// path in the published manifest, so the built file is the one to test.
const pkgRoot = join(__dirname, '..');
const migrations = join(pkgRoot, 'dist', 'migrations.json');

if (!existsSync(migrations)) {
  throw new Error(
    `${migrations} does not exist. Run \`npm run build\` before the tests — ` +
      `the schematic runner loads compiled factories, not sources.`,
  );
}

describe('the migrations collection', () => {
  it('is where the manifest sends ng update', () => {
    const manifest = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8')) as {
      'ng-update'?: { migrations?: string };
    };
    expect(join(pkgRoot, manifest['ng-update']?.migrations ?? '')).toBe(migrations);
  });

  it('resolves every factory', () => {
    const runner = new SchematicTestRunner('acw-migrations', migrations);
    const collection = runner.engine.createCollection('acw-migrations');
    for (const name of collection.listSchematicNames(true)) {
      expect(() => collection.createSchematic(name, true), name).not.toThrow();
    }
  });
});

/** A logger that keeps its warnings, which is what the user sees of a skipped edit. */
function capture(): { logger: logging.Logger; warnings: string[] } {
  const logger = new logging.Logger('migration');
  const warnings: string[] = [];
  logger.subscribe((entry) => {
    if (entry.level === 'warn') {
      warnings.push(entry.message);
    }
  });
  return { logger, warnings };
}

describe('replaceGeneratedText', () => {
  const edit = {
    generated: 'node scripts/build.mjs',
    replacement: 'node scripts/build.mjs --out "$OUT"',
    manual: 'Add `--out "$OUT"` to the build command.',
  };

  it('replaces what a release wrote, and finds the fix in place on a second run', () => {
    const tree = new HostTree();
    tree.create('/run.sh', 'set -e\nnode scripts/build.mjs\n');
    const { logger, warnings } = capture();

    expect(replaceGeneratedText(tree, logger, '/run.sh', edit)).toBe('applied');
    expect(tree.readText('/run.sh')).toBe('set -e\nnode scripts/build.mjs --out "$OUT"\n');
    expect(replaceGeneratedText(tree, logger, '/run.sh', edit)).toBe('current');
    expect(tree.readText('/run.sh')).toBe('set -e\nnode scripts/build.mjs --out "$OUT"\n');
    expect(warnings).toEqual([]);
  });

  it('takes text out without mistaking what is left for the fix', () => {
    const tree = new HostTree();
    tree.create('/a.ts', 'one();\ntwo();\n');
    const { logger } = capture();
    const removal = { generated: 'one();\ntwo();\n', replacement: 'one();\n', manual: '' };

    expect(replaceGeneratedText(tree, logger, '/a.ts', removal)).toBe('applied');
    expect(replaceGeneratedText(tree, logger, '/a.ts', removal)).toBe('current');
    expect(tree.readText('/a.ts')).toBe('one();\n');
  });

  // Two copies are refused too: there is no telling which one a release wrote.
  it.each([
    ['an edited', 'node tools/build.mjs\n'],
    ['a twice-matching', 'node scripts/build.mjs --verbose\nnode scripts/build.mjs\n'],
  ])('leaves %s file alone and logs the manual step', (_, text) => {
    const tree = new HostTree();
    tree.create('/run.sh', text);
    const { logger, warnings } = capture();

    expect(replaceGeneratedText(tree, logger, '/run.sh', edit)).toBe('skipped');
    expect(tree.readText('/run.sh')).toBe(text);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/run.sh');
    expect(warnings[0]).toContain(edit.manual);
  });

  it('says nothing about a file that is not there', () => {
    const { logger, warnings } = capture();
    expect(replaceGeneratedText(new HostTree(), logger, '/run.sh', edit)).toBe('absent');
    expect(warnings).toEqual([]);
  });
});

describe('replaceGeneratedValue', () => {
  const manifest = `{
  "name": "ws",
  "scripts": {
    "build:site": "ng build site",
    "test": "ng test"
  }
}
`;
  const edit = {
    generated: 'ng build site',
    replacement: 'ng build site && node scripts/check.mjs site',
    manual: 'Append `&& node scripts/check.mjs site` to `build:site`.',
  };

  it('replaces the value and nothing else, once', () => {
    const tree = new HostTree();
    tree.create('/package.json', manifest);
    const { logger, warnings } = capture();
    const at = ['scripts', 'build:site'];

    expect(replaceGeneratedValue(tree, logger, '/package.json', at, edit)).toBe('applied');
    expect(tree.readText('/package.json')).toBe(
      manifest.replace('"ng build site"', `"${edit.replacement}"`),
    );
    expect(replaceGeneratedValue(tree, logger, '/package.json', at, edit)).toBe('current');
    expect(warnings).toEqual([]);
  });

  it('leaves a value the user changed and logs the manual step', () => {
    const tree = new HostTree();
    tree.create('/package.json', manifest.replace('ng build site', 'ng build site -c staging'));
    const { logger, warnings } = capture();

    expect(
      replaceGeneratedValue(tree, logger, '/package.json', ['scripts', 'build:site'], edit),
    ).toBe('skipped');
    expect(tree.readText('/package.json')).toContain('"ng build site -c staging"');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/package.json at "scripts.build:site"');
    expect(warnings[0]).toContain(edit.manual);
  });

  it('adds a key no release wrote, and removes one', () => {
    const tree = new HostTree();
    tree.create('/package.json', manifest);
    const { logger } = capture();
    const add = { generated: undefined, replacement: 'ng lint', manual: '' };
    const remove = { generated: 'ng test', replacement: undefined, manual: '' };

    expect(replaceGeneratedValue(tree, logger, '/package.json', ['scripts', 'lint'], add)).toBe(
      'applied',
    );
    expect(replaceGeneratedValue(tree, logger, '/package.json', ['scripts', 'test'], remove)).toBe(
      'applied',
    );
    expect(JSON.parse(tree.readText('/package.json')).scripts).toEqual({
      'build:site': 'ng build site',
      lint: 'ng lint',
    });
  });

  it('treats a file that does not parse as edited rather than throwing', () => {
    const tree = new HostTree();
    tree.create('/package.json', '{ "scripts": { ');
    const { logger, warnings } = capture();

    expect(
      replaceGeneratedValue(tree, logger, '/package.json', ['scripts', 'build:site'], edit),
    ).toBe('skipped');
    expect(warnings).toHaveLength(1);
  });
});

describe('prepare-once', () => {
  const runner = new SchematicTestRunner('acw-migrations', migrations);
  const codegen = 'npm run codegen:optional --prefix ../../..';
  const libs = 'npm run build:libs --prefix ../../..';
  const prepare = 'angular-capacitor-workspace prepare';

  /** A workspace as 22.6 or 22.7 wrote it, with `shop`'s hooks as given. */
  function workspace(hooks: Record<string, string>): HostTree {
    const tree = new HostTree();
    tree.create(
      '/angular.json',
      JSON.stringify({
        projects: {
          ui: { projectType: 'library', root: 'projects/ui' },
          shop: { projectType: 'application', root: 'projects/shop/web' },
          // An app from before 22.6, whose scripts are in the root manifest.
          admin: { projectType: 'application', root: 'projects/admin' },
        },
      }),
    );
    tree.create(
      '/projects/shop/web/package.json',
      JSON.stringify({ name: '@ws/shop', scripts: { build: 'ng build shop', ...hooks } }, null, 2),
    );
    return tree;
  }

  async function migrate(
    tree: HostTree,
  ): Promise<{ hooks: Record<string, string>; warnings: string[] }> {
    const warnings: string[] = [];
    const subscription = runner.logger.subscribe((entry) => {
      if (entry.level === 'warn') {
        warnings.push(entry.message);
      }
    });
    const result = await runner.runSchematic('prepare-once', {}, tree);
    subscription.unsubscribe();
    return {
      hooks: JSON.parse(result.readContent('/projects/shop/web/package.json')).scripts,
      warnings,
    };
  }

  // Codegen's hook comes first when the design system was generated with the
  // workspace, and last when it was added to a workspace that had codegen.
  it.each([
    ['the library build', libs],
    ['codegen', codegen],
    ['codegen, then the library build', `${codegen} && ${libs}`],
    ['the library build, then codegen', `${libs} && ${codegen}`],
  ])('replaces a hook running %s with prepare', async (_, hook) => {
    const { hooks, warnings } = await migrate(
      workspace({ prestart: hook, prebuild: hook, pree2e: hook }),
    );
    expect(hooks).toEqual({
      build: 'ng build shop',
      prestart: prepare,
      prebuild: prepare,
      pree2e: prepare,
    });
    expect(warnings).toEqual([]);
  });

  it('changes nothing on a second run', async () => {
    const once = workspace({ prebuild: `${codegen} && ${libs}` });
    await runner.runSchematic('prepare-once', {}, once);
    const before = once.readText('/projects/shop/web/package.json');
    const { warnings } = await migrate(once);
    expect(once.readText('/projects/shop/web/package.json')).toBe(before);
    expect(warnings).toEqual([]);
  });

  it('leaves an edited hook alone and logs the manual step', async () => {
    const edited = `${libs} && echo built`;
    const { hooks, warnings } = await migrate(workspace({ prebuild: edited, prestart: libs }));
    expect(hooks['prebuild']).toBe(edited);
    expect(hooks['prestart']).toBe(prepare);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('scripts.prebuild');
    expect(warnings[0]).toContain(prepare);
  });

  it('leaves a project without hooks, or without a manifest of its own, alone', async () => {
    const { hooks, warnings } = await migrate(workspace({}));
    expect(hooks).toEqual({ build: 'ng build shop' });
    expect(warnings).toEqual([]);
  });
});

describe('theme-story-providers', () => {
  const runner = new SchematicTestRunner('acw-migrations', migrations);
  const story = '/projects/ui/src/lib/theme/theme-toggle.stories.ts';
  const template = readFileSync(
    join(pkgRoot, 'src/plugins/theming/files/lib/src/lib/theme/theme-toggle.stories.ts.template'),
    'utf8',
  );

  /** The story as 22.5 to 22.9 wrote it: the template without the decorator. */
  const written = template
    .replace(
      "import { applicationConfig, type Meta, type StoryObj } from '@storybook/angular-vite';\nimport { provideTheme } from './theme';\n",
      "import type { Meta, StoryObj } from '@storybook/angular-vite';\n",
    )
    .replace(/\n {2}\/\/ `ThemeService`[^\n]*\n[^\n]*\n {2}decorators: [^\n]*/, '');

  /** A design system with the story as given, bound to the runtime package or not. */
  function workspace(content: string, binding = true): HostTree {
    const tree = new HostTree();
    tree.create(
      '/angular.json',
      JSON.stringify({ projects: { ui: { projectType: 'library', root: 'projects/ui' } } }),
    );
    tree.create(
      '/projects/ui/src/lib/theme/theme.ts',
      binding
        ? 'export function provideTheme(): EnvironmentProviders {}\n'
        : "@Injectable({ providedIn: 'root' })\nexport class ThemeService {}\n",
    );
    tree.create(story, content);
    return tree;
  }

  async function migrate(tree: HostTree): Promise<{ story: string; warnings: string[] }> {
    const warnings: string[] = [];
    const subscription = runner.logger.subscribe((entry) => {
      if (entry.level === 'warn') {
        warnings.push(entry.message);
      }
    });
    const result = await runner.runSchematic('theme-story-providers', {}, tree);
    subscription.unsubscribe();
    return { story: result.readContent(story), warnings };
  }

  it('starts from the story a release wrote', () => {
    expect(written).not.toBe(template);
    expect(written).not.toContain('provideTheme');
  });

  it('gives the story what the template now writes', async () => {
    const { story: migrated, warnings } = await migrate(workspace(written));
    expect(migrated).toBe(template);
    expect(warnings).toEqual([]);
  });

  it('changes nothing on a second run, or in a workspace generated after it', async () => {
    const { story: migrated, warnings } = await migrate(workspace(template));
    expect(migrated).toBe(template);
    expect(warnings).toEqual([]);
  });

  it('leaves a design system from before the runtime package alone', async () => {
    const { story: migrated, warnings } = await migrate(workspace(written, false));
    expect(migrated).toBe(written);
    expect(warnings).toEqual([]);
  });

  it('leaves an edited story alone and logs the manual step', async () => {
    const edited = written.replace("tags: ['autodocs'],", "tags: ['autodocs', 'test'],");
    const { story: migrated, warnings } = await migrate(workspace(edited));
    expect(migrated).toBe(edited);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('provideTheme()');
  });
});
