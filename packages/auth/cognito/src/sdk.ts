import type * as Cognito from 'amazon-cognito-identity-js';

export type CognitoSdk = typeof Cognito;

let loaded: CognitoSdk | undefined;
let loading: Promise<CognitoSdk> | undefined;

/** The SDK, once it has loaded, or `undefined` before. */
export function cognitoSdk(): CognitoSdk | undefined {
  return loaded;
}

/**
 * Loads `amazon-cognito-identity-js`, once.
 *
 * Imported when it is needed rather than at the top of a module, for two
 * reasons. A workspace's design system imports this entry point to bind it,
 * and everything that imports the design system — a prerendered site, an app
 * without sign-in — would otherwise evaluate the SDK too. And the SDK depends
 * on `buffer@4`, which reads Node's `global` as it loads: a browser has none,
 * so it is defined here first, where it is needed, rather than by every app
 * that might load the SDK. A dev server does not tree-shake, so either would
 * reach every page.
 *
 * `withCognito` loads it while the app starts, so a session in storage is
 * there by the time the first page renders. A failed load is not fatal: the
 * next call that needs the SDK tries again.
 */
export function loadCognitoSdk(): Promise<CognitoSdk> {
  if (!loading) {
    loading = load().catch((error: unknown) => {
      loading = undefined;
      throw error;
    });
  }
  return loading;
}

async function load(): Promise<CognitoSdk> {
  (globalThis as { global?: unknown }).global ??= globalThis;
  const module: unknown = await import('amazon-cognito-identity-js');
  // An ES build of the SDK has its classes on the namespace; its CommonJS
  // build, loaded through Node's interop, can have them on `default`.
  loaded = (
    (module as Partial<CognitoSdk>).CognitoUserPool
      ? module
      : (module as { default: CognitoSdk }).default
  ) as CognitoSdk;
  return loaded;
}
