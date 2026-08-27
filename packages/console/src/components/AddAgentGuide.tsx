/**
 * "Add an agent", by tool — the zero state and the add-another page share this.
 * One tab per place an agent lives (Claude Code, Codex, Cursor, a terminal);
 * every tab hands over the SAME setup prompt (components/AgentSetup.tsx), so
 * the wording an agent receives never depends on which door the human picked.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AgentSetupPrompt, CopyBlock, TERMINAL_CMD } from './AgentSetup.js';

const TOOLS = ['Claude Code', 'Codex', 'Cursor', 'Terminal'] as const;
type Tool = (typeof TOOLS)[number];

export default function AddAgentGuide({ startCode }: { startCode?: string }) {
  const [tool, setTool] = useState<Tool>('Claude Code');

  return (
    <div className="guide">
      <div className="tabs" role="tablist" aria-label="Where does your agent live?">
        {TOOLS.map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tool === t}
            className={tool === t ? 'tab active' : 'tab'}
            onClick={() => setTool(t)}
          >
            {t}
          </button>
        ))}
      </div>

      <div className="tab-panel">
        {tool === 'Claude Code' && (
          <>
            <AgentSetupPrompt label="Paste this into Claude Code:" startCode={startCode} />
            <p className="field-hint">
              Claude Code sets everything up and prints a link. Open the link — that puts you in
              charge right here.
            </p>
          </>
        )}

        {tool === 'Codex' && (
          <>
            <AgentSetupPrompt label="Paste this into Codex:" startCode={startCode} />
            <p className="field-hint">
              Codex sets everything up and prints a link. Open the link — that puts you in charge
              right here.
            </p>
            <p className="field-hint">
              Working in a cloud workspace (Codex on the web)? If it hits a network wall, the
              one-time fix is at{' '}
              <a className="link" href="https://basedagents.ai/codex" target="_blank" rel="noreferrer">
                basedagents.ai/codex
              </a>
              . Once it&rsquo;s connected, the <Link className="link" to="/welcome">Welcome page</Link>{' '}
              can make your agent permanent across workspaces.
            </p>
          </>
        )}

        {tool === 'Cursor' && (
          <>
            <AgentSetupPrompt label="Paste this into Cursor's agent chat (⌘I):" startCode={startCode} />
            <p className="field-hint">
              Cursor sets everything up and prints a link. Open the link — that puts you in charge
              right here.
            </p>
          </>
        )}

        {tool === 'Terminal' && (
          <>
            <div className="agent-setup">
              <div className="start-prompt-label">Run this in any terminal on your computer:</div>
              <CopyBlock text={TERMINAL_CMD} />
            </div>
            <p className="field-hint">
              It walks you through setup and prints a link at the end — open the link and you&rsquo;re
              in charge here.
            </p>
          </>
        )}
      </div>

      <p className="field-hint guide-footer">
        Whatever the tool, the moves are the same: your agent asks, you approve with a tap, and you
        can cut it off any time.
      </p>
    </div>
  );
}
