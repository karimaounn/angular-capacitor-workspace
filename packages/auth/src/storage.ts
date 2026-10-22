import { InjectionToken } from '@angular/core';

/**
 * Where a backend keeps the tokens.
 *
 * A synchronous key-value store, because that is what the SDKs call: Cognito's
 * reads its last user synchronously while the session is being restored, and
 * there is no point at which it could wait for an answer. The default is
 * `localStorage`. A device build that wants Capacitor's Preferences or the
 * platform keychain, which are asynchronous, implements `hydrate` and keeps an
 * in-memory mirror behind these four.
 */
export interface AuthTokenStorage {
  /**
   * Loads the backing store into memory, once, before anything reads it.
   *
   * Optional, and absent on a synchronous store. `provideAuth` registers it as
   * an app initializer, so Angular holds bootstrap until it resolves: that is
   * what puts it ahead of the first guard and the first request, the two things
   * that read the session. Without it a device build starts signed out and,
   * a moment later, is not.
   */
  hydrate?(): Promise<void>;

  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;

  /**
   * Drops everything in the store. Declared because Cognito's storage interface
   * declares it; nothing calls it. The obvious implementation is wider than the
   * name suggests: `localStorage.clear()` would take the theme and the locale
   * with it.
   */
  clear(): void;
}

/**
 * The default: `localStorage`, guarded so it cannot take the app down.
 *
 * `localStorage` throws, rather than returning null, in private modes, with
 * cookies blocked, and anywhere without a `window`. A failed read is the same
 * as being signed out, which is the right answer in each of those; a failed
 * write costs the session at the next reload and nothing sooner.
 */
export const webTokenStorage: AuthTokenStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Blocked or absent: see above.
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Blocked or absent: see above.
    }
  },
  clear() {
    try {
      localStorage.clear();
    } catch {
      // Blocked or absent: see above.
    }
  },
};

/** Token persistence for this platform. Defaults to `webTokenStorage`. */
export const AUTH_TOKEN_STORAGE = new InjectionToken<AuthTokenStorage>('AUTH_TOKEN_STORAGE', {
  providedIn: 'root',
  factory: () => webTokenStorage,
});
