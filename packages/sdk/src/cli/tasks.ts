/**
 * basedagents tasks [--status open] [--category code] [--limit 10]
 *
 * List tasks from the registry.
 */

import { RegistryClient } from '../index.js';
import type { Task } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

const API_URL = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';

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

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function tasks(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${bold('basedagents tasks')} ${dim('[options]')}

List tasks from the registry.

${bold('Options:')}
  --status <status>     Filter by status (open, claimed, submitted, verified, cancelled)
  --category <cat>      Filter by category (research, code, content, data, automation)
  --capability <cap>    Filter by required capability
  --limit <n>           Max results (default 20, max 100)
  --json                Output raw JSON
  --api <url>           Custom API endpoint
`);
    process.exit(0);
  }

  const apiUrl = getFlag(args, '--api') ?? API_URL;
  const jsonMode = args.includes('--json');
  const client = new RegistryClient(apiUrl);

  const params: Record<string, string> = {};
  const status = getFlag(args, '--status');
  const category = getFlag(args, '--category');
  const capability = getFlag(args, '--capability');
  const limit = getFlag(args, '--limit');

  if (status) params.status = status;
  if (category) params.category = category;
  if (capability) params.capability = capability;
  if (limit) params.limit = limit;

  try {
    const result = await client.getTasks(params);

    if (jsonMode) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    const taskList = result.tasks;
    if (!taskList.length) {
      console.log(dim('\n  No tasks found.\n'));
      return;
    }

    console.log('');
    console.log(`  ${bold(`${taskList.length} task${taskList.length !== 1 ? 's' : ''}`)}`);
    console.log('');

    for (const t of taskList) {
      const bounty = t.bounty_amount ? yellow(` ${t.bounty_amount} ${t.bounty_token ?? 'USDC'}`) : '';
      console.log(`  ${dim(t.task_id)}  ${statusColor(t.status)}${bounty}`);
      console.log(`  ${bold(t.title)}`);
      console.log(`  ${dim(t.description.slice(0, 80))}${t.description.length > 80 ? '…' : ''}`);
      if (t.category) console.log(`  ${dim('category:')} ${t.category}`);
      console.log('');
    }
  } catch (err) {
    console.log(red(`\n  Failed to fetch tasks: ${err instanceof Error ? err.message : 'unknown error'}\n`));
    process.exit(1);
  }
}
