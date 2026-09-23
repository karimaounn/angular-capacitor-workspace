import { afterEach, describe, expect, it } from 'vitest';
import { withSpinner, withSpinnerAsync } from '../src/spinner';

/**
 * Every case here runs the real thing, worker and all. The interesting part of
 * this module is what it does to a terminal that is being blocked, and a mocked
 * worker would test the mock.
 */
const ANSI = /\u001B\[[0-9;]*m/g;

/** Blocks the event loop, the way every step this wraps does. */
function block(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin the CPU, not the loop */
  }
}

const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const environment = { ...process.env };

function terminal(isTTY: boolean, env: Record<string, string | undefined> = {}): void {
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });
  for (const [key, value] of Object.entries({ CI: undefined, TERM: 'xterm-256color', ...env })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
  process.env = { ...environment };
});

function collect(): { lines: string[]; log: (message: string) => void } {
  const lines: string[] = [];
  return { lines, log: (message) => lines.push(message.replace(ANSI, '')) };
}

describe('off a terminal', () => {
  // The whole point of the fallback: a CI log still says what is running while
  // it runs, rather than only once it has finished.
  it('prints the step before its work, and nothing after', () => {
    terminal(false);
    const { lines, log } = collect();

    const value = withSpinner(log, 'Auditing…', () => {
      expect(lines).toEqual(['  · Auditing…']);
      return 'done';
    });

    expect(value).toBe('done');
    expect(lines).toEqual(['  · Auditing…']);
  });

  it('leaves a terminal that cannot animate alone', () => {
    terminal(true, { TERM: 'dumb' });
    const { lines, log } = collect();
    withSpinner(log, 'Auditing…', () => undefined);
    expect(lines).toEqual(['  · Auditing…']);
  });

  // A build log is a file that happens to be attached to a pseudo-terminal.
  it('leaves CI alone even when it claims to be a terminal', () => {
    terminal(true, { CI: '1' });
    const { lines, log } = collect();
    withSpinner(log, 'Auditing…', () => undefined);
    expect(lines).toEqual(['  · Auditing…']);
  });

  it('awaits the work before reporting it', async () => {
    terminal(false);
    const { lines, log } = collect();
    let finished = false;

    const value = await withSpinnerAsync(log, 'Running app…', async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      finished = true;
      return 7;
    });

    expect(value).toBe(7);
    expect(finished).toBe(true);
    expect(lines).toEqual(['  · Running app…']);
  });
});

describe('on a terminal', () => {
  it('reports the step once it is done, with how long it took', () => {
    terminal(true);
    const { lines, log } = collect();

    withSpinner(log, 'Installing dependencies…', () => {
      // Nothing is logged while the spinner owns the line.
      expect(lines).toEqual([]);
      block(20);
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ {2}· Installing dependencies… \d+\.\d+s$/);
  });

  // A step that throws — a failed bootstrap, an unresolvable lockfile — must
  // still hand the line back, or the error is printed over a spinner that is
  // still turning.
  it('stops, and still reports, when the work throws', () => {
    terminal(true);
    const { lines, log } = collect();

    expect(() =>
      withSpinner(log, 'Bootstrapping…', () => {
        block(20);
        throw new Error('boom');
      }),
    ).toThrow('boom');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^ {2}· Bootstrapping… \d+\.\d+s$/);
  });

  it('survives a run of steps, as a generation is', async () => {
    terminal(true);
    const { lines, log } = collect();

    for (const name of ['workspace', 'ui-lib', 'app']) {
      await withSpinnerAsync(log, `Running ${name}…`, async () => {
        block(5);
      });
    }

    expect(lines).toHaveLength(3);
    expect(lines[2]).toMatch(/^ {2}· Running app… \d+\.\d+s$/);
  });
});
