import type { GenerateOptions } from '../api';
import type { WorkspaceView } from '../utils/workspace-view';

/**
 * An optional feature that extends the projects a workspace already has.
 *
 * The hosts — the workspace overlay, `app`, `marketing` and `ui-lib` — create
 * projects. A plugin adds something to them: translation, theme switching, an
 * OpenAPI client, a curated package. Everything the rest of the generator needs
 * to know about one is in its definition, so a plugin is added or changed in its
 * own directory and the registry, and nowhere else:
 *
 *   • which schematic options a `create` request turns into (`requested`)
 *   • which policy feature tokens it carries, both from the request
 *     (`features`) and from a workspace on disk (`detect`), side by side so the
 *     two cannot drift apart unnoticed
 *   • how a project generated after it gets its per-project half (`forProject`)
 *
 * Its schematic does the work, and edits a host's files only through the
 * extension points in `src/extend/`. A plugin never names a line of a host
 * template, and a host never names a plugin.
 *
 * Every function here is pure data over the request or a `WorkspaceView`, so
 * `doctor` can load the registry without running a schematic.
 */
export interface WorkspacePlugin {
  /**
   * The schematic that installs it (`ng generate @angular-capacitor-workspace/cli:<id>`),
   * which `collection.json` names the same way.
   */
  readonly id: string;

  /**
   * The schematic's options for a workspace being generated, or `undefined` when
   * the request leaves this plugin out.
   */
  requested(options: GenerateOptions): Record<string, unknown> | undefined;

  /** The policy feature tokens this plugin adds to a workspace being generated. */
  features(options: GenerateOptions): readonly string[];

  /**
   * The same tokens, read off a workspace that exists — for `doctor`, `audit`
   * and `ng add`. Must agree with `features` on any workspace this plugin
   * generated, which `test/plugins.spec.ts` checks for every plugin.
   *
   * Never read a token off the dependency a policy rule scoped to it decides
   * about. See "Feature tokens" in AGENTS.md.
   */
  detect(workspace: WorkspaceView): readonly string[];

  /**
   * The options to re-run this plugin's schematic with, for `project` — a
   * project generated after the plugin was installed — or `undefined` when the
   * plugin is not installed or has nothing for that kind of project.
   *
   * Run through `schematic()`, never by calling the plugin's rules from the
   * host: `url()` resolves against the schematic that is executing, so a rule
   * called from the app schematic would look for its templates under
   * `schematics/app/`, find none, and write nothing — silently.
   */
  forProject?(workspace: WorkspaceView, project: string): Record<string, unknown> | undefined;
}
