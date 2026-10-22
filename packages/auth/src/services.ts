import { Injectable, computed, inject, signal } from '@angular/core';
import { type Observable, throwError } from 'rxjs';

import { ACCOUNT_BACKEND, PASSWORD_BACKEND } from './backend';
import { AuthError } from './errors';
import type {
  AuthChallenge,
  ChallengeRaised,
  CodeDestination,
  SignedIn,
  SignUpResult,
  UserAttributes,
} from './outcome';

function unsupported(what: string): Observable<never> {
  return throwError(
    () => new AuthError('NotSupported', `The sign-in backend this app uses has no ${what}.`),
  );
}

/**
 * Sign-in with an email address and a password.
 *
 * Everything that only makes sense for an account that has a password:
 * signing in with it, the challenge to choose a new one, registration,
 * recovery and changing it. A screen that injects this is a password screen;
 * one that injects only `AuthSession` and `AccountService` works for every
 * method.
 *
 * In front of the backend's `PASSWORD_BACKEND`, so a screen is written against
 * this and not against a provider. A backend without passwords leaves the
 * token out, and every call here fails with `NotSupported`.
 */
@Injectable({ providedIn: 'root' })
export class PasswordAuthService {
  private readonly backend = inject(PASSWORD_BACKEND, { optional: true });
  private readonly none = signal<AuthChallenge | null>(null);

  /** Whether the backend offers password sign-in at all. */
  readonly supported = this.backend !== null;

  /**
   * The challenge sign-in was interrupted by. It lives in memory, so it dies
   * with a reload: a screen that answers one checks it is still there.
   */
  readonly pendingChallenge = computed(() => (this.backend?.pendingChallenge ?? this.none)());

  /**
   * Creates an account. Usually the provider sends a code to the address, and
   * the account cannot sign in until `confirmSignUp` has it.
   */
  signUp(email: string, password: string): Observable<SignUpResult> {
    return this.backend?.signUp(email, password) ?? unsupported('registration');
  }

  confirmSignUp(email: string, code: string): Observable<void> {
    return this.backend?.confirmSignUp(email, code) ?? unsupported('registration');
  }

  /** Sends a fresh confirmation code, replacing any still outstanding. */
  resendConfirmationCode(email: string): Observable<CodeDestination> {
    return this.backend?.resendConfirmationCode(email) ?? unsupported('registration');
  }

  /**
   * Two of the failures are the wrong screen rather than errors, and arrive as
   * an `AuthError` to branch on: `UserNotConfirmed` (the code was never
   * entered) and `PasswordResetRequired` (an administrator reset it).
   */
  signIn(email: string, password: string): Observable<SignedIn | ChallengeRaised> {
    return this.backend?.signIn(email, password) ?? unsupported('password sign-in');
  }

  /**
   * Answers `NEW_PASSWORD_REQUIRED`, which is what an account an administrator
   * created meets on its first sign-in.
   */
  completeNewPassword(newPassword: string): Observable<SignedIn | ChallengeRaised> {
    return this.backend?.completeNewPassword(newPassword) ?? unsupported('password sign-in');
  }

  /** Sends a reset code. */
  forgotPassword(email: string): Observable<CodeDestination> {
    return this.backend?.forgotPassword(email) ?? unsupported('password recovery');
  }

  /** Sets a new password with the reset code. Does not sign the user in. */
  confirmForgotPassword(email: string, code: string, newPassword: string): Observable<void> {
    return (
      this.backend?.confirmForgotPassword(email, code, newPassword) ??
      unsupported('password recovery')
    );
  }

  /** Changes the signed-in user's password. The session stays valid. */
  changePassword(previousPassword: string, proposedPassword: string): Observable<void> {
    return (
      this.backend?.changePassword(previousPassword, proposedPassword) ??
      unsupported('password change')
    );
  }
}

/**
 * What a signed-in user can do to their account, however they signed in.
 *
 * Apart from the methods because these are the same operations for all of
 * them. Changing a password is not here: it means nothing to an account that
 * has none, so it is `PasswordAuthService`'s.
 */
@Injectable({ providedIn: 'root' })
export class AccountService {
  private readonly backend = inject(ACCOUNT_BACKEND, { optional: true });

  /** The signed-in user's attributes, read from the provider. */
  getUserAttributes(): Observable<UserAttributes> {
    return this.backend?.attributes() ?? unsupported('account attributes');
  }

  /** Revokes every session the user has, on every device, then drops this one. */
  globalSignOut(): Observable<void> {
    return this.backend?.globalSignOut() ?? unsupported('global sign-out');
  }

  /**
   * Deletes the account at the provider. Irreversible, and it removes only the
   * identity: whatever your own API keeps under the user's `sub` stays, and
   * needs an endpoint of its own to clear first.
   */
  deleteAccount(): Observable<void> {
    return this.backend?.deleteAccount() ?? unsupported('account deletion');
  }
}
