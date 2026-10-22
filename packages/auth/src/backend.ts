import {
  InjectionToken,
  type EnvironmentProviders,
  type Provider,
  type Signal,
} from '@angular/core';
import type { Observable } from 'rxjs';

import type { JwtClaims } from './claims';
import type {
  AuthChallenge,
  AuthTokens,
  ChallengeRaised,
  CodeDestination,
  SignedIn,
  SignUpResult,
  UserAttributes,
} from './outcome';

/**
 * The contract between this package's services and a provider's backend.
 *
 * ## Why it is split by method
 *
 * Identity providers differ less than their SDKs do. Each offers some of a
 * short list of ways to sign in — a password, a one-time code, a redirect to
 * an identity provider — and ends every one of them with a session. So the
 * contract is one interface for the session, which every backend implements,
 * and one per method, which a backend implements when its provider offers that
 * method. The services apps use (`AuthSession`, `PasswordAuthService`,
 * `AccountService`) sit in front of it, and a screen written against them works
 * with whichever backend the app was given.
 *
 * ## Who it is for
 *
 * The backends in this package's entry points — `@angular-capacitor-workspace/auth/cognito`
 * today. It is exported because they import it from here, and it is versioned
 * with them rather than for anyone else: within a release line it can change in
 * any minor, because every backend that implements it ships in the same
 * package, at the same version. The services in front of it are what keeps that
 * from reaching an app.
 */

/** A session, as a backend reports it: the tokens of one that is valid, decoded. */
export interface AuthSnapshot {
  readonly idToken: string;
  readonly accessToken: string;
  readonly idClaims: JwtClaims;
  readonly accessClaims: JwtClaims;
  /** Epoch milliseconds the access token expires at. */
  readonly expiresAt: number;
}

/**
 * Holds, refreshes and drops the session. Every backend has one.
 *
 * The backend owns where the tokens are kept and how they are refreshed,
 * because the SDKs do: one caches them under keys of its own and refreshes on
 * read, another keeps them behind its own API and refreshes on a timer. What
 * the rest of the package needs is the same either way.
 */
export interface SessionBackend {
  /**
   * The session held now, or `null`. Set by sign-in and refresh, cleared by
   * sign-out and by a refresh that failed. A snapshot: it does not change when
   * the access token expires, only when something next asks for it.
   */
  readonly current: Signal<AuthSnapshot | null>;

  /**
   * The session, with the refresh token spent first if the access token has
   * expired. Emits `null` when there is none or the refresh failed, and never
   * errors: being signed out is a state, not a failure. Completes after one
   * value.
   */
  fresh(): Observable<AuthSnapshot | null>;

  /** Drops the session here. The tokens stay valid at the provider until they expire. */
  signOut(): void;

  /**
   * Keeps tokens obtained outside the backend's own calls — a redirect back
   * from a hosted page, a deep link into a native app — as the session.
   */
  adoptTokens(tokens: AuthTokens): void;
}

/** What a signed-in user can do to their account, however they signed in. */
export interface AccountBackend {
  attributes(): Observable<UserAttributes>;
  /** Revokes every session the user has, everywhere, then drops this one. */
  globalSignOut(): Observable<void>;
  deleteAccount(): Observable<void>;
}

/** Sign-in with an email address and a password. */
export interface PasswordBackend {
  /** The challenge `signIn` was interrupted by, until it is answered or a new attempt starts. */
  readonly pendingChallenge: Signal<AuthChallenge | null>;
  signUp(email: string, password: string): Observable<SignUpResult>;
  confirmSignUp(email: string, code: string): Observable<void>;
  resendConfirmationCode(email: string): Observable<CodeDestination>;
  signIn(email: string, password: string): Observable<SignedIn | ChallengeRaised>;
  /** Answers `NEW_PASSWORD_REQUIRED`. */
  completeNewPassword(newPassword: string): Observable<SignedIn | ChallengeRaised>;
  forgotPassword(email: string): Observable<CodeDestination>;
  confirmForgotPassword(email: string, code: string, newPassword: string): Observable<void>;
  changePassword(previousPassword: string, proposedPassword: string): Observable<void>;
}

export const SESSION_BACKEND = new InjectionToken<SessionBackend>('SESSION_BACKEND');
export const ACCOUNT_BACKEND = new InjectionToken<AccountBackend>('ACCOUNT_BACKEND');
export const PASSWORD_BACKEND = new InjectionToken<PasswordBackend>('PASSWORD_BACKEND');

/**
 * A provider's backend, as `provideAuth` takes it: `withCognito(…)`.
 *
 * Its providers register `SESSION_BACKEND` and each method's token the
 * provider offers. A method left out is one the services report as
 * `NotSupported`, rather than one that fails on a null injector.
 */
export interface AuthBackend {
  /** The provider, for messages: `'cognito'`. */
  readonly name: string;
  readonly providers: readonly (Provider | EnvironmentProviders)[];
}
