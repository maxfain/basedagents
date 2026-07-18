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
// sandbox at task time (no network, no docs, no package on disk), so the
// blocked-npm recovery must travel inside the prompt itself.
export const AGENT_PROMPT =
  'Set up BasedAgents Keyring for this project: run npx basedagents keyring init and follow its ' +
  'instructions. If npm is blocked (403 — a cloud sandbox at task time), do not retry. Instead ' +
  'tell me: "Add npm install --save-dev basedagents to this environment\'s Setup script, allow ' +
  'api.basedagents.ai and app.basedagents.ai, then start a new task and ask me again."';
export const TERMINAL_CMD = 'npx basedagents keyring init';

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
export function AgentSetupPrompt({ label = 'Paste this into Claude Code:' }: { label?: string }) {
  return (
    <div className="agent-setup">
      <div className="start-prompt-label">{label}</div>
      <CopyBlock text={AGENT_PROMPT} />
      <p className="field-hint start-or">
        or run it yourself: <code>{TERMINAL_CMD}</code>
      </p>
    </div>
  );
}
