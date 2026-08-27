/**
 * /agents/new — add an agent, from whichever tool the human lives in.
 * Also serves as the zero state: /agents redirects here when nothing is
 * connected yet.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { Link } from 'react-router-dom';
import AddAgentGuide from '../components/AddAgentGuide.js';

export default function AddAgent() {
  return (
    <div className="page">
      <div className="page-head">
        <h1>Add an agent</h1>
      </div>
      <p className="page-lede">
        An agent is the AI that builds for you — Claude Code, Codex, Cursor. Pick the one you use;
        it sets itself up and shows up in the sidebar here.
      </p>
      <AddAgentGuide />
      <p className="field-hint guide-advanced">
        Advanced: <Link className="link" to="/delegations">connect an agent by its ID →</Link>
      </p>
    </div>
  );
}
