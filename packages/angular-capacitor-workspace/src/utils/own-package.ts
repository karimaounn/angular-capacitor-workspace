import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SchematicsException } from '@angular-devkit/schematics';

/**
 * This package's own manifest.
 *
 * Hard-coding anything out of it would mean a release that forgot to update a
 * string generates workspaces describing a package that does not exist.
 */
export function ownManifest(): { version?: string; engines?: Record<string, string> } {
  // dist/utils/own-package.js → the package root is two levels up, and the
  // same is true of src/utils/own-package.ts when the sources run directly.
  return JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
}

/** The version of this package, read from its own manifest. */
export function ownVersion(): string {
  const { version } = ownManifest();
  if (!version) {
    throw new SchematicsException(
      "Could not read this package's own version from its manifest. The " +
        'generated workspace needs it to depend on the packages that made it.',
    );
  }
  return version;
}

/**
 * The runtime packages the plugins install, by plugin.
 *
 * Published from this repository with the generator, at the same version, so a
 * workspace depends on the ones its generator was released with: `^` the
 * generator's own version.
 */
export const RUNTIME_PACKAGES = {
  i18n: '@angular-capacitor-workspace/i18n',
  theming: '@angular-capacitor-workspace/theming',
} as const;

/** The range a workspace depends on a runtime package with, unless told another. */
export function runtimeRange(): string {
  return `^${ownVersion()}`;
}

/**
 * `{ runtimeSpec }` for a plugin's schematic, when a `create` request names a
 * build of its runtime package to install — a tarball of this checkout, before
 * the release that contains it is published. Nothing otherwise.
 */
export function runtimeSpec(
  options: { readonly packageSpecs?: Readonly<Record<string, string>> },
  name: string,
): { runtimeSpec?: string } {
  const spec = options.packageSpecs?.[name];
  return spec ? { runtimeSpec: spec } : {};
}
