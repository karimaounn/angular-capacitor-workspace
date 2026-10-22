/**
 * The failures a screen branches on, whichever provider raised them.
 *
 * Each provider names its failures its own way — Cognito as exception names,
 * others as error codes — and its backend maps them onto these. The set is the
 * ones a screen actually reacts to; anything else is `Unknown` and is shown
 * with whatever message the provider returned.
 */
export type AuthErrorCode =
  /** Sign-up: that email already has an account. */
  | 'UsernameExists'
  /** Sign-in: wrong password, or the account is disabled. */
  | 'NotAuthorized'
  /** No such user. Only surfaces when the provider does not hide it. */
  | 'UserNotFound'
  /** Sign-in: the account exists but its confirmation code was never entered. */
  | 'UserNotConfirmed'
  /** Sign-in: an administrator reset the password; the user must set a new one. */
  | 'PasswordResetRequired'
  /** Confirmation or reset: wrong code. */
  | 'CodeMismatch'
  /** Confirmation or reset: the code timed out. */
  | 'ExpiredCode'
  /** The password breaks the provider's policy. The provider's message names the rule. */
  | 'InvalidPassword'
  /** Malformed input, or a sign-in flow the provider's client does not permit. */
  | 'InvalidParameter'
  /** Too many attempts; the provider is rate-limiting this identity. */
  | 'LimitExceeded'
  /** Too many requests overall. */
  | 'TooManyRequests'
  /** Nothing reached the provider: offline, or DNS. */
  | 'Network'
  /** The app has not been told which provider to use: an empty pool id, say. */
  | 'NotConfigured'
  /** The configured backend has no such operation: password sign-in on one without passwords. */
  | 'NotSupported'
  | 'Unknown';

/**
 * A failure from the provider, carrying a code screens can branch on.
 *
 * The code matters because several failures are not errors from the user's
 * point of view but the wrong screen: `UserNotConfirmed` means "go and enter
 * the code we sent you", and `PasswordResetRequired` means "go through
 * forgot-password". Both arrive as a failed sign-in.
 */
export class AuthError extends Error {
  constructor(
    readonly code: AuthErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * A message worth showing a user, for the codes where a provider's own wording
 * is unhelpful or says more than it should.
 *
 * `NotAuthorized` and `UserNotFound` are deliberately the same, vague about
 * which half was wrong: saying "no such account" is what turns a sign-in form
 * into a way of finding out who has one.
 */
export function describeAuthError(code: AuthErrorCode, providerMessage: string): string {
  switch (code) {
    case 'UsernameExists':
      return 'An account with that email already exists. Try signing in instead.';
    case 'NotAuthorized':
    case 'UserNotFound':
      return 'Incorrect email or password.';
    case 'UserNotConfirmed':
      return 'This account still needs to be confirmed. Check your email for the code.';
    case 'PasswordResetRequired':
      return 'This account needs a new password. Use "Forgot password" to set one.';
    case 'CodeMismatch':
      return 'That code is not correct. Check it and try again.';
    case 'ExpiredCode':
      return 'That code has expired. Request a new one.';
    case 'LimitExceeded':
    case 'TooManyRequests':
      return 'Too many attempts. Wait a minute and try again.';
    case 'Network':
      return 'Could not reach the sign-in service. Check your connection.';
    // The rest carry a message that names the rule or the setting at fault,
    // which beats anything generic written here.
    default:
      return providerMessage;
  }
}

/**
 * Anything a sign-in call failed with, as an `AuthError`.
 *
 * A backend maps its provider's failures before they reach a screen, so what
 * arrives here is usually one already; anything else is `Unknown`.
 */
export function toAuthError(cause: unknown): AuthError {
  if (cause instanceof AuthError) {
    return cause;
  }
  const message =
    typeof cause === 'string'
      ? cause
      : ((cause as { message?: unknown } | null)?.message ?? 'Authentication failed.');
  return new AuthError('Unknown', typeof message === 'string' ? message : 'Authentication failed.');
}
