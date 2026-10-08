# angular-capacitor-workspace

A generator for Angular 22 workspaces that ship as a web app, a Capacitor mobile
app, a prerendered marketing site and shared libraries — wired together with
Storybook, Vitest browser tests, Playwright, and an optional OpenAPI codegen
step.

```bash
npm create angular-capacitor-workspace@latest my-workspace
```

Two packages, one repo, following the `create-vite` / `vite` precedent:

| Package                                                                             | Contains                                                              | Entry                                           |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------- |
| [`angular-capacitor-workspace`](packages/angular-capacitor-workspace)               | the schematics, the dependency policy, the gate, the programmatic API | `ng add`, `ng generate`, `npx … audit\|doctor`  |
| [`create-angular-capacitor-workspace`](packages/create-angular-capacitor-workspace) | argv, prompts, the `ng new` bootstrap                                 | `npm create angular-capacitor-workspace@latest` |

## Usage

Requires Node ≥ 24.8 and npm ≥ 11.6, the first npm with the install-script
allowlist that generated workspaces depend on. 24.8 is the first Node whose
bundled npm clears that floor — no Node 22.x ever did, and on an older npm
`allowScripts` and `--strict-allow-scripts` are accepted and silently ignored.
Mobile targets also need a native toolchain: a JDK and the Android SDK for
Android, macOS with Xcode for iOS.

### Create a workspace

With no flags it asks what to generate. With flags it asks nothing, which is
the form for scripts and CI. The flags go after `--`, or npm keeps them for
itself:

```bash
npm create angular-capacitor-workspace@latest acme -- \
  --app storefront --mobile android,ios \
  --app admin \
  --marketing site --marketing-origin https://acme.example \
  --ui-lib ui --e2e playwright --with cdk --i18n en,fr
```

That gives:

```
acme/
  projects/
    storefront/web/        Angular app, client-rendered
    storefront/mobile/     its Capacitor shell, an npm workspace member
    admin/web/             a second app, web only
    site/web/              marketing site, prerendered to static HTML
                           (once per language, with --i18n)
    ui/                    design-system library, with Storybook
  playwright.base.ts       shared Playwright config the apps extend
  AGENTS.md                house rules
  README.md                first run, and a table of every script
```

Every flag is listed in the
[create package's README](packages/create-angular-capacitor-workspace/README.md#options).
Add `--dry-run` to see the file list and the audit result without writing
anything.

### Work in it

```bash
cd acme
npm start storefront              # serves an app; there is no default, so name one
npm test                          # every unit-test suite, once
npm run build                     # every app; the site's build also checks its SEO
npm run build site                # one project; so do test, e2e and watch
npm run e2e                       # every Playwright suite
npm run storybook                 # the ui library in isolation
```

Each app, site and mobile shell keeps its own scripts in its own
`package.json`, an npm workspace member, so the root manifest names no project
and stays the same however many there are. `start`, `watch`, `build`, `test` and
`e2e` take the project as an argument, through `scripts/project.mjs`; anything
else a project has runs with `-w`, such as
`npm run run:android -w @acme/storefront-mobile`. The generated README lists
every script the workspace has. The native Android and iOS projects are added
by hand, once per platform; see
[Mobile](packages/angular-capacitor-workspace/README.md#mobile).

### Grow it

The schematics stay installed, so everything `create` can generate can also be
added later:

```bash
ng generate angular-capacitor-workspace:app back-office
ng generate angular-capacitor-workspace:mobile admin --platforms android
ng generate angular-capacitor-workspace:theming
ng generate angular-capacitor-workspace:codegen
ng generate angular-capacitor-workspace:i18n --locales en,fr
ng generate angular-capacitor-workspace:packages cdk
```

Theming, translation and the curated packages are plugins: they extend every
project already there and every one generated after them, so a workspace grown
one `ng generate` at a time matches one generated in a single run. Codegen reads the OpenAPI document from `OPENAPI_SPEC`; see
[API client](packages/angular-capacitor-workspace/README.md#api-client). To bring
an existing Angular workspace under the policy, run
`ng add angular-capacitor-workspace`.

### Keep it audit-clean

```bash
npm run audit:policy                            # fail on any advisory the policy does not cover
ng update angular-capacitor-workspace@22        # newer policy patches, and fixes to generated files
npx angular-capacitor-workspace doctor --fix    # apply the policy to this workspace
```

`ng update` runs the release's migrations, which fix files an earlier release
generated and print the change to make by hand in any file you have edited. A
plain `npm install` runs none;
`ng update angular-capacitor-workspace --migrate-only --from=<old version>` runs
them afterwards.

The [schematics package README](packages/angular-capacitor-workspace/README.md)
covers every schematic, the `audit` and `doctor` output, and the programmatic
API.

## What this is for

`ng new` already emits a correct Angular 22 app. What it does not emit is the
_workspace shape_: an app split into `web/` and `mobile/` siblings, a marketing
app configured for static prerendering while the SPA stays client-only, a shared
Playwright base, a design-system library with browser-mode tests and a contrast
checker.

Nor a first screen that shows any of it. A generated app opens on its design
system rather than on the Angular splash: light, dark and three palettes, a
toggle in the shell, and every colour on the page resolving through tokens that
`check:contrast` has verified in both modes. Switching is two attributes on
`<html>`, so nothing re-renders — and the preference is applied before the first
paint rather than a beat after it. `--no-theming` leaves the toggle out and the
apps following the system's light or dark; without `--ui-lib` the app gets the
same shell in system colours, with nothing to switch.

And it does not emit a **dependency policy**. A generated workspace should be
audit-clean on the day it is generated, and should tell you when it stops being
so. That is most of what this package is.

## The remedy ladder

Every advisory gets the strongest remedy that applies, and the ordering is the
point — overriding a package you could have declined to install is weaker than
not installing it.

| Tier | Remedy                          | Applies when                             | Live example                              |
| ---- | ------------------------------- | ---------------------------------------- | ----------------------------------------- |
| 1    | **Prune** — never install it    | the dependency is unused or optional     | `express` in a static marketing workspace |
| 2    | **Override** — pin a transitive | a real dependency drags in a bad version | `xcode → uuid`, `json-magic → undici`     |
| 3    | **Floor** — raise a minimum     | the direct range permits a bad version   | `vitest ^4.0.8` → `^4.1.11`               |
| 4    | **Accept** — record and expire  | no fix exists and the path is dev-only   | `braces`, on the webpack Storybook only   |

Tier 4 entries carry a review date, and an expired one fails the build. An
accepted advisory that nobody revisits is how a workspace quietly rots. An entry
can be scoped with `onlyWhen`, so one kept for older workspaces fails only them.

The whole policy is one data-only file:
[`src/policy/advisories.ts`](packages/angular-capacitor-workspace/src/policy/advisories.ts).
Patching a new advisory is an edit there plus a release.

### What pruning cannot fix

The plan this repo was built from assumed the `@angular-devkit/build-angular`
advisory chain could be pruned, on the grounds that nothing uses it. Measuring
it said otherwise, and the correction shaped the design:

- A stock Angular 22.1.8 workspace — `ng new` plus `ng generate application` —
  installs **no** `@angular-devkit/build-angular` at all and audits clean. The
  prune rule is real, but it is guarding against something that is no longer
  the default.
- `@storybook/angular@10.6` declares `@angular-devkit/build-angular`,
  `/core` and `/architect` as **required** peers. Any workspace with a design
  system gets them back, whatever the manifest says, and with them
  `webpack-dev-server → sockjs → uuid@8`.

So a prune rule needs to know when it does not apply. Each one carries
`unlessUsing` guards naming the conditions under which the package is
legitimate, and with Storybook on, the ladder escalates to Tier 2. Both paths
end at `found 0 vulnerabilities`; only one of them is available.

The chain did not stay patchable. By October 2026 it ended in `braces`, with no
fixed release to pin, and the policy had to accept it — 7 high in every plain
`npm audit`, one advisory counted once per package on the path. The fix was to
change frameworks: the design system now uses `@storybook/angular-vite`, which
builds on `@angular/build` and declares no `build-angular` peer at all, so the
prune rule now fires with Storybook on as well. The guard that keeps the package
is the webpack framework's own builders in `angular.json`, which is what
workspaces generated before the switch still have.

## Layout

```
packages/
  angular-capacitor-workspace/       schematics, policy, gate, CLI
    src/policy/advisories.ts         ← the file you patch
    src/policy/versions.ts           ← pins for what ng new does not choose
    src/catalog.ts                   ← the packages --with knows how to wire in
    src/migrations.json              ng update fixes for files a release wrote
    src/gate/                        lockfile resolve + npm audit + proposals
    src/style.ts                     the terminal palette both CLIs print with
    src/schematics/                  the hosts: workspace, app, marketing,
                                     ui-lib, mobile, ng-add
    src/plugins/                     theming, codegen, i18n, packages, and the
                                     registry that runs them
    src/extend/                      the extension points plugins edit hosts through
    src/cli/                         audit, doctor
  create-angular-capacitor-workspace/
    src/                             argv, prompts, bootstrap
e2e/
  rows.mjs                           the matrix rows, shared by the two below
  matrix.mjs                         generate → install → build → test → audit
  sweep.mjs                          daily advisory sweep, opens an issue
  deprecations.mjs                   which deprecations are ours to fix
  deprecation-issue.mjs              merges the rows into one issue
scripts/
  sync-versions.mjs                  reports pins that have moved
  bump.mjs                           writes the next version everywhere
  check-release.mjs                  checks a release tag against the tree
  create-local.mjs                   npm run create: a workspace from this checkout
  pack-self.mjs                      packs the schematics for the above
```

## Development

```bash
npm install
npm run build
npm test                # unit + schematic tests (builds first)
npm run e2e:minimal     # one matrix row against the real registry
npm run e2e             # the full matrix — minutes per row
npm run sweep           # audit every row against today's advisories
npm run sync-versions   # report pins that have moved
```

### How this is tested

Unit tests over the policy and the JSON patches are cheap and worth having, but
they are not what keeps this working. What breaks a generator is upstream:
Angular renaming an option, Storybook changing a peer range, a new advisory
landing three levels down. None of that is visible from an in-memory tree.

So the load-bearing test is `e2e/matrix.mjs` — generate, install, build, test
and audit for real, in a temp directory, against the live registry:

| Row         | Apps | Mobile       | Marketing | ui  | theming | codegen |
| ----------- | ---- | ------------ | --------- | --- | ------- | ------- |
| `minimal`   | 1    | —            | —         | —   | —       | —       |
| `full`      | 1    | android      | 1         | yes | yes     | yes     |
| `multi-app` | 2    | android, ios | 2         | yes | —       | —       |
| `lib-only`  | —    | —            | —         | yes | yes     | —       |

The minimal row runs on every PR; the full matrix runs nightly alongside the
advisory sweep. Nightly rather than on-merge because the failures it catches
arrive on wall-clock time rather than on commits.

### Deprecations

An advisory has a severity, a vulnerable range and a remedy, which is what makes
the four-tier ladder possible. A deprecation has none of those — it is one
maintainer's opinion, published on their schedule, and often with no move
available at all. So generated workspaces never gate on one, and neither does
any pull request here.

The nightly matrix does, but only for the narrow case that is always actionable:
a deprecated package **this generator itself writes** into a manifest, that npm
does not put back as a required peer. That rule can never be permanently red,
because anything it reports can be fixed in this repo on the day it appears.

Everything else is reported as context. A generated workspace carrying Storybook
installs three deprecated packages today, none of them written by this
generator: `@angular/animations`, a required peer of `@storybook/angular-vite`,
and two native bindings underneath `ng-packagr`. Nothing here can reach them,
and `e2e/deprecations.mjs` has nothing to waive.

A generated workspace depends on `angular-capacitor-workspace` — that is what
keeps `audit:policy`, `doctor` and `ng generate` working after generation. Before
publication that version does not exist on the registry, so the matrix `npm
pack`s the local build and passes `--self-spec file:…`. It tests the tarball that
would ship rather than something adjacent to it.

## Status

Every milestone of the plan this repo was built from is implemented and
verified against the live registry on Angular 22.1.8 / npm 11.16:

| Milestone                      | Verified by                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| 0 — policy, gate, bootstrap    | all four matrix rows generate and report `found 0 vulnerabilities`                             |
| 1 — workspace overlay          | `workspace` schematic tests; generated root matches the intended shape                         |
| 2 — `app` + Playwright         | `npm run e2e` passes in a generated workspace against a real dev server                        |
| 3 — `ui` library               | `build:libs`, `check:contrast` (22 pairings × 2 modes) and `test:storybook` pass               |
| 4 — `mobile`                   | `sync:shop:android` builds and syncs the real bundle into `android/app/src/main/assets/public` |
| 5 — `marketing`                | `ng build` emits prerendered HTML and no server bundle                                         |
| 6 — `codegen`                  | the client generated from `e2e/fixtures/sample-openapi.yaml` compiles                          |
| 7 — `doctor` / `audit` / sweep | an aged workspace reports three drifts; `--fix` applies them and re-runs clean                 |

Two caveats worth stating plainly:

- **`sync:android` is verified as far as the SDK-free path goes.** `cap add
android` and `cap sync android` run and place the built bundle correctly.
  Compiling the APK needs a full Android SDK and is not exercised here; the
  shell's generated `preflight` script checks for one.
- **The `globalThis.global` polyfill entry is not emitted.** The plan called for
  it "only when a dependency needs it", and nothing in the generated dependency
  set does. A mechanism with no trigger would be dead code; add it alongside the
  dependency that needs it.

### Open questions from the plan

- **Registry.** Decided: public npm, from the public repository at
  [karimaounn/angular-capacitor-workspace](https://github.com/karimaounn/angular-capacitor-workspace).
  Both `angular-capacitor-workspace` and `create-angular-capacitor-workspace`
  were unclaimed on npm as of 2026-09-19.
- **`auth`.** Out of scope, as instructed. Nothing in the generated tree assumes
  an identity provider.
- **Angular 23.** Decided: branch. The package's major is the Angular major it
  generates for, so 23.0.0 ships with Angular 23 and policy patches for Angular
  22 workspaces continue as 22.x from a maintenance branch. `ANGULAR_LINE` in
  `src/policy/versions.ts`, the package version, the `@angular/core` peer and
  the `@schematics/angular` range must agree; `test/release-line.spec.ts`
  enforces it.

## Design notes

**Overlay, don't template.** Every app and library is generated by
`externalSchematic('@schematics/angular', …)` and then patched. A frozen copy of
Angular 22.1's output drifts from 22.6's within a quarter; delegating means only
the patch needs checking, and the matrix is what says it needs checking.

**Patches fail loudly.** JSON edits go through `jsonc-parser` so comments and
formatting survive, and a patch that cannot find its anchor throws with the name
of what it expected. A silent no-op produces a workspace that builds and is
subtly wrong, which is worse than a crash during generation.

**`allowScripts` is an allowlist.** npm ≥ 11.6 can block dependency install
scripts, and generated workspaces block everything not named. Generated CI runs
`npm ci --strict-allow-scripts`, which turns a new transitive postinstall into a
decision someone makes rather than code that quietly ran. It is the one rung
that is preventative rather than reactive.

**No prompt library.** `create-angular-capacitor-workspace` has exactly one
runtime dependency — the schematics package. The prompts, arrow-key lists
included, are one file over `node:readline` and raw stdin. A generator arguing
that the strongest remedy is not installing the package should take its own
advice.

## Contributing

Issues and pull requests are welcome; [CONTRIBUTING.md](CONTRIBUTING.md) covers
the setup, the tests a change needs and how to patch the policy. Report
vulnerabilities in this package privately, as described in
[SECURITY.md](SECURITY.md).

## Licence

[MIT](LICENSE) © 2026 Karim Aoun.
