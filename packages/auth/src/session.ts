import { Injectable, computed, inject } from '@angular/core';
import { type Observable, map } from 'rxjs';

import { SESSION_BACKEND, type AuthSnapshot } from './backend';
import type { JwtClaims } from './claims';
import { AuthError } from './errors';
import type { AuthTokens } from './outcome';

/**
 * The session, however it was obtained and whichever provider issued it.
 *
 * Every sign-in method ends here, and everything downstream reads it without
 * knowing which method that was: `authGuard` asks `validate()`,
 * `authInterceptor` asks for a token, an account screen reads `idClaims`. None
 * of them changes when a method or a provider is added, which is what the
 * split between this and the backend is for.
 */
@Injectable({ providedIn: 'root' })
export class AuthSession {
  private readonly backend = (() => {
    const backend = inject(SESSION_BACKEND, { optional: true });
    if (!backend) {
      throw new AuthError(
        'NotConfigured',
        'No sign-in backend is provided. Add provideAuth(…, withCognito(…)) to the ' +
          "application's providers.",
      );
    }
    return backend;
  })();

  /**
   * Claims off the ID token: `email`, `name`, `sub`. For showing, not for
   * deciding anything: nothing here verifies a signature.
   */
  readonly idClaims = computed<JwtClaims | null>(() => this.backend.current()?.idClaims ?? null);

  /** Claims off the access token. */
  readonly accessClaims = computed<JwtClaims | null>(
    () => this.backend.current()?.accessClaims ?? null,
  );

  /** Epoch milliseconds the session's access token expires at, or `null` when signed out. */
  readonly expiresAt = computed(() => this.backend.current()?.expiresAt ?? null);

  /**
   * Whether a session is held. A snapshot, for showing "signed in as": it can
   * read `true` after the access token has expired, until something asks for
   * the token. `validate()` is what a decision should rest on.
   */
  readonly isAuthenticated = computed(() => this.backend.current() !== null);

  /**
   * Whether a session is held, with the refresh token spent first if the
   * access token has expired. What the guards ask, so a visitor who comes back
   * after an hour is let through on their refresh token rather than sent to
   * sign in.
   */
  validate(): Observable<boolean> {
    return this.backend.fresh().pipe(map((session) => session !== null));
  }

  /** The ID token, refreshed if it has expired, or `null` when signed out. */
  idToken(): Observable<string | null> {
    return this.token((session) => session.idToken);
  }

  /** The access token, refreshed if it has expired, or `null` when signed out. */
  accessToken(): Observable<string | null> {
    return this.token((session) => session.accessToken);
  }

  /**
   * Drops the session on this device. The tokens stay valid at the provider
   * until they expire: `AccountService.globalSignOut` is what revokes them.
   */
  signOut(): void {
    this.backend.signOut();
  }

  /**
   * Keeps tokens obtained outside the sign-in services — a redirect back from
   * a hosted page, a deep link — as the session. Call it as soon as the
   * exchange returns them.
   */
  adoptTokens(tokens: AuthTokens): void {
    this.backend.adoptTokens(tokens);
  }

  private token(pick: (session: AuthSnapshot) => string): Observable<string | null> {
    return this.backend.fresh().pipe(map((session) => (session ? pick(session) : null)));
  }
}
