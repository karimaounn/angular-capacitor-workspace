/**
 * Programmatic entry point.
 *
 * `@angular-capacitor-workspace/create` is a thin argv-and-prompts shell over
 * this; anything it can do, a script can do.
 */
export { featuresFor, generateWorkspace, GenerateError } from './api';
export type {
  AppSpec,
  GenerateOptions,
  GenerateResult,
  MarketingSpec,
  MobilePlatform,
} from './api';
export { PLACEHOLDER_ORIGIN } from './schematics/marketing';

/**
 * The packages `--with` knows how to wire in. Exported so the `/create` shell
 * renders its help and its prompt from the catalog rather than from a second
 * list that would fall behind it.
 */
export {
  CATALOG,
  CATALOG_IDS,
  catalogEntry,
  packageFeature,
  resolveCatalog,
  unknownPackageMessage,
  withRequired,
} from './catalog';
export type { CatalogEntry, CatalogPackage, DependencyBlock } from './catalog';

/**
 * The locales the generator knows the endonym and direction of. Exported so
 * the `/create` prompt offers them by name rather than from a second list.
 */
export { KNOWN_LOCALES } from './locales';
export type { LocaleInfo } from './locales';

export { runGate } from './gate';
export { collectDeprecations } from './gate';
export type { Deprecation, Finding, GateResult, Severity } from './gate';

export { applyPolicy, POLICY, PolicyError } from './policy';
export type { Policy, PolicyContext, PolicyDecision, Tier } from './policy';

export { diagnose } from './cli/doctor';
export type { Diagnosis, Drift } from './cli/doctor';

/**
 * The terminal styling the CLIs print with, so `/create` — and anything else
 * wrapping this — renders its own output in the same palette rather than
 * inventing a second one.
 */
export * as style from './style';
