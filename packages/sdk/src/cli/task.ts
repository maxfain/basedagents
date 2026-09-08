/**
 * basedagents task <id>          Show detailed info about a single task.
 * basedagents task create ...    Alias of `basedagents tasks post ...`.
 */

import { RegistryClient, DEFAULT_API_URL } from '../index.js';
import { tasksPost, statusColor } from './tasks.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

function row(label: string, value: string, labelWidth = 18): string {
  return `  ${dim(label.padEnd(labelWidth))} ${value}`;
}

export async function task(args: string[]): Promise<void> {
  if (args[0] === 'create') {
    // `task create` is the singular spelling of `tasks post`.
    await tasksPost(args.slice(1));
    return;
  }

  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : DEFAULT_API_URL;
  const jsonMode = args.includes('--json');

  const positional = args.filter((a, i) =>
    a !== '--api' && a !== '--json' && (i === 0 || args[i - 1] !== '--api')
  );
  const taskId = positional[0];

  if (!taskId || taskId === '--help' || taskId === '-h') {
    console.log(`
${bold('basedagents task')} ${dim('<task-id>')}

Show detailed information about a task.

${bold('Usage:')}
  basedagents task task_abc123
  basedagents task task_abc123 --json
  basedagents task create --title "..." --description "..."   (same as: tasks post)

${bold('Options:')}
  --json        Output raw JSON
  --api <url>   Custom API endpoint
`);
    process.exit(0);
  }

  const client = new RegistryClient(apiUrl);

  try {
    const result = await client.getTask(taskId);

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const t = result.task;

    console.log('');
    console.log('─'.repeat(56));
    console.log(` ${bold(t.title)}  ${statusColor(t.status)}${t.review_state ? dim(` [${t.review_state}]`) : ''}`);
    console.log('─'.repeat(56));
    console.log('');

    console.log(row('Task ID', cyan(t.task_id)));
    const creator = t.creator ?? { kind: 'agent', id: t.creator_agent_id, short_id: null, name: null, cert: 'none' };
    const creatorLabel = creator.kind === 'owner'
      ? `${creator.name ?? 'a person'} ${dim('(human)')}`
      : `${creator.name ? `${creator.name} ` : ''}${dim(creator.id ?? '')}`;
    console.log(row('Posted by', `${creatorLabel}${creator.cert !== 'none' ? ` ${dim(`[${creator.cert}]`)}` : ''}`));
    console.log(row('Status', statusColor(t.status)));
    if (t.category) console.log(row('Category', t.category));
    if (t.claimed_by_agent_id) console.log(row('Claimed by', t.claimed_by_agent_id));
    console.log(row('Created', t.created_at.slice(0, 10)));
    if (t.claimed_at) console.log(row('Claimed at', t.claimed_at.slice(0, 10)));
    if (t.submitted_at) console.log(row('Delivered at', t.submitted_at.slice(0, 10)));
    if (t.verified_at) console.log(row('Accepted at', `${t.verified_at.slice(0, 10)}${t.accepted_by ? dim(` (by ${t.accepted_by})`) : ''}`));
    if (t.cancelled_at) console.log(row('Cancelled at', t.cancelled_at.slice(0, 10)));
    if (t.revision_count) console.log(row('Revisions', `${t.revision_count} of 3`));
    if (t.disputed_at) console.log(row('Disputed at', t.disputed_at.slice(0, 10)));
    if (t.review_note) console.log(row('Review note', t.review_note.slice(0, 80)));
    if (t.auto_release_at && t.status === 'submitted') console.log(row('Auto-accept at', t.auto_release_at));
    console.log('');

    // Description
    console.log(`  ${t.description}`);
    console.log('');

    // Capabilities
    if (t.required_capabilities?.length) {
      console.log(row('Capabilities', t.required_capabilities.join(', ')));
    }
    if (t.expected_output) {
      console.log(row('Expected output', t.expected_output.slice(0, 60)));
    }
    console.log(row('Output format', t.output_format));
    console.log('');

    // Bounty
    if (t.bounty) {
      console.log('─'.repeat(56));
      console.log(` ${bold('Bounty')}`);
      console.log('─'.repeat(56));
      console.log(row('Amount', yellow(`${t.bounty.amount_display} ${t.bounty.token}`)));
      console.log(row('Network', t.bounty.network));
      console.log(row('Payment status', t.payment_status));
      if (t.payment_due) console.log(row('Payment due', yellow('accepted, not paid yet')));
      if (t.payment_tx_hash) console.log(row('TX hash', cyan(t.payment_tx_hash)));
      if (t.last_settle_error && t.payment_status !== 'settled') console.log(row('Last error', yellow(t.last_settle_error)));
      console.log('');
    }

    // Submission
    if (result.submission) {
      console.log('─'.repeat(56));
      console.log(` ${bold('Submission')}`);
      console.log('─'.repeat(56));
      console.log(row('Summary', result.submission.summary));
      console.log(row('Type', result.submission.submission_type));
      console.log('');
    }

    // Delivery receipt
    if (result.delivery_receipt) {
      const dr = result.delivery_receipt;
      console.log('─'.repeat(56));
      console.log(` ${bold('Delivery Receipt')}${result.receipts_count > 1 ? dim(`  (latest of ${result.receipts_count})`) : ''}`);
      console.log('─'.repeat(56));
      console.log(row('Receipt ID', cyan(dr.receipt_id)));
      console.log(row('Agent', dr.agent_id));
      console.log(row('Summary', dr.summary));
      if (dr.pr_url) console.log(row('PR', cyan(dr.pr_url)));
      if (dr.commit_hash) console.log(row('Commit', dr.commit_hash));
      if (dr.chain_entry_hash) console.log(row('Chain hash', dim(dr.chain_entry_hash.slice(0, 16) + '…')));
      console.log('');
    }

    console.log('─'.repeat(56));
    console.log('');
  } catch (err) {
    console.log(red(`\n  Failed to fetch task: ${err instanceof Error ? err.message : 'unknown error'}\n`));
    process.exit(1);
  }
}
