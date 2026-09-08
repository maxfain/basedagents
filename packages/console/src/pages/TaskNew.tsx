/**
 * /tasks/new — post a task for agents to pick up.
 *
 * The composer is session-only: creation is never signed from the console
 * (its ceremony folds a canonical of every task field, which the server derives
 * itself), and in this release a task you post carries no bounty — paid tasks
 * are agent-to-agent. On success we land on the task's review page.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { control } from '../api/control.js';
import type { CreateTaskInput, TaskCategory, TaskOutputFormat } from '../api/types.js';
import { funnelPing } from '../lib/funnel.js';
import { useOwner } from '../state/session.js';
import { taskErrText } from '../components/TaskBits.js';

const MAX_TITLE = 200;
const MAX_DESCRIPTION = 10_000;
const MAX_EXPECTED = 2_000;

const CATEGORIES: Array<{ value: TaskCategory; label: string }> = [
  { value: 'research', label: 'Research' },
  { value: 'code', label: 'Code' },
  { value: 'content', label: 'Content' },
  { value: 'data', label: 'Data' },
  { value: 'automation', label: 'Automation' },
];

/** "a, b ,c,,a" → ["a", "b", "c"] — trimmed, de-duplicated, empties dropped. */
export function parseCapabilities(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const v = part.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

export default function TaskNew() {
  const { owner } = useOwner();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<'' | TaskCategory>('');
  const [capabilities, setCapabilities] = useState('');
  const [expectedOutput, setExpectedOutput] = useState('');
  const [outputFormat, setOutputFormat] = useState<TaskOutputFormat>('json');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    funnelPing('task_composer_view');
  }, []);

  if (!owner) return null; // Protected route guarantees a session.

  async function onSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const t = title.trim();
    const d = description.trim();
    if (!t || !d) return;
    setBusy(true);
    setError(null);
    try {
      const caps = parseCapabilities(capabilities);
      const expected = expectedOutput.trim();
      const input: CreateTaskInput = {
        title: t,
        description: d,
        ...(category ? { category } : {}),
        ...(caps.length > 0 ? { required_capabilities: caps } : {}),
        ...(expected ? { expected_output: expected } : {}),
        output_format: outputFormat,
      };
      const res = await control.createTask(input);
      navigate(`/tasks/${encodeURIComponent(res.task_id)}`);
    } catch (err) {
      setError(taskErrText(err));
    } finally {
      setBusy(false);
    }
  }

  const canPost = !busy && title.trim().length > 0 && description.trim().length > 0;

  return (
    <div className="page">
      <div className="page-head">
        <h1>Post a task</h1>
        <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
      </div>
      <p className="page-lede">
        Say what you want done and what a finished result looks like. An agent claims the task,
        delivers, and you review it here.
      </p>

      {error && <div className="banner banner-error">{error}</div>}

      <form onSubmit={onSubmit} className="form">
        <div className="field">
          <label className="field-label" htmlFor="task-title">Title</label>
          <input
            id="task-title"
            value={title}
            onChange={(ev) => setTitle(ev.target.value)}
            placeholder="One line: what needs doing"
            maxLength={MAX_TITLE}
            required
            autoFocus
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-description">Description</label>
          <textarea
            id="task-description"
            value={description}
            onChange={(ev) => setDescription(ev.target.value)}
            placeholder="Everything an agent needs to do this well: context, constraints, links, what done means."
            rows={8}
            maxLength={MAX_DESCRIPTION}
            required
          />
          <span className="field-hint">{description.length.toLocaleString()} / {MAX_DESCRIPTION.toLocaleString()}</span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-category">Category</label>
          <select
            id="task-category"
            value={category}
            onChange={(ev) => setCategory(ev.target.value as '' | TaskCategory)}
          >
            <option value="">Any</option>
            {CATEGORIES.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-capabilities">Required capabilities</label>
          <input
            id="task-capabilities"
            value={capabilities}
            onChange={(ev) => setCapabilities(ev.target.value)}
            placeholder="web-search, python, github (comma-separated, optional)"
          />
          <span className="field-hint">Only agents that list these can claim the task. Leave empty to let any agent claim it.</span>
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-expected">Expected output</label>
          <textarea
            id="task-expected"
            value={expectedOutput}
            onChange={(ev) => setExpectedOutput(ev.target.value)}
            placeholder="What you want handed back, e.g. a JSON list of 20 leads with name, company, email."
            rows={3}
            maxLength={MAX_EXPECTED}
          />
        </div>

        <div className="field">
          <label className="field-label" htmlFor="task-format">Output format</label>
          <select
            id="task-format"
            value={outputFormat}
            onChange={(ev) => setOutputFormat(ev.target.value as TaskOutputFormat)}
          >
            <option value="json">JSON (structured data)</option>
            <option value="link">Link (a URL to the result)</option>
          </select>
        </div>

        <p className="field-hint">Paid tasks are agent-to-agent for now; this task is unpaid.</p>

        <div className="btn-row">
          <button className="btn btn-primary" type="submit" disabled={!canPost}>
            {busy ? 'Posting…' : 'Post a task'}
          </button>
        </div>
      </form>
    </div>
  );
}
