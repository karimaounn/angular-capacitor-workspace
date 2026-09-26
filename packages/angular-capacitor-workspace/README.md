# angular-capacitor-workspace

Schematics, a dependency policy and an audit gate for an Angular 22 workspace
that ships as a web app, a Capacitor mobile app, a prerendered marketing site
and shared libraries.

To create a new workspace, use the companion package:

```bash
npm create angular-capacitor-workspace@latest my-workspace
```

This package is what that one installs, and what stays in the generated
workspace afterwards. It requires Node ≥ 24.8 and npm ≥ 11.6. 24.8 is the first Node whose bundled
npm clears that floor; on anything older, `allowScripts` and
`--strict-allow-scripts` are accepted and ignored.

Its major version is the Angular major it targets: 22.x is for Angular 22
workspaces. When moving to a new Angular major, update the two together:

```bash
ng update @angular/core@23 @angular/cli@23 angular-capacitor-workspace@23
```

## In an existing workspace

```bash
ng add angular-capacitor-workspace
```

Applies the root overlay and the dependency policy to a workspace that already
exists. Features are inferred from the tree rather than asked for: a Storybook
someone added by hand still forces the peer that makes pruning impossible,
whether or not this invocation knows about it.

### Generating

```bash
ng generate angular-capacitor-workspace:app shop --mobile android
ng generate angular-capacitor-workspace:marketing site --origin https://example.org
ng generate angular-capacitor-workspace:ui-lib ui --prefix acme
ng generate angular-capacitor-workspace:mobile shop --platforms ios
ng generate angular-capacitor-workspace:codegen
ng generate angular-capacitor-workspace:packages cdk
```

| Schematic   | Emits                                                                                                    |
| ----------- | -------------------------------------------------------------------------------------------------------- |
| `workspace` | tsconfig paths, Playwright base, house rules, README, CI workflow                                        |
| `app`       | a client-rendered app at `projects/<name>/web`, a starter shell, room for a `mobile/` sibling            |
| `marketing` | a prerendered static site with per-page SEO tags, a 404 page and postbuild checks                        |
| `ui-lib`    | ng-packagr, Storybook + Compodoc, browser-mode Vitest, SCSS layering, themes, contrast checker           |
| `mobile`    | a Capacitor sibling registered as its own npm workspace member                                           |
| `codegen`   | orval config, a per-app client seam, and `pre*` hooks on every build entry point                         |
| `packages`  | curated packages — the CDK, Angular Aria, a service worker — at ranges resolved against the Angular line |

`ng generate angular-capacitor-workspace:<schematic> --help` lists every
option, including ones not shown above: `--prefix` and `--port` on `app` and
`marketing`, `--app-id` and `--app-name` on `mobile`, `--storybook=false` on
`ui-lib`.

Each schematic adds a row to the scripts table in the workspace README for
every script it creates, so that table lists what the workspace can run.

### Theming

A workspace with a `ui-lib` gets light, dark and three palettes, and every app
generated after it opens on a starter screen that demonstrates them.

The mechanism is two attributes on `<html>` — `data-theme` (`light`, `dark`, or
absent for "follow the OS") and `data-palette`. Every combination is declared in
the stylesheet up front, so switching either is an attribute write: no
re-render, and no component that has to know a theme exists. `ThemeService`
owns those attributes and the stored preference; `<ui-theme-toggle>` is the
control, and each app's `index.html` carries a small inline script that applies
the stored value before the first paint.

The colour that travels with a palette is `--accent`, which is deliberately not
`--info`: a theme should change the brand, not restyle informational messages.
`npm run check:contrast` compiles the real Sass and checks every declared
pairing in every palette in both modes, so adding a palette that fails WCAG
fails the build rather than shipping.

A marketing site imports the tokens but carries no toggle and no script. A
prerendered page is written once and served to everyone, so light and dark are
left to `prefers-color-scheme` in CSS — the only mechanism that survives being
cached at the edge.

Without `--ui-lib`, an app gets the same shell in system colours and nothing to
switch.

### Mobile

An app generated with `--mobile`, or given one later with the `mobile`
schematic, gets a Capacitor shell at `projects/<app>/mobile`, beside `web/`.
That directory is its own npm workspace member, so the Capacitor CLI and
plugins resolve from there.

The native `android/` and `ios/` projects are not generated. Add each platform
once:

```bash
(cd projects/shop/mobile && npx cap add android)
```

From then on, work from the workspace root:

```bash
npm run sync:shop:android   # build, then copy the bundle into android/
npm run open:shop:android   # open the project in Android Studio
npm run run:shop:android    # build, sync and run on a device or emulator
```

Use `sync:<app>` rather than `npx cap sync`. The script builds first, and a
bare `cap sync` copies whatever is left in `dist/` from last time.

Native builds need a JDK 17 or newer and the Android SDK (`ANDROID_HOME`) for
Android, and macOS with Xcode for iOS. `npm run preflight:shop` checks for them
before a build fails halfway through.

### Marketing site

The `marketing` schematic starts from Angular's SSR application and converts
it to `outputMode: "static"`. Every route is rendered to its own HTML file at
build time. There is no Node server, `server.ts` is deleted, and the policy
prunes `express`.

The rest of what it generates exists because the site needs to be found by
search engines:

- **Head tags per page.** Each route declares `data.seo` (a title and a
  description). `PageMetaStrategy`, a `TitleStrategy`, turns that into the
  title, description, canonical, robots, Open Graph and JSON-LD tags. Because
  it also runs during prerender, the tags are in the static HTML.
- **Its own origin.** `--origin` sets `SITE_ORIGIN` in `src/app/site.ts`, which
  canonical URLs, the sitemap and the JSON-LD are all built from, and the
  `Sitemap:` line in `public/robots.txt`. Without `--origin` it is
  `https://example.com`, and every build warns until it is changed.
- **A prerendered 404.** `/404` is `noindex`. Configure the host to serve it
  with a 404 status for unknown paths, not to rewrite them to `index.html`.
- **Postbuild checks.** `build:<site>` writes `sitemap.xml` from the
  prerendered pages. It then fails when a page has no `<h1>` (the prerender
  fell back to an empty shell), shares a title or description with another
  page, has a wrong canonical, or pins `data-theme` on `<html>`. Without these
  checks, a prerender that fails still looks like a successful build.

Run it more than once for more than one site. A product site and a docs site
are two sets of pages sharing a design system, not two repositories: each site
gets its own project, dev-server port, scripts and origin, and they share the
`scripts/` postbuild checks — which a second generation leaves alone, so
checks someone has tuned survive it.

- **Page budgets.** The initial bundle warns at 380 kB and fails at 450 kB,
  instead of Angular's app-sized 500 kB and 1 MB.
- **E2E suite.** With `--e2e playwright`: hydration without console errors,
  the 404 page, head tags on client-side navigation, the skip link, and AXE on
  every page reachable from the home page, in light and dark mode.

The generated `projects/<site>/web/README.md` covers hosting: real 404s,
upload order and caching.

### API client

```bash
ng generate angular-capacitor-workspace:codegen   # every application, or --apps shop
OPENAPI_SPEC=../api/openapi.yaml npm run codegen
OPENAPI_SPEC=https://api.example.com/openapi.json npm run codegen
```

The spec location comes from `OPENAPI_SPEC` (renamed with `--spec-env-var`)
rather than a committed copy, so the client tracks the API rather than a
snapshot of it. For each app, orval writes an Angular client to
`projects/<app>/web/src/api/generated/`, which is gitignored.

Every generated request goes through `projects/<app>/web/src/api/api-client.ts`.
That file is yours, and regeneration never touches it. Set the base URL there
(it starts as `/api`), along with auth headers and error mapping.

Build, serve and test scripts run codegen first. When `OPENAPI_SPEC` is unset
they skip it with a message rather than failing, so a fresh clone without
access to the spec still starts.

### Curated packages

```bash
ng generate angular-capacitor-workspace:packages cdk aria    # or --with at generation
```

| Id               | Package                   | Adds                                                                     |
| ---------------- | ------------------------- | ------------------------------------------------------------------------ |
| `cdk`            | `@angular/cdk`            | overlays, a11y, drag & drop, virtual scrolling — behaviour, no styling   |
| `aria`           | `@angular/aria`           | listbox, combobox, menu, tabs, tree, grid — WAI-ARIA patterns, no markup |
| `service-worker` | `@angular/service-worker` | an `ngsw-config.json`, the production build option and the registration  |

`aria` brings `cdk` with it: `@angular/aria` peers `@angular/cdk` at an exact
version, so the two have to come from one resolution rather than from npm's
auto-install.

`service-worker` wires every application except a prerendered site, and
registers nothing inside the Capacitor shell. A marketing site wants to be
current and crawlable, which a worker helps with neither; on device the mobile
sibling ships whatever the web build emitted, so a worker there serves the shell
it cached before the last native update. The generated README section explains
both, and how to opt a docs site in.

`npm install @angular/cdk` is one command and needs no generator. What the
schematic adds is the rest of it: a range taken from the Angular line rather
than `latest`, the peer declaration every library in the workspace needs before
it can publish a component built on the package, a feature token (`pkg:cdk`)
that scopes a future policy remedy to the workspaces carrying it, the global
stylesheet the package ships unloaded — wired into every application's `styles`,
ahead of the app's own so your rules still win — and a README section on what
the package is for and what bites people.

That last part is `ng add`'s setup half without its install half. `ng add`
installs before it configures, and here the gate audits a resolved lockfile
before anything reaches disk; it also resolves against the default project, and
a workspace carrying several apps plus a marketing site has no default worth
guessing at.

The list is short on purpose. Everything in it has been resolved against the
Angular line and run through the audit gate; anything else belongs on the end of
an `npm install`. Proposals go in
[`src/catalog.ts`](src/catalog.ts).

## Commands

```bash
npx angular-capacitor-workspace audit    # resolve a lockfile, audit it, fail on anything new
npx angular-capacitor-workspace doctor   # diff this workspace against the installed policy
npx angular-capacitor-workspace doctor --fix
npx angular-capacitor-workspace policy   # print the policy this version ships
```

### `audit`

Runs `npm install --package-lock-only --ignore-scripts` and then `npm audit`.
Lockfile-only is what makes it affordable — seconds rather than minutes — and it
produces exactly the tree `npm audit` reads.

Anything the policy did not account for is reported with the advisory id, the
full dependency path, the tier that would fix it, and a ready-to-paste policy
entry:

```
HIGH  GHSA-vmh5-mc38-953g  undici vulnerable to TLS certificate validation bypass…
  package: undici  vulnerable: >=7.23.0 <7.28.0
  path: @scalar/openapi-parser → @scalar/json-magic → undici
  remedy: tier override — undici is transitive under @scalar/json-magic, and the
          advisory is fixed in 7.28.0. Scope the override to @scalar/json-magic
          so the rest of the tree keeps its own resolution.

    {
      spec: { '@scalar/json-magic': { undici: '^7.28.0' } },
      advisories: ['GHSA-vmh5-mc38-953g'],
      reason: '…',
    }
```

The snippet matters more than it looks. A gate that fails with "7 moderate
vulnerabilities" sends you to a browser; a gate that fails with the object to
paste keeps the remedy ladder cheap enough that people actually climb it.

### `doctor`

The upgrade path. Patching the policy should fix **existing** workspaces, not
just future ones — so `doctor` reads the installed policy, diffs it against this
workspace, and reports the delta:

```
3 difference(s) from the installed policy:

  [floor/stale] vitest sits below the policy floor.
      now:  vitest@^4.0.8
      want: vitest@^4.1.11
  [override/missing] The policy pins a transitive dependency under sockjs.
      now:  (none)
      want: overrides.sockjs = {"uuid":"^11.1.1"}
  [allowScripts/missing] lmdb needs an install script and is not yet allowlisted.
```

Bumping this package and running `doctor --fix` is how a two-year-old project
gets this quarter's patches. It also reports allowlist entries that are no
longer needed — an exemption for a package no longer in the tree is attack
surface for nothing.

## Programmatic API

```ts
import { generateWorkspace, runGate, applyPolicy, POLICY } from "angular-capacitor-workspace";

await generateWorkspace({
  directory: "./my-workspace",
  apps: [{ name: "shop", mobile: ["android"] }],
  marketing: [{ name: "site", origin: "https://acme.example" }],
  uiLib: "ui",
  uiLibPrefix: "acme",
  e2e: "playwright",
  auditLevel: "moderate",
});
```

`runGate` and `applyPolicy` are exported separately for anyone who wants the
dependency machinery without the schematics.

## The policy

One data-only module, `src/policy/advisories.ts`, holding four tiers — prune,
override, floor, accept — plus the npm `allowScripts` allowlist. Every entry
carries the reason and the evidence, because an unverified remedy is
indistinguishable from a superstition six months later.

See the [repository README](https://github.com/karimaounn/angular-capacitor-workspace)
for the ladder and for why pruning is not always available.

## Licence

[MIT](https://github.com/karimaounn/angular-capacitor-workspace/blob/main/LICENSE).
Source, issues and contributions:
[github.com/karimaounn/angular-capacitor-workspace](https://github.com/karimaounn/angular-capacitor-workspace).
