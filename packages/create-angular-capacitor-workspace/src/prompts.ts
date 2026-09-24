import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { style } from 'angular-capacitor-workspace';

const { bold, cyan, dim, MARK } = style;

/** What a keypress means here. Anything else is ignored. */
type Key =
  | { kind: 'up' }
  | { kind: 'down' }
  | { kind: 'space' }
  | { kind: 'enter' }
  | { kind: 'all' }
  | { kind: 'abort' }
  | { kind: 'digit'; value: number };

const CURSOR_HIDE = '\u001B[?25l';
const CURSOR_SHOW = '\u001B[?25h';
/** Move the cursor up `n` lines, to the first column, and clear what follows. */
const rewind = (n: number) => `\u001B[${n}A\r\u001B[0J`;
/** Colour codes, which occupy no columns when the width of a line is measured. */
const ANSI = /\u001B\[[0-9;]*m/g;
/** What a typed answer is preceded by, on the line below its question. */
const CURSOR = `${MARK.cursor} `;

/**
 * A minimal prompt layer over `node:readline` and raw stdin.
 *
 * No dependency, on purpose. This package exists to generate workspaces with a
 * defensible dependency set, and a prompt library — which is what the ecosystem
 * reaches for reflexively — would put a dozen transitive packages, and their
 * advisories, between a user and their first command. The whole argument of
 * this generator is that the strongest remedy is not installing the package.
 * It would be a strange tool that did not take its own advice.
 *
 * Lists are navigated with the arrow keys and answered with Return, the way
 * every other scaffolder does it, because nobody should have to type `android`
 * to pick the option they can already see. That needs raw mode, so on anything
 * that is not a terminal — a pipe, a CI job, the integration tests — the same
 * questions fall back to being answered by number or by name on one line.
 *
 * The styling is the same handful of escape codes, borrowed from the library so
 * the questions and the generation log read as one program. It collapses to
 * plain text off a terminal, and under `NO_COLOR`.
 */
export class Prompter {
  /** Whether the list prompts can take over the screen and read keys. */
  private readonly interactive = stdin.isTTY === true && stdout.isTTY === true;

  /** Opened on the first typed question, and kept until a list prompt wants stdin. */
  private rl: Interface | undefined;

  /** Off a terminal: every line stdin has produced that no question has taken yet. */
  private readonly queued: string[] = [];
  private waiting: ((line: string) => void) | undefined;
  private exhausted = false;

  close(): void {
    this.release();
    if (this.interactive) {
      stdout.write(CURSOR_SHOW);
    }
  }

  /**
   * `? Question (default)`, with the cursor to follow on the line below.
   *
   * Two lines rather than one because the answer then starts in the same column
   * every time, which is what makes a run of ten questions scan as a list
   * rather than as ragged prose. The frame is handed back rather than written
   * and forgotten, because answering the question redraws over exactly the rows
   * it took up.
   */
  private frame(question: string, hint?: string, warning?: string): string {
    const suffix = hint === undefined ? '' : ` ${dim(`(${hint})`)}`;
    const problem = warning === undefined ? '' : ` ${MARK.warn} ${dim(warning)}`;
    return `\n${MARK.prompt} ${bold(question)}${suffix}${problem}\n`;
  }

  /** The rows a question and its answer occupy, which is what a redraw walks back over. */
  private occupied(asked: string, typed: string): number {
    return rows(`${asked}${CURSOR}${typed}\n`);
  }

  /**
   * Replaces the question just answered with `✓ Question answer`.
   *
   * Scrollback from a finished run should read as a list of decisions, not as a
   * column of question marks standing next to the defaults nobody can tell were
   * taken. So the two lines the question occupied collapse into one: the mark
   * turns, the hint goes — whatever it offered has now been decided — and the
   * answer sits to the right of the question, where the list prompts already
   * put theirs. Off a terminal nothing can be redrawn, so the answer is echoed
   * after the cursor instead, which piped input otherwise leaves dangling.
   */
  private settle(asked: string, typed: string, question: string, answer: string): void {
    if (!this.interactive) {
      stdout.write(`${answer}\n`);
      return;
    }
    const summary = `\n${MARK.ok} ${bold(question)} ${cyan(answer)}\n`;
    stdout.write(rewind(this.occupied(asked, typed)) + summary);
  }

  /** Clears an answer that was not taken, so the question is asked again in place. */
  private retry(asked: string, typed: string): void {
    stdout.write(this.interactive ? rewind(this.occupied(asked, typed)) : '\n');
  }

  /**
   * One typed line.
   *
   * On a terminal readline earns its keep — echo, backspace, kill-line — and is
   * held open across questions; a list prompt releases it before taking stdin
   * raw, so the two never hold the stream at once. Off a terminal there is
   * nothing to edit, and readline's own line reading loses answers, so the
   * queue below reads them instead.
   */
  private async read(cursor = CURSOR): Promise<string> {
    if (this.interactive) {
      this.rl ??= createInterface({ input: stdin, output: stdout });
      // Handed to readline rather than written ahead of it: readline redraws
      // the line it owns from the first column on every keystroke, so a cursor
      // printed beforehand is wiped by the first character typed — and the
      // answer then sits in a column the redraw below has not accounted for.
      return (await this.rl.question(cursor)).trim();
    }
    stdout.write(cursor);
    return (await this.nextLine()).trim();
  }

  /**
   * The next line stdin has to offer, off a terminal.
   *
   * Asking readline one question at a time loses piped input: a `printf` feeds
   * every answer in a single chunk, and the lines that arrive while no question
   * is pending are read and discarded. So the lines are queued as they arrive
   * and questions take from the queue, which is what makes a scripted run — the
   * integration tests, a shell one-liner in a README — answer the same
   * questions a person does. After end-of-input every question reads empty,
   * which is what takes the defaults.
   */
  private nextLine(): Promise<string> {
    if (this.rl === undefined) {
      const rl = createInterface({ input: stdin });
      rl.on('line', (line) => this.deliver(line));
      rl.on('close', () => {
        this.exhausted = true;
        this.deliver('');
      });
      this.rl = rl;
    }

    const queued = this.queued.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (this.exhausted) return Promise.resolve('');
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }

  private deliver(line: string): void {
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting(line);
    } else if (!this.exhausted) {
      this.queued.push(line);
    }
  }

  /** Hands stdin back, so a list prompt can read it raw. */
  private release(): void {
    this.rl?.close();
    this.rl = undefined;
  }

  /**
   * One typed answer, asked until it is one.
   *
   * `validate` gives back the reason an answer is no good, and that reason is
   * shown against the question rather than printed beneath it: a rejected
   * answer should leave the screen as it found it, or a fat-fingered URL ends
   * up with three copies of its question on screen and only the last one live.
   */
  async text(
    question: string,
    fallback?: string,
    validate?: (value: string) => string | undefined,
  ): Promise<string> {
    let warning: string | undefined;
    for (;;) {
      const asked = this.frame(question, fallback, warning);
      stdout.write(asked);
      const typed = await this.read();
      // An empty line takes the default, which is then shown as the answer —
      // the alternative being a transcript that cannot tell a run that accepted
      // every default from one that was never answered at all.
      const answer = typed === '' && fallback !== undefined ? fallback : typed;

      if (answer === '') {
        // A question with no default and no more input to read would otherwise
        // ask itself forever, which off a terminal is a hung CI job.
        if (this.exhausted) {
          throw new Error(`Ran out of input at "${question}".`);
        }
        warning = undefined;
        this.retry(asked, typed);
        continue;
      }

      warning = validate?.(answer);
      if (warning !== undefined) {
        this.retry(asked, typed);
        continue;
      }

      this.settle(asked, typed, question, answer);
      return answer;
    }
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    const asked = this.frame(question, fallback ? 'Y/n' : 'y/N');
    stdout.write(asked);
    const typed = await this.read();
    const answer = typed === '' ? fallback : typed.toLowerCase().startsWith('y');
    this.settle(asked, typed, question, answer ? 'Yes' : 'No');
    return answer;
  }

  /** Single choice from a list: arrow keys and Return, or a number typed. */
  async select<T extends string>(
    question: string,
    choices: readonly { value: T; label: string }[],
    fallback: T,
  ): Promise<T> {
    if (!this.interactive) {
      return this.selectByLine(question, choices, fallback);
    }

    const start = choices.findIndex((choice) => choice.value === fallback);
    let active = start === -1 ? 0 : start;

    const draw = (): string => {
      const head = `\n${MARK.prompt} ${bold(question)} ${dim('· ↑↓ move · ⏎ select')}\n`;
      const rows = choices.map((choice, index) =>
        index === active ? `${cyan('❯')} ${cyan(choice.label)}\n` : `  ${dim(choice.label)}\n`,
      );
      return head + rows.join('');
    };

    const chosen = await this.run(draw, (key) => {
      if (key.kind === 'up') {
        active = (active - 1 + choices.length) % choices.length;
        return undefined;
      }
      if (key.kind === 'down') {
        active = (active + 1) % choices.length;
        return undefined;
      }
      if (key.kind === 'digit' && key.value >= 1 && key.value <= choices.length) {
        active = key.value - 1;
        return undefined;
      }
      if (key.kind === 'enter') return { done: choices[active]!.value };
      return undefined;
    });

    // Leave the answer behind, so scrollback reads as a transcript of the run
    // rather than as a list of questions whose answers scrolled away.
    const label = choices.find((choice) => choice.value === chosen)!.label;
    stdout.write(`\n${MARK.ok} ${bold(question)} ${cyan(label)}\n`);
    return chosen;
  }

  /** Several choices from a list: Space toggles, Return confirms. */
  async multi<T extends string>(
    question: string,
    choices: readonly { value: T; label: string }[],
    fallback: readonly T[] = [],
  ): Promise<T[]> {
    if (!this.interactive) {
      return this.multiByLine(question, choices, fallback);
    }

    const picked = new Set<T>(fallback);
    let active = 0;

    const draw = (): string => {
      const head = `\n${MARK.prompt} ${bold(question)} ${dim('· ↑↓ move · ␣ toggle · a all · ⏎ confirm')}\n`;
      const rows = choices.map((choice, index) => {
        const box = picked.has(choice.value) ? cyan('◉') : dim('◯');
        const pointer = index === active ? cyan('❯') : ' ';
        const label = index === active ? cyan(choice.label) : dim(choice.label);
        return `${pointer} ${box} ${label}\n`;
      });
      const none = picked.size === 0 ? `  ${dim('nothing selected')}\n` : '';
      return head + rows.join('') + none;
    };

    const selected = await this.run<T[]>(draw, (key) => {
      if (key.kind === 'up') {
        active = (active - 1 + choices.length) % choices.length;
        return undefined;
      }
      if (key.kind === 'down') {
        active = (active + 1) % choices.length;
        return undefined;
      }
      if (key.kind === 'space') {
        toggle(picked, choices[active]!.value);
        return undefined;
      }
      if (key.kind === 'digit' && key.value >= 1 && key.value <= choices.length) {
        active = key.value - 1;
        toggle(picked, choices[active]!.value);
        return undefined;
      }
      if (key.kind === 'all') {
        if (picked.size === choices.length) {
          picked.clear();
        } else {
          for (const choice of choices) picked.add(choice.value);
        }
        return undefined;
      }
      if (key.kind === 'enter') {
        return {
          done: choices.filter((choice) => picked.has(choice.value)).map((choice) => choice.value),
        };
      }
      return undefined;
    });

    const answer =
      selected.length === 0
        ? dim('none')
        : cyan(
            choices
              .filter((choice) => selected.includes(choice.value))
              .map((choice) => choice.label)
              .join(', '),
          );
    stdout.write(`\n${MARK.ok} ${bold(question)} ${answer}\n`);
    return selected;
  }

  /**
   * Draws the list, then redraws it on every keypress until the handler answers.
   *
   * Redrawing is done by walking back over exactly the lines just written and
   * clearing from there, rather than clearing the screen, so everything printed
   * before the question stays where it was.
   */
  private run<T>(draw: () => string, onKey: (key: Key) => { done: T } | undefined): Promise<T> {
    this.release();
    return new Promise<T>((resolve) => {
      const wasRaw = stdin.isRaw === true;
      stdin.setRawMode(true);
      stdin.resume();
      stdin.setEncoding('utf8');
      stdout.write(CURSOR_HIDE);

      let height = 0;
      const render = (): void => {
        const frame = draw();
        stdout.write((height > 0 ? rewind(height) : '') + frame);
        height = rows(frame);
      };

      const restore = (): void => {
        stdin.off('data', onData);
        stdin.setRawMode(wasRaw);
        stdin.pause();
        stdout.write(rewind(height) + CURSOR_SHOW);
      };

      const onData = (chunk: string): void => {
        // A chunk can carry several keys at once — a held arrow key, or a fast
        // typist — and whatever follows the answer belongs to the next question,
        // so it goes back on the stream rather than being dropped.
        let pending = chunk;
        while (pending.length > 0) {
          const { key, rest } = nextKey(pending);
          pending = rest;
          if (!key) continue;

          if (key.kind === 'abort') {
            restore();
            stdout.write('\n');
            process.exit(130);
          }
          const outcome = onKey(key);
          if (outcome) {
            restore();
            if (pending.length > 0) stdin.unshift(pending);
            resolve(outcome.done);
            return;
          }
        }
        render();
      };

      render();
      stdin.on('data', onData);
    });
  }

  /** The list prompts as one typed line, for when there is no terminal. */
  private async selectByLine<T extends string>(
    question: string,
    choices: readonly { value: T; label: string }[],
    fallback: T,
  ): Promise<T> {
    stdout.write(`\n${MARK.prompt} ${bold(question)}\n`);
    for (const [index, choice] of choices.entries()) {
      const isDefault = choice.value === fallback;
      const marker = isDefault ? MARK.ok : ' ';
      const label = isDefault ? choice.label : dim(choice.label);
      stdout.write(`  ${marker} ${dim(`${index + 1}`)}  ${label}\n`);
    }

    const answer = await this.read(`${CURSOR}${dim(`(${fallback})`)} `);
    const chosen = answer === '' ? fallback : match(choices, answer)?.value;
    if (chosen === undefined) {
      stdout.write(`\n  ${MARK.warn} ${dim('Not one of the options.')}\n`);
      return this.selectByLine(question, choices, fallback);
    }

    // Nothing echoes piped input, so the answer is written where it was typed.
    stdout.write(`${choices.find((choice) => choice.value === chosen)?.label ?? chosen}\n`);
    return chosen;
  }

  private async multiByLine<T extends string>(
    question: string,
    choices: readonly { value: T; label: string }[],
    fallback: readonly T[],
  ): Promise<T[]> {
    stdout.write(`\n${MARK.prompt} ${bold(question)} ${dim('(comma-separated)')}\n`);
    for (const [index, choice] of choices.entries()) {
      stdout.write(`    ${dim(`${index + 1}`)}  ${dim(choice.label)}\n`);
    }

    const hint = fallback.length > 0 ? fallback.join(',') : 'none';
    const answer = await this.read(`${CURSOR}${dim(`(${hint})`)} `);

    const selected: T[] = [];
    if (answer === '') {
      selected.push(...fallback);
    } else if (answer.toLowerCase() !== 'none') {
      for (const part of answer.split(',')) {
        const token = part.trim();
        const choice = match(choices, token);
        if (!choice) {
          stdout.write(`\n  ${MARK.warn} ${dim(`"${token}" is not one of the options.`)}\n`);
          return this.multiByLine(question, choices, fallback);
        }
        if (!selected.includes(choice.value)) {
          selected.push(choice.value);
        }
      }
    }

    const labels = choices
      .filter((choice) => selected.includes(choice.value))
      .map((choice) => choice.label);
    stdout.write(`${labels.length === 0 ? 'none' : labels.join(', ')}\n`);
    return selected;
  }
}

/**
 * How many terminal rows a frame occupies, so the redraw walks back over
 * exactly those and no further.
 *
 * Counting newlines is not enough: a long question on a narrow terminal is
 * wrapped by the terminal into several rows, and a redraw that ignored that
 * would leave the overflow on screen. Escape codes are stripped first, since
 * they take no columns.
 */
function rows(frame: string): number {
  const width = stdout.columns && stdout.columns > 0 ? stdout.columns : 80;
  const lines = frame.split('\n');
  lines.pop(); // Every frame ends with a newline; nothing follows it.
  return lines.reduce(
    (total, line) => total + Math.max(1, Math.ceil(line.replace(ANSI, '').length / width)),
    0,
  );
}

function toggle<T>(set: Set<T>, value: T): void {
  if (!set.delete(value)) set.add(value);
}

/** A typed answer, read as a 1-based index or as the exact value. */
function match<T extends string>(
  choices: readonly { value: T; label: string }[],
  token: string,
): { value: T; label: string } | undefined {
  const index = Number.parseInt(token, 10);
  if (Number.isInteger(index) && index >= 1 && index <= choices.length) {
    return choices[index - 1];
  }
  return choices.find((choice) => choice.value === token);
}

/**
 * Reads one key off the front of the input, and hands back what is left.
 *
 * Hand-rolled rather than `readline.emitKeypressEvents`, which would want an
 * interface holding stdin for the whole prompt — the thing the per-question
 * readline above exists to avoid.
 */
export function nextKey(input: string): { key?: Key; rest: string } {
  if (input.startsWith('\u001B[A') || input.startsWith('\u001BOA')) {
    return { key: { kind: 'up' }, rest: input.slice(3) };
  }
  if (input.startsWith('\u001B[B') || input.startsWith('\u001BOB')) {
    return { key: { kind: 'down' }, rest: input.slice(3) };
  }
  // Any other escape sequence — a mouse report, Home, a function key — is
  // swallowed whole so its tail does not arrive as stray letters.
  if (input.startsWith('\u001B')) {
    const end = input.slice(1).search(/[A-Za-z~]/);
    return { rest: end === -1 ? '' : input.slice(end + 2) };
  }

  const char = input[0]!;
  const rest = input.slice(1);

  if (char === '\r' || char === '\n') return { key: { kind: 'enter' }, rest };
  if (char === ' ') return { key: { kind: 'space' }, rest };
  if (char === '\u0003' || char === '\u0004') return { key: { kind: 'abort' }, rest };
  if (char === 'a' || char === 'A') return { key: { kind: 'all' }, rest };
  if (char >= '1' && char <= '9') return { key: { kind: 'digit', value: Number(char) }, rest };
  // Vim habits, since the fingers are already there.
  if (char === 'k') return { key: { kind: 'up' }, rest };
  if (char === 'j') return { key: { kind: 'down' }, rest };

  return { rest };
}
