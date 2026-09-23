/**
 * An animated progress line, for the steps that are long enough to look hung.
 *
 * Generation spends nearly all of its wall clock inside child processes — the
 * Angular bootstrap, the lockfile resolve, the audit, and `npm install`, which
 * on its own is minutes. Each of those printed one static line and then went
 * silent, which on a slow network is indistinguishable from a hang.
 *
 * The frames are drawn from a worker thread, which is the one unusual thing
 * here and the reason the rest looks the way it does. Every slow step is a
 * *synchronous* child process: `spawnSync` blocks the event loop for its whole
 * duration, so a `setInterval` on the main thread would paint one frame and
 * then freeze on it until the install finished — an animation that stops
 * exactly when it is needed. A worker has an event loop of its own, and
 * `fs.writeSync(1, …)` reaches the terminal directly instead of going through
 * the main thread's stdout proxy, so it keeps turning while the main thread is
 * blocked. Handing the work to the worker also keeps `runGate` synchronous,
 * which is what its callers, and the published API, expect.
 *
 * No dependency, for the same reason as the prompt layer in `create-*`: a
 * spinner is ten characters and a carriage return, and a generator whose whole
 * argument is a defensible dependency set does not get to install a package for
 * that.
 *
 * Off a terminal nothing is animated, and the step's line is printed before its
 * work starts, exactly as it always was — so a CI log still says what is
 * running while it runs, and a redirected run is byte-for-byte what it was.
 */
import { Worker } from 'node:worker_threads';
import { cyan, dim, progress } from './style';

type Log = (message: string) => void;

/** Single-column frames, to match the markers in `style.ts`. */
const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** For a console that predates any of that. */
const ASCII = ['-', '\\', '|', '/'];

const INTERVAL_MS = 80;
/**
 * Nothing is drawn for this long, so the steps that finish quickly — most of
 * the schematics — never flash a spinner nobody had time to read. Everything
 * worth animating here is a child process measured in seconds.
 */
const DELAY_MS = 250;
/** How long `stop` waits for the worker to erase its line before moving on. */
const HANDSHAKE_MS = 250;

/** Indices into the shared flags: "stop now", and "the line is erased". */
const STOP = 0;
const ERASED = 1;

/**
 * The worker, as source rather than a file, so the built package stays a single
 * directory of modules and nothing has to resolve a path at runtime.
 *
 * It draws pre-rendered lines handed to it by the main thread, so no styling —
 * and no decision about whether to style — lives out here.
 */
const WORKER = `
const { writeSync } = require('node:fs');
const { workerData } = require('node:worker_threads');
const { lines, shared } = workerData;
const flags = new Int32Array(shared);

// A terminal that goes away mid-write is not worth an unhandled rejection in a
// thread whose only job is decoration.
const draw = (text) => {
  try {
    writeSync(1, text);
  } catch {}
};

Atomics.wait(flags, ${STOP}, 0, ${DELAY_MS});
let drawn = false;
for (let i = 0; Atomics.load(flags, ${STOP}) === 0; i += 1) {
  draw('\\r\\u001B[2K' + lines[i % lines.length]);
  drawn = true;
  Atomics.wait(flags, ${STOP}, 0, ${INTERVAL_MS});
}
// A step that beat the delay wrote nothing, so there is nothing to erase — and
// erasing anyway would clear a row the caller may have just printed on.
if (drawn) draw('\\r\\u001B[2K');
Atomics.store(flags, ${ERASED}, 1);
Atomics.notify(flags, ${ERASED});
`;

class Spinner {
  private readonly flags: Int32Array<ArrayBufferLike>;
  private readonly worker: Worker;

  constructor(label: string) {
    const shared = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    this.flags = new Int32Array(shared);
    this.worker = new Worker(WORKER, {
      eval: true,
      workerData: { lines: frames(label), shared },
    });
    // Decoration never holds the process open, and an `error` event with no
    // listener would be thrown at a program that is busy doing the real work.
    this.worker.unref();
    this.worker.on('error', () => Atomics.store(this.flags, ERASED, 1));
  }

  /**
   * Stops the animation and waits — synchronously, because the caller may well
   * be between two `spawnSync` calls — until the worker has erased its line, so
   * that whatever is printed next starts on a clean row.
   */
  stop(): void {
    Atomics.store(this.flags, STOP, 1);
    Atomics.notify(this.flags, STOP);
    if (Atomics.load(this.flags, ERASED) === 0) {
      Atomics.wait(this.flags, ERASED, 0, HANDSHAKE_MS);
    }
    void this.worker.terminate();
  }
}

/**
 * Runs `work` with `label` spinning beside it, then logs the line and how long
 * it took.
 *
 * The line is logged after the fact rather than before precisely because it now
 * carries a duration; the spinner is what answers "is it still going" in the
 * meantime. Without a spinner — off a terminal — that trade is a bad one, so
 * `begin` prints the line up front instead and nothing follows it.
 */
export function withSpinner<T>(log: Log, label: string, work: () => T): T {
  const end = begin(log, label);
  try {
    return work();
  } finally {
    end();
  }
}

/** The same, for a step that is awaited rather than blocking. */
export async function withSpinnerAsync<T>(
  log: Log,
  label: string,
  work: () => Promise<T>,
): Promise<T> {
  const end = begin(log, label);
  try {
    return await work();
  } finally {
    end();
  }
}

function begin(log: Log, label: string): () => void {
  const spinner = start(label);
  if (!spinner) {
    log(progress(label));
    return () => {};
  }

  const started = Date.now();
  return () => {
    spinner.stop();
    log(progress(`${label} ${seconds(Date.now() - started)}`));
  };
}

function start(label: string): Spinner | undefined {
  if (!animated()) return undefined;
  try {
    return new Spinner(label);
  } catch {
    // Worker threads can be unavailable — a `--frozen-intrinsics` run, a
    // sandbox. The step is still worth reporting; it just does not move.
    return undefined;
  }
}

/**
 * Whether to animate at all.
 *
 * Read at call time rather than at load, so a long-lived process that has its
 * stdout redirected part-way — and the tests — get the answer that is true now.
 * `NO_COLOR` is deliberately not consulted: it asks for no colour, which the
 * frames already honour through `style`, not for no motion.
 */
function animated(): boolean {
  const env = process.env;
  if (process.stdout.isTTY !== true) return false;
  if (env['TERM'] === 'dumb') return false;
  // A build log is a file that happens to be attached to a pseudo-terminal.
  // Thousands of carriage returns in it help nobody.
  if (env['CI']) return false;
  return true;
}

/** One pre-rendered line per frame, truncated to fit the terminal. */
function frames(label: string): string[] {
  // A line that wraps cannot be erased by the worker, which clears one row —
  // the overflow would be left on screen once per frame.
  const width = Math.max(24, (process.stdout.columns || 80) - 1);
  const room = width - 4; // "  X " — the two-space indent, the frame, a space.
  const text = label.length > room ? `${label.slice(0, room - 1)}…` : label;
  return glyphs().map((glyph) => `  ${cyan(glyph)} ${dim(text)}`);
}

function glyphs(): string[] {
  // Windows Terminal is fine with braille; the legacy console is not, and it is
  // still what `cmd.exe` opens.
  const legacyConsole =
    process.platform === 'win32' &&
    process.env['WT_SESSION'] === undefined &&
    process.env['TERM_PROGRAM'] === undefined;
  return legacyConsole ? ASCII : BRAILLE;
}

/** Long enough to be worth a decimal, or long enough not to be. */
function seconds(ms: number): string {
  return ms >= 10_000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`;
}
