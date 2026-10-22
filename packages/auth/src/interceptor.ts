import type { HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { switchMap } from 'rxjs';

import { AUTH_CONFIG } from './config';
import { AuthSession } from './session';

/**
 * Sends the session's token to the app's API, as `Authorization: Bearer`.
 *
 * Only to requests under `apiBaseUrl`. An app talks to more than one host —
 * its API, which wants the token, and the identity provider, which must never
 * be sent it — so the token goes where it was configured to and nowhere else.
 * With no `apiBaseUrl`, it goes nowhere.
 *
 * The token is asked for on every request, and asking refreshes it when it
 * has expired: a request made an hour after the last one goes out with a live
 * token rather than coming back 401 for a reason the user cannot do anything
 * about.
 */
export const authInterceptor: HttpInterceptorFn = (request, next) => {
  const { apiBaseUrl, bearerToken } = inject(AUTH_CONFIG);
  if (apiBaseUrl === '' || !isUnder(request.url, apiBaseUrl)) {
    return next(request);
  }

  const session = inject(AuthSession);
  const token = bearerToken === 'id' ? session.idToken() : session.accessToken();
  return token.pipe(
    switchMap((value) =>
      // Signed out, or the refresh token has expired too: send the request
      // bare. The API's 401 says more than a request this refused to make.
      next(
        value === null
          ? request
          : request.clone({ setHeaders: { Authorization: `Bearer ${value}` } }),
      ),
    ),
  );
};

/** `https://api.example.com/v1` covers `/v1` and `/v1/…`, but not `/v10`. */
function isUnder(url: string, base: string): boolean {
  return url === base || (url.startsWith(base) && '/?#'.includes(url[base.length]!));
}
