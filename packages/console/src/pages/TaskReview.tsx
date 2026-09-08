/**
 * /tasks/:taskId — one task you posted: what you asked for, what came back
 * (every delivery, newest first), and the review actions for its state.
 *
 *   submitted            → Accept (optional note) · Request changes (note, max 3) · Dispute (reason)
 *   submitted + disputed → Accept · Cancel task
 *   open | claimed       → Cancel task
 *   verified             → "Accepted on <date>" (+ "accepted automatically" after the 7-day window)
 *
 * Reviews work on your sign-in alone. When the account holds a passkey, each
 * review is also signed: the action string binds the task id and the sha256 of
 * the note you typed (`task.accept:<id>:<sha256hex(note)>`), the server
 * re-derives it from the body it receives, and {nonce, assertion} ride along.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { control, ControlApiError } from '../api/control.js';
import type { SignedAction } from '../api/control.js';
import type { OwnerTask, OwnerTaskDetail, OwnerTaskReceipt } from '../api/types.js';
import { sha256hex } from '../lib/action.js';
import { runAction } from '../lib/ceremony.js';
import { useOwner } from '../state/session.js';
import {
  MAX_REVISIONS,
  TaskReviewPills,
  TaskStatusPill,
  fmtDate,
  isStaleError,
  taskErrText,
} from '../components/TaskBits.js';

const MAX_NOTE = 2_000;

interface Milestone {
  key: string;
  at: string;
  label: string;
}

/** The task's history in time order, from the timestamps the task carries. */
function milestones(task: OwnerTask, claimer: string | null): Milestone[] {
  const out: Milestone[] = [{ key: 'posted', at: task.created_at, label: 'Posted' }];
  if (task.claimed_at) out.push({ key: 'claimed', at: task.claimed_at, label: claimer ? `Claimed by ${claimer}` : 'Claimed' });
  if (task.revision_requested_at) out.push({ key: 'revision', at: task.revision_requested_at, label: 'Changes requested' });
  if (task.submitted_at) out.push({ key: 'delivered', at: task.submitted_at, label: 'Delivered' });
  if (task.disputed_at) out.push({ key: 'disputed', at: task.disputed_at, label: 'Disputed' });
  if (task.verified_at) {
    out.push({
      key: 'accepted',
      at: task.verified_at,
      label: task.accepted_by === 'auto' ? 'Accepted automatically' : 'Accepted',
    });
  }
  if (task.cancelled_at) out.push({ key: 'cancelled', at: task.cancelled_at, label: 'Cancelled' });
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

function ReceiptCard({ receipt, latest }: { receipt: OwnerTaskReceipt; latest: boolean }) {
  const links = receipt.artifact_urls ?? [];
  return (
    <li className="card">
      <div className="card-main">
        <div className="card-title">
          <span>{latest ? 'Latest delivery' : 'Earlier delivery'}</span>
          {receipt.agent_name && <span className="muted">by {receipt.agent_name}</span>}
        </div>
        <p className="prewrap">{receipt.summary}</p>
        {(links.length > 0 || receipt.pr_url || receipt.commit_hash) && (
          <div className="receipt-links">
            {links.map((u) => (
              <a key={u} href={u} target="_blank" rel="noreferrer noopener">{u}</a>
            ))}
            {receipt.pr_url && (
              <a href={receipt.pr_url} target="_blank" rel="noreferrer noopener">Pull request</a>
            )}
            {receipt.commit_hash && (
              <code title={receipt.commit_hash}>commit {receipt.commit_hash.slice(0, 12)}</code>
            )}
          </div>
        )}
        <div className="card-meta">
          <span>Completed {fmtDate(receipt.completed_at)}</span>
          <span className="dot">·</span>
          <code className="muted" title={receipt.receipt_id}>{receipt.receipt_id}</code>
        </div>
      </div>
    </li>
  );
}

export default function TaskReview() {
  const { taskId = '' } = useParams<{ taskId: string }>();
  const { owner } = useOwner();
  const [detail, setDetail] = useState<OwnerTaskDetail | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null); // 'accept' | 'revision' | 'dispute' | 'cancel'
  const [error, setError] = useState<string | null>(null);
  const [notFound, setNotFound] = useState(false);
  const ownerId = owner?.owner_id;

  const load = useCallback(async () => {
    if (!ownerId || !taskId) return;
    try {
      setDetail(await control.task(taskId));
      setNotFound(false);
    } catch (err) {
      if (err instanceof ControlApiError && err.status === 404) {
        setNotFound(true);
      } else {
        setError(taskErrText(err));
      }
    }
  }, [ownerId, taskId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** The passkey half of a review, when the account has one; nothing otherwise. */
  async function sign(actionType: string): Promise<SignedAction | undefined> {
    if (!owner?.has_passkey) return undefined;
    // The canonical is {action_type, owner_id, nonce} — the content lives in
    // the action string itself, so there are no extra params to mirror.
    return runAction(owner.owner_id, actionType, {});
  }

  async function run(kind: string, fn: () => Promise<unknown>): Promise<void> {
    setBusy(kind);
    setError(null);
    try {
      await fn();
      setNote('');
      await load();
    } catch (err) {
      setError(taskErrText(err));
      if (isStaleError(err)) await load();
    } finally {
      setBusy(null);
    }
  }

  async function onAccept(): Promise<void> {
    const text = note.trim();
    await run('accept', async () => {
      const signed = await sign(`task.accept:${taskId}:${sha256hex(text)}`);
      await control.acceptTask(taskId, text ? text : undefined, signed);
    });
  }

  async function onRequestChanges(): Promise<void> {
    const text = note.trim();
    if (!text) {
      setError('Say what should change — the note goes to the agent that delivered.');
      return;
    }
    await run('revision', async () => {
      const signed = await sign(`task.revision:${taskId}:${sha256hex(text)}`);
      await control.requestTaskRevision(taskId, text, signed);
    });
  }

  async function onDispute(): Promise<void> {
    const text = note.trim();
    if (!text) {
      setError('Say why you are disputing this delivery — the reason goes on the record.');
      return;
    }
    if (!window.confirm('Dispute this work? Automatic acceptance pauses until you accept or cancel.')) return;
    await run('dispute', async () => {
      const signed = await sign(`task.dispute:${taskId}:${sha256hex(text)}`);
      await control.disputeTask(taskId, text, signed);
    });
  }

  async function onCancel(): Promise<void> {
    if (!window.confirm('Cancel this task? Agents can no longer claim or deliver it. This cannot be undone.')) return;
    await run('cancel', async () => {
      const signed = await sign(`task.cancel:${taskId}`);
      await control.cancelTask(taskId, signed);
    });
  }

  if (!owner) return null; // Protected route guarantees a session.

  if (notFound) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Task not found</h1>
          <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
        </div>
        <p className="page-lede">This task is not one of yours, or it no longer exists.</p>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="page">
        <div className="page-head">
          <h1>Task</h1>
          <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
        </div>
        {error ? <div className="banner banner-error">{error}</div> : <div className="empty"><p className="muted">Loading…</p></div>}
      </div>
    );
  }

  const task = detail.task;
  const receipts = detail.receipts ?? (detail.delivery_receipt ? [detail.delivery_receipt] : []);
  const claimer = task.claimer_name ?? receipts[0]?.agent_name ?? task.claimed_by_agent_id;
  const disputed = task.review_state === 'disputed';
  const reviewing = task.status === 'submitted';
  const cancellable = task.status === 'open' || task.status === 'claimed' || (reviewing && disputed);
  const revisionsLeft = Math.max(0, MAX_REVISIONS - (task.revision_count ?? 0));
  const capabilities = task.required_capabilities ?? [];

  return (
    <div className="page">
      <div className="page-head agent-head">
        <div>
          <h1>{task.title}</h1>
          <div className="card-meta">
            <TaskStatusPill task={task} />
            <TaskReviewPills task={task} />
            {task.category && <span className="pill">{task.category}</span>}
            <code className="muted" title={task.task_id}>{task.task_id}</code>
          </div>
        </div>
        <Link to="/tasks" className="btn btn-ghost">Back to tasks</Link>
      </div>

      {error && <div className="banner banner-error">{error}</div>}

      {task.status === 'verified' && (
        <div className="banner banner-ok" data-testid="task-accepted">
          Accepted on {fmtDate(task.verified_at)}
          {task.accepted_by === 'auto' && ' — accepted automatically after 7 days without a review.'}
          {task.accepted_by !== 'auto' && '.'}
        </div>
      )}
      {task.status === 'cancelled' && (
        <div className="banner banner-warn">Cancelled on {fmtDate(task.cancelled_at)}.</div>
      )}
      {reviewing && disputed && (
        <div className="banner banner-warn">
          You disputed this delivery{task.disputed_at ? ` on ${fmtDate(task.disputed_at)}` : ''}. Automatic
          acceptance is paused until you accept or cancel.
        </div>
      )}
      {task.status === 'claimed' && task.review_state === 'revision_requested' && (
        <div className="banner banner-warn">
          You asked for changes{task.revision_requested_at ? ` on ${fmtDate(task.revision_requested_at)}` : ''}. The
          agent that delivered can send a new version; you will review it here.
        </div>
      )}

      <section className="panel">
        <h2>What you asked for</h2>
        <p className="prewrap">{task.description}</p>
        {task.expected_output && (
          <>
            <div className="side-head">Expected output</div>
            <p className="prewrap">{task.expected_output}</p>
          </>
        )}
        <div className="kv">
          <span className="kv-key">Output format</span>
          <span>{task.output_format === 'link' ? 'Link' : 'JSON'}</span>
        </div>
        {capabilities.length > 0 && (
          <div className="chips">
            {capabilities.map((c) => <span key={c} className="chip">{c}</span>)}
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Timeline</h2>
        <ul className="timeline">
          {milestones(task, claimer).map((m) => (
            <li key={`${m.key}-${m.at}`}>
              <span className="timeline-label">{m.label}</span>
              <span className="muted">{fmtDate(m.at)}</span>
            </li>
          ))}
        </ul>
        {task.review_note && (
          <>
            <div className="side-head">Your latest note</div>
            <p className="prewrap card-note">{task.review_note}</p>
          </>
        )}
      </section>

      {(reviewing || cancellable) && (
        <section className="panel" data-testid="task-review-actions">
          <h2>{reviewing ? 'Your review' : 'Actions'}</h2>
          {reviewing && (
            <div className="form">
              <div className="field">
                <label className="field-label" htmlFor="review-note">
                  {disputed ? 'Note (optional)' : 'Note to the agent that delivered'}
                </label>
                <textarea
                  id="review-note"
                  value={note}
                  onChange={(ev) => setNote(ev.target.value)}
                  placeholder={disputed
                    ? 'Optional: a word on why you are accepting after all.'
                    : 'Optional when you accept. Required when you ask for changes or dispute.'}
                  rows={3}
                  maxLength={MAX_NOTE}
                  disabled={busy !== null}
                />
              </div>
            </div>
          )}
          <div className="btn-row review-actions">
            {reviewing && (
              <button className="btn btn-primary" onClick={() => void onAccept()} disabled={busy !== null}>
                {busy === 'accept' ? 'Accepting…' : 'Accept'}
              </button>
            )}
            {reviewing && !disputed && (
              <>
                <button
                  className="btn btn-ghost"
                  onClick={() => void onRequestChanges()}
                  disabled={busy !== null || revisionsLeft === 0}
                  title={revisionsLeft === 0 ? `You have used all ${MAX_REVISIONS} change requests.` : undefined}
                >
                  {busy === 'revision' ? 'Sending…' : 'Request changes'}
                </button>
                <span className="muted revision-count">{task.revision_count ?? 0} of {MAX_REVISIONS} used</span>
                <button className="btn btn-danger" onClick={() => void onDispute()} disabled={busy !== null}>
                  {busy === 'dispute' ? 'Disputing…' : 'Dispute'}
                </button>
              </>
            )}
            {cancellable && (
              <button className="btn btn-danger" onClick={() => void onCancel()} disabled={busy !== null}>
                {busy === 'cancel' ? 'Cancelling…' : 'Cancel task'}
              </button>
            )}
          </div>
        </section>
      )}

      <h2 className="page-subhead">Deliveries</h2>
      {receipts.length === 0 ? (
        <div className="empty">
          <p className="muted">Nothing delivered yet.</p>
        </div>
      ) : (
        <ul className="cards">
          {receipts.map((r, i) => <ReceiptCard key={r.receipt_id} receipt={r} latest={i === 0} />)}
        </ul>
      )}
    </div>
  );
}
