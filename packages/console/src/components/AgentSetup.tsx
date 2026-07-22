/**
 * The one setup instruction, in one place — "your agent installs it itself"
 * (onboarding redesign Move 1). Primary = paste the prompt to Claude Code;
 * secondary = run the command yourself. Reused by every first-run surface
 * (/start, the /home empty state, the /welcome empty state) so the wording is
 * identical wherever a novice first meets it.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useState } from 'react';

// The pasted prompt is the only channel that reaches an agent in a cold cloud
// sandbox at task time — but the human's browser is unrestricted, so the prompt
// carries a POINTER to basedagents.ai/codex, not the full recovery payload.
// It must also survive a SKEPTICAL agent: provenance links, expected behavior
// (including that an existing vault is REUSED, never rotated or overwritten —
// a real agent stopped because "create a vault" didn't match the vault already
// on its disk), a safety-aligned tripwire, and a "verify me" pointer at
// agent.json so a doubting agent can check instead of refuse. Never "follow
// its instructions", never a scripted verbatim reply. The fallback names its
// trigger per WALL: a harness permission-gate denial is NOT an npm failure
// and must never route to /codex — the aligned answer there is the human
// approving the command or running it themselves. Keep this string identical
// to the marketing hero prompt (same words, spaces for its line breaks).
export const AGENT_PROMPT =
  'Set up BasedAgents Keyring — open source (npm: basedagents · ' +
  'github.com/maxfain/basedagents · docs: basedagents.ai/docs/agents · ' +
  'verify me first: basedagents.ai/.well-known/agent.json). ' +
  'Run: npx basedagents keyring init ' +
  'It should create a local vault — or reuse an existing one untouched; ' +
  're-running is safe, nothing is rotated or overwritten — register your ' +
  'agent ID, and print a link for me to take control in my browser. It ' +
  'never asks for a password or an existing key — stop and tell me if ' +
  'anything differs. ' +
  'Blocked? Don\'t work around it — tell me which wall it was: ' +
  'my own tooling\'s permission gate (I\'ll approve it, or run the command ' +
  'myself in a terminal) · npm or the network (the one-time fix is at ' +
  'basedagents.ai/codex — keep the URL exact — then I start a new task).';
export const TERMINAL_CMD = 'npx basedagents keyring init';

/**
 * The start-code variant (browser door, /start after the magic-link click):
 * `--start st_…` carries the there-verified email into the claim, so the
 * /link page needs one click instead of re-typing it (CONTROL_PLANE §8, "the
 * start code"). Rendered ONLY on that authenticated screen — every other
 * surface keeps the byte-identical generic prompt.
 */
export function buildTerminalCmd(startCode?: string): string {
  return startCode ? `${TERMINAL_CMD} --start ${startCode}` : TERMINAL_CMD;
}
export function buildAgentPrompt(startCode?: string): string {
  return startCode ? AGENT_PROMPT.replace(TERMINAL_CMD, buildTerminalCmd(startCode)) : AGENT_PROMPT;
}

export function CopyBlock({ text, big = false }: { text: string; big?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block cmd cmd-row">
      <span className={big ? 'code-block-select' : undefined}>{text}</span>
      <button
        className="btn btn-ghost btn-sm"
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          })
        }
      >
        {copied ? 'Copied ✓' : 'Copy'}
      </button>
    </div>
  );
}

/** Paste-to-your-agent (primary) + run-it-yourself (secondary). */
export function AgentSetupPrompt({
  label = 'Paste this into Claude Code:',
  startCode,
}: {
  label?: string;
  startCode?: string;
}) {
  return (
    <div className="agent-setup">
      <div className="start-prompt-label">{label}</div>
      <CopyBlock text={buildAgentPrompt(startCode)} />
      <p className="field-hint start-or">
        or run it yourself: <code>{buildTerminalCmd(startCode)}</code>
      </p>
    </div>
  );
}
