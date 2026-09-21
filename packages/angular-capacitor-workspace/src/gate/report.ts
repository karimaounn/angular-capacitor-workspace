import type { PolicyDecision } from '../policy/types';
import type { Finding, Severity } from './audit';

const BULLET = '  •';

export function formatDecisions(decisions: readonly PolicyDecision[]): string {
  if (decisions.length === 0) {
    return 'Policy: nothing to apply.';
  }

  const lines = ['Dependency policy:'];
  for (const decision of decisions) {
    const mark = decision.outcome === 'applied' ? '✓' : '·';
    lines.push(`${BULLET} ${mark} [${decision.tier}] ${decision.detail}`);
  }
  return lines.join('\n');
}

/**
 * Formats unhandled findings as something a maintainer can act on without
 * leaving the terminal: what it is, how the tree reaches it, and the policy
 * entry that would fix it.
 *
 * The snippet matters more than it looks. The gate failing with "7 moderate
 * vulnerabilities" sends you to a browser; the gate failing with the exact
 * object to paste into advisories.ts keeps the remedy ladder cheap enough that
 * people actually climb it.
 */
export function formatFindings(findings: readonly Finding[], auditLevel: Severity): string {
  if (findings.length === 0) {
    return `Audit gate: found 0 vulnerabilities at or above "${auditLevel}".`;
  }

  const lines: string[] = [
    `Audit gate: ${findings.length} advisory/advisories at or above "${auditLevel}" ` +
      `are not accounted for by the policy.`,
    '',
  ];

  for (const finding of findings) {
    lines.push(`${finding.severity.toUpperCase()}  ${finding.id}  ${finding.title}`);
    lines.push(`  package: ${finding.package}  vulnerable: ${finding.range}`);
    if (finding.url) {
      lines.push(`  advisory: ${finding.url}`);
    }
    for (const path of finding.paths.slice(0, 4)) {
      lines.push(`  path: ${path.join(' → ')}`);
    }
    if (finding.paths.length > 4) {
      lines.push(`  path: … and ${finding.paths.length - 4} more`);
    }
    lines.push(`  remedy: tier ${finding.proposal.tier} — ${finding.proposal.rationale}`);
    lines.push('');
    lines.push(indent(finding.proposal.snippet, 4));
    lines.push('');
  }

  lines.push(
    'Add the entries above to src/policy/advisories.ts (or to your own policy ' +
      'override), then re-run the gate.',
  );
  return lines.join('\n');
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n');
}
