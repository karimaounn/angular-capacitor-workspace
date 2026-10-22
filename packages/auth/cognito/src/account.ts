import { Injectable, inject } from '@angular/core';
import type { AccountBackend, UserAttributes } from '@angular-capacitor-workspace/auth';
import type { Observable } from 'rxjs';

import { toCognitoError } from './errors';
import { CognitoSession } from './session';

/** A user pool's account operations, for whoever is signed in. */
@Injectable()
export class CognitoAccount implements AccountBackend {
  private readonly session = inject(CognitoSession);

  attributes(): Observable<UserAttributes> {
    return this.session.withUser<UserAttributes>((user, subscriber) => {
      user.getUserAttributes((error, attributes) => {
        if (error) {
          subscriber.error(toCognitoError(error));
          return;
        }
        subscriber.next({
          username: user.getUsername(),
          attributes: Object.fromEntries(
            (attributes ?? []).map((attribute) => [attribute.getName(), attribute.getValue()]),
          ),
        });
        subscriber.complete();
      });
    });
  }

  globalSignOut(): Observable<void> {
    return this.session.withUser<void>((user, subscriber) => {
      user.globalSignOut({
        onSuccess: () => {
          this.session.clear();
          subscriber.next();
          subscriber.complete();
        },
        onFailure: (error: unknown) => subscriber.error(toCognitoError(error)),
      });
    });
  }

  deleteAccount(): Observable<void> {
    return this.session.withUser<void>((user, subscriber) => {
      user.deleteUser((error) => {
        if (error) {
          subscriber.error(toCognitoError(error));
          return;
        }
        this.session.clear();
        subscriber.next();
        subscriber.complete();
      });
    });
  }
}
