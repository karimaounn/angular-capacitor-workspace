import { Injectable, computed, inject, signal } from '@angular/core';
import {
  AuthError,
  type AuthSnapshot,
  type AuthTokens,
  type SessionBackend,
} from '@angular-capacitor-workspace/auth';
import type { CognitoUser, CognitoUserSession } from 'amazon-cognito-identity-js';
import { Observable, from, map, of, share, switchMap, type Subscriber } from 'rxjs';

import { CognitoPool } from './pool';
import { cognitoSdk, loadCognitoSdk } from './sdk';

/**
 * The session, as Cognito's SDK keeps it.
 *
 * The SDK persists the tokens itself, under keys of its own in
 * `AUTH_TOKEN_STORAGE`, and `getSession` spends the refresh token when the
 * access token has expired. This wraps both in signals and Observables, so
 * nothing above it sees a callback.
 *
 * The password and account backends write to it (`record`, `clear`) when a
 * call of theirs signs someone in or out, which keeps who may change the
 * session a short list.
 */
@Injectable()
export class CognitoSession implements SessionBackend {
  private readonly cognito = inject(CognitoPool);
  private readonly held = signal<CognitoUserSession | null>(null);

  /** One `getSession` at a time, so a guard and a request arriving together refresh once. */
  private inflight: Observable<CognitoUserSession | null> | null = null;

  readonly current = computed(() => {
    const session = this.held();
    return session ? snapshot(session) : null;
  });

  constructor() {
    // Restores the session in storage. Once the SDK has loaded, which
    // `withCognito` has the app wait for, a valid one is there synchronously;
    // an expired one is refreshed, and the guards wait for that through `fresh`.
    this.load().subscribe();
  }

  fresh(): Observable<AuthSnapshot | null> {
    return this.load().pipe(map((session) => (session ? snapshot(session) : null)));
  }

  signOut(): void {
    this.cognito.currentUser()?.signOut();
    this.held.set(null);
  }

  /**
   * Keeps tokens obtained outside the SDK — the hosted UI's token endpoint, a
   * deep link — where the SDK will find them after a reload and refresh them.
   *
   * The username is the ID token's `cognito:username`, which is the key the
   * SDK caches under. Adopt promptly: the SDK measures clock drift from the
   * token's `iat` at this point, so a token handed over late reads as fresh.
   */
  adoptTokens(tokens: AuthTokens): void {
    const sdk = cognitoSdk();
    if (!sdk) {
      throw new AuthError(
        'Unknown',
        'adoptTokens was called before the Cognito SDK loaded. Call it once the app has started.',
      );
    }
    const session = new sdk.CognitoUserSession({
      IdToken: new sdk.CognitoIdToken({ IdToken: tokens.idToken }),
      AccessToken: new sdk.CognitoAccessToken({ AccessToken: tokens.accessToken }),
      RefreshToken: new sdk.CognitoRefreshToken({ RefreshToken: tokens.refreshToken }),
    });
    const claims = session.getIdToken().payload;
    const username = claims['cognito:username'] ?? claims['sub'];
    if (typeof username !== 'string') {
      throw new AuthError(
        'Unknown',
        'That ID token carries no username claim, so it did not come from this user pool.',
      );
    }
    this.cognito.userFor(sdk, username).setSignInUserSession(session);
    this.held.set(session);
  }

  /** Records the session a sign-in produced. The SDK has already stored it. */
  record(session: CognitoUserSession): void {
    this.held.set(session);
  }

  /** Forgets the session here, after a call that ended it at Cognito. */
  clear(): void {
    this.held.set(null);
  }

  /**
   * Runs an operation that needs the signed-in user with a live session:
   * reading attributes, changing the password, deleting the account. The SDK
   * attaches the access token to those itself, once a session is loaded onto
   * the user, which is what this does first.
   */
  withUser<T>(operation: (user: CognitoUser, subscriber: Subscriber<T>) => void): Observable<T> {
    return this.cognito.withSdk(
      () =>
        new Observable<T>((subscriber) => {
          const user = this.cognito.currentUser();
          if (user === null) {
            subscriber.error(new AuthError('NotAuthorized', 'You are not signed in.'));
            return;
          }
          user.getSession((error: Error | null, session: CognitoUserSession | null) => {
            if (error || !session?.isValid()) {
              subscriber.error(
                new AuthError('NotAuthorized', 'Your session has expired. Sign in again.'),
              );
              return;
            }
            this.held.set(session);
            operation(user, subscriber);
          });
        }),
    );
  }

  /**
   * The stored session, refreshed if it has expired, or `null`. A failed
   * refresh is the ordinary signed-out case, not an error, and so is an app
   * with no pool configured, which never loads the SDK for it.
   */
  private load(): Observable<CognitoUserSession | null> {
    if (this.inflight) {
      return this.inflight;
    }
    if (!this.cognito.configured) {
      return of(null);
    }
    if (!cognitoSdk()) {
      // Only when something asks before the app has started — a test, say.
      return from(loadCognitoSdk()).pipe(switchMap(() => this.load()));
    }
    const user = this.cognito.currentUser();
    if (user === null) {
      this.held.set(null);
      return of(null);
    }
    const request = new Observable<CognitoUserSession | null>((subscriber) => {
      user.getSession((error: Error | null, session: CognitoUserSession | null) => {
        this.inflight = null;
        const valid = !error && session?.isValid() ? session : null;
        this.held.set(valid);
        subscriber.next(valid);
        subscriber.complete();
      });
    }).pipe(share());
    this.inflight = request;
    return request;
  }
}

function snapshot(session: CognitoUserSession): AuthSnapshot {
  const id = session.getIdToken();
  const access = session.getAccessToken();
  return {
    idToken: id.getJwtToken(),
    accessToken: access.getJwtToken(),
    idClaims: id.payload,
    accessClaims: access.payload,
    // The SDK reports seconds; everything else here is milliseconds.
    expiresAt: access.getExpiration() * 1000,
  };
}
