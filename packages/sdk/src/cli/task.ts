/**
 * basedagents task <id>
 *
 * Show detailed info about a single task.
 */

import { RegistryClient } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

const API_URL = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';

function row(label: string, value: string, labelWidth = 18): string {
  return `  ${dim(label.padEnd(labelWidth))} ${value}`;
}

function statusColor(status: string): string {
  switch (status) {
    case 'open':      return green(status);
    case 'claimed':   return yellow(status);
    case 'submitted': return cyan(status);
    case 'verified':  return green(status);
    case 'cancelled': return red(status);
    default:          return status;
  }
}

export async function task(args: string[]): Promise<void> {
  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;
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
    console.log(` ${bold(t.title)}  ${statusColor(t.status)}`);
    console.log('─'.repeat(56));
    console.log('');

    console.log(row('Task ID', cyan(t.task_id)));
    console.log(row('Creator', t.creator_agent_id));
    console.log(row('Status', statusColor(t.status)));
    if (t.category) console.log(row('Category', t.category));
    if (t.claimed_by_agent_id) console.log(row('Claimed by', t.claimed_by_agent_id));
    console.log(row('Created', t.created_at.slice(0, 10)));
    if (t.claimed_at) console.log(row('Claimed at', t.claimed_at.slice(0, 10)));
    if (t.submitted_at) console.log(row('Submitted at', t.submitted_at.slice(0, 10)));
    if (t.verified_at) console.log(row('Verified at', t.verified_at.slice(0, 10)));
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
    if (t.bounty_amount) {
      console.log('─'.repeat(56));
      console.log(` ${bold('Bounty')}`);
      console.log('─'.repeat(56));
      console.log(row('Amount', yellow(`${t.bounty_amount} ${t.bounty_token ?? 'USDC'}`)));
      if (t.bounty_network) console.log(row('Network', t.bounty_network));
      console.log(row('Payment status', t.payment_status));
      if (t.payment_tx_hash) console.log(row('TX hash', cyan(t.payment_tx_hash)));
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
      console.log(` ${bold('Delivery Receipt')}`);
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
