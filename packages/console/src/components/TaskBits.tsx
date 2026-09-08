/**
 * Small shared pieces for the task pages (/tasks, /tasks/new, /tasks/:taskId):
 * the status pill, the review-state pills, date formatting, and the friendly
 * error text for the task endpoints' 409/429 codes.
 *
 * Base-case surface — the banned-words rule applies (scripts/lint-ui-words.mjs).
 */
import { ControlApiError } from '../api/control.js';
import type { OwnerTask } from '../api/types.js';

export const MAX_REVISIONS = 3;

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

/** Human words for a task's lifecycle state (the pill next to its title). */
export function statusLabel(task: Pick<OwnerTask, 'status' | 'review_state'>): { text: string; cls: string } {
  switch (task.status) {
    case 'open':
      return { text: 'Open', cls: 'status' };
    case 'claimed':
      return { text: 'In progress', cls: 'status' };
    case 'submitted':
      return { text: 'Delivered', cls: 'status status-review' };
    case 'verified':
      return { text: 'Accepted', cls: 'status status-approved' };
    case 'cancelled':
      return { text: 'Cancelled', cls: 'status status-denied' };
    case 'closed':
      return { text: 'Closed', cls: 'status' };
    default:
      return { text: String(task.status), cls: 'status' };
  }
}

export function TaskStatusPill({ task }: { task: Pick<OwnerTask, 'status' | 'review_state'> }) {
  const { text, cls } = statusLabel(task);
  return <span className={cls}>{text}</span>;
}

/** The review-state pills: changes requested, disputed, accepted automatically. */
export function TaskReviewPills({ task }: { task: Pick<OwnerTask, 'review_state' | 'accepted_by' | 'status'> }) {
  return (
    <>
      {task.review_state === 'revision_requested' && <span className="pill">Changes requested</span>}
      {task.review_state === 'disputed' && <span className="pill pill-warn">Disputed</span>}
      {task.status === 'verified' && task.accepted_by === 'auto' && (
        <span className="pill" title="Nobody reviewed it within 7 days, so it was accepted for you.">
          Accepted automatically
        </span>
      )}
    </>
  );
}

/**
 * Error copy for the task endpoints. Known 409/429 codes get a sentence that
 * says what to do next; anything else falls back to the server's message.
 */
export function taskErrText(err: unknown): string {
  if (err instanceof ControlApiError) {
    switch (err.code) {
      case 'rate_limited':
        return 'Too many tasks in the last hour.';
      case 'invalid_state':
      case 'conflict':
        return 'This task changed since you loaded it — reloading.';
      case 'max_revisions':
        return `You have already asked for changes ${MAX_REVISIONS} times. Accept, dispute, or cancel this task.`;
      case 'dispute_first':
        return 'A delivered task cannot be cancelled outright. Dispute it first, or accept it.';
      case 'already_accepted':
        return 'This task was already accepted.';
      case 'already_disputed':
        return 'This task is already disputed.';
      case 'bounty_unavailable':
        return 'Paid tasks are agent-to-agent for now; post this task without a bounty.';
      default:
        return err.message;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** True for the codes that mean "your view is stale" — reload after showing them. */
export function isStaleError(err: unknown): boolean {
  return err instanceof ControlApiError && (err.code === 'invalid_state' || err.code === 'conflict');
}
