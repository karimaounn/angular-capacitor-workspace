import type { GuardToken, PolicyContext } from './types';

/**
 * Compiles a builder glob into a matcher. `*` matches any run of characters,
 * so `@angular-devkit/build-angular:*` matches every target that builder
 * serves. No other metacharacter is special, and the rest is escaped.
 */
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

/**
 * A guard is satisfied when either form matches: the token names an enabled
 * feature, or it globs a builder the generated `angular.json` actually uses.
 *
 * Checking both rather than dispatching on the token's shape keeps the policy
 * file readable — `unlessUsing: ['storybook', '@angular-devkit/build-angular:*']`
 * says "keep these if the Storybook feature is on, or if any builder needs
 * them", and neither half has to know which kind the other is.
 */
export function isGuardSatisfied(token: GuardToken, ctx: PolicyContext): boolean {
  if (ctx.features.has(token)) {
    return true;
  }

  if (token.includes(':')) {
    const matcher = globToRegExp(token);
    for (const builder of ctx.builders) {
      if (matcher.test(builder)) {
        return true;
      }
    }
  }

  return false;
}

/** The first satisfied guard, or `undefined` when none hold. */
export function firstSatisfiedGuard(
  tokens: readonly GuardToken[] | undefined,
  ctx: PolicyContext,
): GuardToken | undefined {
  return tokens?.find((token) => isGuardSatisfied(token, ctx));
}

/** True when `tokens` is absent (unconditional) or any token is satisfied. */
export function anySatisfied(
  tokens: readonly GuardToken[] | undefined,
  ctx: PolicyContext,
): boolean {
  return (
    tokens === undefined || tokens.length === 0 || firstSatisfiedGuard(tokens, ctx) !== undefined
  );
}
