/**
 * The four rungs of the remedy ladder, strongest first.
 *
 * The ordering is the whole point: a remedy is only correct if no stronger one
 * applies. Overriding a package you could have declined to install is weaker
 * than not installing it, and accepting an advisory you could have overridden
 * is weaker still.
 */
export type Tier = 'prune' | 'override' | 'floor' | 'accept';

export const TIER_ORDER: readonly Tier[] = ['prune', 'override', 'floor', 'accept'];

/**
 * A capability token naming a condition under which a prunable package is
 * legitimate. Two forms are understood, and a guard is satisfied if either
 * matches:
 *
 * - a builder glob — `"@angular-devkit/build-angular:*"` — matched against
 *   every `architect.<target>.builder` value in the generated `angular.json`;
 * - a feature token — `"ssr:server"`, `"storybook"` — matched against the
 *   feature set the generation run enabled.
 *
 * Peer dependencies count as use. A package that npm will reinstall as a
 * required peer of something you *are* installing cannot be pruned, and the
 * guard is where that fact gets recorded.
 */
export type GuardToken = string;

export interface PruneRule {
  /** Packages removed from every dependency block when no guard is satisfied. */
  packages: string[];
  /** Advisory ids this rule is the remedy for, if any. Documentation only. */
  advisories?: string[];
  /** Why the package is unnecessary. Required — a prune without a reason rots. */
  reason: string;
  /** Conditions under which the packages are legitimate and must be kept. */
  unlessUsing?: GuardToken[];
}

/**
 * npm `overrides` are nested: `{ sockjs: { uuid: '^11.1.1' } }` rewrites uuid
 * only underneath sockjs. Scoping is deliberate — a bare `{ uuid: '^11.1.1' }`
 * would rewrite every uuid in the tree, which is a far larger blast radius than
 * the advisory justifies.
 */
export type OverrideSpec = string | { [dependency: string]: OverrideSpec };

export interface OverrideRule {
  /** The nested override tree merged into the generated `package.json`. */
  spec: Record<string, OverrideSpec>;
  advisories?: string[];
  reason: string;
  /** Only applied when one of these guards is satisfied. Omit to always apply. */
  onlyWhen?: GuardToken[];
}

export interface FloorRule {
  /** Package whose resolved version must not fall below `min`. */
  package: string;
  /** Minimum acceptable version, as a plain version, not a range. */
  min: string;
  /** The range written into `package.json` to enforce the floor. */
  range: string;
  advisories?: string[];
  reason: string;
  onlyWhen?: GuardToken[];
}

export interface AcceptedAdvisory {
  /** GHSA or CVE id, exactly as `npm audit --json` reports it. */
  id: string;
  /** Packages the advisory is against. */
  packages: string[];
  reason: string;
  /**
   * Review date, `YYYY-MM-DD`. Enforced: generating or auditing with an expired
   * acceptance is a hard failure, not a warning. An accepted advisory nobody
   * revisits is how a workspace quietly rots.
   */
  until: string;
  /** Asserts the path never reaches production output. Documentation only. */
  devOnly?: boolean;
}

export interface Policy {
  /** Date the whole file was last reviewed against the registry, `YYYY-MM-DD`. */
  reviewed: string;
  prune: PruneRule[];
  overrides: OverrideRule[];
  floors: FloorRule[];
  accepted: AcceptedAdvisory[];
  /**
   * npm >= 11.6 lifecycle-script allowlist, emitted as the `allowScripts` field
   * of the generated `package.json`. Everything absent is blocked at install.
   */
  allowScripts: Record<string, boolean>;
}

/** A single thing the policy did, for the generation report and for `doctor`. */
export interface PolicyDecision {
  tier: Tier;
  /** `applied` — changed the manifest. `skipped` — a guard held it back. */
  outcome: 'applied' | 'skipped';
  packages: string[];
  detail: string;
  /** The guard that caused a skip, when outcome is `skipped`. */
  guard?: GuardToken;
}

export interface PolicyContext {
  /** Feature tokens enabled for this workspace, e.g. `storybook`, `mobile`. */
  features: Set<string>;
  /** Every `architect.<target>.builder` string in the workspace. */
  builders: Set<string>;
  /** Today, injectable so expiry tests do not depend on the wall clock. */
  today?: Date;
}
