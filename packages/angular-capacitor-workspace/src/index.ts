/**
 * Programmatic entry point.
 *
 * `create-angular-capacitor-workspace` is a thin argv-and-prompts shell over
 * this; anything it can do, a script can do.
 */
export { featuresFor, generateWorkspace, GenerateError } from './api';
export type { AppSpec, GenerateOptions, GenerateResult, MobilePlatform } from './api';
export { PLACEHOLDER_ORIGIN } from './schematics/marketing';

export { runGate } from './gate';
export { collectDeprecations } from './gate';
export type { Deprecation, Finding, GateResult, Severity } from './gate';

export { applyPolicy, POLICY, PolicyError } from './policy';
export type { Policy, PolicyContext, PolicyDecision, Tier } from './policy';

export { diagnose } from './cli/doctor';
export type { Diagnosis, Drift } from './cli/doctor';

/**
 * The terminal styling the CLIs print with, so `create-*` — and anything else
 * wrapping this — renders its own output in the same palette rather than
 * inventing a second one.
 */
export * as style from './style';
