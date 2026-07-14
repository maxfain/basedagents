/**
 * Interactive input — hidden secret entry (raw mode, nothing echoed),
 * y/N confirmation, and piped-stdin reading. node:readline only, no deps.
 *
 * Prompts write to stderr so stdout stays clean for pipeable output.
 */

import * as readline from 'node:readline';
import { CliError } from './shared.js';

/** Read all of stdin (piped input). Strips one trailing newline. */
export async function readStdinAll(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin as AsyncIterable<Buffer | string>) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
}

/** Read one visible line (used for confirmations and non-TTY fallback). */
function readLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Prompt for a secret with echo disabled: the terminal is switched to raw
 * mode and keypresses are collected manually, so nothing is written back.
 * Enter submits, Backspace edits, Ctrl-C aborts (exit 130).
 */
export function promptHidden(question: string): Promise<string> {
  const input = process.stdin;
  if (!input.isTTY) {
    return readLine(question); // not interactive — no raw-mode dance possible
  }
  return new Promise<string>(resolve => {
    process.stderr.write(question);
    readline.emitKeypressEvents(input);
    const wasRaw = input.isRaw === true;
    input.setRawMode(true);
    input.resume();
    let value = '';

    function finish(): void {
      input.off('keypress', onKeypress);
      input.setRawMode(wasRaw);
      input.pause();
      process.stderr.write('\n');
    }

    function onKeypress(str: string | undefined, key: readline.Key | undefined): void {
      const name = key?.name;
      if (key?.ctrl && name === 'c') {
        finish();
        process.exit(130);
      }
      if (name === 'return' || name === 'enter' || (key?.ctrl && name === 'd')) {
        finish();
        resolve(value);
        return;
      }
      if (name === 'backspace') {
        value = value.slice(0, -1);
        return;
      }
      if (typeof str === 'string' && str.length > 0 && !key?.ctrl && !key?.meta) {
        value += str;
      }
    }

    input.on('keypress', onKeypress);
  });
}

/** y/N confirmation. Anything but y/yes (case-insensitive) is a no. */
export async function confirm(question: string): Promise<boolean> {
  const answer = (await readLine(`${question} [y/N] `)).trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

/**
 * Acquire a secret, in priority order:
 *   1. --value flag (warned — it can leak into shell history)
 *   2. piped stdin
 *   3. interactive hidden prompt
 */
export async function acquireSecret(valueFlag: string | undefined, promptLabel: string): Promise<string> {
  if (valueFlag !== undefined) {
    console.error('⚠ --value can leak secrets into shell history — prefer piping on stdin or the hidden prompt.');
    if (!valueFlag) throw new CliError('Secret value must not be empty');
    return valueFlag;
  }
  if (!process.stdin.isTTY) {
    const piped = await readStdinAll();
    if (!piped) throw new CliError('No secret on stdin — pipe one in, pass --value, or run interactively');
    return piped;
  }
  const value = await promptHidden(`${promptLabel} (input hidden): `);
  if (!value) throw new CliError('Empty secret — aborted');
  return value;
}
