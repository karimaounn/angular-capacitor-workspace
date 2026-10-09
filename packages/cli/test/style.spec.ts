import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The module decides once, at load, whether to emit escape codes — so every
 * case here has to re-import it under a different environment.
 */
async function load(env: Record<string, string | undefined>, isTTY: boolean) {
  vi.resetModules();
  const previous = { ...process.env };
  const descriptor = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');

  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  Object.defineProperty(process.stdout, 'isTTY', { value: isTTY, configurable: true });

  try {
    return await import('../src/style');
  } finally {
    process.env = previous;
    if (descriptor) Object.defineProperty(process.stdout, 'isTTY', descriptor);
  }
}

const CLEAR = { NO_COLOR: undefined, FORCE_COLOR: undefined, TERM: 'xterm-256color' };

afterEach(() => {
  vi.resetModules();
});

describe('colour detection', () => {
  it('colours a terminal', async () => {
    const style = await load(CLEAR, true);
    expect(style.colorEnabled()).toBe(true);
    expect(style.red('x')).toBe('\u001B[31mx\u001B[39m');
  });

  it('stays plain when the output is redirected', async () => {
    const style = await load(CLEAR, false);
    expect(style.colorEnabled()).toBe(false);
    expect(style.red('x')).toBe('x');
  });

  // The point of the whole module: a CI log, a `> out.txt`, or NO_COLOR gets
  // byte-for-byte what this tool printed before any of it existed.
  it('honours NO_COLOR over the TTY', async () => {
    const style = await load({ ...CLEAR, NO_COLOR: '1' }, true);
    expect(style.bold('x')).toBe('x');
    expect(style.MARK.ok).toBe('✓');
  });

  it('honours FORCE_COLOR over the absence of a TTY', async () => {
    const style = await load({ ...CLEAR, FORCE_COLOR: '1' }, false);
    expect(style.colorEnabled()).toBe(true);
  });

  it('reads FORCE_COLOR=0 as a refusal, not as "set"', async () => {
    const style = await load({ ...CLEAR, FORCE_COLOR: '0' }, true);
    expect(style.colorEnabled()).toBe(false);
  });

  it('leaves a dumb terminal alone', async () => {
    const style = await load({ ...CLEAR, TERM: 'dumb' }, true);
    expect(style.colorEnabled()).toBe(false);
  });
});

describe('composition', () => {
  it('carries a blank line with every heading, since output is written a line at a time', async () => {
    const style = await load({ ...CLEAR, NO_COLOR: '1' }, false);
    expect(style.heading('Audit gate')).toBe('\nAudit gate');
    expect(style.progress('Auditing…')).toBe('  · Auditing…');
  });

  it('escalates colour with severity', async () => {
    const style = await load(CLEAR, true);
    expect(style.bySeverity('critical')).toBe(style.red);
    expect(style.bySeverity('high')).toBe(style.red);
    expect(style.bySeverity('moderate')).toBe(style.yellow);
    expect(style.bySeverity('low')).toBe(style.dim);
  });
});
