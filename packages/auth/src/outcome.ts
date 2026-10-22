/**
 * Where a one-time code was sent.
 *
 * Shared by the flows that send one: sign-up confirmation and password reset
 * today, a passwordless challenge next.
 */
export interface CodeDestination {
  /** Obscured by the provider, e.g. `k***@g***.com`. Null when it declines to say. */
  readonly destination: string | null;
}

/**
 * Something the provider wants before it will issue tokens.
 *
 * Named rather than a bare string because the interesting challenges carry
 * context a screen needs: a one-time code has a destination to show. The name
 * is the provider's own and left open — `NEW_PASSWORD_REQUIRED`, `EMAIL_OTP`,
 * `SMS_MFA` — because which ones can occur depends on the provider and the
 * method, and only the method that raised one knows how to answer it. A screen
 * handles the names it knows and sends the visitor back to sign in on any
 * other.
 */
export interface AuthChallenge {
  readonly name: string;
  /** Where a code was sent, when the challenge is a one-time code. */
  readonly destination?: string | null;
}

/** Tokens issued. `AuthSession` now holds a session. */
export interface SignedIn {
  readonly status: 'signed-in';
}

/** Interrupted. Answer it through the same service that returned it. */
export interface ChallengeRaised {
  readonly status: 'challenge';
  readonly challenge: AuthChallenge;
}

/**
 * The browser is being sent elsewhere — a hosted page, an identity provider —
 * and this document may never run again. Returned rather than navigating
 * silently, so a caller can show that something is happening and a test can
 * assert the destination without the page unloading.
 */
export interface Redirecting {
  readonly status: 'redirecting';
  readonly url: string;
}

/**
 * Every way a sign-in attempt can end, across all methods.
 *
 * The methods reach a session by different routes and share no call
 * signature — a password takes two secrets at once, a passwordless method an
 * identifier and then a code, a federated one a provider name and leaves the
 * page. What they share is how an attempt ends. A method's return type is the
 * part of this union it can produce: `PasswordAuthService.signIn` returns
 * `SignedIn | ChallengeRaised`, so a password screen that handles both is
 * exhaustive and the compiler says so.
 */
export type SignInOutcome = SignedIn | ChallengeRaised | Redirecting;

/** The three tokens a sign-in yields, for a method that receives them as strings. */
export interface AuthTokens {
  readonly idToken: string;
  readonly accessToken: string;
  /** Required: without it the session cannot outlive the access token. */
  readonly refreshToken: string;
}

/** Result of a self-service sign-up. */
export interface SignUpResult extends CodeDestination {
  /** True when the provider confirmed the account at once; false means a code was sent. */
  readonly userConfirmed: boolean;
}

/** A user's attributes, as the provider stores them. */
export interface UserAttributes {
  readonly username: string;
  readonly attributes: Readonly<Record<string, string>>;
}
