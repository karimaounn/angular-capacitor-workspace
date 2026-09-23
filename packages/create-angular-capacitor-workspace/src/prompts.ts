import { createInterface, type Interface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { style } from 'angular-capacitor-workspace';

const { bold, dim, MARK } = style;

/**
 * A minimal prompt layer over `node:readline`.
 *
 * No dependency, on purpose. This package exists to generate workspaces with a
 * defensible dependency set, and a prompt library — which is what the ecosystem
 * reaches for reflexively — would put a dozen transitive packages, and their
 * advisories, between a user and their first command. The whole argument of
 * this generator is that the strongest remedy is not installing the package.
 * It would be a strange tool that did not take its own advice.
 *
 * The styling is the same handful of escape codes, borrowed from the library so
 * the questions and the generation log read as one program. It collapses to
 * plain text off a terminal, and under `NO_COLOR`.
 */
export class Prompter {
  private readonly rl: Interface;

  constructor() {
    this.rl = createInterface({ input: stdin, output: stdout });
  }

  close(): void {
    this.rl.close();
  }

  /**
   * `? Question (default)` on its own line, then the cursor.
   *
   * Two lines rather than one because the answer then starts in the same column
   * every time, which is what makes a run of ten questions scan as a list
   * rather than as ragged prose.
   */
  private line(question: string, hint?: string): string {
    const suffix = hint === undefined ? '' : ` ${dim(`(${hint})`)}`;
    return `\n${MARK.prompt} ${bold(question)}${suffix}\n${MARK.cursor} `;
  }

  async text(question: string, fallback?: string): Promise<string> {
    const answer = (await this.rl.question(this.line(question, fallback))).trim();
    if (answer === '' && fallback !== undefined) {
      return fallback;
    }
    if (answer === '') {
      return this.text(question, fallback);
    }
    return answer;
  }

  async confirm(question: string, fallback = true): Promise<boolean> {
    const hint = fallback ? 'Y/n' : 'y/N';
    const answer = (await this.rl.question(this.line(question, hint))).trim().toLowerCase();
    if (answer === '') return fallback;
    return answer.startsWith('y');
  }

  /** Single choice from a list, answered by number or by exact value. */
  async select<T extends string>(
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

    const answer = (await this.rl.question(`${MARK.cursor} ${dim(`(${fallback})`)} `)).trim();
    if (answer === '') return fallback;

    const byIndex = Number.parseInt(answer, 10);
    if (Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length) {
      return choices[byIndex - 1]!.value;
    }

    const byValue = choices.find((choice) => choice.value === answer);
    if (byValue) return byValue.value;

    stdout.write(`  ${MARK.warn} ${dim('Not one of the options.')}\n`);
    return this.select(question, choices, fallback);
  }

  /** Comma-separated multi-choice. An empty answer selects nothing. */
  async multi<T extends string>(
    question: string,
    choices: readonly { value: T; label: string }[],
    fallback: readonly T[] = [],
  ): Promise<T[]> {
    stdout.write(`\n${MARK.prompt} ${bold(question)} ${dim('(comma-separated)')}\n`);
    for (const [index, choice] of choices.entries()) {
      stdout.write(`    ${dim(`${index + 1}`)}  ${dim(choice.label)}\n`);
    }

    const hint = fallback.length > 0 ? fallback.join(',') : 'none';
    const answer = (await this.rl.question(`${MARK.cursor} ${dim(`(${hint})`)} `)).trim();
    if (answer === '') return [...fallback];
    if (answer.toLowerCase() === 'none') return [];

    const selected: T[] = [];
    for (const part of answer.split(',')) {
      const token = part.trim();
      const byIndex = Number.parseInt(token, 10);
      const choice =
        Number.isInteger(byIndex) && byIndex >= 1 && byIndex <= choices.length
          ? choices[byIndex - 1]
          : choices.find((candidate) => candidate.value === token);

      if (!choice) {
        stdout.write(`  ${MARK.warn} ${dim(`"${token}" is not one of the options.`)}\n`);
        return this.multi(question, choices, fallback);
      }
      if (!selected.includes(choice.value)) {
        selected.push(choice.value);
      }
    }
    return selected;
  }
}
