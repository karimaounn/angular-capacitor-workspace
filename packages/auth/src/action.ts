import { signal } from '@angular/core';
import type { Observable } from 'rxjs';

import { type AuthError, toAuthError } from './errors';

/**
 * Submission state for one form: whether it is busy, its last failure, and a
 * notice.
 *
 * A class each form owns rather than a service, so two forms on one screen —
 * changing a password and deleting the account — never share a spinner or
 * overwrite each other's error.
 */
export class AuthAction {
  readonly busy = signal(false);
  readonly error = signal<AuthError | null>(null);
  /** Feedback that is not an error: "we sent a code to k***@g***.com". */
  readonly notice = signal<string | null>(null);

  /**
   * Runs one request, tracking busy and error around it. A second call while
   * one is running is ignored, which is what stops a double submit.
   *
   * `onError` returns `true` when it has handled the failure itself — a
   * `UserNotConfirmed` that becomes a redirect, say — and the error is then not
   * shown, since the user never sees its consequences.
   */
  run<T>(
    work: Observable<T>,
    onSuccess: (value: T) => void,
    onError?: (error: AuthError) => boolean,
  ): void {
    if (this.busy()) {
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    this.notice.set(null);

    work.subscribe({
      next: (value) => {
        this.busy.set(false);
        onSuccess(value);
      },
      error: (cause: unknown) => {
        this.busy.set(false);
        const error = toAuthError(cause);
        if (onError?.(error) !== true) {
          this.error.set(error);
        }
      },
    });
  }
}
