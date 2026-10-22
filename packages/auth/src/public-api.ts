/*
 * Sign-in for an angular-capacitor-workspace.
 *
 * Everything here works the same whichever identity provider an app signs in
 * with: the session, the guards, the interceptor, the services screens are
 * written against, and the errors they branch on. The provider's half is a
 * backend from one of this package's other entry points —
 * `@angular-capacitor-workspace/auth/cognito` — passed to `provideAuth`. The
 * workspace's design system binds the two to its `src/config/auth.ts` and
 * re-exports this, so applications import from there.
 */

export { AUTH_CONFIG, provideAuth } from './config';
export type { AuthConfig, AuthRoutes, BearerToken, ResolvedAuthConfig } from './config';
export { AuthSession } from './session';
export { AccountService, PasswordAuthService } from './services';
export { authGuard, guestGuard } from './guards';
export { authInterceptor } from './interceptor';
export { AuthError, describeAuthError, toAuthError } from './errors';
export type { AuthErrorCode } from './errors';
export type {
  AuthChallenge,
  AuthTokens,
  ChallengeRaised,
  CodeDestination,
  Redirecting,
  SignedIn,
  SignInOutcome,
  SignUpResult,
  UserAttributes,
} from './outcome';
export { stringClaim } from './claims';
export type { JwtClaims } from './claims';
export { AuthAction } from './action';
export {
  DEFAULT_PASSWORD_POLICY,
  PASSWORD_POLICY,
  describePasswordPolicy,
  passwordPolicyErrors,
} from './password-policy';
export type { PasswordPolicy } from './password-policy';
export { AUTH_TOKEN_STORAGE, webTokenStorage } from './storage';
export type { AuthTokenStorage } from './storage';

// The backends' contract. For this package's entry points; see `backend.ts`
// for why it can change within a release line and the services above cannot.
export { ACCOUNT_BACKEND, PASSWORD_BACKEND, SESSION_BACKEND } from './backend';
export type {
  AccountBackend,
  AuthBackend,
  AuthSnapshot,
  PasswordBackend,
  SessionBackend,
} from './backend';
