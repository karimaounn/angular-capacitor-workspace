import { InjectionToken } from '@angular/core';

/**
 * A provider's password policy, restated for checking as the user types.
 *
 * A copy, not the source of truth: the provider enforces its own policy
 * whatever happens here. Restating it is worth it because a rejection from the
 * provider costs a round trip and names one rule at a time, while this lists
 * every rule a password breaks at once. If the two drift, the provider wins and
 * the user sees an `InvalidPassword` the form said would not happen.
 */
export interface PasswordPolicy {
  readonly minLength: number;
  readonly requireUppercase: boolean;
  readonly requireLowercase: boolean;
  readonly requireDigits: boolean;
  readonly requireSymbols: boolean;
}

/** Cognito's policy for a user pool created without one, and the default here. */
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  requireUppercase: true,
  requireLowercase: true,
  requireDigits: true,
  requireSymbols: false,
};

/** The policy in force, from `provideAuth({ password: { policy } })`. */
export const PASSWORD_POLICY = new InjectionToken<PasswordPolicy>('PASSWORD_POLICY', {
  providedIn: 'root',
  factory: () => DEFAULT_PASSWORD_POLICY,
});

/** One line per rule, for showing beside the field before anything is typed. */
export function describePasswordPolicy(policy: PasswordPolicy): readonly string[] {
  const rules = [`At least ${policy.minLength} characters`];
  if (policy.requireUppercase) rules.push('An uppercase letter');
  if (policy.requireLowercase) rules.push('A lowercase letter');
  if (policy.requireDigits) rules.push('A number');
  if (policy.requireSymbols) rules.push('A symbol');
  return rules;
}

/**
 * Every rule `password` breaks, in the order `describePasswordPolicy` lists
 * them: all of them rather than the first, so a password is fixed in one pass.
 *
 * Takes the policy rather than injecting it, so a validator that runs outside
 * an injection context can call it.
 */
export function passwordPolicyErrors(policy: PasswordPolicy, password: string): readonly string[] {
  const failures: string[] = [];
  if (password.length < policy.minLength) {
    failures.push(`Must be at least ${policy.minLength} characters.`);
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    failures.push('Must contain an uppercase letter.');
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    failures.push('Must contain a lowercase letter.');
  }
  if (policy.requireDigits && !/[0-9]/.test(password)) {
    failures.push('Must contain a number.');
  }
  if (policy.requireSymbols && !/[^A-Za-z0-9]/.test(password)) {
    failures.push('Must contain a symbol.');
  }
  return failures;
}
