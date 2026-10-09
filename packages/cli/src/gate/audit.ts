import type { Tier } from '../policy/types';

export type Severity = 'info' | 'low' | 'moderate' | 'high' | 'critical';

export const SEVERITY_ORDER: readonly Severity[] = ['info', 'low', 'moderate', 'high', 'critical'];

export function atOrAbove(severity: Severity, level: Severity): boolean {
  return SEVERITY_ORDER.indexOf(severity) >= SEVERITY_ORDER.indexOf(level);
}

/** One advisory, with every path through the tree that reaches it. */
export interface Finding {
  /** GHSA id where npm reports one, else the numeric advisory source. */
  id: string;
  title: string;
  url: string;
  severity: Severity;
  /** The package the advisory is against. */
  package: string;
  /** The vulnerable version range, as npm states it. */
  range: string;
  /** Dependency paths from a direct dependency down to `package`. */
  paths: string[][];
  /** npm's own view: `false`, `true`, or a concrete upgrade. */
  fixAvailable: false | true | { name: string; version: string; isSemVerMajor: boolean };
  /** True when the vulnerable package is itself a direct dependency. */
  isDirect: boolean;
  /** The rung of the ladder that would fix this, and how. */
  proposal: Proposal;
}

export interface Proposal {
  tier: Tier;
  /** A ready-to-paste fragment for src/policy/advisories.ts. */
  snippet: string;
  rationale: string;
}

interface RawAdvisory {
  source?: number;
  name?: string;
  dependency?: string;
  title?: string;
  url?: string;
  severity?: string;
  range?: string;
}

interface RawVulnerability {
  name: string;
  severity: string;
  isDirect: boolean;
  via: Array<RawAdvisory | string>;
  effects: string[];
  range: string;
  nodes: string[];
  fixAvailable: Finding['fixAvailable'];
}

export interface AuditReport {
  auditReportVersion?: number;
  vulnerabilities?: Record<string, RawVulnerability>;
  metadata?: { vulnerabilities?: Record<string, number> };
  error?: { code?: string; summary?: string };
}

/**
 * npm's audit output is a graph keyed by package, where `via` mixes advisory
 * objects with the names of other vulnerable packages, and `effects` points at
 * dependents. Rebuilding paths means walking `effects` upward until we reach a
 * direct dependency.
 */
export function parseAudit(json: string): AuditReport {
  const trimmed = json.trim();
  if (trimmed === '') {
    throw new Error('npm audit produced no output.');
  }
  try {
    return JSON.parse(trimmed) as AuditReport;
  } catch (error) {
    throw new Error(
      `Could not parse npm audit output as JSON: ${(error as Error).message}\n` +
        `First 400 characters:\n${trimmed.slice(0, 400)}`,
    );
  }
}

/**
 * Walks `effects` upward to enumerate paths from a direct dependency down to
 * the vulnerable package.
 *
 * Cycles are possible in a dependency graph, so the walk carries its own visit
 * set. Depth is capped because a pathological tree should degrade to a shorter
 * report rather than hang the gate.
 */
function pathsTo(
  name: string,
  vulns: Record<string, RawVulnerability>,
  depth = 0,
  seen: ReadonlySet<string> = new Set(),
): string[][] {
  if (depth > 24 || seen.has(name)) {
    return [[name]];
  }

  const node = vulns[name];
  if (!node || node.isDirect || node.effects.length === 0) {
    return [[name]];
  }

  const nextSeen = new Set(seen).add(name);
  const out: string[][] = [];
  for (const effect of node.effects) {
    for (const parentPath of pathsTo(effect, vulns, depth + 1, nextSeen)) {
      out.push([...parentPath, name]);
    }
  }
  return out.length > 0 ? out : [[name]];
}

/**
 * The lowest version that escapes a vulnerable range.
 *
 * npm states ranges like `<11.1.1` or `>=2.1.0 <4.1.11`. The upper bound is the
 * version the advisory was fixed in, so the last `<` bound is the answer. When
 * the range has no upper bound — `>=0.3.17`, meaning every published version is
 * affected — there is nothing to suggest, and saying so is more useful than
 * inventing a number.
 */
export function fixedVersionFor(range: string): string | undefined {
  const bounds = [...range.matchAll(/<\s*([0-9][0-9A-Za-z.+-]*)/g)];
  return bounds.at(-1)?.[1];
}

function proposeFix(vuln: RawVulnerability, advisory: RawAdvisory, paths: string[][]): Proposal {
  const id = idOf(advisory) ?? advisoryId(vuln);
  // The advisory's own range carries the upper bound (`<7.29.0`); the
  // vulnerability's aggregate range is often the hyphen form (`7.0.0 - 7.28.0`),
  // which names the last broken version rather than the first fixed one.
  // Preferring the advisory range is the difference between proposing a working
  // override and wrongly concluding no fix exists.
  const fixed = fixedVersionFor(advisory.range ?? '') ?? fixedVersionFor(vuln.range);
  const parent = paths[0]?.at(-2);

  if (vuln.isDirect && typeof vuln.fixAvailable === 'object') {
    return {
      tier: 'floor',
      snippet: [
        '{',
        `  package: ${quoteValue(vuln.name)},`,
        `  min: '${vuln.fixAvailable.version}',`,
        `  range: '^${vuln.fixAvailable.version}',`,
        `  advisories: ['${id}'],`,
        `  reason: '…',`,
        '}',
      ].join('\n'),
      rationale:
        `${vuln.name} is a direct dependency and npm has a fix at ` +
        `${vuln.fixAvailable.version}` +
        (vuln.fixAvailable.isSemVerMajor ? ' (a major bump — check the changelog).' : '.'),
    };
  }

  if (parent !== undefined && fixed !== undefined) {
    return {
      tier: 'override',
      snippet: [
        '{',
        `  spec: { ${quoteKey(parent)}: { ${quoteKey(vuln.name)}: '^${fixed}' } },`,
        `  advisories: ['${id}'],`,
        `  reason: '…',`,
        '}',
      ].join('\n'),
      rationale:
        `${vuln.name} is transitive under ${parent}, and the advisory is fixed ` +
        `in ${fixed}. Scope the override to ${parent} so the rest of the tree ` +
        `keeps its own resolution.`,
    };
  }

  if (vuln.isDirect) {
    return {
      tier: 'prune',
      snippet: [
        '{',
        `  packages: [${quoteValue(vuln.name)}],`,
        `  advisories: ['${id}'],`,
        `  reason: '…',`,
        `  unlessUsing: ['…'],`,
        '}',
      ].join('\n'),
      rationale:
        `${vuln.name} is a direct dependency with no published fix. Check ` +
        `whether anything actually loads it — the strongest remedy is not ` +
        `installing it.`,
    };
  }

  return {
    tier: 'accept',
    snippet: [
      '{',
      `  id: '${id}',`,
      `  packages: [${quoteValue(vuln.name)}],`,
      `  reason: '…',`,
      `  until: '${sixMonthsOut()}',`,
      `  devOnly: true,`,
      '}',
    ].join('\n'),
    rationale:
      `No published version of ${vuln.name} escapes \`${vuln.range}\`, so there ` +
      `is nothing to pin to. If the path is dev-only, accept it with an expiry.`,
  };
}

/** An object key: bare when it is a valid identifier, quoted otherwise. */
function quoteKey(name: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(name) ? name : `'${name}'`;
}

/** A string value. Always quoted — `[undici]` is an identifier, not a name. */
function quoteValue(name: string): string {
  return `'${name}'`;
}

function idOf(advisory: RawAdvisory): string | undefined {
  const fromUrl = advisory.url?.match(/(GHSA-[\w-]+|CVE-[\d-]+)/)?.[1];
  if (fromUrl) return fromUrl;
  return advisory.source === undefined ? undefined : String(advisory.source);
}

function sixMonthsOut(): string {
  const date = new Date();
  date.setUTCMonth(date.getUTCMonth() + 6);
  return date.toISOString().slice(0, 10);
}

function advisoryId(vuln: RawVulnerability): string {
  for (const via of vuln.via) {
    if (typeof via === 'object') {
      const fromUrl = via.url?.match(/(GHSA-[\w-]+|CVE-[\d-]+)/)?.[1];
      if (fromUrl) return fromUrl;
      if (via.source !== undefined) return String(via.source);
    }
  }
  return `unknown:${vuln.name}`;
}

/** Flattens an audit report into one finding per advisory. */
export function findingsFrom(report: AuditReport): Finding[] {
  const vulns = report.vulnerabilities ?? {};
  const findings: Finding[] = [];

  for (const vuln of Object.values(vulns)) {
    const advisories = vuln.via.filter((via): via is RawAdvisory => typeof via === 'object');
    if (advisories.length === 0) {
      // This node is only vulnerable because something it depends on is; the
      // advisory itself is reported against that dependency. Skipping avoids
      // reporting the same GHSA once per node in the chain.
      continue;
    }

    const paths = pathsTo(vuln.name, vulns);

    for (const advisory of advisories) {
      const url = advisory.url ?? '';
      findings.push({
        id: idOf(advisory) ?? 'unknown',
        title: advisory.title ?? 'Unknown advisory',
        url,
        severity: (advisory.severity ?? vuln.severity) as Severity,
        package: vuln.name,
        range: advisory.range ?? vuln.range,
        paths,
        fixAvailable: vuln.fixAvailable,
        isDirect: vuln.isDirect,
        proposal: proposeFix(vuln, advisory, paths),
      });
    }
  }

  return findings.sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(b.severity) - SEVERITY_ORDER.indexOf(a.severity) ||
      a.package.localeCompare(b.package),
  );
}
