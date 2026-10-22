import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApplicationInitStatus, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  Router,
  provideRouter,
  type ActivatedRouteSnapshot,
  type RouterStateSnapshot,
  type UrlTree,
} from '@angular/router';
import { firstValueFrom, isObservable, of, type Observable } from 'rxjs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccountService,
  AuthError,
  AuthSession,
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_POLICY,
  PasswordAuthService,
  SESSION_BACKEND,
  authGuard,
  authInterceptor,
  describeAuthError,
  describePasswordPolicy,
  guestGuard,
  passwordPolicyErrors,
  provideAuth,
  toAuthError,
  type AuthBackend,
  type AuthConfig,
  type AuthSnapshot,
  type AuthTokenStorage,
  type SessionBackend,
} from '../src/public-api';

/**
 * The package against a backend that is not Cognito: what every provider
 * shares — the guards, the interceptor, the services and their errors — has to
 * work from the contract alone.
 */

const SNAPSHOT: AuthSnapshot = {
  idToken: 'id-token',
  accessToken: 'access-token',
  idClaims: { email: 'ada@example.com' },
  accessClaims: {},
  expiresAt: Date.now() + 3_600_000,
};

/** A session backend whose session a test sets, and which counts `fresh` calls. */
class FakeSession implements SessionBackend {
  readonly current = signal<AuthSnapshot | null>(null);
  freshCalls = 0;
  /** What `fresh` resolves to: the session a refresh would produce. */
  refreshed: AuthSnapshot | null = null;

  fresh(): Observable<AuthSnapshot | null> {
    this.freshCalls++;
    this.current.set(this.refreshed);
    return of(this.refreshed);
  }
  signOut(): void {
    this.current.set(null);
  }
  adoptTokens(): void {}
}

function fakeBackend(session: FakeSession): AuthBackend {
  return { name: 'fake', providers: [{ provide: SESSION_BACKEND, useValue: session }] };
}

const ROUTES = { signIn: '/auth/sign-in', afterSignIn: '/home' };

function configure(session: FakeSession, config: Partial<AuthConfig> = {}): void {
  TestBed.configureTestingModule({
    providers: [
      provideRouter([]),
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      provideAuth({ routes: ROUTES, ...config }, fakeBackend(session)),
    ],
  });
}

afterEach(() => TestBed.resetTestingModule());

/** Runs a functional guard in an injection context and settles what it returns. */
async function guard(
  fn: typeof authGuard,
  url = '/orders/7',
): Promise<boolean | UrlTree | unknown> {
  const result = TestBed.runInInjectionContext(() =>
    fn({} as ActivatedRouteSnapshot, { url } as RouterStateSnapshot),
  );
  return isObservable(result) ? firstValueFrom(result) : result;
}

describe('provideAuth', () => {
  it('says what to add when an app has no backend', () => {
    TestBed.configureTestingModule({});
    expect(() => TestBed.inject(AuthSession)).toThrow(/provideAuth/);
  });

  it('loads an asynchronous token store before the app starts', async () => {
    let hydrated = false;
    const storage: AuthTokenStorage = {
      hydrate: async () => {
        await Promise.resolve();
        hydrated = true;
      },
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    };
    configure(new FakeSession(), { tokenStorage: storage });
    await TestBed.inject(ApplicationInitStatus).donePromise;
    expect(hydrated).toBe(true);
  });

  it('provides the password policy it is given, and Cognito’s default otherwise', () => {
    const strict = { ...DEFAULT_PASSWORD_POLICY, minLength: 12 };
    configure(new FakeSession(), { password: { policy: strict } });
    expect(TestBed.inject(PASSWORD_POLICY)).toBe(strict);

    TestBed.resetTestingModule();
    configure(new FakeSession());
    expect(TestBed.inject(PASSWORD_POLICY)).toBe(DEFAULT_PASSWORD_POLICY);
  });
});

describe('AuthSession', () => {
  it('reads the backend’s session as signals', () => {
    const session = new FakeSession();
    configure(session);
    const auth = TestBed.inject(AuthSession);
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.idClaims()).toBeNull();

    session.current.set(SNAPSHOT);
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.idClaims()).toEqual({ email: 'ada@example.com' });
    expect(auth.expiresAt()).toBe(SNAPSHOT.expiresAt);
  });

  it('asks the backend for a fresh token, and answers null when signed out', async () => {
    const session = new FakeSession();
    configure(session);
    const auth = TestBed.inject(AuthSession);
    expect(await firstValueFrom(auth.accessToken())).toBeNull();

    session.refreshed = SNAPSHOT;
    expect(await firstValueFrom(auth.accessToken())).toBe('access-token');
    expect(await firstValueFrom(auth.idToken())).toBe('id-token');
    expect(session.freshCalls).toBe(3);
  });
});

describe('the guards', () => {
  it('send a visitor to sign in, remembering where they were going', async () => {
    configure(new FakeSession());
    const result = await guard(authGuard);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe(
      '/auth/sign-in?returnUrl=%2Forders%2F7',
    );
  });

  it('let a visitor in on a session that only a refresh could restore', async () => {
    // `current` is null until `fresh` runs: the access token had expired.
    const session = new FakeSession();
    session.refreshed = SNAPSHOT;
    configure(session);
    expect(await guard(authGuard)).toBe(true);
  });

  it('keep someone signed in off the guest screens', async () => {
    const session = new FakeSession();
    configure(session);
    expect(await guard(guestGuard)).toBe(true);

    session.refreshed = SNAPSHOT;
    const result = await guard(guestGuard);
    expect(TestBed.inject(Router).serializeUrl(result as UrlTree)).toBe('/home');
  });
});

describe('authInterceptor', () => {
  function send(url: string): string | null {
    TestBed.inject(HttpClient).get(url).subscribe();
    const request = TestBed.inject(HttpTestingController).expectOne(url);
    const header = request.request.headers.get('Authorization');
    request.flush({});
    return header;
  }

  function signedIn(config: Partial<AuthConfig>): void {
    const session = new FakeSession();
    session.refreshed = SNAPSHOT;
    configure(session, config);
  }

  it('sends the access token to the API, and only to the API', () => {
    signedIn({ apiBaseUrl: 'https://api.example.com/v1/' });
    expect(send('https://api.example.com/v1/orders')).toBe('Bearer access-token');
    expect(send('https://api.example.com/v1')).toBe('Bearer access-token');
    expect(send('https://api.example.com/v10/orders')).toBeNull();
    expect(send('https://cognito-idp.us-east-1.amazonaws.com/')).toBeNull();
  });

  it('sends the ID token when the gateway wants that one', () => {
    signedIn({ apiBaseUrl: 'https://api.example.com', bearerToken: 'id' });
    expect(send('https://api.example.com/orders')).toBe('Bearer id-token');
  });

  it('sends nothing anywhere until it is given an API', () => {
    signedIn({});
    expect(send('https://api.example.com/orders')).toBeNull();
  });

  it('sends a request bare when nobody is signed in', () => {
    configure(new FakeSession(), { apiBaseUrl: 'https://api.example.com' });
    expect(send('https://api.example.com/orders')).toBeNull();
  });
});

describe('a backend without passwords or accounts', () => {
  it('fails each call as NotSupported rather than on a null injector', async () => {
    configure(new FakeSession());
    const password = TestBed.inject(PasswordAuthService);
    expect(password.supported).toBe(false);
    expect(password.pendingChallenge()).toBeNull();
    await expect(firstValueFrom(password.signIn('a@b.c', 'pw'))).rejects.toMatchObject({
      code: 'NotSupported',
    });
    await expect(
      firstValueFrom(TestBed.inject(AccountService).deleteAccount()),
    ).rejects.toBeInstanceOf(AuthError);
  });
});

describe('errors', () => {
  it('words sign-in failures so they say nothing about which half was wrong', () => {
    expect(describeAuthError('UserNotFound', 'User does not exist.')).toBe(
      describeAuthError('NotAuthorized', 'Incorrect username or password.'),
    );
  });

  it('keeps the provider’s message where it names the rule', () => {
    expect(describeAuthError('InvalidPassword', 'Password must have symbols')).toBe(
      'Password must have symbols',
    );
  });

  it('passes an AuthError through and wraps anything else as Unknown', () => {
    const error = new AuthError('ExpiredCode', 'Expired.');
    expect(toAuthError(error)).toBe(error);
    expect(toAuthError(new Error('boom'))).toMatchObject({ code: 'Unknown', message: 'boom' });
    expect(toAuthError(undefined).code).toBe('Unknown');
  });
});

describe('the password policy', () => {
  const errorsFor = (password: string) => passwordPolicyErrors(DEFAULT_PASSWORD_POLICY, password);

  it('accepts a password that meets every rule', () => {
    expect(errorsFor('Password1')).toEqual([]);
  });

  it('reports every rule a password breaks at once', () => {
    expect(errorsFor('abc')).toEqual([
      'Must be at least 8 characters.',
      'Must contain an uppercase letter.',
      'Must contain a number.',
    ]);
  });

  it('applies the policy it is given', () => {
    const strict = { ...DEFAULT_PASSWORD_POLICY, minLength: 12, requireSymbols: true };
    expect(passwordPolicyErrors(strict, 'Password1')).toEqual([
      'Must be at least 12 characters.',
      'Must contain a symbol.',
    ]);
  });

  it('describes the rules in the order it checks them', () => {
    expect(describePasswordPolicy(DEFAULT_PASSWORD_POLICY)).toEqual([
      'At least 8 characters',
      'An uppercase letter',
      'A lowercase letter',
      'A number',
    ]);
  });
});
