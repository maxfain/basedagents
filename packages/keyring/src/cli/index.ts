/**
 * based — BasedAgents Keyring CLI.
 *
 * Scoped, revocable credentials bound to cryptographic agent identities:
 * secrets sealed to Ed25519 keys, grants with constraints, short-lived
 * leases, and a hash-chained signed access log.
 */

import { KeyringError } from '../keyring.js';
import { CliError } from './shared.js';
import { cmdExport, cmdVerifyLog } from './vault.js';
import { cmdInit } from './onboard.js';
import { cmdAdd, cmdUpdateSecret, cmdRemove, cmdCredentials } from './credentials.js';
import { cmdIdentity, cmdIdentities, cmdAgents } from './identities.js';
import { cmdGrant, cmdRevoke, cmdKill, cmdRequests, cmdApprove, cmdDeny } from './grants.js';
import { cmdTimeline } from './timeline.js';
import { cmdRun } from './run.js';
import { cmdDoctor } from './doctor.js';
import { cmdConnect } from './connect.js';
import { cmdAdmin, cmdMcp } from './serve.js';
import { cmdLink, cmdSync } from './sync.js';

const VERSION = '0.5.12';

const HELP = `
based — BasedAgents Keyring: scoped, revocable credentials for AI agents

Secrets are sealed to Ed25519 agent identities, delivered as short-lived
leases, and every access lands in a hash-chained signed log.

Usage:
  based <command> [options]

Vault:
  init                                  Set everything up: vault, agent, MCP config,
                                        and the browser link to take control
       [--name <agent name>] [--api <url>] [--yes] [--no-link] [--no-browser]
       [--bare] [--owner-keypair <file>]   (--bare = vault only, the old behavior)
  export [--out <file>]                 Signed JSON export of the access log
  verify-log                            Verify the log's hash chain + signatures

Credentials:
  connect <provider> [--agent <ref>] [--days <n>]
                                        Mint a scoped token for an agent — browser once to
                                        set up provisioning, then API-only (v1: vercel)
  add <label> [--provider <p>] [--env <VAR>] [--scope <s>] [--rotation <note>]
              [--provider-key-id <id>] [--value <secret>]
                                        Add a secret (--value, piped stdin, or hidden prompt)
  update-secret <cred> [--value <v>]    Replace a secret; re-seals to owner + active grantees
  rm <cred> [--yes]                     Remove a credential and all its grants
  credentials                           Every credential and who holds it

Identities:
  identity add <agent_id> [--name <n>] [--keypair <path>]
  identity rm <ref>
  identities                            List known identities
  agents                                Per-agent view: grants, leases, last access

Grants:
  grant <cred> <agent> [--expires <dur|iso>] [--max-ttl <seconds>]
                       [--max-uses <n>] [--project <tag>]
  revoke <grant_id> [--reason <r>]      Revoke one grant (new leases blocked instantly)
  kill <agent> [--reason <r>]           Kill switch: revoke ALL grants, then sweep for residual access
  doctor                                Sweep for ambient access outside Keyring (nonzero exit if any)
  requests [--all]                      Grant requests awaiting approval
  approve <request_id> --credential <cred> [grant options]
  deny <request_id> [--reason <r>]

Access:
  run [--agent <ref>] [--keypair <file>] [--context <c>] [--ttl <seconds>] -- <command...>
                                        Lease granted credentials, inject as env vars, run
  timeline [--agent <ref>] [--credential <cred>] [--project <tag>] [--type <event_type>]
           [--since <iso>] [--until <iso>] [--limit <n>]
                                        Human-readable access event stream

Servers:
  admin [--port <n>]                    Local admin UI (Ctrl-C to stop)
  mcp                                   MCP server on stdio (for agents)
  link [--api <url>] [--yes]            Anchor your console passkey(s) as owner authority
  sync [--api <url>] [--watch <secs>]   Apply owner-approved grants from the control plane

Global options:
  --dir <path>       Vault directory (default: $BASEDAGENTS_KEYRING_DIR or ~/.basedagents/keyring)
  --version, -v      Print version
  --help, -h         Show this help

Examples:
  based init
  printf %s "$STRIPE_KEY" | based add "Stripe key (prod)" --provider stripe --env STRIPE_SECRET_KEY
  based identity add ag_7Xk9... --name ci-bot --keypair ~/.basedagents/keys/ci-bot-keypair.json
  based grant STRIPE_SECRET_KEY ci-bot --expires 7d --max-uses 100
  based run --agent ci-bot -- npm run deploy
  based kill ci-bot --reason "compromised host"
`;

type CommandHandler = (args: string[], dir: string | undefined) => Promise<void>;

const COMMANDS: Record<string, CommandHandler> = {
  init: cmdInit,
  add: cmdAdd,
  connect: cmdConnect,
  'update-secret': cmdUpdateSecret,
  rm: cmdRemove,
  identity: cmdIdentity,
  identities: cmdIdentities,
  grant: cmdGrant,
  revoke: cmdRevoke,
  kill: cmdKill,
  agents: cmdAgents,
  credentials: cmdCredentials,
  requests: cmdRequests,
  approve: cmdApprove,
  deny: cmdDeny,
  timeline: cmdTimeline,
  doctor: cmdDoctor,
  export: cmdExport,
  'verify-log': cmdVerifyLog,
  run: cmdRun,
  admin: cmdAdmin,
  mcp: cmdMcp,
  link: cmdLink,
  sync: cmdSync,
};

/**
 * Pull the global `--dir <path>` flag out of argv (it may appear anywhere
 * before a bare `--`); everything else passes through untouched.
 */
function extractDir(args: string[]): { dir: string | undefined; rest: string[] } {
  const rest: string[] = [];
  let dir: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') {
      rest.push(...args.slice(i));
      break;
    }
    if (args[i] === '--dir') {
      dir = args[i + 1];
      if (dir === undefined) throw new CliError('Option --dir requires a value');
      i++;
      continue;
    }
    rest.push(args[i]);
  }
  return { dir, rest };
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const beforeSeparator = separator === -1 ? argv : argv.slice(0, separator);

  if (argv.length === 0 || beforeSeparator.includes('--help') || beforeSeparator.includes('-h')) {
    console.log(HELP);
    return;
  }
  if (beforeSeparator.includes('--version') || beforeSeparator.includes('-v')) {
    console.log(VERSION);
    return;
  }

  try {
    const { dir, rest } = extractDir(argv);
    const command = rest[0];
    const handler = command !== undefined ? COMMANDS[command] : undefined;
    if (!handler) {
      console.error(command ? `Unknown command: ${command}` : 'No command given.');
      console.error("Run 'based --help' for usage.");
      process.exitCode = 1;
      return;
    }
    await handler(rest.slice(1), dir);
  } catch (err) {
    if (err instanceof KeyringError || err instanceof CliError) {
      console.error(`Error: ${err.message}`);
    } else if (err instanceof Error) {
      console.error(`Error: ${err.message}`);
      if (process.env.BASEDAGENTS_DEBUG) console.error(err.stack);
    } else {
      console.error(`Error: ${String(err)}`);
    }
    process.exitCode = 1;
  }
}
