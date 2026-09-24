import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = join(dirname(dirname(fileURLToPath(import.meta.url))), 'deprecation-issue.mjs');
const ALL_ROWS = ['minimal', 'full', 'multi-app', 'lib-only'];

const WAIVED = [
  {
    package: '@angular-devkit/build-angular',
    version: '22.1.8',
    message: 'webpack deprecated',
    direct: true,
    waiver: {
      peerOf: '@storybook/angular',
      reason: 'required peer',
      revisitWhen: 'storybook moves',
    },
  },
  {
    package: '@angular/platform-browser-dynamic',
    version: '22.1.7',
    message: 'use platform-browser',
    direct: true,
    waiver: {
      peerOf: '@storybook/angular',
      reason: 'required peer',
      revisitWhen: 'storybook moves',
    },
  },
];

let reports;
let out;

beforeEach(() => {
  reports = mkdtempSync(join(tmpdir(), 'acw-reports-'));
  out = join(reports, '..', `issue-${Date.now()}.md`);
});

afterEach(() => {
  rmSync(reports, { recursive: true, force: true });
  rmSync(out, { force: true });
});

/** Every package a row with Storybook declares that this check cares about. */
const STORYBOOK_DIRECT = [
  '@angular-devkit/build-angular',
  '@angular/platform-browser-dynamic',
  '@storybook/angular',
];

/** One row's report, as `matrix.mjs --deprecation-json` writes it. */
function writeRow(row, deprecations, { selected = [row], direct = STORYBOOK_DIRECT } = {}) {
  writeFileSync(
    join(reports, `deprecations-${row}.json`),
    JSON.stringify({ selected, allRows: ALL_ROWS, rows: [{ row, deprecations, direct }] }),
  );
}

function empty() {
  return { findings: [], waived: [], transitive: [] };
}

function run(directory = reports) {
  const result = spawnSync(process.execPath, [script, directory, '--out', out], {
    encoding: 'utf8',
  });
  return {
    code: result.status,
    output: `${result.stdout}${result.stderr}`,
    filed: existsSync(out),
  };
}

describe('exit codes', () => {
  // The workflow branches on these: it files an issue only when a body exists,
  // and fails the run on any non-zero. Changing them changes the nightly.

  it('is clean and files nothing when every row reported and nothing is unexpected', () => {
    writeRow('minimal', empty(), { direct: ['@angular/core'] });
    for (const row of ['full', 'multi-app', 'lib-only']) {
      writeRow(row, { findings: [], waived: WAIVED, transitive: [] });
    }

    expect(run()).toMatchObject({ code: 0, filed: false });
  });

  it('writes a body and exits 1 on an unexpected deprecation', () => {
    writeRow('full', {
      findings: [
        {
          package: '@angular/animations',
          version: '22.1.7',
          message: 'Use `animate.enter` instead.',
          direct: true,
        },
      ],
      waived: WAIVED,
      transitive: [],
    });

    expect(run()).toMatchObject({ code: 1, filed: true });
  });

  it('exits 2 without a body when no row reported at all', () => {
    // A broken nightly, not a clean one — and the missing body is what stops the
    // workflow filing an issue about nothing.
    expect(run()).toMatchObject({ code: 2, filed: false });
  });

  it('exits 2 without a body when the reports directory does not exist', () => {
    expect(run(join(reports, 'nope'))).toMatchObject({ code: 2, filed: false });
  });
});

describe('staleness across rows', () => {
  it('does not judge a waiver on a partial run', () => {
    // `minimal` forces no Storybook peer, so both waivers are legitimately
    // absent. Calling them stale here would train everyone to ignore this.
    writeRow('minimal', empty(), { direct: ['@angular/core'] });

    const result = run();
    expect(result.code).toBe(0);
    expect(result.output).toContain('partial run');
  });

  it('reports a waiver whose package no row declares any more', () => {
    writeRow('minimal', empty(), { direct: ['@angular/core'] });
    for (const row of ['full', 'multi-app', 'lib-only']) {
      writeRow(
        row,
        { findings: [], waived: [WAIVED[0]], transitive: [] },
        // @angular/platform-browser-dynamic is gone from the manifest: the
        // waiver really is surface for nothing.
        { direct: ['@angular-devkit/build-angular', '@storybook/angular'] },
      );
    }

    const result = run();
    expect(result).toMatchObject({ code: 1, filed: true });
    expect(result.output).not.toContain('partial run');
  });

  it('stays green when a waived package stops warning but is still declared', () => {
    // The 2026-09-24 nightly. Angular 22.2.0 shipped without the `deprecated`
    // markers its whole line had carried, so every row reported an empty
    // `waived` list while still declaring both packages. Nothing in this repo
    // changed and nothing here is actionable, so this must not file an issue —
    // the old check called both waivers stale and told the nightly to delete
    // them, which would have armed the trap for the day the markers returned.
    writeRow('minimal', empty(), { direct: ['@angular/core'] });
    for (const row of ['full', 'multi-app', 'lib-only']) {
      writeRow(row, empty());
    }

    const result = run();
    expect(result).toMatchObject({ code: 0, filed: false });
    expect(result.output).toContain('2 dormant');
  });

  it('will not judge staleness from rows that recorded no direct dependencies', () => {
    // A report written before `direct` existed cannot say whether the package is
    // still in the tree, and reading the silence as absence is the conflation
    // this check was changed to avoid.
    for (const row of ALL_ROWS) {
      writeFileSync(
        join(reports, `deprecations-${row}.json`),
        JSON.stringify({
          selected: [row],
          allRows: ALL_ROWS,
          rows: [{ row, deprecations: empty() }],
        }),
      );
    }

    const result = run();
    expect(result).toMatchObject({ code: 0, filed: false });
    expect(result.output).toContain('staleness not assessed');
  });

  it('reads the rows from nested artifact directories', () => {
    // download-artifact can land each row in its own folder depending on how it
    // is configured; the merge must not depend on that.
    mkdirSync(join(reports, 'deprecations-full'));
    writeFileSync(
      join(reports, 'deprecations-full', 'deprecations-full.json'),
      JSON.stringify({
        selected: ['full'],
        allRows: ALL_ROWS,
        rows: [{ row: 'full', deprecations: { findings: [], waived: WAIVED, transitive: [] } }],
      }),
    );

    expect(run().code).toBe(0);
  });
});
