import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SchematicTestRunner, type UnitTestTree } from '@angular-devkit/schematics/testing';
import { beforeAll, describe, expect, it } from 'vitest';
import { authPlugin } from '../src/plugins/auth/plugin';
import { pinFor } from '../src/policy/versions';
import { treeView } from '../src/utils/workspace-view';

const collection = join(__dirname, '..', 'dist', 'collection.json');

if (!existsSync(collection)) {
  throw new Error(`${collection} does not exist. Run \`npm run build\` before the tests.`);
}

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

/** A design system, an app with Playwright, and a prerendered site — before sign-in. */
async function workspace(): Promise<UnitTestTree> {
  const base = await runner().runSchematic(
    'workspace',
    { uiLib: 'ui', e2e: 'playwright' },
    await baseWorkspace(),
  );
  const lib = await runner().runSchematic('ui-lib', { name: 'ui' }, base);
  const app = await runner().runSchematic('app', { name: 'shop', e2e: 'playwright' }, lib);
  return runner().runSchematic('marketing', { name: 'site' }, app);
}

const APP = '/projects/shop/web';
const SCREENS = [
  'auth.routes.ts',
  'account-link.ts',
  'new-password.ts',
  'new-password.html',
  'sign-in.page.ts',
  'sign-in.page.html',
  'sign-up.page.ts',
  'sign-up.page.html',
  'reset-password.page.ts',
  'reset-password.page.html',
  'account.page.ts',
  'account.page.html',
  'auth-page.scss',
  'auth-form.scss',
];

describe('auth', () => {
  let tree: UnitTestTree;

  beforeAll(async () => {
    tree = await runner().runSchematic('auth', {}, await workspace());
  });

  describe('in the design system', () => {
    it('installs the package, and the provider’s SDK beside it', () => {
      const own = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')).version;
      const dependencies = JSON.parse(tree.readContent('/package.json')).dependencies;
      expect(dependencies).toMatchObject({
        '@angular-capacitor-workspace/auth': `^${own}`,
        'amazon-cognito-identity-js': pinFor('amazon-cognito-identity-js'),
      });
      expect(
        JSON.parse(tree.readContent('/projects/ui/package.json')).peerDependencies,
      ).toMatchObject({ '@angular-capacitor-workspace/auth': `^${own}` });
    });

    it('writes the settings, with Cognito as the provider and password sign-in', () => {
      const config = tree.readContent('/projects/ui/src/config/auth.ts');
      expect(config).toContain("provider: 'cognito',");
      expect(config).toContain("methods: ['password'],");
      expect(config).toContain("The ones\n   * Amazon Cognito offers here: 'password'.");
      expect(config).toContain("routes: { signIn: '/auth/sign-in', afterSignIn: '/' },");
      expect(config).toContain('Plain values only');
    });

    it('binds the package to them through the Cognito backend, and exports it', () => {
      const binding = tree.readContent('/projects/ui/src/lib/auth/auth.ts');
      expect(binding).toContain('rewritten by every run');
      expect(binding).toContain(
        "import { withCognito, cognito } from '@angular-capacitor-workspace/auth/cognito';",
      );
      expect(binding).toContain("import { AUTH } from '../../config/auth';");
      expect(binding).toContain('withCognito(environment.auth),');
      expect(binding).toContain('readonly auth: ReturnType<typeof cognito>;');
      expect(binding).toContain('apiBaseUrl: environment.api.baseUrl,');
      // The settings function, for the environments to import from the design system.
      expect(binding).toContain('export { cognito };');
      expect(tree.readContent('/projects/ui/src/public-api.ts')).toContain(
        "export * from './lib/auth/auth';",
      );
    });
  });

  describe('in an app', () => {
    it('hands over the screens', () => {
      for (const file of SCREENS) {
        expect(tree.exists(`${APP}/src/app/auth/${file}`), file).toBe(true);
      }
      // Built from the design system's button, with this app's selectors.
      const signIn = tree.readContent(`${APP}/src/app/auth/sign-in.page.html`);
      expect(signIn).toContain('<ui-button type="submit"');
      expect(signIn).toContain('autocomplete="current-password"');
      expect(tree.readContent(`${APP}/src/app/auth/sign-up.page.html`)).toContain(
        '<app-new-password [(password)]="password" />',
      );
    });

    it('declares the pool and the API in the environment, empty until set', () => {
      const env = `${APP}/src/environments`;
      for (const name of ['environment.ts', 'environment.development.ts']) {
        const environment = tree.readContent(`${env}/${name}`);
        expect(environment, name).toContain("  api: { baseUrl: '/api' },\n");
        // The pool is typed where it is written, by the function the design
        // system exports for it, rather than by a shape to know.
        expect(environment.startsWith("import { cognito } from 'ui';\n\n/**\n"), name).toBe(true);
        expect(environment, name).toContain(
          '   * Where the app signs people in: Amazon Cognito. Empty until set, and the\n' +
            '   * app runs signed out meanwhile; signing in says what is missing.\n' +
            '   */\n' +
            "  auth: cognito({ userPoolId: '', userPoolClientId: '' }),\n",
        );
      }
      // Nothing beside them for the generator to own.
      expect(tree.exists(`${env}/define-environment.ts`)).toBe(false);
      expect(tree.getDir(`${env}/settings`).subfiles).toEqual([]);
    });

    it('provides sign-in from the environment, and the interceptor on a new HttpClient', () => {
      const config = tree.readContent(`${APP}/src/app/app.config.ts`);
      expect(config).toContain('provideAuthentication(environment),');
      expect(config).toContain('provideHttpClient(withInterceptors([authInterceptor])),');
      expect(config).toContain("import { provideAuthentication, authInterceptor } from 'ui';");
      expect(config).toContain("import { environment } from '../environments/environment';");
    });

    it('routes the screens under /auth', () => {
      expect(tree.readContent(`${APP}/src/app/app.routes.ts`)).toContain(
        "    loadChildren: () => import('./auth/auth.routes').then((m) => m.AUTH_ROUTES),\n",
      );
    });

    it('puts the account link in the header, and provides what it reads to the shell’s spec', () => {
      expect(tree.readContent(`${APP}/src/app/app.html`)).toContain('<app-account-link />');
      expect(tree.readContent(`${APP}/src/app/app.ts`)).toContain(
        "import { AccountLink } from './auth/account-link';",
      );
      const spec = tree.readContent(`${APP}/src/app/app.spec.ts`);
      expect(spec).toContain('provideAuthentication(environment),');
      expect(spec).toContain("import { environment } from '../environments/environment';");
    });

    it('adds an end-to-end suite where the app has Playwright', () => {
      expect(tree.exists(`${APP}/e2e/auth.spec.ts`)).toBe(true);
    });
  });

  it('leaves the prerendered site alone', () => {
    expect(tree.exists('/projects/site/web/src/app/auth/sign-in.page.ts')).toBe(false);
    expect(tree.exists('/projects/site/web/src/environments/environment.ts')).toBe(false);
    expect(tree.readContent('/projects/site/web/src/app/app.config.ts')).not.toContain(
      'provideAuthentication',
    );
  });

  it('documents itself, and adds its house rules', () => {
    expect(tree.readContent('/README.md')).toContain('## Sign-in');
    expect(tree.readContent('/README.md')).toContain('src/environments/environment.ts');
    expect(tree.readContent('/AGENTS.md')).toContain('A guard routes; it does not protect.');
  });

  it('carries auth and auth:cognito, read back off the config', () => {
    expect([...authPlugin.detect(treeView(tree))].sort()).toEqual(['auth', 'auth:cognito']);
    expect(authPlugin.features({ directory: 'ws', uiLib: 'ui', auth: 'cognito' })).toEqual([
      'auth',
      'auth:cognito',
    ]);
  });

  it('changes nothing when run again', async () => {
    const again = await runner().runSchematic('auth', {}, tree);
    for (const file of tree.files) {
      expect(again.readContent(file), file).toBe(tree.readContent(file));
    }
    expect(again.files.length).toBe(tree.files.length);
  });

  it('keeps edits to what it handed over, and rewrites the binding', async () => {
    const edited = await runner().runSchematic('auth', {}, await workspace());
    const values = `${APP}/src/environments/environment.ts`;
    const page = `${APP}/src/app/auth/sign-in.page.html`;
    const config = '/projects/ui/src/config/auth.ts';
    const binding = '/projects/ui/src/lib/auth/auth.ts';
    const connected =
      "import { cognito } from 'ui';\n\n" +
      'export const environment = {\n' +
      "  api: { baseUrl: 'https://api.example.com' },\n" +
      "  auth: cognito({ userPoolId: 'us-east-1_Abc', userPoolClientId: 'c' }),\n" +
      '};\n';
    edited.overwrite(values, connected);
    edited.overwrite(page, '<h1>Ours</h1>\n');
    edited.overwrite(config, `${edited.readContent(config)}// tuned\n`);
    edited.overwrite(binding, '// edited\n');

    const rerun = await runner().runSchematic('auth', {}, edited);
    expect(rerun.readContent(values)).toBe(connected);
    expect(rerun.readContent(page)).toBe('<h1>Ours</h1>\n');
    expect(rerun.readContent(config)).toContain('// tuned');
    expect(rerun.readContent(binding)).toContain('withCognito');
  });

  it('reaches an app generated after it', async () => {
    const grown = await runner().runSchematic('app', { name: 'admin' }, tree);
    const root = '/projects/admin/web/src';
    expect(grown.exists(`${root}/app/auth/sign-in.page.ts`)).toBe(true);
    expect(grown.readContent(`${root}/app/app.config.ts`)).toContain(
      'provideAuthentication(environment)',
    );
    expect(grown.readContent(`${root}/environments/environment.ts`)).toContain('  auth: cognito(');
    expect(grown.readContent(`${root}/app/app.routes.ts`)).toContain('./auth/auth.routes');
  });

  describe('refuses', () => {
    it('a workspace without a design system', async () => {
      const bare = await runner().runSchematic(
        'app',
        { name: 'shop' },
        await runner().runSchematic('workspace', {}, await baseWorkspace()),
      );
      await expect(runner().runSchematic('auth', {}, bare)).rejects.toThrow(
        /design-system library.*has none/s,
      );
    });

    it('a prerendered site, by name', async () => {
      await expect(runner().runSchematic('auth', { apps: ['site'] }, tree)).rejects.toThrow(
        /prerendered site/,
      );
    });

    it('a provider in the config that it does not know', async () => {
      const unknown = await runner().runSchematic('auth', {}, await workspace());
      const config = '/projects/ui/src/config/auth.ts';
      unknown.overwrite(
        config,
        unknown.readContent(config).replace("provider: 'cognito',", "provider: 'okta',"),
      );
      await expect(runner().runSchematic('auth', {}, unknown)).rejects.toThrow(
        /AUTH\.provider in projects\/ui\/src\/config\/auth\.ts must be one of 'cognito', not 'okta'/,
      );
    });

    it('methods in the config the provider does not implement, or none', async () => {
      const config = '/projects/ui/src/config/auth.ts';
      for (const methods of ["['magic-link']", '[]']) {
        const unknown = await runner().runSchematic('auth', {}, await workspace());
        unknown.overwrite(
          config,
          unknown.readContent(config).replace("methods: ['password'],", `methods: ${methods},`),
        );
        await expect(runner().runSchematic('auth', {}, unknown), methods).rejects.toThrow(
          /AUTH\.methods in projects\/ui\/src\/config\/auth\.ts must list at least one of the ways cognito signs in: 'password'/,
        );
      }
    });

    it('a method its schema does not offer', async () => {
      await expect(
        runner().runSchematic('auth', { methods: ['passwordless'] }, await workspace()),
      ).rejects.toThrow(/passwordless/);
    });
  });

  it('takes the methods it is given on the first run, and accepts them again', async () => {
    const first = await runner().runSchematic(
      'auth',
      { provider: 'cognito', methods: ['password'] },
      await workspace(),
    );
    expect(first.readContent('/projects/ui/src/config/auth.ts')).toContain(
      "methods: ['password'],",
    );
    await expect(
      runner().runSchematic('auth', { methods: ['password'] }, first),
    ).resolves.toBeDefined();
  });
});
