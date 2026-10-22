import { ApplicationInitStatus } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cognito, withCognito, type CognitoConfig } from '../cognito/src/public-api';
import { cognitoErrorCode, toCognitoError } from '../cognito/src/errors';
import { cognitoSdk } from '../cognito/src/sdk';
import {
  AccountService,
  AuthSession,
  PasswordAuthService,
  provideAuth,
  type AuthTokenStorage,
} from '../src/public-api';

/**
 * The Cognito backend, as far as it goes without a user pool to talk to: how
 * it starts, what it does without configuration, and how it reads and writes
 * the SDK's token cache. Nothing here reaches the network.
 */

const POOL: CognitoConfig = {
  userPoolId: 'us-east-1_Testpool',
  userPoolClientId: 'test-client-id',
};

const PREFIX = `CognitoIdentityServiceProvider.${POOL.userPoolClientId}`;

/** An unsigned JWT: the SDK decodes payloads and verifies nothing. */
function jwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

function tokens(username: string, expiresIn = 3600) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { 'cognito:username': username, sub: 'sub-1', iat: now, exp: now + expiresIn };
  return {
    idToken: jwt({ ...claims, email: `${username}@example.com` }),
    accessToken: jwt({ ...claims, token_use: 'access' }),
    refreshToken: 'refresh-token',
  };
}

/** Writes a session where the SDK caches one, as a sign-in on this device would have. */
function storeSession(username: string): void {
  const issued = tokens(username);
  localStorage.setItem(`${PREFIX}.LastAuthUser`, username);
  localStorage.setItem(`${PREFIX}.${username}.idToken`, issued.idToken);
  localStorage.setItem(`${PREFIX}.${username}.accessToken`, issued.accessToken);
  localStorage.setItem(`${PREFIX}.${username}.refreshToken`, issued.refreshToken);
  localStorage.setItem(`${PREFIX}.${username}.clockDrift`, '0');
}

/** Configures the app and lets it start, which is when the SDK loads. */
async function configure(pool: CognitoConfig = POOL, tokenStorage?: AuthTokenStorage) {
  TestBed.configureTestingModule({
    providers: [
      provideAuth(
        { routes: { signIn: '/auth/sign-in', afterSignIn: '/' }, tokenStorage },
        withCognito(pool),
      ),
    ],
  });
  await TestBed.inject(ApplicationInitStatus).donePromise;
}

beforeEach(() => localStorage.clear());
afterEach(() => TestBed.resetTestingModule());

// First, before anything has asked for the SDK.
describe('the SDK', () => {
  it('is not loaded by importing the entry point, nor for an app with no pool', async () => {
    expect(cognitoSdk()).toBeUndefined();
    await configure({ userPoolId: '', userPoolClientId: '' });
    TestBed.inject(AuthSession);
    expect(cognitoSdk()).toBeUndefined();
  });

  it('is loaded while an app with a pool starts', async () => {
    await configure();
    expect(cognitoSdk()?.CognitoUserPool).toBeTypeOf('function');
  });
});

describe('withCognito', () => {
  it('restores the session a sign-in left in storage', async () => {
    storeSession('ada');
    await configure();
    const session = TestBed.inject(AuthSession);
    expect(session.isAuthenticated()).toBe(true);
    expect(session.idClaims()?.['email']).toBe('ada@example.com');
  });

  it('starts signed out when storage holds nothing', async () => {
    await configure();
    const session = TestBed.inject(AuthSession);
    expect(session.isAuthenticated()).toBe(false);
    expect(await firstValueFrom(session.validate())).toBe(false);
  });

  it('keeps adopted tokens where a reload finds them', async () => {
    await configure();
    TestBed.inject(AuthSession).adoptTokens(tokens('grace'));
    expect(localStorage.getItem(`${PREFIX}.LastAuthUser`)).toBe('grace');

    // A second app instance over the same storage: a reload.
    TestBed.resetTestingModule();
    await configure();
    expect(TestBed.inject(AuthSession).isAuthenticated()).toBe(true);
  });

  it('signs out on this device', async () => {
    storeSession('ada');
    await configure();
    const session = TestBed.inject(AuthSession);
    session.signOut();
    expect(session.isAuthenticated()).toBe(false);
    expect(localStorage.getItem(`${PREFIX}.ada.accessToken`)).toBeNull();
  });

  it('offers password sign-in and the account operations', async () => {
    await configure();
    expect(TestBed.inject(PasswordAuthService).supported).toBe(true);
    expect(TestBed.inject(AccountService)).toBeDefined();
  });

  it('reads storage only after an asynchronous store has loaded', async () => {
    const reads: string[] = [];
    let hydrated = false;
    const early: string[] = [];
    await configure(POOL, {
      hydrate: async () => {
        await Promise.resolve();
        hydrated = true;
      },
      getItem: (key) => {
        reads.push(key);
        if (!hydrated) early.push(key);
        return null;
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
    });
    TestBed.inject(AuthSession);
    expect(reads.length).toBeGreaterThan(0);
    expect(early).toEqual([]);
  });
});

describe('an app whose pool is not configured yet', () => {
  it('starts signed out, with the empty pool a generated environment holds', async () => {
    // As the generator writes it: `auth: cognito({ userPoolId: '', userPoolClientId: '' })`.
    const empty = { userPoolId: '', userPoolClientId: '' };
    expect(cognito(empty)).toBe(empty);
    await configure(cognito(empty));
    expect(TestBed.inject(AuthSession).isAuthenticated()).toBe(false);
    await expect(
      firstValueFrom(TestBed.inject(PasswordAuthService).signIn('ada@example.com', 'pw')),
    ).rejects.toMatchObject({
      code: 'NotConfigured',
      message: expect.stringContaining('auth: cognito({ … })'),
    });
  });

  it('starts, signed out', async () => {
    await configure({ userPoolId: '', userPoolClientId: '' });
    expect(TestBed.inject(AuthSession).isAuthenticated()).toBe(false);
  });

  it('fails sign-in saying what to set', async () => {
    await configure({ userPoolId: '', userPoolClientId: '' });
    await expect(
      firstValueFrom(TestBed.inject(PasswordAuthService).signIn('ada@example.com', 'pw')),
    ).rejects.toMatchObject({ code: 'NotConfigured', message: /userPoolId/ });
  });

  it('names a pool id the SDK refuses', async () => {
    await configure({ userPoolId: 'not-a-pool', userPoolClientId: 'client' });
    expect(TestBed.inject(AuthSession).isAuthenticated()).toBe(false);
    await expect(
      firstValueFrom(TestBed.inject(PasswordAuthService).forgotPassword('ada@example.com')),
    ).rejects.toMatchObject({ code: 'NotConfigured', message: /not-a-pool/ });
  });
});

describe('Cognito errors', () => {
  it('maps exception names, with or without their suffix and namespace', () => {
    expect(cognitoErrorCode('NotAuthorizedException')).toBe('NotAuthorized');
    expect(cognitoErrorCode('com.amazonaws#CodeMismatchException')).toBe('CodeMismatch');
    expect(cognitoErrorCode('NetworkError')).toBe('Network');
    expect(cognitoErrorCode('SomethingNew')).toBe('Unknown');
  });

  it('turns an SDK failure into an AuthError worth showing', () => {
    const error = toCognitoError({
      code: 'UserNotFoundException',
      message: 'User does not exist.',
    });
    expect(error).toMatchObject({ code: 'UserNotFound', message: 'Incorrect email or password.' });
  });
});
