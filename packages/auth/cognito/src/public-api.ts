/*
 * Amazon Cognito user pools, as a backend for @angular-capacitor-workspace/auth.
 *
 *     provideAuth(settings, withCognito({ userPoolId, userPoolClientId }))
 *
 * Sessions, email and password sign-in over SRP, and the account operations,
 * through `amazon-cognito-identity-js`: an optional peer of this package, which
 * a workspace that signs in with Cognito installs and one that does not never
 * downloads. It is loaded when the app starts, not when this is imported; see
 * `loadCognitoSdk`.
 */
import { inject, provideAppInitializer } from '@angular/core';
import {
  ACCOUNT_BACKEND,
  PASSWORD_BACKEND,
  SESSION_BACKEND,
} from '@angular-capacitor-workspace/auth';
import type { AuthBackend } from '@angular-capacitor-workspace/auth';

import { CognitoAccount } from './account';
import { CognitoPassword } from './password';
import { COGNITO_CONFIG, CognitoPool, type CognitoConfig } from './pool';
import { loadCognitoSdk } from './sdk';
import { CognitoSession } from './session';

export { cognito } from './pool';
export type { CognitoConfig } from './pool';

/** The Cognito backend, for `provideAuth`. */
export function withCognito(config: CognitoConfig): AuthBackend {
  return {
    name: 'cognito',
    providers: [
      { provide: COGNITO_CONFIG, useValue: config },
      CognitoPool,
      CognitoSession,
      CognitoPassword,
      CognitoAccount,
      { provide: SESSION_BACKEND, useExisting: CognitoSession },
      { provide: PASSWORD_BACKEND, useExisting: CognitoPassword },
      { provide: ACCOUNT_BACKEND, useExisting: CognitoAccount },
      // The app starts once the SDK has loaded, so a session in storage is
      // restored before the first page renders rather than a moment after.
      // Not for an app with no pool yet, which has no session to restore, and
      // not at the cost of starting: an SDK that fails to load is tried again
      // by the first call that needs it.
      provideAppInitializer(() =>
        inject(CognitoPool).configured
          ? loadCognitoSdk().then(
              () => undefined,
              () => undefined,
            )
          : undefined,
      ),
    ],
  };
}
