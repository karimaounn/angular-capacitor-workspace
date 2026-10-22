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
  type SchematicContext,
  type Tree,
} from '@angular-devkit/schematics';
import {
  buildOn,
  exportFromLibrary,
  requireDesignSystem,
  type DesignSystem,
} from '../../extend/design-system';
import {
  addHeaderControl,
  addHttpInterceptor,
  addRootProvider,
  addRoute,
  addShellTestProvider,
} from '../../extend/shell';
import { addEnvironmentGroups, API_SETTINGS, environmentFrom } from '../../extend/environment';
import { pins } from '../../policy/versions';
import { ConfigError } from '../../utils/config-file';
import { RUNTIME_PACKAGES } from '../../utils/own-package';
import { addDependencies, appendSection, readProjects, README_MD } from '../../utils/workspace';
import { isPrerendered, treeView } from '../../utils/workspace-view';
import {
  AUTH_CONFIG,
  AUTH_PROVIDERS,
  installedAuth,
  methodsOf,
  type AuthMethod,
  type AuthProvider,
  type AuthSetup,
} from './plugin';

export interface AuthOptions {
  provider?: AuthProvider;
  methods?: AuthMethod[];
  apps?: string[];
  /** What to install `@angular-capacitor-workspace/auth` from, for a build not yet published. */
  runtimeSpec?: string;
}

/**
 * Sign-in: the settings and a binding in the design system, and in every app
 * the screens, the routes to them, the provider and the interceptor.
 *
 * The session, the guards and the interceptor are
 * @angular-capacitor-workspace/auth, installed rather than copied, with the
 * provider's backend from one of its entry points. What this writes is
 * configuration — `src/config/auth.ts` for the workspace, each app's
 * environments for where it signs in — the binding that joins the two, and the
 * screens, which are the app's to restyle and rewrite.
 *
 *     ng generate @angular-capacitor-workspace/cli:auth
 */
export function auth(options: AuthOptions = {}): Rule {
  return (tree: Tree) => {
    const design = requireDesignSystem(
      tree,
      'Sign-in is configured in the design-system library, which every app imports it from',
    );
    const setup = resolveSetup(tree, design, options);
    const { provider } = setup;

    return chain([
      library(tree, design, setup, options.runtimeSpec),
      ...targets(tree, options.apps).map((app) => application(app, design, provider)),
      (host: Tree) => {
        documentAuth(host, design, provider);
        houseRules(host, design);
      },
    ]);
  };
}

/**
 * The provider and the methods: the config's, once there is one, or
 * `--provider` and `--methods` on the first run, which writes the config with
 * them.
 *
 * A run that names others than the config's is refused. The config is the one
 * place they are chosen; changing them there and running this again is how a
 * workspace moves.
 */
function resolveSetup(tree: Tree, design: DesignSystem, options: AuthOptions): AuthSetup {
  let installed: AuthSetup | undefined;
  try {
    installed = installedAuth(treeView(tree));
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new SchematicsException(error.message);
    }
    throw error;
  }
  const config = `${design.root}/${AUTH_CONFIG}`;

  if (!installed) {
    const provider = options.provider ?? 'cognito';
    const offered = methodsOf(provider);
    const methods = [...new Set(options.methods?.length ? options.methods : [offered[0]!])];
    const missing = methods.filter((method) => !offered.includes(method));
    if (missing.length > 0) {
      throw new SchematicsException(
        `${provider} has no ${missing.join(' or ')} sign-in. It offers ${offered.join(', ')}.`,
      );
    }
    return { provider, methods };
  }

  if (options.provider && options.provider !== installed.provider) {
    throw new SchematicsException(
      `${design.name} already signs in with ${installed.provider}. The provider is ` +
        `${config}: change it there, then run this schematic without --provider to ` +
        `bring every app in line.`,
    );
  }
  const asked = new Set(options.methods ?? []);
  if (
    asked.size > 0 &&
    (asked.size !== installed.methods.length ||
      !installed.methods.every((method) => asked.has(method)))
  ) {
    throw new SchematicsException(
      `${design.name} already signs in by ${installed.methods.join(', ')}. The methods ` +
        `are ${config}: change them there, then run this schematic without --methods to ` +
        `bring every app in line.`,
    );
  }
  return installed;
}

/**
 * The applications that get sign-in: every one that is not a prerendered
 * site, or the ones named. A site is refused by name: its pages are rendered
 * once and served to everyone, so there is nobody to sign in.
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
        `"${name}" is a prerendered site. Its pages are served to every visitor ` +
          `as they were built, so there is no one to sign in.`,
      );
    }
    return name;
  });
}

/**
 * Leaves files that already exist alone. What this writes is the user's from
 * the moment it is written, and the schematic runs again every time an app is
 * generated into a workspace that has sign-in.
 */
function onlyNew(tree: Tree): Rule {
  return filter((path) => !tree.exists(path));
}

/** The template variables that name the provider's backend. */
function backendContext(provider: AuthProvider) {
  return { provider, backend: AUTH_PROVIDERS[provider] };
}

// ── The library half ─────────────────────────────────────────────────────────

function library(
  tree: Tree,
  design: DesignSystem,
  { provider, methods }: AuthSetup,
  runtimeSpec: string | undefined,
): Rule {
  // The config is the workspace's, written once. The binding is the
  // generator's, derived from the config and rewritten on every run, so a
  // change of provider there reaches the binding here.
  const context = {
    ...strings,
    ...backendContext(provider),
    methods,
    offered: methodsOf(provider),
    importName: design.name,
  };
  const binding = (path: string) => path.endsWith('/lib/auth/auth.ts.template');

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
      buildOn(host, design, RUNTIME_PACKAGES.auth, runtimeSpec);
      // The provider's SDK, an optional peer of the package that only a
      // workspace signing in with that provider installs.
      addDependencies(host, pins([AUTH_PROVIDERS[provider].sdk]), 'dependencies');
      exportFromLibrary(host, design, './lib/auth/auth', ["export * from './lib/auth/auth';"]);
    },
  ]);
}

// ── The application half ─────────────────────────────────────────────────────

function application(name: string, design: DesignSystem, provider: AuthProvider): Rule {
  return (tree: Tree, context: SchematicContext) => {
    const project = readProjects(tree)[name]!;
    const root = project.root ?? '';
    const prefix = project.prefix ?? 'app';
    const e2e = tree.exists(`/${root}/playwright.config.ts`);
    const variables = {
      ...strings,
      ...backendContext(provider),
      importName: design.name,
      libPrefix: design.prefix,
      prefix,
    };
    const fromDesign = (symbols: string) => `import { ${symbols} } from '${design.name}';`;

    return chain([
      mergeWith(
        apply(url('./files/app'), [applyTemplates(variables), move(`/${root}`), onlyNew(tree)]),
        MergeStrategy.Overwrite,
      ),
      // The suite only where the project has Playwright.
      e2e
        ? mergeWith(
            apply(url('./files/app-e2e'), [
              applyTemplates(variables),
              move(`/${root}`),
              onlyNew(tree),
            ]),
            MergeStrategy.Overwrite,
          )
        : noop(),
      (host: Tree) => {
        // Where the app signs in and where its API is, per environment. The
        // API's address is the app's one setting for it, which its API client
        // reads too, so the token goes where the requests do. The provider's
        // settings are a call to the function the binding exports for them,
        // so they are checked where they are typed.
        const backend = AUTH_PROVIDERS[provider];
        const manual = addEnvironmentGroups(host, name, [
          API_SETTINGS,
          {
            key: 'auth',
            doc:
              `Where the app signs people in: ${backend.label}. Empty until set, and the\n` +
              'app runs signed out meanwhile; signing in says what is missing.',
            defaults: `${backend.settings}(${backend.emptySettings})`,
            import: { symbol: backend.settings, from: design.name },
          },
        ]);
        if (manual) {
          context.logger.warn(manual);
        }
        const environment = `import { environment } from '${environmentFrom('src/app')}';`;
        addRootProvider(host, name, {
          symbol: 'provideAuthentication',
          expression: 'provideAuthentication(environment)',
          imports: [fromDesign('provideAuthentication'), environment],
        });
        addHttpInterceptor(host, name, {
          symbol: 'authInterceptor',
          import: fromDesign('authInterceptor'),
        });
        const routed = addRoute(host, name, {
          key: './auth/auth.routes',
          expression: [
            '{',
            "  path: 'auth',",
            "  loadChildren: () => import('./auth/auth.routes').then((m) => m.AUTH_ROUTES),",
            '}',
          ].join('\n'),
        });
        if (!routed) {
          context.logger.warn(
            `${name} has no Routes array in src/app/app.routes.ts, so the sign-in screens ` +
              `are not routed. Add { path: 'auth', loadChildren: () => ` +
              `import('./auth/auth.routes').then((m) => m.AUTH_ROUTES) } to its routes.`,
          );
        }
        const link = addHeaderControl(host, name, {
          symbol: 'AccountLink',
          from: './auth/account-link',
          markup: `<${prefix}-account-link />`,
        });
        // The link reads the session, so the shell's spec needs it provided.
        if (link) {
          addShellTestProvider(host, name, {
            symbol: 'provideAuthentication',
            expression: 'provideAuthentication(environment)',
            imports: [fromDesign('provideAuthentication'), environment],
          });
        }
      },
    ]);
  };
}

// ── Documentation ────────────────────────────────────────────────────────────

function documentAuth(tree: Tree, design: DesignSystem, provider: AuthProvider): void {
  const { label, settings } = AUTH_PROVIDERS[provider];
  appendSection(
    tree,
    README_MD,
    'Sign-in',
    `Every app signs people in with ${label}: screens under \`/auth\` — sign in,
create an account, reset a password, and the account page — and a link in the
header. Behind them is \`@angular-capacitor-workspace/auth\`, exported by
\`${design.name}\`: \`AuthSession\`, \`authGuard\` and \`guestGuard\` for routes,
and \`authInterceptor\`, which sends the token to your API and nowhere else.

**Before anyone can sign in**, give each app its ${label} settings in its
\`src/environments/environment.ts\` (production) and
\`environment.development.ts\` (\`ng serve\`):

\`\`\`ts
import { ${settings} } from '${design.name}';

export const environment = {
  api: { baseUrl: 'https://api.example.com' },
  auth: ${settings}({ userPoolId: 'us-east-1_…', userPoolClientId: '…' }),
};
\`\`\`

None of it is secret: it reaches every browser that loads the app. Until it is
set, the app runs signed out and the sign-in screen says what is missing.
\`${settings}(…)\` returns what it is given and types it, so a field that is
missing or misspelt fails the build on that line. The session's token goes to
\`api.baseUrl\`, which the API client reads too, so the two always agree. Those
two files are yours: the generator added these settings, at their defaults and
with what each means, and leaves them to you.

How sign-in behaves — the routes the guards send people to, the token your API
gets, the password policy the sign-up form checks — is
\`${design.root}/${AUTH_CONFIG}\`. \`${design.root}/src/lib/auth/auth.ts\` is the
generator's, rewritten by \`ng generate @angular-capacitor-workspace/cli:auth\`;
the screens in each app's \`src/app/auth/\` are yours.

To guard a route of your own:

\`\`\`ts
import { authGuard } from '${design.name}';

{ path: 'orders', canActivate: [authGuard], loadComponent: () => … }
\`\`\`

An app generated later gets sign-in too. To give it to an app that predates it,
or to one you left out:

\`\`\`bash
ng generate @angular-capacitor-workspace/cli:auth --apps <app>
\`\`\``,
  );
}

/** The rules sign-in adds to AGENTS.md. Every one is a mistake that compiles. */
function houseRules(tree: Tree, design: DesignSystem): void {
  appendSection(
    tree,
    '/AGENTS.md',
    'Sign-in',
    `
Apps sign people in through \`@angular-capacitor-workspace/auth\`, which
\`${design.name}\` exports.

- **Write screens against \`AuthSession\`, \`PasswordAuthService\` and
  \`AccountService\`**, never against the provider's SDK. They are the same
  whichever provider the workspace uses; the SDK is not.
- **A guard routes; it does not protect.** Anything a signed-out visitor must
  not see is behind the API, which checks the token. Guard routes with
  \`authGuard\`, which refreshes an expired session before deciding, rather
  than reading \`isAuthenticated()\`.
- **Never attach the token by hand.** \`authInterceptor\` sends it to the
  app's API, \`api.baseUrl\` in its environment, and nowhere else; a request to
  another host does not get it. Point the API somewhere else there, not in a
  copy.
- **Configure; leave the machinery to the generator.** Settings are
  \`src/config/auth.ts\`, and each app's provider settings its
  \`src/environments/environment*.ts\`. \`src/lib/auth/auth.ts\` is rewritten
  by the generator, so an edit to it is lost. Nothing in an environment may be
  a secret: it ships in the bundle.
`,
  );
}
