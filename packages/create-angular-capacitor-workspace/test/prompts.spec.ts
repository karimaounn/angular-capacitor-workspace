import { describe, expect, it } from 'vitest';
import { nextKey } from '../src/prompts';

/** Everything a chunk of raw input can carry, read one key at a time. */
function keys(input: string): string[] {
  const read: string[] = [];
  let rest = input;
  while (rest.length > 0) {
    const step = nextKey(rest);
    rest = step.rest;
    if (step.key) {
      read.push(step.key.kind === 'digit' ? `digit:${step.key.value}` : step.key.kind);
    }
  }
  return read;
}

describe('nextKey', () => {
  it('reads the keys a list prompt answers to', () => {
    expect(keys('\u001B[A\u001B[B \r')).toEqual(['up', 'down', 'space', 'enter']);
  });

  it('reads the application-cursor arrows some terminals send', () => {
    expect(keys('\u001BOA\u001BOB')).toEqual(['up', 'down']);
  });

  it('takes a number as a jump to that option', () => {
    expect(keys('12')).toEqual(['digit:1', 'digit:2']);
  });

  it('takes Ctrl-C and Ctrl-D as an abort', () => {
    expect(keys('\u0003')).toEqual(['abort']);
    expect(keys('\u0004')).toEqual(['abort']);
  });

  it('swallows an escape sequence whole, so its tail is not read as letters', () => {
    // A mouse report, and Home — neither should toggle anything or move.
    expect(keys('\u001B[<0;1;1M\u001B[H\r')).toEqual(['enter']);
  });

  it('ignores anything else', () => {
    expect(keys('qz.')).toEqual([]);
  });

  it('hands back what is left, so keys typed ahead reach the next question', () => {
    const step = nextKey('\rios\n');
    expect(step.key).toEqual({ kind: 'enter' });
    expect(step.rest).toBe('ios\n');
  });
});
