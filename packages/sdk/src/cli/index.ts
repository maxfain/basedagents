/**
 * basedagents CLI
 *
 * Usage:
 *   basedagents validate [file]     Validate a manifest before registration
 *   basedagents validate --help     Show help
 */

import { validate } from './validate.js';
import { register } from './register.js';
import { init } from './init.js';
import { whois } from './whois.js';
import { check } from './check.js';
import { tasks } from './tasks.js';
import { task } from './task.js';
import { wallet } from './wallet.js';
import { scanCommand } from './scan.js';

const VERSION = '0.5.1';

const HELP = `
basedagents — CLI for BasedAgents

Usage:
  basedagents <command> [options]

Commands:
  init                             Interactive registration wizard
  whois <name-or-id>               Look up any agent by name or ID
  check <package-or-agent-id>      Check if a package/agent is trusted
  scan <package>                   Download & scan an npm package for dangerous patterns
  register                         Interactive registration (prompts)
  register --manifest <file>       Non-interactive — read profile from JSON file
  validate [file]                  Validate a basedagents.json manifest
                                   Defaults to ./basedagents.json if no file given
  tasks [--status open]            List tasks from the registry
  task <id>                        Show task detail
  wallet [set <address>]           Get or set your wallet address

Options:
  --version, -v     Print version
  --help, -h        Show this help message

Examples:
  npx basedagents init
  npx basedagents whois Hans
  npx basedagents whois ag_7Xk9mP2qR8nK4vL3
  npx basedagents check @some/mcp-server
  npx basedagents scan lodash
  npx basedagents scan @modelcontextprotocol/server-filesystem --json
  npx basedagents register
  npx basedagents register --manifest ./basedagents.json
  npx basedagents validate
  npx basedagents validate ./my-agent/basedagents.json

Docs: https://basedagents.ai/docs
`;

export async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  if (args.includes('--version') || args.includes('-v')) {
    console.log(VERSION);
    process.exit(0);
  }

  const command = args[0];

  if (command === 'init') {
    await init(args.slice(1));
    return;
  }

  if (command === 'whois') {
    await whois(args.slice(1));
    return;
  }

  if (command === 'register') {
    await register(args.slice(1));
    return;
  }

  if (command === 'tasks') {
    await tasks(args.slice(1));
    return;
  }

  if (command === 'task') {
    await task(args.slice(1));
    return;
  }

  if (command === 'wallet') {
    await wallet(args.slice(1));
    return;
  }

  if (command === 'validate') {
    const file = args[1] ?? 'basedagents.json';
    const result = validate(file);
    process.exit(result.valid ? 0 : 1);
  }

  if (command === 'scan') {
    await scanCommand(args.slice(1));
    return;
  }

  if (command === 'check') {
    await check(args.slice(1));
    return;
  }

  console.error(`\nUnknown command: ${command}`);
  console.error(`Run 'basedagents --help' for usage.\n`);
  process.exit(1);
}
