import type { GenerateOptions } from '../../api';
import { designSystemIn } from '../../extend/design-system';
import { ConfigError, readConfigLiteral } from '../../utils/config-file';
import { RUNTIME_PACKAGES, runtimeSpec } from '../../utils/own-package';
import { isPrerendered, type WorkspaceView } from '../../utils/workspace-view';
import type { WorkspacePlugin } from '../types';

/** The design system's auth config, relative to the library's root. */
export const AUTH_CONFIG = 'src/config/auth.ts';

/**
 * The ways of signing in, by the name the config and `--auth-methods` use.
 *
 * Only what the runtime package implements, screens included: a method listed
 * here is one a workspace can be generated with and sign in by.
 */
export const AUTH_METHODS = {
  password: { label: 'Email and password' },
} as const;

export type AuthMethod = keyof typeof AUTH_METHODS;

export function isAuthMethod(name: unknown): name is AuthMethod {
  return typeof name === 'string' && Object.hasOwn(AUTH_METHODS, name);
}

interface ProviderEntry {
  readonly label: string;
  readonly entry: string;
  readonly factory: string;
  readonly settings: string;
  readonly emptySettings: string;
  readonly sdk: string;
  readonly methods: readonly AuthMethod[];
}

/**
 * The identity providers the plugin can sign in with, by the name the config
 * and `--auth` use, and what each one takes.
 *
 * A provider is a backend in @angular-capacitor-workspace/auth — one of its
 * entry points — and the SDK that backend calls, which the workspace installs
 * beside it. Everything else the plugin writes is the same for all of them.
 */
export const AUTH_PROVIDERS = {
  cognito: {
    label: 'Amazon Cognito',
    /** The entry point that holds the backend. */
    entry: `${RUNTIME_PACKAGES.auth}/cognito`,
    /** The backend's factory, which the entry point exports. */
    factory: 'withCognito',
    /**
     * The function that types the backend's settings, which the entry point
     * exports and the binding re-exports. An app's environment names its
     * settings as a call to it, `auth: cognito({ … })`, so a wrong field fails
     * on that line rather than where the environment is handed over.
     */
    settings: 'cognito',
    /**
     * Its argument before anything is set, as the plugin writes it into each
     * environment. Only the `full` matrix row compiles it against the
     * function's parameter.
     */
    emptySettings: "{ userPoolId: '', userPoolClientId: '' }",
    /** The SDK, an optional peer of the package, with its pin in `versions.ts`. */
    sdk: 'amazon-cognito-identity-js',
    /** The methods its backend implements, the first being the default. */
    methods: ['password'],
  },
} as const satisfies Record<string, ProviderEntry>;

export type AuthProvider = keyof typeof AUTH_PROVIDERS;

export function isAuthProvider(name: unknown): name is AuthProvider {
  return typeof name === 'string' && Object.hasOwn(AUTH_PROVIDERS, name);
}

/** A provider as `/create` offers it: its id and name, and the methods it has. */
export interface AuthProviderChoice {
  readonly id: AuthProvider;
  readonly label: string;
  readonly methods: readonly { readonly id: AuthMethod; readonly label: string }[];
}

/** The providers, for `/create`'s validation and prompt. */
export const AUTH_PROVIDER_CHOICES: readonly AuthProviderChoice[] = Object.entries(
  AUTH_PROVIDERS,
).map(([id, provider]) => ({
  id: id as AuthProvider,
  label: provider.label,
  methods: provider.methods.map((method) => ({ id: method, label: AUTH_METHODS[method].label })),
}));

/** The methods `provider` implements. */
export function methodsOf(provider: AuthProvider): readonly AuthMethod[] {
  return AUTH_PROVIDERS[provider].methods;
}

/** What `src/config/auth.ts` says that the generator needs to know. */
export interface AuthSetup {
  readonly provider: AuthProvider;
  /** At least one, each one the provider implements. */
  readonly methods: readonly AuthMethod[];
}

/**
 * The workspace's auth config, or `undefined` when it has no sign-in.
 *
 * Read out of the design system's `src/config/auth.ts` with
 * `readConfigLiteral`, which evaluates the `AUTH` literal alone. Throws
 * `ConfigError`, naming what is wrong, when the file is there and cannot be
 * used.
 */
export function installedAuth(workspace: WorkspaceView): AuthSetup | undefined {
  const design = designSystemIn(workspace);
  const file = design && `${design.root}/${AUTH_CONFIG}`;
  const source = file && workspace.read(file);
  if (!file || source === undefined) {
    return undefined;
  }

  const { provider, methods } = readConfigLiteral(source, 'AUTH', file) as {
    provider?: unknown;
    methods?: unknown;
  };
  if (!isAuthProvider(provider)) {
    throw new ConfigError(
      `AUTH.provider in ${file} must be one of ${quoted(Object.keys(AUTH_PROVIDERS))}` +
        `${typeof provider === 'string' ? `, not '${provider}'` : ''}.`,
    );
  }
  const offered = methodsOf(provider);
  if (
    !Array.isArray(methods) ||
    methods.length === 0 ||
    !methods.every((method) => (offered as readonly unknown[]).includes(method))
  ) {
    throw new ConfigError(
      `AUTH.methods in ${file} must list at least one of the ways ${provider} signs in: ` +
        `${quoted(offered)}.`,
    );
  }
  return { provider, methods: methods as AuthMethod[] };
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `'${name}'`).join(', ');
}

/**
 * Sign-in: a session, guards and an interceptor from the runtime package, and
 * sign-in screens in every app.
 *
 * Apps only: a prerendered site's pages are served to everyone, so there is
 * no one to sign in. The tokens are `auth` and `auth:<provider>`, read off the
 * config, so a policy rule can be scoped to a provider's SDK.
 */
export const authPlugin: WorkspacePlugin = {
  id: 'auth',
  requested: (options) =>
    wanted(options)
      ? {
          provider: options.auth,
          ...(options.authMethods?.length ? { methods: options.authMethods } : {}),
          ...runtimeSpec(options, RUNTIME_PACKAGES.auth),
        }
      : undefined,
  features: (options) => (wanted(options) ? ['auth', `auth:${options.auth}`] : []),
  detect(workspace) {
    const setup = installedAuth(workspace);
    return setup ? ['auth', `auth:${setup.provider}`] : [];
  },
  forProject(workspace, project) {
    const target = workspace.projects[project];
    if (
      !installedAuth(workspace) ||
      target?.projectType !== 'application' ||
      isPrerendered(target)
    ) {
      return undefined;
    }
    return { apps: [project] };
  },
};

/**
 * Requested. Without a design system the schematic refuses, saying why, as
 * i18n does: asked for and silently left out would be worse.
 */
function wanted(options: GenerateOptions): boolean {
  return Boolean(options.auth);
}
