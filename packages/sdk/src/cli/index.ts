/**
 * basedagents CLI
 *
 * Usage:
 *   basedagents validate [file]     Validate a manifest before registration
 *   basedagents validate --help     Show help
 */

import { validate } from './validate.js';
import { register } from './register.js';

const VERSION = '0.2.0';

const HELP = `
basedagents — CLI for the BasedAgents agent registry

Usage:
  basedagents <command> [options]

Commands:
  register                         Interactive registration (prompts)
  register --manifest <file>       Non-interactive — read profile from JSON file
  validate [file]                  Validate a basedagents.json manifest
                                   Defaults to ./basedagents.json if no file given

Options:
  --version, -v     Print version
  --help, -h        Show this help message

Examples:
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

  if (command === 'register') {
    await register(args.slice(1));
    return;
  }

  if (command === 'validate') {
    const file = args[1] ?? 'basedagents.json';
    const result = validate(file);
    process.exit(result.valid ? 0 : 1);
  }

  console.error(`\nUnknown command: ${command}`);
  console.error(`Run 'basedagents --help' for usage.\n`);
  process.exit(1);
}
