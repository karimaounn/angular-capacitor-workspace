import { POLICY } from '../policy/advisories';
import type { Policy } from '../policy/types';
import { atOrAbove, findingsFrom, parseAudit, type Finding, type Severity } from './audit';
import { auditJson, resolveLockfile } from './npm';
import { formatFindings } from './report';

export interface GateOptions {
  cwd: string;
  /** Advisories below this severity are reported but do not fail the gate. */
  auditLevel?: Severity;
  policy?: Policy;
  /** Skip the lockfile resolve when a fresh one already exists. */
  skipResolve?: boolean;
  log?: (message: string) => void;
}

export interface GateResult {
  ok: boolean;
  /** Everything npm reported, including entries below `auditLevel`. */
  all: Finding[];
  /** At or above `auditLevel` and not accepted by policy — these fail the gate. */
  unhandled: Finding[];
  /** At or above `auditLevel` but covered by a Tier 4 acceptance. */
  accepted: Finding[];
  report: string;
}

/**
 * Resolves a lockfile and audits it, failing on anything the policy did not
 * account for.
 *
 * Runs after the policy has already patched the manifest, so every remaining
 * finding is by construction unhandled — there is no second chance to remedy
 * one here, and that is deliberate. The gate's job is to notice, not to fix.
 */
export function runGate(options: GateOptions): GateResult {
  const { cwd, auditLevel = 'moderate', policy = POLICY, skipResolve = false } = options;
  const log = options.log ?? (() => {});

  if (!skipResolve) {
    log('Resolving lockfile (npm install --package-lock-only --ignore-scripts)…');
    const resolved = resolveLockfile(cwd);
    if (resolved.status !== 0) {
      return {
        ok: false,
        all: [],
        unhandled: [],
        accepted: [],
        report:
          'Audit gate: could not resolve a lockfile, so the tree was never ' +
          'audited.\n\n' +
          tail(resolved.stderr || resolved.stdout, 40) +
          '\n\nAn ERESOLVE here usually means a peer range is unsatisfiable at ' +
          'the pinned Angular line. Check src/policy/versions.ts.',
      };
    }
  }

  log('Auditing (npm audit --json)…');
  const audited = auditJson(cwd);
  const report = parseAudit(audited.stdout);

  if (report.error) {
    return {
      ok: false,
      all: [],
      unhandled: [],
      accepted: [],
      report: `Audit gate: npm audit failed — ${report.error.summary ?? report.error.code}`,
    };
  }

  const all = findingsFrom(report);
  const acceptedIds = new Set(policy.accepted.map((entry) => entry.id));

  const relevant = all.filter((finding) => atOrAbove(finding.severity, auditLevel));
  const accepted = relevant.filter((finding) => acceptedIds.has(finding.id));
  const unhandled = relevant.filter((finding) => !acceptedIds.has(finding.id));

  const sections = [formatFindings(unhandled, auditLevel)];
  if (accepted.length > 0) {
    sections.push(
      '',
      `Accepted by policy (Tier 4), not failing the gate:`,
      ...accepted.map((finding) => `  • ${finding.id} ${finding.package} — ${finding.title}`),
    );
  }
  const below = all.length - relevant.length;
  if (below > 0) {
    sections.push('', `${below} advisory/advisories below "${auditLevel}" not shown.`);
  }

  return {
    ok: unhandled.length === 0,
    all,
    unhandled,
    accepted,
    report: sections.join('\n'),
  };
}

function tail(text: string, lines: number): string {
  return text.split('\n').slice(-lines).join('\n');
}

export { atOrAbove, findingsFrom, parseAudit, SEVERITY_ORDER } from './audit';
export type { AuditReport, Finding, Proposal, Severity } from './audit';
export { npm, resolveLockfile, auditJson } from './npm';
export { formatDecisions, formatFindings } from './report';
