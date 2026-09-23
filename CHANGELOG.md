# Changelog

Both packages are released together at the same version. The major is the
Angular major they generate for — 22.x is Angular 22 — so a breaking change
within a line lands as a minor. See [Versioning](CONTRIBUTING.md#versioning).

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- `style`, exported from the `angular-capacitor-workspace` root: the sixteen
  escape codes both CLIs print with, written out rather than imported, on the
  same argument as the prompt layer. It degrades to the identity function off a
  terminal, and honours `NO_COLOR` and `FORCE_COLOR` ahead of the TTY check — so a redirected run, or a CI log, gets byte-for-byte
  the plain text these tools printed before.

### Changed

- Generation, `doctor`, `audit` and the interactive prompts now print in
  sections — `Workspace`, `Dependency policy`, `Audit gate`, `Install` — with
  progress dimmed, outcomes marked `✓` or `✗`, and commands the reader is meant
  to type in colour. The wording is unchanged; only the hierarchy is new. A
  generation log that was one undifferentiated wall now says at a glance which
  phase failed.
- `angular-capacitor-workspace audit` writes its progress lines to stdout
  rather than stderr, so they stay in order with the report they introduce.
  `--json` still suppresses them entirely, leaving stdout machine-readable.

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

### Added

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

[22.1.0]: https://github.com/karimaounn/angular-capacitor-workspace/compare/v22.0.0...v22.1.0
[22.0.0]: https://github.com/karimaounn/angular-capacitor-workspace/releases/tag/v22.0.0
