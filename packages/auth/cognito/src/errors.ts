import {
  AuthError,
  describeAuthError,
  type AuthErrorCode,
} from '@angular-capacitor-workspace/auth';

/**
 * Cognito's exception names, by the code a screen branches on.
 *
 * The SDK fails with an `Error` carrying the service's exception name on
 * `code` and `name` — `NotAuthorizedException` — which is the only part of a
 * failure a program can read.
 */
const CODES: Readonly<Record<string, AuthErrorCode>> = {
  UsernameExists: 'UsernameExists',
  NotAuthorized: 'NotAuthorized',
  UserNotFound: 'UserNotFound',
  UserNotConfirmed: 'UserNotConfirmed',
  PasswordResetRequired: 'PasswordResetRequired',
  CodeMismatch: 'CodeMismatch',
  ExpiredCode: 'ExpiredCode',
  InvalidPassword: 'InvalidPassword',
  InvalidParameter: 'InvalidParameter',
  LimitExceeded: 'LimitExceeded',
  TooManyRequests: 'TooManyRequests',
  NetworkError: 'Network',
};

/** Maps an exception name, with or without its namespace and `Exception` suffix. */
export function cognitoErrorCode(name: string | undefined): AuthErrorCode {
  const bare = name?.replace(/^.*#/, '').replace(/Exception$/, '');
  return (bare && CODES[bare]) || 'Unknown';
}

/** Anything the SDK failed with, as an `AuthError` with a message worth showing. */
export function toCognitoError(cause: unknown): AuthError {
  if (cause instanceof AuthError) {
    return cause;
  }
  if (typeof cause === 'object' && cause !== null) {
    const { code, name, message } = cause as { code?: string; name?: string; message?: string };
    const errorCode = cognitoErrorCode(code ?? name);
    return new AuthError(errorCode, describeAuthError(errorCode, message ?? 'Sign-in failed.'));
  }
  return new AuthError('Unknown', typeof cause === 'string' ? cause : 'Sign-in failed.');
}
