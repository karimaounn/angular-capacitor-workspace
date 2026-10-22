import { Injectable, InjectionToken, inject } from '@angular/core';
import { AUTH_TOKEN_STORAGE, AuthError } from '@angular-capacitor-workspace/auth';
import type { CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { defer, from, switchMap, type Observable } from 'rxjs';

import { cognitoSdk, loadCognitoSdk, type CognitoSdk } from './sdk';

/**
 * The Cognito user pool an app signs in against.
 *
 * Neither value is secret: both are published to every browser that loads the
 * app. The app client must have been created without a client secret, since a
 * browser has nowhere to keep one.
 */
export interface CognitoConfig {
  /** `us-east-1_AbC123xYz`. */
  readonly userPoolId: string;
  /** The app client's id. A client with a secret cannot be used from a browser. */
  readonly userPoolClientId: string;
}

/**
 * The user pool, as an app's environment names it:
 *
 *     auth: cognito({ userPoolId: 'us-east-1_AbC123xYz', userPoolClientId: '…' })
 *
 * Returns what it is given. It is there for the type: an environment is a
 * plain object with no type of its own, so without it a missing or misspelt
 * field surfaces only where the environment is handed to the provider, as the
 * whole object not being assignable. With it, the field fails on the line it
 * is written, with `CognitoConfig` on hover. Both ids empty is an app whose
 * pool is not set yet: it starts signed out, and signing in says so.
 */
export function cognito(settings: CognitoConfig): CognitoConfig {
  return settings;
}

export const COGNITO_CONFIG = new InjectionToken<CognitoConfig>('COGNITO_CONFIG');

/**
 * The one place a `CognitoUserPool` is built.
 *
 * Every Cognito call needs the same pool built the same way, with the same
 * storage: two would be two token caches for one identity. Built on first use
 * rather than up front, so an app whose pool is not configured yet still
 * starts — signed out, with every sign-in call failing as `NotConfigured` and
 * saying what to set — rather than failing to boot.
 *
 * Internal to this entry point: the SDK's types never reach its public API,
 * which is what lets the backend change without an app noticing.
 */
@Injectable()
export class CognitoPool {
  private readonly config = inject(COGNITO_CONFIG);

  /**
   * Passed to every pool and user built here. The SDK takes its storage at
   * construction and has no way to change it afterwards.
   */
  private readonly storage = inject(AUTH_TOKEN_STORAGE);

  private built: CognitoUserPool | undefined;

  /** Whether the app has named a pool at all. */
  readonly configured = Boolean(this.config.userPoolId && this.config.userPoolClientId);

  /**
   * Runs `operation` with the SDK, loading it first if the app has not yet.
   * Every call that reaches Cognito goes through here.
   */
  withSdk<T>(operation: (sdk: CognitoSdk) => Observable<T>): Observable<T> {
    return defer(() => {
      const sdk = cognitoSdk();
      return sdk ? operation(sdk) : from(loadCognitoSdk()).pipe(switchMap(operation));
    });
  }

  /** The pool, or an `AuthError` saying why there is none. Needs the SDK loaded. */
  pool(sdk: CognitoSdk): CognitoUserPool {
    if (this.built) {
      return this.built;
    }
    if (!this.configured) {
      throw new AuthError(
        'NotConfigured',
        'No Cognito user pool is configured. Set userPoolId and userPoolClientId ' +
          "in the app's environment: auth: cognito({ … }).",
      );
    }
    try {
      this.built = new sdk.CognitoUserPool({
        UserPoolId: this.config.userPoolId,
        ClientId: this.config.userPoolClientId,
        Storage: this.storage,
      });
    } catch (error) {
      // The SDK checks the id's shape here and throws a bare Error.
      throw new AuthError(
        'NotConfigured',
        `The Cognito user pool "${this.config.userPoolId}" cannot be used: ` +
          (error as Error).message,
      );
    }
    return this.built;
  }

  /** A handle for a user who may not have signed in on this device. */
  userFor(sdk: CognitoSdk, username: string): CognitoUser {
    return new sdk.CognitoUser({
      Username: username,
      Pool: this.pool(sdk),
      Storage: this.storage,
    });
  }

  /**
   * The user whose tokens are in storage, or `null`. Synchronous, and says
   * nothing about whether the tokens are still valid. An unusable pool has no
   * users, which is how an unconfigured app starts signed out, and so does an
   * SDK that has not loaded yet.
   */
  currentUser(): CognitoUser | null {
    const sdk = cognitoSdk();
    if (!sdk || !this.configured) {
      return null;
    }
    try {
      return this.pool(sdk).getCurrentUser();
    } catch {
      return null;
    }
  }
}
