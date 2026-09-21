import * as semver from 'semver';
import { POLICY } from './advisories';
import { anySatisfied, firstSatisfiedGuard } from './guards';
import type { OverrideSpec, Policy, PolicyContext, PolicyDecision } from './types';

/** The subset of a `package.json` the policy reads and writes. */
export interface Manifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  overrides?: Record<string, OverrideSpec>;
  allowScripts?: Record<string, boolean>;
  [key: string]: unknown;
}

const DEPENDENCY_BLOCKS = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;

export interface PolicyResult {
  manifest: Manifest;
  decisions: PolicyDecision[];
}

/** Thrown when the policy itself is unusable — an expired acceptance, a conflict. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * Deep-merges an override subtree, refusing to silently reconcile a conflict.
 *
 * Two rules disagreeing about the same pin is a policy bug, and resolving it by
 * last-write-wins would hide which remedy actually shipped.
 */
function mergeOverride(
  into: Record<string, OverrideSpec>,
  from: Record<string, OverrideSpec>,
  path: string[] = [],
): void {
  for (const [key, incoming] of Object.entries(from)) {
    const existing = into[key];
    const here = [...path, key];

    if (existing === undefined) {
      into[key] = incoming;
      continue;
    }

    if (typeof existing === 'string' || typeof incoming === 'string') {
      if (existing !== incoming) {
        throw new PolicyError(
          `Conflicting overrides for "${here.join(' > ')}": ` +
            `${JSON.stringify(existing)} vs ${JSON.stringify(incoming)}. ` +
            `Two policy rules disagree; resolve it in src/policy/advisories.ts.`,
        );
      }
      continue;
    }

    mergeOverride(existing, incoming, here);
  }
}

/**
 * Raises a dependency range to a floor when the current one permits something
 * below it.
 *
 * "Permits" is the operative word. A range is only acceptable if every version
 * it allows is at or above the floor, which is what `semver.ltr` tests: the
 * floor version being outside (below) the range is *not* the question — the
 * question is whether the range's minimum sits under the floor.
 */
function rangePermitsBelow(range: string, min: string): boolean {
  const lowest = semver.minVersion(range);
  if (lowest === null) {
    // An unparseable range (a git url, `*`, a workspace protocol) cannot be
    // reasoned about. Treat it as permitting anything, and let the caller
    // decide — silently declaring it safe is how a floor stops holding.
    return true;
  }
  return semver.lt(lowest, min);
}

function parseReviewDate(value: string, field: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new PolicyError(`Invalid ${field} date "${value}". Expected YYYY-MM-DD.`);
  }
  return new Date(`${value}T00:00:00Z`);
}

/**
 * Applies the remedy ladder to a manifest, returning the patched manifest and
 * an ordered account of every decision.
 *
 * The manifest is copied, never mutated in place: callers hold the original for
 * the drift diff that `doctor` prints.
 */
export function applyPolicy(
  manifest: Manifest,
  ctx: PolicyContext,
  policy: Policy = POLICY,
): PolicyResult {
  const next: Manifest = structuredClone(manifest);
  const decisions: PolicyDecision[] = [];
  const today = ctx.today ?? new Date();

  // ── Tier 4 first: an expired acceptance invalidates the whole run ───────
  // Checked before anything is applied so a stale policy fails loudly rather
  // than producing a workspace that looks clean because the gate never ran.
  for (const accepted of policy.accepted) {
    const until = parseReviewDate(accepted.until, `accepted[${accepted.id}].until`);
    if (until.getTime() < today.getTime()) {
      throw new PolicyError(
        `Accepted advisory ${accepted.id} expired on ${accepted.until}. ` +
          `Re-review it in src/policy/advisories.ts: either a fix has shipped ` +
          `(move it up the ladder to prune, override or floor) or it has not ` +
          `(extend \`until\` and say why). Packages: ${accepted.packages.join(', ')}.`,
      );
    }
    decisions.push({
      tier: 'accept',
      outcome: 'applied',
      packages: accepted.packages,
      detail: `${accepted.id} accepted until ${accepted.until} — ${accepted.reason}`,
    });
  }

  // ── Tier 1: prune ───────────────────────────────────────────────────────
  for (const rule of policy.prune) {
    const guard = firstSatisfiedGuard(rule.unlessUsing, ctx);
    if (guard !== undefined) {
      decisions.push({
        tier: 'prune',
        outcome: 'skipped',
        packages: rule.packages,
        guard,
        detail:
          `Kept: "${guard}" is in use. Pruning would be undone by the resolver ` +
          `or would break the build.`,
      });
      continue;
    }

    const removed: string[] = [];
    for (const block of DEPENDENCY_BLOCKS) {
      const deps = next[block];
      if (!deps) continue;
      for (const name of rule.packages) {
        if (name in deps) {
          delete deps[name];
          removed.push(name);
        }
      }
      if (Object.keys(deps).length === 0) {
        delete next[block];
      }
    }

    decisions.push({
      tier: 'prune',
      outcome: 'applied',
      packages: rule.packages,
      detail:
        removed.length > 0
          ? `Removed ${removed.join(', ')} — ${rule.reason}`
          : `Not present; kept out — ${rule.reason}`,
    });
  }

  // ── Tier 2: override ────────────────────────────────────────────────────
  for (const rule of policy.overrides) {
    if (!anySatisfied(rule.onlyWhen, ctx)) {
      decisions.push({
        tier: 'override',
        outcome: 'skipped',
        packages: Object.keys(rule.spec),
        detail: `Not applicable: none of ${rule.onlyWhen?.join(', ')} is enabled.`,
      });
      continue;
    }

    next.overrides ??= {};
    mergeOverride(next.overrides, rule.spec);
    decisions.push({
      tier: 'override',
      outcome: 'applied',
      packages: Object.keys(rule.spec),
      detail: `Pinned ${describeOverride(rule.spec)} — ${rule.reason}`,
    });
  }

  // ── Tier 3: floor ───────────────────────────────────────────────────────
  for (const rule of policy.floors) {
    if (!anySatisfied(rule.onlyWhen, ctx)) {
      decisions.push({
        tier: 'floor',
        outcome: 'skipped',
        packages: [rule.package],
        detail: `Not applicable: none of ${rule.onlyWhen?.join(', ')} is enabled.`,
      });
      continue;
    }

    let raised = false;
    for (const block of DEPENDENCY_BLOCKS) {
      const deps = next[block];
      const current = deps?.[rule.package];
      if (!deps || current === undefined) continue;
      if (rangePermitsBelow(current, rule.min)) {
        deps[rule.package] = rule.range;
        raised = true;
      }
    }

    decisions.push({
      tier: 'floor',
      outcome: raised ? 'applied' : 'skipped',
      packages: [rule.package],
      detail: raised
        ? `Raised ${rule.package} to ${rule.range} — ${rule.reason}`
        : `${rule.package} already at or above ${rule.min}, or not installed.`,
    });
  }

  // ── Install-script allowlist ────────────────────────────────────────────
  if (Object.keys(policy.allowScripts).length > 0) {
    next.allowScripts = { ...policy.allowScripts, ...next.allowScripts };
    decisions.push({
      tier: 'prune',
      outcome: 'applied',
      packages: Object.keys(policy.allowScripts),
      detail:
        `allowScripts allowlist written; every other package is blocked from ` +
        `running install scripts (npm >= 11.6).`,
    });
  }

  sortManifestBlocks(next);
  return { manifest: next, decisions };
}

function describeOverride(spec: Record<string, OverrideSpec>, path: string[] = []): string {
  return Object.entries(spec)
    .map(([key, value]) =>
      typeof value === 'string'
        ? `${[...path, key].join(' > ')}@${value}`
        : describeOverride(value, [...path, key]),
    )
    .join(', ');
}

/** Keeps generated manifests diff-stable regardless of insertion order. */
function sortManifestBlocks(manifest: Manifest): void {
  for (const block of [...DEPENDENCY_BLOCKS, 'peerDependencies', 'allowScripts'] as const) {
    const value = manifest[block];
    if (!value || typeof value !== 'object') continue;
    manifest[block] = Object.fromEntries(
      Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
    ) as never;
  }
}
