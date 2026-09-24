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
 * staleness sweep below: an entry whose package no longer appears in any
 * generated manifest is an exemption for nothing and is reported so it can be
 * deleted. An entry whose package is still there but has stopped warning is a
 * different thing and is only noted; see `dormantWaivers`.
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
 * Waivers whose package no longer appears in any generated manifest.
 *
 * Staleness is judged on the package being gone from the tree, not on its
 * deprecation warning going quiet. In an install log those two look identical
 * — the package simply stops being mentioned — and they mean opposite things.
 * A package nothing installs any more is an exemption for nothing and the entry
 * should go. A package still forced into the tree whose maintainer dropped the
 * marker is a waiver between jobs, and deleting that one arms the trap: the
 * marker comes back, the entry is gone, and the nightly goes red on a morning
 * nothing here changed — which is the failure this whole file exists to avoid.
 *
 * Angular 22.2.0 is the case in point. It shipped on 2026-09-23 without the
 * `deprecated` markers every release from 21.0.0 to 22.1.9 carried, so both
 * entries below stopped warning overnight while remaining required peers of
 * `@storybook/angular` and direct entries in the generated manifest.
 *
 * `present` is the union of the direct dependency names across every row. Only
 * meaningful after a complete run: `--row minimal` carries no Storybook, so
 * both entries are legitimately absent and reporting them there would train
 * everyone to ignore this. The caller decides whether the run was complete.
 */
export function staleWaivers(present) {
  return EXPECTED.filter((entry) => !present.has(entry.package));
}

/**
 * Waivers whose package is still installed but no longer warns.
 *
 * Reported as context, never failed on. It is the honest answer to "why did the
 * waived list go empty", and the first thing to check before believing a
 * `revisitWhen` has come true — an upstream release that merely forgot to run
 * `npm deprecate` looks exactly like one that undeprecated on purpose.
 */
export function dormantWaivers(present, warned) {
  return EXPECTED.filter((entry) => present.has(entry.package) && !warned.has(entry.package));
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
export function renderIssue(rows, stale = [], dormant = []) {
  const withFindings = rows.filter((row) => row.deprecations.findings.length > 0);

  // The heading tracks what is actually in the body. A stale waiver is not a
  // deprecated package — it is the absence of one — and an issue that says
  // "unexpected deprecations" over a list of things that stopped being
  // deprecated sends the reader looking for a package that is not there.
  const lines = [
    withFindings.length > 0
      ? '## Unexpected deprecations in generated workspaces'
      : '## Deprecation waivers that no longer match anything',
    '',
    `Generated ${new Date().toISOString().slice(0, 10)} from a real install of each matrix row.`,
    '',
  ];

  if (withFindings.length > 0) {
    lines.push(
      'Each package below is one this generator writes into a generated manifest ' +
        'itself, and is not a required peer of anything it installs — so it is ' +
        'removable here, in this repo. Transitive deprecations are listed at the ' +
        "end as context; they are not this repo's to fix.",
      '',
    );
  }

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
      '### Waivers whose package has left the tree',
      '',
      'These are listed in `EXPECTED`, but no row declares the package any more —',
      'not merely "it stopped warning", which is reported separately and is not a',
      'reason to delete anything. An exemption for a package nothing installs is',
      'surface for nothing; delete them.',
      '',
      ...stale.map((entry) => `- \`${entry.package}\` — waived because: ${entry.reason}`),
      '',
    );
  }

  if (dormant.length > 0) {
    lines.push(
      '### Waivers that are still needed but stopped warning',
      '',
      'The package is still a direct entry in a generated manifest, but the',
      'registry no longer reports it deprecated. **Do not delete these.** An',
      'upstream release that forgot to run `npm deprecate` looks exactly like one',
      'that undeprecated on purpose, and if the marker comes back to an entry that',
      'has been deleted the nightly goes red with no warning and nothing changed',
      'here. Confirm against the `revisitWhen` below before touching them.',
      '',
      ...dormant.map(
        (entry) =>
          `- \`${entry.package}\` — required peer of \`${entry.peerOf}\`. ` +
          `_Revisit when: ${entry.revisitWhen}_`,
      ),
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
