import {
  InjectionToken,
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';

import type { AuthBackend } from './backend';
import { PASSWORD_POLICY, type PasswordPolicy } from './password-policy';
import { AUTH_TOKEN_STORAGE, type AuthTokenStorage } from './storage';

/**
 * Where the guards send someone they turn away.
 *
 * Route strings rather than anything structured, because that is all
 * `Router.createUrlTree` needs, and a package that knew more about an app's
 * route table would be wrong in the next app.
 */
export interface AuthRoutes {
  /** Where `authGuard` sends a visitor who is not signed in, e.g. `/auth/sign-in`. */
  readonly signIn: string;
  /** Where `guestGuard` sends someone already signed in, and sign-in ends without a `returnUrl`. */
  readonly afterSignIn: string;
}

/**
 * Which token `authInterceptor` sends.
 *
 * The access token is the one OAuth means for calling an API. Some gateways
 * want the ID token instead: API Gateway's Cognito user-pool authorizer, for
 * one, rejects access tokens unless the method names OAuth scopes. The two
 * expire together and are refreshed together, so the choice changes nothing
 * else.
 */
export type BearerToken = 'access' | 'id';

/** Everything this package needs from an app, apart from its backend. */
export interface AuthConfig {
  readonly routes: AuthRoutes;

  /**
   * The API whose requests carry the token: `https://api.example.com/v1`.
   * Matched as a prefix of each request's URL, so the token goes to that API
   * and nowhere else — not to the identity provider, not to a CDN. Empty or
   * absent, no request carries it.
   */
  readonly apiBaseUrl?: string;

  /** Defaults to `'access'`. */
  readonly bearerToken?: BearerToken;

  /** Options for password sign-in. */
  readonly password?: { readonly policy?: PasswordPolicy };

  /** Token persistence. Defaults to `localStorage`; see `AuthTokenStorage`. */
  readonly tokenStorage?: AuthTokenStorage;
}

/** `AuthConfig`, with the defaults filled in, as the guards and interceptor read it. */
export interface ResolvedAuthConfig {
  readonly routes: AuthRoutes;
  /** Without a trailing slash, so the interceptor's prefix test is exact; `''` for none. */
  readonly apiBaseUrl: string;
  readonly bearerToken: BearerToken;
}

export const AUTH_CONFIG = new InjectionToken<ResolvedAuthConfig>('AUTH_CONFIG');

/**
 * Sign-in for an application:
 *
 *     provideAuth({ routes: { signIn: '/auth/sign-in', afterSignIn: '/' } }, withCognito(pool))
 *
 * The backend is the provider's half (see `AuthBackend`), and everything else
 * here works the same whichever it is. A workspace's design system wraps this
 * as `provideAuthentication(connection)`, with the settings from its
 * `src/config/auth.ts`.
 *
 * The services are provided in root; this registers values, and an override
 * for each optional token the config sets. The initializer is registered
 * whatever the storage, so a store supplied through DI rather than through
 * this config is still loaded before the first read. It does nothing for a
 * store that needs no loading.
 */
export function provideAuth(config: AuthConfig, backend: AuthBackend): EnvironmentProviders {
  const resolved: ResolvedAuthConfig = {
    routes: config.routes,
    apiBaseUrl: (config.apiBaseUrl ?? '').replace(/\/+$/, ''),
    bearerToken: config.bearerToken ?? 'access',
  };

  return makeEnvironmentProviders([
    { provide: AUTH_CONFIG, useValue: resolved },
    ...(config.password?.policy
      ? [{ provide: PASSWORD_POLICY, useValue: config.password.policy }]
      : []),
    ...(config.tokenStorage
      ? [{ provide: AUTH_TOKEN_STORAGE, useValue: config.tokenStorage }]
      : []),
    ...backend.providers,
    provideAppInitializer(() => inject(AUTH_TOKEN_STORAGE).hydrate?.()),
  ]);
}
