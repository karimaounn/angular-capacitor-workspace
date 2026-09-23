import type { Manifest } from '../policy/apply';

/**
 * A deprecation warning npm printed while installing.
 *
 * Deliberately not modelled as a `Finding`, and deliberately not fed to the
 * gate. An advisory has a severity, a vulnerable range and a remedy, which is
 * what makes the four-tier ladder possible. A deprecation has none of those: it
 * is one maintainer's opinion, published on their schedule rather than on any
 * commit, and frequently carries no action at all — `whatwg-encoding` saying
 * "use @exodus/bytes instead" arrives three levels below a generated workspace,
 * where nothing the workspace owns can act on it.
 *
 * So these are collected and reported, never gated on. The narrow case where
 * failing *is* right — a deprecation on a package this generator itself writes,
 * which is therefore always fixable here — belongs to this repo's own nightly
 * matrix, and lives in `e2e/deprecations.mjs` rather than in the shipped gate.
 */
export interface Deprecation {
  package: string;
  /** The resolved version npm warned about. */
  version: string;
  /** The maintainer's message, verbatim. */
  message: string;
  /**
   * True when the package is a direct entry in the generated manifest.
   *
   * The distinction that decides who can act: a direct entry is one this
   * generator chose and can reconsider, a transitive one arrived underneath
   * something else and is upstream's to move.
   */
  direct: boolean;
}

/**
 * `npm warn deprecated <name>@<version>: <message>`.
 *
 * The name is matched lazily so that a scoped package keeps its leading `@` and
 * still splits on the `@` before the version — `@angular/animations@22.1.7` has
 * two, and only the second one separates.
 */
const WARNING = /^npm\s+warn\s+deprecated\s+(.+?)@([^@\s:]+):\s*(.*)$/;

/**
 * The deprecation warnings in `output`, deduplicated and sorted by package.
 *
 * npm emits these only while reifying a tree: a package it does not have to
 * unpack is a package it does not warn about. An install into a populated
 * `node_modules` prints none at all, and neither does `--dry-run`. Anything
 * reading this must therefore read an empty result as "nothing was installed",
 * never as "nothing is deprecated" — a check that quietly passes because it
 * looked at the wrong install is worse than no check.
 */
export function collectDeprecations(output: string, manifest: Manifest = {}): Deprecation[] {
  const declared = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ]);

  const seen = new Map<string, Deprecation>();

  for (const line of output.split('\n')) {
    const match = WARNING.exec(line.trim());
    if (!match) continue;

    const [, name, version, message] = match;
    if (name === undefined || version === undefined) continue;

    seen.set(`${name}@${version}`, {
      package: name,
      version,
      message: (message ?? '').trim(),
      direct: declared.has(name),
    });
  }

  return [...seen.values()].sort((a, b) => a.package.localeCompare(b.package));
}
