/**
 * confirm() in non-interactive shells (agent runs, CI): the answer is the
 * call site's DECLARED default — never a hang on stdin, never an implicit
 * yes for destructive confirms. Only benign-by-design steps (init's MCP
 * registration) opt into nonTtyDefault:true; rm / passkey anchoring keep no.
 */
import { describe, it, expect } from 'vitest';
import { confirm } from './prompt.js';

describe('confirm in non-interactive shells', () => {
  it('defaults to no unless the call site opts in', async () => {
    // vitest runs without a TTY — exactly the agent-shell condition.
    expect(process.stdin.isTTY).toBeFalsy();
    await expect(confirm('remove this thing?')).resolves.toBe(false);
    await expect(confirm('benign setup step?', { nonTtyDefault: true })).resolves.toBe(true);
  });
});
