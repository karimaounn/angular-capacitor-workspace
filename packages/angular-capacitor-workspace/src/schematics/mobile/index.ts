import { strings } from '@angular-devkit/core';
import {
  apply,
  applyTemplates,
  chain,
  MergeStrategy,
  mergeWith,
  move,
  url,
  SchematicsException,
  type Rule,
  type Tree,
} from '@angular-devkit/schematics';
import { VERSIONS } from '../../policy/versions';
import { JsonFile } from '../../utils/json-file';
import {
  addScripts,
  addWorkspaceMember,
  documentMobile,
  documentScripts,
  PACKAGE_JSON,
  readProject,
  type AngularProject,
} from '../../utils/workspace';
import type { MobilePlatform } from '../../api';

export interface MobileOptions {
  app: string;
  platforms?: MobilePlatform[];
  appId?: string;
  appName?: string;
}

/** Where the Capacitor half of an app lives, beside `web/`. */
export const MOBILE_SUBDIR = 'mobile';

/**
 * A Capacitor shell beside an existing application.
 *
 * Registered as an npm workspace member with its own `package.json`, so `cap`
 * resolves its config, its plugins and its platform packages from the directory
 * it is actually about. Capacitor discovers plugins by walking the dependencies
 * of the package it runs in — hoisting the CLI to the workspace root and
 * running it from there works right up until two apps want different plugins.
 */
export function mobile(options: MobileOptions): Rule {
  return (tree: Tree) => {
    const app = strings.dasherize(options.app);
    const platforms = options.platforms?.length ? options.platforms : (['android'] as const);
    const project = readProject(tree, app);
    const appRoot = projectParentRoot(project, app);

    const workspace = workspaceName(tree);
    const mobileRoot = `${appRoot}/${MOBILE_SUBDIR}`;
    const appId = options.appId ?? defaultAppId(workspace, app);
    const appName = options.appName ?? strings.classify(app);

    const templates = apply(url('./files'), [
      applyTemplates({
        ...strings,
        app,
        workspace,
        platforms: [...platforms],
        appId,
        appName,
        webDir: webDirFor(tree, app, mobileRoot),
        versions: Object.fromEntries(
          Object.entries(VERSIONS).map(([name, pin]) => [name, pin.range]),
        ),
      }),
      move(`/${mobileRoot}`),
    ]);

    return chain([
      mergeWith(templates, MergeStrategy.Overwrite),
      (host: Tree) => {
        addWorkspaceMember(host, mobileRoot);
        mobileScripts(host, app, mobileRoot, [...platforms]);
        documentMobile(host, mobileReadmeBlock(app, appName, [...platforms], appId, mobileRoot));
      },
      helperScripts(app),
    ]);
  };
}

/**
 * The per-app block folded into the root README's Mobile section: one
 * numbered step per command, each in its own code block, rather than the
 * commands buried inside prose.
 *
 * The order is the order that works. `cap add` finishes by syncing the web
 * build into the platform it just created, so it fails outright until that
 * build exists — which is why the web build comes first and the preflight
 * check, whose whole job is to fail before a native toolchain does, comes
 * before both.
 */
function mobileReadmeBlock(
  app: string,
  appName: string,
  platforms: MobilePlatform[],
  appId: string,
  mobileRoot: string,
): string {
  const needs = list([
    ...(platforms.includes('android') ? ['a JDK (17+)', 'the Android SDK'] : []),
    ...(platforms.includes('ios') ? ['Xcode'] : []),
  ]);
  // The preflight script only looks for Xcode on macOS, because only macOS can
  // build for iOS. Saying so here stops the check reading as a broken one on
  // the machine where it deliberately says nothing.
  const caveat = platforms.includes('ios') ? ' (the iOS checks run on macOS only)' : '';

  const steps = [
    [
      `Check this machine has what a native build needs — ${needs}${caveat}:`,
      [`npm run preflight:${app}`],
    ],
    [
      'Build the web app, then add each platform once. `cap add` copies that ' +
        'build into the native project it creates, so it has to exist first:',
      [
        `npm run build:${app}`,
        ...platforms.map((platform) => `npm run --workspace ${mobileRoot} cap -- add ${platform}`),
      ],
    ],
    [
      'From then on, one command builds, syncs and runs it on a device or emulator:',
      platforms.map((platform) => `npm run run:${app}:${platform}`),
    ],
    [
      `Before publishing, change its app id — \`${appId}\`, set in ` +
        `\`${mobileRoot}/capacitor.config.ts\`. Once an app is live in a store ` +
        `the id is permanent.`,
      [],
    ],
  ] as const;

  const body = steps
    .map(([lead, lines], index) => {
      const step = `${index + 1}. ${wrap(lead, STEP_INDENT.length)}`;
      return lines.length > 0 ? `${step}\n\n${codeBlock(lines)}` : step;
    })
    .join('\n\n');

  return `### ${appName}\n\n${body}`;
}

/** `['a', 'b', 'c']` → `a, b and c`. */
function list(parts: readonly string[]): string {
  if (parts.length < 3) {
    return parts.join(' and ');
  }
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/** The indent that puts a line under a numbered-list marker rather than beside it. */
const STEP_INDENT = '   ';

/**
 * Wraps prose to the width the rest of the README is written at.
 *
 * The lead lines carry an app id and a path interpolated into them, so their
 * length is not knowable when they are written — left alone they run to
 * whatever those values happen to add up to, in a file every other line of
 * which stops at 78 columns.
 */
function wrap(text: string, indent: number, width = 78): string {
  // Uniform, because `1. ` is exactly as wide as the indent every later line
  // carries: each rendered line starts at the same column.
  const limit = width - indent;
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/)) {
    if (line && `${line} ${word}`.length > limit) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) {
    lines.push(line);
  }
  return lines.join(`\n${STEP_INDENT}`);
}

/** A bash code block, indented to nest under a numbered-list step. */
function codeBlock(lines: readonly string[]): string {
  return [
    `${STEP_INDENT}\`\`\`bash`,
    ...lines.map((line) => `${STEP_INDENT}${line}`),
    `${STEP_INDENT}\`\`\``,
  ].join('\n');
}

/**
 * The app's own directory — the parent of `web/`, and the place `mobile/` goes.
 *
 * `readProject().root` points at `projects/<app>/web` after relocation, so the
 * sibling directory is one level up.
 */
function projectParentRoot(project: AngularProject, app: string): string {
  if (!project.root) {
    throw new SchematicsException(`Project "${app}" has no root in angular.json.`);
  }
  const segments = project.root.split('/').filter(Boolean);
  if (segments.at(-1) !== 'web') {
    throw new SchematicsException(
      `Expected "${app}" to live under a "web" subdirectory (found "${project.root}"). ` +
        `The mobile schematic adds a sibling to the web app, so the app must have ` +
        `been generated by this collection's "app" schematic.`,
    );
  }
  return segments.slice(0, -1).join('/');
}

/**
 * The browser output of the app's build target, relative to the mobile package.
 *
 * Read from `angular.json` rather than assumed, because `outputPath` is exactly
 * the kind of option a team changes once and forgets — and a `webDir` pointing
 * at a directory that no longer exists fails as a blank white screen on device,
 * with no error anywhere.
 */
function webDirFor(tree: Tree, app: string, mobileRoot: string): string {
  const angularJson = new JsonFile(tree, '/angular.json');
  const configured = angularJson.get<string | { base?: string }>([
    'projects',
    app,
    'architect',
    'build',
    'options',
    'outputPath',
  ]);

  const base = typeof configured === 'string' ? configured : (configured?.base ?? `dist/${app}`);

  const upToRoot = '../'.repeat(mobileRoot.split('/').filter(Boolean).length);
  return `${upToRoot}${base}/browser`;
}

function workspaceName(tree: Tree): string {
  const file = new JsonFile(tree, PACKAGE_JSON);
  return strings.dasherize(file.mustGet<string>(['name'], 'the workspace name'));
}

function defaultAppId(workspace: string, app: string): string {
  // Reverse-DNS ids may not contain hyphens in the Android package name.
  const clean = (value: string) => value.replace(/[^a-zA-Z0-9]/g, '');
  return `com.${clean(workspace) || 'example'}.${clean(app)}`;
}

function mobileScripts(
  tree: Tree,
  app: string,
  mobileRoot: string,
  platforms: MobilePlatform[],
): void {
  const inMobile = `npm run --workspace ${mobileRoot}`;
  const scripts: Record<string, string> = {
    // Build then sync, always in that order. See capacitor.config.ts.
    [`sync:${app}`]: `npm run build:${app} && ${inMobile} sync`,
  };
  const docs: Record<string, string> = {
    // The native projects are not generated, and every sync fails until one
    // exists. This row is where someone reading the table first hits that.
    [`sync:${app}`]:
      `builds \`${app}\` and copies it into every native project — ` +
      `add each platform once first, as the Mobile section above describes`,
  };

  for (const platform of platforms) {
    const native = PLATFORM_NAMES[platform];
    scripts[`sync:${app}:${platform}`] = `npm run build:${app} && ${inMobile} sync -- ${platform}`;
    scripts[`open:${app}:${platform}`] = `${inMobile} open:${platform}`;
    scripts[`run:${app}:${platform}`] = `npm run build:${app} && ${inMobile} run:${platform}`;

    docs[`sync:${app}:${platform}`] =
      `builds \`${app}\` and copies it into the ${native.label} project`;
    docs[`open:${app}:${platform}`] = `opens the ${native.label} project in ${native.ide}`;
    docs[`run:${app}:${platform}`] = `builds, syncs and runs \`${app}\` on ${native.target}`;
  }

  addScripts(tree, scripts);
  documentScripts(tree, docs);
}

const PLATFORM_NAMES: Record<MobilePlatform, { label: string; ide: string; target: string }> = {
  android: { label: 'Android', ide: 'Android Studio', target: 'an Android device or emulator' },
  ios: { label: 'iOS', ide: 'Xcode', target: 'an iOS device or simulator' },
};

/**
 * Root helper scripts for the parts of a mobile build that npm scripts model
 * badly — multi-step Gradle invocations and SDK preflight checks.
 */
function helperScripts(app: string): Rule {
  return (tree: Tree) => {
    const path = '/scripts/cap-preflight.sh';
    if (tree.exists(path)) {
      return;
    }
    tree.create(path, PREFLIGHT_SH);
    addScripts(tree, {
      [`preflight:${app}`]: 'bash scripts/cap-preflight.sh',
    });
    documentScripts(tree, {
      [`preflight:${app}`]: 'checks for a JDK, the Android SDK and Xcode before a native build',
    });
  };
}

const PREFLIGHT_SH = `#!/usr/bin/env bash
# Checks the things a Capacitor build needs before it fails halfway through
# with a Gradle stack trace that does not mention any of them.
set -euo pipefail

fail=0
note() { printf '  %-22s %s\\n' "$1" "$2"; }

echo "Capacitor preflight"

if command -v java >/dev/null 2>&1; then
  note "java" "$(java -version 2>&1 | head -1)"
else
  note "java" "MISSING — Android builds need a JDK (17 or newer)"
  fail=1
fi

if [ -n "\${ANDROID_HOME:-}" ] || [ -n "\${ANDROID_SDK_ROOT:-}" ]; then
  note "android sdk" "\${ANDROID_HOME:-\$ANDROID_SDK_ROOT}"
else
  note "android sdk" "MISSING — set ANDROID_HOME or ANDROID_SDK_ROOT"
  fail=1
fi

if [ "$(uname)" = "Darwin" ]; then
  if command -v xcodebuild >/dev/null 2>&1; then
    note "xcode" "$(xcodebuild -version 2>/dev/null | head -1)"
  else
    note "xcode" "MISSING — iOS builds need Xcode and its command line tools"
    fail=1
  fi
else
  note "xcode" "skipped (iOS builds require macOS)"
fi

if [ "$fail" -ne 0 ]; then
  echo
  echo "Preflight failed. Fix the items marked MISSING above."
  exit 1
fi

echo
echo "Preflight passed."
`;
