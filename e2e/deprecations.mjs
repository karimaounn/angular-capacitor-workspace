/**
 * The deprecation rule for generated workspaces.
 *
 * Deliberately not part of the shipped policy, and deliberately not a gate a
 * generated workspace runs. A deprecation lands on the registry's clock rather
 * than on anyone's commit, so a workspace whose CI failed on one would go red
 * on a morning nobody touched it — and a gate people learn to bypass also
 * launders the real failures standing next to it. `advisories.ts` is for things
 * with a severity and a remedy; this is not one of those.
 *
 * What *is* worth failing over is narrow: a deprecation on a package this
 * generator itself writes into a manifest, that is not a required peer of
 * something the generator installs. That is always fixable here, in this repo,
 * on the day it appears — so unlike a blanket deprecation gate it can never be
 * permanently red, and the waiver list below can never grow to cover things
 * nobody can act on.
 *
 * Everything else — a deprecation three levels down inside Compodoc, say — is
 * reported as context and gates nothing. Upstream will move or it will not.
 */

/**
 * Direct dependencies knowingly shipped deprecated.
 *
 * The bar for an entry is that the package is not ours to remove: npm puts it
 * back as a required peer whatever the manifest says. Anything that fails that
 * bar belongs in `POLICY.prune` instead, which is what happened to
 * `@angular/animations`.
 *
 * `revisitWhen` is the analogue of the `until` date on an accepted advisory.
 * There is no wall-clock expiry to enforce here — a deprecation does not become
 * more urgent by sitting — so the check that keeps this list honest is the
 * staleness sweep below: an entry that stops appearing in any row is an
 * exemption for nothing and is reported so it can be deleted.
 */
export const EXPECTED = [
  {
    package: '@angular-devkit/build-angular',
    peerOf: '@storybook/angular',
    reason:
      "Angular's webpack support is deprecated in favour of @angular/build, which " +
      'this generator already uses for every builder it emits. The package is in ' +
      'the tree only because Storybook 10.6 declares it a REQUIRED peer, so npm ' +
      'reinstalls it whatever the manifest says. POLICY.prune already removes it ' +
      'from every row that does not carry Storybook.',
    revisitWhen: 'Storybook ships an @angular/build-based builder, or drops the devkit peers.',
  },
  {
    package: '@angular/platform-browser-dynamic',
    peerOf: '@storybook/angular',
    reason:
      'Deprecated in favour of @angular/platform-browser. Nothing this generator ' +
      'emits imports it; it is declared only because leaving this required peer of ' +
      '@storybook/angular implicit makes npm backtrack it onto Angular 20 and fail ' +
      'the install with ERESOLVE. See policy/versions.ts.',
    revisitWhen: 'Storybook 10 drops the peer, or Angular removes the package.',
  },
];

/**
 * Splits what an install reported into the three things they are.
 *
 * `findings` fail the run. `waived` and `transitive` are printed so the report
 * says what it looked at, which is the difference between "no findings" and
 * "nothing was checked".
 */
export function classify(deprecations) {
  const waivers = new Map(EXPECTED.map((entry) => [entry.package, entry]));
  const findings = [];
  const waived = [];
  const transitive = [];

  for (const deprecation of deprecations) {
    if (!deprecation.direct) {
      transitive.push(deprecation);
      continue;
    }
    const waiver = waivers.get(deprecation.package);
    if (waiver) {
      waived.push({ ...deprecation, waiver });
    } else {
      findings.push(deprecation);
    }
  }

  return { findings, waived, transitive };
}

/**
 * Waivers no row exercised.
 *
 * Only meaningful after a complete run: `--row minimal` carries no Storybook,
 * so both entries are legitimately absent and reporting them there would train
 * everyone to ignore this. The caller decides whether the run was complete.
 */
export function staleWaivers(seen) {
  return EXPECTED.filter((entry) => !seen.has(entry.package));
}

/** One line per deprecation, for the console summary. */
export function summarise({ findings, waived, transitive }) {
  const parts = [];
  if (findings.length > 0) parts.push(`${findings.length} unexpected`);
  if (waived.length > 0) parts.push(`${waived.length} expected`);
  if (transitive.length > 0) parts.push(`${transitive.length} transitive`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

/**
 * The issue body.
 *
 * Written so that the first screen answers "what do I have to do", and the
 * context that follows exists to stop the next person re-deriving why the
 * waived ones are waived.
 */
export function renderIssue(rows, stale = []) {
  const withFindings = rows.filter((row) => row.deprecations.findings.length > 0);

  const lines = [
    '## Unexpected deprecations in generated workspaces',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} from a real install of each matrix row.`,
    '',
    'Each package below is one this generator writes into a generated manifest ' +
      'itself, and is not a required peer of anything it installs — so it is ' +
      'removable here, in this repo. Transitive deprecations are listed at the ' +
      "end as context; they are not this repo's to fix.",
    '',
  ];

  for (const row of withFindings) {
    lines.push(`### Row: \`${row.row}\``, '');
    for (const finding of row.deprecations.findings) {
      lines.push(
        `#### \`${finding.package}@${finding.version}\``,
        '',
        `> ${finding.message}`,
        '',
        'Either drop it from the schematic that writes it and add a `POLICY.prune`',
        'entry so `doctor --fix` reaches workspaces that already exist — or, if npm',
        'puts it back as a required peer, add it to `EXPECTED` in',
        '`e2e/deprecations.mjs` with the peer that forces it.',
        '',
      );
    }
  }

  if (stale.length > 0) {
    lines.push(
      '### Waivers that no row exercised',
      '',
      'These are listed in `EXPECTED` but no longer appear in any install. An',
      'exemption for a package that is no longer there is surface for nothing —',
      'delete them.',
      '',
      ...stale.map((entry) => `- \`${entry.package}\` — waived because: ${entry.reason}`),
      '',
    );
  }

  const waived = dedupe(rows.flatMap((row) => row.deprecations.waived));
  if (waived.length > 0) {
    lines.push('### Expected, and why', '');
    for (const entry of waived) {
      lines.push(
        `- \`${entry.package}@${entry.version}\` — required peer of ` +
          `\`${entry.waiver.peerOf}\`. ${entry.waiver.reason} _Revisit when: ` +
          `${entry.waiver.revisitWhen}_`,
      );
    }
    lines.push('');
  }

  const transitive = dedupe(rows.flatMap((row) => row.deprecations.transitive));
  if (transitive.length > 0) {
    lines.push(
      '### Transitive, for information',
      '',
      'Nothing here writes these; they arrived underneath something else.',
      '',
      ...transitive.map((entry) => `- \`${entry.package}@${entry.version}\` — ${entry.message}`),
      '',
    );
  }

  return lines.join('\n');
}

function dedupe(entries) {
  const seen = new Map();
  for (const entry of entries) {
    seen.set(`${entry.package}@${entry.version}`, entry);
  }
  return [...seen.values()].sort((a, b) => a.package.localeCompare(b.package));
}
