import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AuthError,
  type AuthChallenge,
  type ChallengeRaised,
  type CodeDestination,
  type PasswordBackend,
  type SignedIn,
  type SignUpResult,
} from '@angular-capacitor-workspace/auth';
import type { CognitoUser } from 'amazon-cognito-identity-js';
import { Observable, type Subscriber } from 'rxjs';

import { toCognitoError } from './errors';
import { CognitoPool } from './pool';
import { CognitoSession } from './session';

/**
 * Email and password sign-in against a user pool, over SRP.
 *
 * SRP (`USER_SRP_AUTH`) is the reason to take the SDK at all: the password
 * never leaves the browser, because SRP proves knowledge of it without sending
 * it. A client written against Cognito's API by hand is left with
 * `USER_PASSWORD_AUTH`, which does send it.
 *
 * The pool is assumed to sign in by email: the email is the username, and the
 * only attribute registration sets.
 */
@Injectable()
export class CognitoPassword implements PasswordBackend {
  private readonly cognito = inject(CognitoPool);
  private readonly session = inject(CognitoSession);

  /**
   * The user mid-challenge. The SDK keeps a challenge on the `CognitoUser`
   * object and offers no way to resume one, so this reference is the only
   * thing that can answer it, and it dies with a reload.
   */
  private readonly challenged = signal<CognitoUser | null>(null);

  readonly pendingChallenge = computed<AuthChallenge | null>(() => {
    const name = this.challenged()?.challengeName;
    return name === undefined ? null : { name };
  });

  signUp(email: string, password: string): Observable<SignUpResult> {
    return this.cognito.withSdk(
      (sdk) =>
        new Observable<SignUpResult>((subscriber) => {
          this.cognito
            .pool(sdk)
            .signUp(
              email,
              password,
              [new sdk.CognitoUserAttribute({ Name: 'email', Value: email })],
              [],
              (error, result) => {
                if (error || !result) {
                  subscriber.error(toCognitoError(error));
                  return;
                }
                subscriber.next({
                  userConfirmed: result.userConfirmed,
                  destination: result.codeDeliveryDetails?.Destination ?? null,
                });
                subscriber.complete();
              },
            );
        }),
    );
  }

  confirmSignUp(email: string, code: string): Observable<void> {
    return this.cognito.withSdk(
      (sdk) =>
        new Observable<void>((subscriber) => {
          // `false`: never move an email alias off another account to satisfy this.
          this.cognito.userFor(sdk, email).confirmRegistration(code, false, done(subscriber));
        }),
    );
  }

  resendConfirmationCode(email: string): Observable<CodeDestination> {
    return this.cognito.withSdk(
      (sdk) =>
        new Observable<CodeDestination>((subscriber) => {
          this.cognito.userFor(sdk, email).resendConfirmationCode((error, result) => {
            if (error) {
              subscriber.error(toCognitoError(error));
              return;
            }
            subscriber.next({ destination: destinationOf(result) });
            subscriber.complete();
          });
        }),
    );
  }

  signIn(email: string, password: string): Observable<SignedIn | ChallengeRaised> {
    return this.cognito.withSdk(
      (sdk) =>
        new Observable<SignedIn | ChallengeRaised>((subscriber) => {
          const user = this.cognito.userFor(sdk, email);
          this.challenged.set(null);
          user.authenticateUser(
            new sdk.AuthenticationDetails({ Username: email, Password: password }),
            {
              onSuccess: (session) => {
                // The SDK stored the tokens as it went, so the session is
                // recorded, not adopted: adopting would store a second copy.
                this.session.record(session);
                subscriber.next({ status: 'signed-in' });
                subscriber.complete();
              },
              onFailure: (error: unknown) => subscriber.error(toCognitoError(error)),
              // A challenge is not a failure. The SDK sends it to a callback of
              // its own, and without this the call would never end.
              newPasswordRequired: () => {
                this.challenged.set(user);
                subscriber.next({
                  status: 'challenge',
                  challenge: { name: 'NEW_PASSWORD_REQUIRED' },
                });
                subscriber.complete();
              },
            },
          );
        }),
    );
  }

  completeNewPassword(newPassword: string): Observable<SignedIn | ChallengeRaised> {
    return new Observable<SignedIn | ChallengeRaised>((subscriber) => {
      const user = this.challenged();
      if (user === null) {
        subscriber.error(new AuthError('Unknown', 'No challenge is outstanding. Sign in again.'));
        return;
      }
      // No attributes: echoing back the ones Cognito sent is what makes it
      // refuse to "modify an immutable attribute".
      user.completeNewPasswordChallenge(
        newPassword,
        {},
        {
          onSuccess: (session) => {
            this.session.record(session);
            this.challenged.set(null);
            subscriber.next({ status: 'signed-in' });
            subscriber.complete();
          },
          onFailure: (error: unknown) => subscriber.error(toCognitoError(error)),
        },
      );
    });
  }

  forgotPassword(email: string): Observable<CodeDestination> {
    return this.cognito.withSdk(
      (sdk) =>
        new Observable<CodeDestination>((subscriber) => {
          const sent = (data: unknown) => {
            subscriber.next({ destination: destinationOf(data) });
            subscriber.complete();
          };
          this.cognito.userFor(sdk, email).forgotPassword({
            // `inputVerificationCode` when a code was sent, `onSuccess` in the
            // rarer case that needs none. Both mean the request worked.
            inputVerificationCode: sent,
            onSuccess: sent,
            onFailure: (error: unknown) => subscriber.error(toCognitoError(error)),
          });
        }),
    );
  }

  confirmForgotPassword(email: string, code: string, newPassword: string): Observable<void> {
    return this.cognito.withSdk(
      (sdk) =>
        new Observable<void>((subscriber) => {
          this.cognito.userFor(sdk, email).confirmPassword(code, newPassword, {
            onSuccess: () => {
              subscriber.next();
              subscriber.complete();
            },
            onFailure: (error: unknown) => subscriber.error(toCognitoError(error)),
          });
        }),
    );
  }

  changePassword(previousPassword: string, proposedPassword: string): Observable<void> {
    return this.session.withUser<void>((user, subscriber) => {
      user.changePassword(previousPassword, proposedPassword, done(subscriber));
    });
  }
}

/** A Node-style callback that ends `subscriber`. */
function done(subscriber: Subscriber<void>): (error?: Error | null) => void {
  return (error) => {
    if (error) {
      subscriber.error(toCognitoError(error));
      return;
    }
    subscriber.next();
    subscriber.complete();
  };
}

function destinationOf(result: unknown): string | null {
  const details = (result as { CodeDeliveryDetails?: { Destination?: string } } | undefined)
    ?.CodeDeliveryDetails;
  return details?.Destination ?? null;
}
