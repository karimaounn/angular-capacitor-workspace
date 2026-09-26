# Changelog

Both packages are released together at the same version. The major is the
Angular major they generate for — 22.x is Angular 22 — so a breaking change
within a line lands as a minor. See [Versioning](CONTRIBUTING.md#versioning).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **`--with aria` adds [Angular Aria](https://angular.dev/guide/aria/overview)**,
  the WAI-ARIA patterns as headless directives — listbox, combobox, select,
  multiselect, autocomplete, menu, menubar, toolbar, accordion, tabs, tree,
  grid — at a range resolved against the Angular line, declared as a peer of
  every library in the workspace, with a README section on it.

  It is the catalog's natural second entry: this generator's reason to exist is
  a design-system library with a Storybook and a contrast checker in front of
  it, and Aria is the accessibility half of that library without a single
  opinion about how it looks.

  `--with aria` brings `cdk` with it. `@angular/aria` peers `@angular/cdk` at an
  _exact_ version, so the two have to come out of one resolution rather than
  from npm's peer auto-install, which writes a range nobody chose. Catalog
  entries can now declare `requires`, and every consumer — the manifest, the
  library peers, the generated README, the `pkg:` feature tokens — sees the
  expanded set rather than the part that was typed.

### Changed

- **`--help` bullets the `--with` catalog.** One unmarked row indented under the
  option's description read as the description continuing; two of them would
  have read as prose. The summaries still line up with every other description
  in the help, with the bullet hanging into the gutter to their left.

## [22.4.0] — 2026-09-24

### Added

- **More than one marketing site per workspace.** `--marketing` is now
  repeatable, the way `--app` is, and `--marketing-origin` binds to the
  `--marketing` before it rather than to the workspace — so
  `--marketing site --marketing-origin https://acme.example --marketing docs
--marketing-origin https://docs.acme.example` gives each site its own set of
  canonical URLs. The interactive run asks "Add another marketing site?" after
  the first, like it already did for applications.

  The `marketing` schematic already supported being run twice; what did not was
  everything upstream of it. A product site and a docs site are two sets of
  pages sharing a design system, and a flag that took one answer sent the
  second one to a second repository. Each site gets its own project, dev-server
  port, `start:`/`build:`/`test:` scripts and entry in `npm run build`, while
  sharing the `scripts/` postbuild checks and the AGENTS.md section.

### Fixed

- **Every per-project script now builds the libraries first.** The root
  `prestart`, `pretest` and `prebuild` hooks cover `npm start`, `npm test` and
  `npm run build` — and nothing else. Each project adds four entry points of
  its own, and in a workspace that imports libraries from `dist/` all four fail
  on a fresh clone: `start:<app>`, `test:<app>` and `e2e:<app>` on an import
  that resolves to a directory nothing has created, `build:<app>` in Sass on
  the same path. Only `prebuild:<app>` was hooked.

  npm hooks each entry point under its own `pre` name, which is the only place
  a fix can go, so the app, marketing and mobile schematics now write all four
  — and only the ones a project actually has, and only once `build:libs`
  exists. The library schematic retrofits the same hooks onto every app already
  in the workspace, which is every app when `ng add` brings a design system
  into one that was generated without it.

### Changed

- **`GenerateOptions.marketing` is a list.** It was `marketing?: string` with a
  separate `marketingOrigin?: string`; it is now
  `marketing?: { name: string; origin?: string }[]`, mirroring `apps`, and
  `marketingOrigin` is gone — an origin belongs to a site, not to a workspace.
  Callers of the programmatic API pass `marketing: [{ name: "site" }]`. The
  `marketing` schematic's own options are unchanged.

- **A mobile app writes its setup into the root README.** Adding a platform
  used to be a sentence in the scripts table pointing at `npx cap add`, with
  the order that works left implicit — `cap add` ends by syncing the web build
  into the project it just created, so it fails outright until that build
  exists. The `mobile` schematic now appends a numbered block per app under a
  `## Mobile` heading: preflight, then the web build, then `cap add` per
  platform, then the one command that builds, syncs and runs. The section
  markers ship in the workspace template unconditionally, so a workspace with
  no mobile app renders nothing between them and one that gains an app later
  still has an anchor to write into.

- **The generated README rewritten.** It states the Node and npm floor before
  `npm install` — below the npm floor the `allowScripts` allowlist is accepted
  and silently ignored, so the workspace looks gated and is not, and both
  numbers are read from the same `engines` block the workspace declares. The
  layout tree names what each directory is, the theming section points at real
  paths under the design system rather than paths relative to nothing, the
  scripts table moves last, and a new "Adding to this workspace" section lists
  the schematics that extend it.

## [22.3.2] — 2026-09-24

### Fixed

- **Generation no longer dies in the audit gate on an unsatisfiable vitest
  peer.** `@angular/cli` 22.2 moved the range `ng new` emits from
  `vitest: ^4.0.8` to `^5.0.0`, and the library schematic deferred to whatever
  the CLI had written. `@vitest/browser-playwright` peers vitest at an exact
  version, not a range, so the tree asked for vitest 5.0.1 and for the provider
  that peers 4.1.11 — npm refused it, the gate could not resolve a lockfile, and
  nothing was installed.

  Both are now pinned to 5.0.1, exact, and the schematic writes its pin over the
  emitted range rather than around it. The pair is one decision in two places,
  so any CLI release is free to move vitest without taking generation with it. A
  test asserts the two pins name the same exact version, and another asserts the
  generated manifest carries the pin and not the range Angular emitted.

  The Tier 3 floor at `vitest ^4.1.11` (GHSA-82fw-gwwq-j7x9) stays for
  workspaces still on the 4.x line. The 5.x line is unaffected and sits above
  it, and `@angular/build:unit-test` peers `^4.0.8 || ^5.0.0`, so `doctor` has
  nothing to raise in a workspace generated from here on.

- **`@types/node` now types the Node the workspace actually requires.** It was
  delegated to Angular's `latestVersions`, on the reasoning that applies to
  everything Angular has an opinion about. But Angular's opinion here is the
  floor its own tooling supports — `^20.17.19` on the 22.1 line — while a
  generated workspace declares `engines.node >= 24.8.0`. Every workspace with an
  e2e suite or a server target was being type-checked against a Node it refuses
  to run.

  vitest 5 turned that from wrong into fatal: it peers
  `@types/node: ^22.0.0 || >=24.0.0`, which `^20` cannot satisfy, so the audit
  gate could not resolve a lockfile for any workspace with a marketing app or
  Playwright. The range is now pinned at `^24.13.6`, and a test ties its major to
  the `engines.node` floor rather than to a literal.

  The pin alone is not enough, because Angular's `server` schematic writes
  `@types/node` after the overlay has run. A Tier 3 floor does the rest: the
  policy is applied after the whole overlay, and it is the only rung that also
  repairs workspaces already generated with `^20` — `npx angular-capacitor-workspace doctor --fix`
  raises it in place.

## [22.3.1] — 2026-09-24

### Changed

- **An answered question in `create-angular-capacitor-workspace` now reads as an
  answer.** The mark turns from a cyan `?` to a green `✓`, the answer moves up
  beside the question in cyan, and the `(default)` hint is dropped — whatever it
  offered has by then been decided. The list prompts already left their answer
  behind this way; the typed ones left a column of question marks standing next
  to hints, with the answers underneath in whatever colour the terminal echoed
  them, so a finished run scrolled back as a list of things that looked unasked.

  Pressing Return now shows the default as the answer rather than nothing at
  all. A transcript that leaves the accepted defaults blank cannot be told apart
  from one nobody answered, which is the transcript people paste into an issue.
  `confirm` shows `Yes` or `No` rather than the bare `y` that was typed, for the
  same reason the list prompts show labels and not values.

  The redraw walks back over exactly the rows the question occupied, counting
  the wrapping the terminal did, so a long question or a long answer on a narrow
  terminal collapses as cleanly as a short one.

- **A rejected answer no longer gets a green check.** `text` takes an optional
  `validate`, and the production URL question passes its origin parsing into it.
  The reason is shown against the question itself, after the hint, and the
  question is then asked again in the same two rows. It used to be answered,
  checked afterwards, and then asked again below the complaint about it, which
  left the screen carrying two copies of the question with only the lower one
  live. A required question left empty re-asks in place for the same reason.

### Fixed

- **The `›` cursor no longer vanishes as soon as anything is typed.** It was
  written before handing the line to `readline`, which repaints the line it owns
  from the first column on every keystroke and so wiped it — the answer ended up
  in a column nothing had accounted for. It is now passed to `rl.question()`, so
  readline repaints it along with the rest.

- **Piped runs echo the answer they took.** Off a terminal nothing echoes stdin,
  so every question in a CI log ended on a bare `› ` and the log recorded which
  questions were asked but not how they were answered — including which defaults
  a scripted run had silently accepted.

## [22.3.0] — 2026-09-23

### Added

- **Generated apps open on their own design system instead of the Angular
  welcome page.** The app schematic now replaces `app.html`, `app.scss`,
  `app.ts`, `app.spec.ts` and `app.routes.ts` with a shell — skip link,
  landmarks, a lazy starter route — and, when the workspace has a `ui-lib`, a
  starter page that renders the library's components, its semantic tokens and a
  theme toggle. Angular's splash is meant to be deleted; shipping it unchanged
  left the two most visible things this generator adds invisible until somebody
  opened a library they had no reason to open yet. Without a `ui-lib` the same
  shell is emitted in system colours, with nothing to demonstrate and nothing to
  switch — a starter page that silently drops half its content is worse than one
  that never claimed to have it.

- **Three palettes, switchable at runtime, and light/dark as a real choice.**
  `_ref.scss` carries `default`, `sand` and `indigo`; `index.scss` emits each
  under `:root[data-palette='…']`, and each of those blocks carries both colour
  schemes. `ThemeService` and `<ui-theme-toggle>` in the library own two
  attributes on `<html>` — `data-theme` and `data-palette` — so a switch is an
  attribute write: nothing re-renders, and no component has to know a theme
  exists.

  `system` is the default mode and is expressed by _removing_ `data-theme`
  rather than by writing the resolved value, which is the difference between a
  preference and a decision: with the attribute absent, a visitor who changes
  their OS theme with the page open sees the page follow.

  Each app's `index.html` gained a small inline script that applies the stored
  preference before the first paint. There is no way to do this from Angular —
  by the time any framework code runs the first frame is on screen — so without
  it every load starts in the system scheme and flips a moment later, for
  exactly the users who asked it not to.

- **`--accent`, a brand colour that is not `--info`.** The primary button and
  the focus ring used `--info`, which meant a palette swap changed the neutrals
  and left the main action identical in every theme. They are now separate
  ramps: `--accent` travels with the palette, `--info` keeps meaning
  "informational". `--accent` fills a control and carries `--on-accent`;
  `--accent-strong` is the step that contrasts with the page and is what
  accent-coloured text uses, including links — which previously used `--info`
  and were never in the contrast table.

  `check:contrast` checks the new pairings across every palette in both modes,
  and now also fails when `PALETTES` in `theme.ts` and `$palettes` in
  `_ref.scss` disagree. Two sources of truth with nothing in the type system
  between them: a palette in the picker with no block behind it is a toggle that
  does nothing, and a palette in the styles the picker never offers is a theme
  nobody can reach.

### Fixed

- **Applications never loaded the design system's stylesheet.** The include path
  was wired into `angular.json` and the tokens were built and published, but
  nothing ever wrote the `@use` — so every `var(--surface)` in the library
  resolved to nothing and the components rendered unstyled in every generated
  workspace. The `app` and `marketing` schematics now write the import, and
  `ui-lib` retrofits it onto apps that predate it. `prebuild` joins `prestart`
  and `pretest` in running `build:libs`, since a build from a fresh clone would
  otherwise fail in Sass.

- **A forced colour scheme left form controls and scrollbars in the other one.**
  `color-scheme: light dark` hands those to the OS preference, which is no
  longer the answer once a toggle has overridden it. `html[data-theme]` now
  pins it.

### Changed

- **`--with cdk` now wires the CDK's overlay stylesheet into every application**,
  at the front of `styles` in `angular.json`, instead of telling you to do it in
  the README. The CDK ships `overlay-prebuilt.css` unloaded, and nothing
  anywhere reports its absence: a dialog, menu, tooltip or autocomplete opens
  unpositioned and with no backdrop, which reads as a broken component rather
  than a missing stylesheet. That is 703 bytes gzipped against a failure mode
  that costs an afternoon to trace, and it is not a trade worth leaving to the
  reader. `a11y-prebuilt.css` stays opt-in — only `cdkVisuallyHidden` needs it —
  and the README says how to add it.

  The front of the array, not the end, because `styles` is concatenated in the
  order it is written: appended last, the vendor sheet would beat every
  `.cdk-overlay-*` rule the app wrote to override it, at equal specificity and
  with no warning from anyone.

  This is `ng add`'s setup half without its install half, and the split is
  deliberate. `ng add` installs before it configures, which is the opposite of
  the ordering here — the gate resolves a lockfile and audits it _before_
  anything reaches disk. It also resolves against the default project, and a
  workspace bootstrapped with `--no-create-application` and then filled with
  several apps and a marketing site has no default worth guessing at, so the new
  `appStyles` field applies to every `projectType: application` by name.
  Recorded for the next entry: `@angular/cdk`'s own `ng-add` is a single
  `addDependency` call on a package the manifest already carries, so running it
  would add nothing.

  A project generated _after_ a catalog package was added gets its per-project
  half too. `packages` is a one-shot over the projects that exist when it runs,
  so an app created later would otherwise come up without the stylesheet every
  other app has, and a library created later without a peer it needs before it
  can publish — neither of which reports anything. The `app`, `marketing` and
  `ui-lib` schematics now end by asking what the manifest already carries and
  re-running it, which is the reasoning behind `addStyleIncludePath` applied to
  the other direction: a cheap unconditional pass is what stops the order
  someone generated their projects in from mattering. `doctor` and the
  schematics now share one definition of which catalog packages a workspace
  carries.

  Libraries get no global stylesheet — ng-packagr's build target has no
  `styles` to prepend to — and Storybook does not pick the sheet up — its
  builder runs with no `styles` option on purpose, since `@storybook/angular`
  routes a global sheet into the component-style pipeline where it never reaches
  css-loader. A library component built on an overlay will look unpositioned
  there while working in the app; the generated README carries the `staticDirs`
  and `preview-head.html` snippet that fixes it.

## [22.2.1] — 2026-09-23

### Fixed

- **A release whose publish had worked could still fail the run, and the error
  blamed the wrong thing.** The publish step confirmed each version by asking
  `npm view --prefer-online` for it five times across twelve seconds. npm's
  write path and its read path are separate systems: the read side is
  CDN-fronted, and on the runner it is answered through the npm cache
  `setup-node` restores, so `--prefer-online` revalidates against an edge that
  can still be serving the previous packument. Twelve seconds is not a
  meaningful head start on that. The version the check called missing is on the
  registry carrying a provenance attestation, which only the OIDC publish job
  can mint — the publish was never the part that went wrong.

  The check now asks the registry for the version document directly,
  `https://registry.npmjs.org/<name>/<version>` — 404 until it lands, and no
  local cache stands in front of it — and waits up to three minutes instead of
  twelve seconds. Three minutes costs a passing run nothing. The same check
  replaces the `npm view` behind the "already on the registry — skipping" test
  that makes a re-run idempotent, where a stale packument could have sent the
  job on to republish a version that was already out.

  Its failure message no longer asserts that the registry staged the version.
  Staging is chosen by the client, not imposed on it — `npm publish` sends
  `stage: false` and only `npm stage publish` does otherwise — so that
  diagnosis sent the reader to trusted publisher permissions that were never
  involved. It now says to check the package page first, because the likeliest
  explanation is that the release is fine and the check simply ran out of
  patience.

## [22.2.0] — 2026-09-23

### Removed

- **`@angular/animations` is no longer written into generated workspaces.** It
  was declared alongside the devkit packages on the same "stop npm backtracking"
  reasoning, but it is an _optional_ peer of both `@storybook/angular` and
  `@angular/platform-browser`, so nothing in the tree ever required it and npm
  installed it only because we asked. Angular 22 deprecates the package in
  favour of `animate.enter` / `animate.leave`, so the pin bought one deprecation
  warning on every install and nothing else. Verified against the registry: the
  install still resolves with no ERESOLVE and `npm ls @angular/animations` comes
  back empty.

  Existing workspaces are covered by a `POLICY.prune` entry, so
  `npx angular-capacitor-workspace doctor --fix` removes it. The rule is guarded
  on a new `animations` feature token, inferred from whether the workspace's own
  source imports the package — a workspace that grew a real `provideAnimations`
  call keeps it.

### Changed

- **The steps that take a while now spin while they run.** Generation spends
  nearly all of its wall clock inside four child processes — the Angular
  bootstrap, the lockfile resolve, `npm audit`, and `npm install` — and each of
  them printed one line and then went quiet for anything up to several minutes,
  which on a slow network is indistinguishable from a hang. Each now animates
  beside its label and, when it finishes, leaves the same quiet line behind with
  how long it took.

  The frames are drawn from a worker thread, which is the unusual part and worth
  recording: every one of those steps is a synchronous child process, so a timer
  on the main thread paints one frame and then freezes on it for the whole
  install — an animation that stops exactly when it is needed. A worker has its
  own event loop, and `fs.writeSync(1, …)` reaches the terminal without going
  through the main thread. That also keeps `runGate` synchronous, so no
  published signature moved. No dependency, for the same reason the prompts
  have none.

  Off a terminal — a pipe, `CI`, `TERM=dumb` — nothing is animated and the
  step's line is printed before its work starts, exactly as it always was, so a
  build log still says what is running while it runs and a redirected run is
  byte-for-byte what it was.

- **The interactive questions with a list of options are now answered with the
  arrow keys**, the way `ng new` and every other scaffolder does it: `↑↓` moves,
  `Space` toggles a platform, `Enter` confirms, and a number still jumps
  straight to an option. Picking Android and iOS meant typing `android,ios` —
  asking someone to spell out an option that is already on screen, and to know
  that the answer is comma-separated. Still no prompt dependency: it is raw mode
  and the same handful of escape codes the log already uses.

  Off a terminal — a pipe, a CI job — the questions fall back to being answered
  by number or by name on one line, as before. That path also stopped losing
  piped answers: readline drops the lines that arrive while no question is
  pending, so `printf 'shop\nios\n' | npm create …` used to hang on the second
  question. Lines are now queued as they arrive, and a question with no default
  that runs out of input fails with the question it was stuck on rather than
  asking itself forever.

### Added

- **`--with cdk` adds the Angular CDK**, and a small curated catalog behind it
  that the flag, the interactive list and the help text all render themselves
  from. There is also a schematic, so a workspace that did not ask at generation
  can ask later:

  ```bash
  npm create angular-capacitor-workspace@latest acme -- --app shop --with cdk
  ng generate angular-capacitor-workspace:packages cdk
  ```

  `npm install @angular/cdk` is one command and needs no generator, so what the
  entry adds is the rest of it: the range Angular's own schematics write for the
  framework, since the CDK ships in lockstep with it and pinning a second number
  by hand is one more thing to remember at every release; a peer declaration on
  every library in the workspace, without which a component built on the CDK
  publishes a package that resolves only by accident of hoisting; a `pkg:cdk`
  feature token, so a future advisory remedy can be scoped to the workspaces
  that carry it the way the undici override is scoped to the ones that have
  orval; and a README section naming the prebuilt overlay stylesheet, which is
  not loaded for you and whose absence looks like a broken dialog rather than a
  missing import.

  The catalog is deliberately short. Everything in it has been resolved against
  the Angular line and run through the audit gate — the `full` matrix row now
  carries `--with cdk` for exactly that — and anything else belongs on the end
  of an `npm install`. Unknown ids fail on the first line of output, naming the
  ones that exist, rather than minutes later inside a schematic.

- `doctor` infers an `animations` feature by scanning the workspace's own
  TypeScript, so a guard can distinguish a dependency someone uses from one the
  generator left behind. The dependency entry cannot be that evidence, for the
  same reason `ssr:server` is not inferred from express being installed.
- Generation collects the deprecation warnings npm prints during the install and
  returns them on `GenerateResult.deprecations`. npm emits these only while it
  unpacks a tree, so this is the one moment the information exists; it used to be
  read only when the install failed.
- The nightly matrix fails on a deprecation in a package the generator itself
  writes, unless `e2e/deprecations.mjs` waives it with the required peer that
  forces it. Findings are merged across rows into a single tracking issue.

  Deliberately nightly and not per-PR: a deprecation is published on the
  registry's clock, so gating a pull request on one turns somebody else's
  release into a red build on a morning this repo changed nothing. Transitive
  deprecations are reported as context and gate nothing — there is no move
  available three levels down inside someone else's dependency.

## [22.1.0] — 2026-09-23

### Fixed

- The advisory sweep failed with `Cannot read properties of null (reading
'edgesOut')`, an arborist crash inside `npm install --package-lock-only`
  reported as a generation error pointing at the Angular line. The cause was
  the npm running it: CI pinned `node-version: 22`, which bundles npm 10.9.8,
  and that npm dies walking vitest 4.x's optional `@vitest/browser-*` peers.
  Any vitest 4.x triggers it, including the `^4.0.8` Angular itself emits, so
  neither the policy's vitest floor nor the packed self-spec was implicated.
- npm below 11.6 accepts `--strict-allow-scripts` and silently ignores it, so
  the install-script allowlist — the whole Tier 1 `allowScripts` remedy — was
  never enforced in CI, ours or the one generated workspaces ship.

### Changed

- **`engines.node` is now `>=24.8.0`**, up from `>=22.12.0`. 24.8 is the first
  Node whose bundled npm clears the existing `npm >= 11.6` floor; `>=24.0.0`
  ships npm 11.3.0 and would have been the same trap. Node 22 with a manually
  upgraded `npm@^11.6` satisfied the old pair, and no longer qualifies —
  nothing here needs a Node 24 API, so that configuration is dropped rather
  than broken.
- Every CI workflow moves to Node 24, ours and the generated template's.
- `@types/node` tracks the floor at `^24`, so the types describe the oldest
  supported runtime rather than the newest available one.
- Generation, `doctor`, `audit` and the interactive prompts now print in
  sections — `Workspace`, `Dependency policy`, `Audit gate`, `Install` — with
  progress dimmed, outcomes marked `✓` or `✗`, and commands the reader is meant
  to type in colour. The wording is unchanged; only the hierarchy is new. A
  generation log that was one undifferentiated wall now says at a glance which
  phase failed.
- `angular-capacitor-workspace audit` writes its progress lines to stdout
  rather than stderr, so they stay in order with the report they introduce.
  `--json` still suppresses them entirely, leaving stdout machine-readable.

### Added

- `style`, exported from the `angular-capacitor-workspace` root: the sixteen
  escape codes both CLIs print with, written out rather than imported, on the
  same argument as the prompt layer. It degrades to the identity function off a
  terminal, and honours `NO_COLOR` and `FORCE_COLOR` ahead of the TTY check —
  so a redirected run, or a CI log, gets byte-for-byte the plain text these
  tools printed before.
- The audit gate refuses to run on npm below `11.6.0`, before the lockfile
  resolve, naming the Node release that carries the floor. Without it this
  surfaces as an arborist stack trace misattributed to the Angular pins.
- Generated workspaces declare the same `engines` floor, read from this
  package's own manifest so the two cannot drift.

`engines` alone does not stop this at install time — npm 10 crashes before it
evaluates the field, `--engine-strict` included. The gate's check is what gives
that user a usable message.

## [22.0.0] — 2026-09-21

Initial release.

[unreleased]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.4.0...HEAD
[22.4.0]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.3.2...v22.4.0
[22.3.2]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.3.1...v22.3.2
[22.3.1]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.3.0...v22.3.1
[22.3.0]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.2.1...v22.3.0
[22.2.1]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.2.0...v22.2.1
[22.2.0]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.1.0...v22.2.0
[22.1.0]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.0.0...v22.1.0
[22.0.0]: https://github.com/karimaounn/angular-capacitor-workspace/releases/tag/v22.0.0
