# Contributing

Thanks for helping. Bug reports, policy patches and fixes for upstream drift
are the most useful contributions. The generator's value is staying correct as
Angular, Storybook, Capacitor and the advisory database change around it.

## Setup

Node ≥ 24.8 and npm ≥ 11.6. 24.8 is the first Node whose bundled npm clears that
floor; on anything older, `allowScripts` and `--strict-allow-scripts` are
accepted and ignored.

```bash
npm ci --strict-allow-scripts
npm run build
npm test                # unit + schematic tests (builds first)
```

`--strict-allow-scripts` is how CI installs, and it fails on any install script
not in the root `allowScripts`. If a dependency you add needs one, add it there
in the same change and say why.

## Before opening a pull request

```bash
npm run typecheck
npm run format:check    # npm run format to fix
npm test
npm run e2e:minimal     # generate, install, build and audit one real workspace
```

CI runs all four on every pull request. The full matrix (`npm run e2e`) takes
several minutes per row and runs nightly, so run it locally only when your change
affects a row other than `minimal`: mobile, marketing, the ui library or codegen.

Schematic changes need a test in
[`test/schematics.spec.ts`](packages/angular-capacitor-workspace/test/schematics.spec.ts),
run against real `@schematics/angular` output rather than a hand-built tree.
If a patch cannot find what it expects, it should throw and name that thing,
not do nothing.

## Patching the dependency policy

Most policy changes are an edit to
[`src/policy/advisories.ts`](packages/angular-capacitor-workspace/src/policy/advisories.ts)
and nothing else. When `audit` reports an unhandled advisory, it prints a
ready-to-paste entry at the tier it recommends. Start from that.

- Use the strongest tier that works: prune before override, override before
  floor, and accept only when nothing else applies.
- Scope overrides under the package that pulls in the bad version, never
  at the top level.
- Write the evidence in `reason`: the dependency path, what you ran and what
  `npm audit` reported afterwards. A reviewer should be able to check it
  without redoing the investigation.
- Tier 4 (accept) entries need a review date. The build fails once that date
  has passed.

`npm run sweep` audits every matrix row against today's advisories, which is
the quickest way to check that a patch works everywhere it should.

## Versioning

The major version is the Angular major the package generates for: 22.x is
Angular 22. Both packages are released together at the same version, and
[`test/release-line.spec.ts`](packages/angular-capacitor-workspace/test/release-line.spec.ts)
fails if they drift apart. Policy patches for an older Angular major go to its
maintenance branch.

Because the major belongs to Angular, a change that breaks consumers within a
line lands as a minor — dropping a supported Node, say. Every release gets a
[`CHANGELOG.md`](CHANGELOG.md) entry; commit messages stay short and point
there.

## Releasing

A release is a tag. Promote `## [Unreleased]` to `## [x.y.z] — <date>`, add its
compare link at the foot of the file, set the version in the root manifest and
in both packages — including the exact `angular-capacitor-workspace` pin in
`create-angular-capacitor-workspace` — and commit. Then:

```bash
git tag v22.2.0
git push origin main v22.2.0
```

[`.github/workflows/release.yml`](.github/workflows/release.yml) does the rest.
It checks that the tag names the version the tree agrees on and that the
changelog has a section for it, runs the CI gate against the tag rather than
trusting that main was green, publishes the generator and then the `create-*`
shell with provenance, and opens the GitHub release from that changelog
section. A `v22.2.0-rc.1` tag publishes under `next` rather than `latest`.

The publish needs an `NPM_TOKEN` secret: a granular automation token with write
access to both packages, and automation rather than publish so that no 2FA
prompt waits for an answer nobody is there to give. It is the one step here
that cannot be undone, so it runs in the `npm` environment — add a required
reviewer to that environment to hold it for approval.

If a run dies between the two publishes, re-run it from the tag rather than
moving the tag. Each step skips what the registry already has.

## Licence

Contributions are accepted under the project's [MIT licence](LICENSE). Each
package directory contains a copy of the root `LICENSE`, because npm only
publishes the one in the package's own directory. If you edit the licence,
update all three; the release-line test checks that they match.
