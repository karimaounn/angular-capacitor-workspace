import { SchematicsException, type Tree } from '@angular-devkit/schematics';
import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
  printParseErrorCode,
  type JSONPath,
  type Node,
  type ParseError,
} from 'jsonc-parser';

const FORMATTING = { insertSpaces: true, tabSize: 2, eol: '\n' } as const;

/**
 * Surgical edits to a JSON file in a schematic `Tree`.
 *
 * Two properties matter, and both come from editing the syntax tree rather than
 * the string:
 *
 * 1. **Formatting and comments survive.** `angular.json` and `tsconfig.json` are
 *    files people read and hand-edit; a patch that reserialises the whole
 *    document turns a two-line change into a whole-file diff.
 * 2. **A missing anchor is an error.** Overlaying Angular's output means every
 *    patch depends on a shape Angular chose and can change. A patch that cannot
 *    find what it expected must fail during generation, because the alternative
 *    — a silent no-op — produces a workspace that builds and is subtly wrong.
 *    That is strictly worse than a crash, and far harder to trace.
 */
export class JsonFile {
  private content: string;

  constructor(
    private readonly tree: Tree,
    private readonly path: string,
  ) {
    const buffer = tree.read(path);
    if (buffer === null) {
      throw new SchematicsException(
        `Expected ${path} to exist. The Angular schematic that creates it may ` +
          `have changed its output, or it ran with a different path.`,
      );
    }
    this.content = buffer.toString('utf8');
    this.assertParses();
  }

  private assertParses(): void {
    const errors: ParseError[] = [];
    parseTree(this.content, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const first = errors[0]!;
      throw new SchematicsException(
        `${this.path} is not valid JSON: ${printParseErrorCode(first.error)} at offset ${first.offset}.`,
      );
    }
  }

  private node(path: JSONPath): Node | undefined {
    const root = parseTree(this.content, [], { allowTrailingComma: true });
    return root === undefined ? undefined : findNodeAtLocation(root, path);
  }

  /** The value at `path`, or `undefined` when absent. */
  get<T = unknown>(path: JSONPath): T | undefined {
    const node = this.node(path);
    return node === undefined ? undefined : (getNodeValue(node) as T);
  }

  has(path: JSONPath): boolean {
    return this.node(path) !== undefined;
  }

  /**
   * The value at `path`, or a thrown `SchematicsException` naming the anchor we
   * expected and could not find.
   *
   * `expectation` should describe what the caller was relying on, not restate
   * the path — "the build target for app `foo`" tells a maintainer which patch
   * broke; "projects.foo.architect.build" only repeats the stack trace.
   */
  mustGet<T = unknown>(path: JSONPath, expectation: string): T {
    const value = this.get<T>(path);
    if (value === undefined) {
      throw new SchematicsException(
        `Anchor not found in ${this.path}: ${expectation} (at "${path.join('.')}").\n` +
          `This generator overlays the Angular schematics, so a missing anchor ` +
          `usually means Angular changed the shape of its output. The patch ` +
          `needs updating rather than skipping — failing here is deliberate.`,
      );
    }
    return value;
  }

  /**
   * Sets `path` to `value`, creating intermediate objects as needed.
   *
   * `insertionIndex` orders new keys; omit it to append. Arrays take a numeric
   * final segment, or `-1` to push.
   */
  modify(path: JSONPath, value: unknown, insertionIndex?: number): void {
    const edits = modify(this.content, path, value, {
      formattingOptions: { ...FORMATTING },
      ...(insertionIndex === undefined ? {} : { getInsertionIndex: () => insertionIndex }),
    });
    this.content = applyEdits(this.content, edits);
  }

  /** Removes `path`. Absent paths are left alone — removal is idempotent. */
  remove(path: JSONPath): void {
    if (!this.has(path)) {
      return;
    }
    const edits = modify(this.content, path, undefined, {
      formattingOptions: { ...FORMATTING },
    });
    this.content = applyEdits(this.content, edits);
  }

  /** Merges `values` into the object at `path`, one key at a time. */
  merge(path: JSONPath, values: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(values)) {
      this.modify([...path, key], value);
    }
  }

  /**
   * Rewrites a whole object with its keys sorted, so generated manifests do not
   * churn on insertion order.
   */
  sortKeys(path: JSONPath): void {
    const value = this.get<Record<string, unknown>>(path);
    if (value === undefined || typeof value !== 'object' || Array.isArray(value)) {
      return;
    }
    const sorted = Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
    this.modify(path, sorted);
  }

  /** The current text, including edits not yet written back to the tree. */
  get text(): string {
    return this.content;
  }

  /** Writes the accumulated edits back into the tree. */
  save(): void {
    this.tree.overwrite(this.path, this.content);
  }
}

/** Reads, patches and saves in one call. */
export function updateJson(tree: Tree, path: string, patch: (file: JsonFile) => void): void {
  const file = new JsonFile(tree, path);
  patch(file);
  file.save();
}
