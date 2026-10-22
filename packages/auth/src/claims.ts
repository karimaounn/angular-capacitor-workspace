/**
 * Claims decoded from a JWT.
 *
 * Values are `unknown` because nothing here verifies a signature: the API that
 * receives the token decides whether it is real. Claims in the browser are for
 * showing and routing only.
 */
export type JwtClaims = Readonly<Record<string, unknown>>;

/** Reads a claim as a string, or `null` when it is absent or of another type. */
export function stringClaim(claims: JwtClaims | null | undefined, name: string): string | null {
  const value = claims?.[name];
  return typeof value === 'string' ? value : null;
}
