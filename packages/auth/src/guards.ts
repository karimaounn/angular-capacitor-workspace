import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { map } from 'rxjs';

import { AUTH_CONFIG } from './config';
import { AuthSession } from './session';

/**
 * Keeps visitors who are not signed in out of a route, remembering where they
 * were going so sign-in can send them back.
 *
 * Routing, not security: the data is behind the API, which checks the token,
 * and a guard running in the browser can be walked past. It asks
 * `validate()` rather than `isAuthenticated`, so an expired access token is
 * refreshed on the way in instead of costing the visitor a sign-in.
 */
export const authGuard: CanActivateFn = (_route, state) => {
  const router = inject(Router);
  const { routes } = inject(AUTH_CONFIG);
  return inject(AuthSession)
    .validate()
    .pipe(
      map(
        (signedIn) =>
          signedIn ||
          router.createUrlTree([routes.signIn], { queryParams: { returnUrl: state.url } }),
      ),
    );
};

/**
 * Keeps someone already signed in off the sign-in and sign-up screens, which
 * would be a dead end offering to do what is already done.
 */
export const guestGuard: CanActivateFn = () => {
  const router = inject(Router);
  const { routes } = inject(AUTH_CONFIG);
  return inject(AuthSession)
    .validate()
    .pipe(map((signedIn) => (signedIn ? router.createUrlTree([routes.afterSignIn]) : true)));
};
