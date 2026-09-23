# create-angular-capacitor-workspace

Scaffold an Angular 22 workspace that ships as a web app, a Capacitor mobile
app, a prerendered marketing site and shared libraries — audit-clean on the day
it is generated.

```bash
npm create angular-capacitor-workspace@latest my-workspace
```

Requires Node ≥ 24.8 and npm ≥ 11.6. 24.8 is the first Node whose bundled npm
clears that floor; on anything older, `allowScripts` and
`--strict-allow-scripts` are accepted and ignored.

Interactive when no flags are given. Questions with a list of options are
answered with the arrow keys — `↑↓` to move, `Space` to toggle a Capacitor
platform, `Enter` to confirm — and pressing Return through every question gives
one app, a `ui` library and Playwright wiring, and no mobile target, marketing
site or codegen, since each of those adds dependencies a workspace should carry
only once someone has decided it needs them.

Off a terminal the same questions are answered by number or by name on one
line, so a run can be scripted:

```bash
printf 'storefront\nandroid,ios\nn\n' | npm create angular-capacitor-workspace@latest shop
```

Non-interactive when any flag is present, so CI and the integration tests take
the same path users do.

## Options

Flags go after a `--`. Without it npm reads them as its own configuration and
passes on only their values.

```bash
npm create angular-capacitor-workspace@latest <directory> -- [options]
```

```
  --app <name>            app to create (repeatable)
  --mobile android,ios    Capacitor platforms for the preceding --app
  --marketing <name>      prerendered static site
  --marketing-origin <url>
                          its production origin, for canonical URLs and the
                          sitemap (default: https://example.com, which its
                          build warns about)
  --ui-lib [name]         design-system library skeleton (default: ui)
  --ui-lib-prefix <p>     selector prefix for its components (default: its name)
  --codegen orval         OpenAPI client generation
  --e2e playwright        end-to-end test wiring
  --audit-level <lvl>     low|moderate|high|critical  (default: moderate)
  --no-install            stop after generating; still writes the lockfile to audit
  --dry-run               show what would be generated
  -h, --help
```

`--mobile` binds to the `--app` before it, so

```bash
npm create angular-capacitor-workspace@latest shop -- \
  --app storefront --mobile android,ios \
  --app admin \
  --marketing site --ui-lib ui --e2e playwright
```

gives the mobile targets to `storefront` and leaves `admin` web-only.

To see what would be generated, and whether it would pass the audit gate,
without writing anything:

```bash
npm create angular-capacitor-workspace@latest shop -- --app storefront --dry-run
```

## What happens

```
npx @angular/cli@^22 new <ws> --no-create-application --skip-install
  → schematics:  workspace overlay, then one per app / library
  → policy:      prune / override / floor, plus the allowScripts allowlist
  → gate:        lockfile resolve + npm audit, fail on anything unhandled
  → npm install
```

The gate runs **before** installing, so a workspace that would fail it is never
installed — but is left on disk for you to inspect.

Everything Angular owns is delegated to Angular. The generator templates only
the delta, which is why it survives Angular minors instead of drifting from
them.

## After generating

```bash
cd my-workspace
npm run build:libs   # libraries are consumed from dist/ — see the generated README
npm start
```

The generated workspace carries the dependency policy with it:

```bash
npm run audit:policy   # the same gate that ran at generation
npm run doctor         # drift from the policy, as the generator ships it today
```

## Licence

[MIT](https://github.com/karimaounn/angular-capacitor-workspace/blob/main/LICENSE).
Source, issues and contributions:
[github.com/karimaounn/angular-capacitor-workspace](https://github.com/karimaounn/angular-capacitor-workspace).
