import { bold, bySeverity, cyan, dim, gray, heading, MARK } from '../style';
import type { PolicyDecision } from '../policy/types';
import type { Finding, Severity } from './audit';

export function formatDecisions(decisions: readonly PolicyDecision[]): string {
  if (decisions.length === 0) {
    return `${heading('Dependency policy')}\n  ${dim('nothing to apply.')}`;
  }

  const lines = [heading('Dependency policy')];
  for (const decision of decisions) {
    const mark = decision.outcome === 'applied' ? MARK.ok : MARK.skip;
    const detail = decision.outcome === 'applied' ? decision.detail : dim(decision.detail);
    lines.push(`  ${mark} ${cyan(`[${decision.tier}]`)} ${detail}`);
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
    return `  ${MARK.ok} ${dim(`found 0 vulnerabilities at or above "${auditLevel}".`)}`;
  }

  const lines: string[] = [
    `  ${MARK.fail} ${findings.length} advisory/advisories at or above "${auditLevel}" ` +
      `are not accounted for by the policy.`,
    '',
  ];

  for (const finding of findings) {
    const severity = bySeverity(finding.severity);
    lines.push(
      `  ${severity(finding.severity.toUpperCase())}  ${bold(finding.id)}  ${finding.title}`,
    );
    lines.push(
      `    ${dim('package:')}  ${finding.package}  ${dim('vulnerable:')} ${finding.range}`,
    );
    if (finding.url) {
      lines.push(`    ${dim('advisory:')} ${dim(finding.url)}`);
    }
    for (const path of finding.paths.slice(0, 4)) {
      lines.push(`    ${dim('path:')}     ${gray(path.join(' → '))}`);
    }
    if (finding.paths.length > 4) {
      lines.push(`    ${dim('path:')}     ${gray(`… and ${finding.paths.length - 4} more`)}`);
    }
    lines.push(
      `    ${dim('remedy:')}   tier ${finding.proposal.tier} — ${finding.proposal.rationale}`,
    );
    lines.push('');
    lines.push(cyan(indent(finding.proposal.snippet, 4)));
    lines.push('');
  }

  lines.push(
    dim(
      'Add the entries above to src/policy/advisories.ts (or to your own policy ' +
        'override), then re-run the gate.',
    ),
  );
  return lines.join('\n');
}

/** A short line naming what the gate looked at but deliberately let past. */
export function formatAccepted(findings: readonly Finding[]): string[] {
  return [
    '',
    dim('Accepted by policy (Tier 4), not failing the gate:'),
    ...findings.map(
      (finding) => `  ${MARK.warn} ${finding.id} ${finding.package} — ${dim(finding.title)}`,
    ),
  ];
}

function indent(text: string, spaces: number): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line === '' ? line : pad + line))
    .join('\n');
}
