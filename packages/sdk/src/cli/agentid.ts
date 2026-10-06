/**
 * `basedagents agentid` — link a verified AgentID (https://agentid.com) to your
 * agent, check link status, or unlink.
 *
 * AgentID is an OPTIONAL attestation on top of AgentSig: the agent proves
 * control of its ag_… signing key to START a link (this command signs the
 * request), then the owner proves control of the AgentID by signing in through
 * the browser URL this prints. It never replaces request signing.
 */

import {
  RegistryClient,
  DEFAULT_API_URL,
  publicKeyToAgentId,
  ApiError,
  type AgentKeypair,
} from '../index.js';
import { loadKeypair } from './wallet.js';

const R = '\x1b[0m';
const bold = (s: string) => `\x1b[1m${s}${R}`;
const dim = (s: string) => `\x1b[2m${s}${R}`;
const red = (s: string) => `\x1b[31m${s}${R}`;
const green = (s: string) => `\x1b[32m${s}${R}`;
const cyan = (s: string) => `\x1b[36m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;

/** Needs an external browser step the CLI can't perform — matches `wallet set`. */
const EXIT_LINK_PENDING = 2;
const EXIT_TIMEOUT = 3;

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

const HELP = `
${bold('basedagents agentid')} ${dim('<link | status | unlink>')}

Link a verified AgentID (an OIDC identity backed by a verified AgentMail inbox)
to your agent. This is an optional attestation on top of AgentSig — it adds a
verified-identity badge and an owner grouping key for sybil-aware reputation,
and never replaces request signing.

${bold('Usage:')}
  basedagents agentid link                 Start a link: prints a sign-in URL, then
                                           waits until you finish in the browser
  basedagents agentid link --no-wait       Print the URL + link id and exit (poll later)
  basedagents agentid status [<id|name>]   Show verified-identity status (yours by default)
  basedagents agentid unlink               Remove your AgentID link

${bold('Options:')}
  --no-wait            Don't poll; print the sign-in URL and link id, exit ${EXIT_LINK_PENDING}
  --timeout <minutes>  How long to wait for the browser step (default 10)
  --keypair <file>     Keypair file (or filename in ~/.basedagents/keys/);
                       default $BASEDAGENTS_KEYPAIR_PATH, else the last key there
  --json               Output raw JSON
  --api <url>          Custom API endpoint

Needs the registry to have AgentID enabled (GET /v1/status -> agentid).
`;

function getFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i !== -1 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Flags that take no value; every other `--flag` consumes the next token. */
const BOOLEAN_FLAGS = new Set(['--json', '--no-wait', '--help', '-h']);

/** The first positional arg, skipping flags and the values they consume. */
function firstPositional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-') && a.length > 1) {
      if (!BOOLEAN_FLAGS.has(a)) i++; // skip this flag's value
      continue;
    }
    return a;
  }
  return undefined;
}

function keypairOrExit(keypairFile: string | undefined): AgentKeypair {
  try {
    return loadKeypair(keypairFile);
  } catch (err) {
    console.error(red(`\n  ✗ ${err instanceof Error ? err.message : 'Failed to load keypair'}\n`));
    process.exit(1);
  }
}

/** Friendly message for the "AgentID not enabled on this registry" 503. */
function explainApiError(err: ApiError): string {
  if (err.status === 503 && err.code === 'agentid_unavailable') {
    return 'This registry has not enabled AgentID linking (GET /v1/status -> agentid).';
  }
  return err.message;
}

export async function agentid(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    return;
  }

  const apiUrl = getFlag(args, '--api') ?? DEFAULT_API_URL;
  const jsonMode = args.includes('--json');
  const keypairFile = getFlag(args, '--keypair');
  const client = new RegistryClient(apiUrl);
  const sub = args[0] && !args[0].startsWith('-') ? args[0] : 'link';
  const rest = args.slice(sub === args[0] ? 1 : 0);

  if (sub === 'status') {
    await runStatus(client, firstPositional(rest), keypairFile, jsonMode);
    return;
  }
  if (sub === 'unlink') {
    await runUnlink(client, keypairFile, jsonMode);
    return;
  }
  if (sub !== 'link') {
    console.error(red(`\n  ✗ Unknown subcommand: ${sub}\n`));
    console.log(HELP);
    process.exit(1);
  }

  // ── link ──
  const kp = keypairOrExit(keypairFile);
  const agentId = publicKeyToAgentId(kp.publicKey);
  const noWait = args.includes('--no-wait');
  const timeoutMin = Number(getFlag(args, '--timeout') ?? '10');

  let start;
  try {
    start = await client.startAgentIdLink(kp);
  } catch (err) {
    if (err instanceof ApiError) {
      console.error(red(`\n  ✗ ${explainApiError(err)}\n`));
      process.exit(1);
    }
    throw err;
  }

  if (jsonMode && noWait) {
    console.log(JSON.stringify(start, null, 2));
    process.exit(EXIT_LINK_PENDING);
  }

  console.error(`\n  ${bold('Link AgentID')} for ${cyan(agentId)}`);
  console.error(`  Open this URL in a browser and sign in with AgentID:\n`);
  console.error(`    ${cyan(start.link_url)}\n`);
  console.error(dim(`  link id: ${start.link_id}  ·  expires ${start.expires_at}`));

  if (noWait) {
    console.error(dim(`\n  Re-run later: basedagents agentid status  (or poll link id ${start.link_id})\n`));
    if (jsonMode) console.log(JSON.stringify(start, null, 2));
    process.exit(EXIT_LINK_PENDING);
  }

  // Poll until the browser step completes.
  const deadline = Date.now() + Math.max(1, timeoutMin) * 60_000;
  console.error(dim(`\n  Waiting for sign-in (up to ${Math.max(1, timeoutMin)} min)…`));
  let delay = 2000;
  for (;;) {
    if (Date.now() > deadline) {
      console.error(yellow(`\n  ⧗ Timed out waiting. The link may still complete — run 'basedagents agentid status' later.\n`));
      process.exit(EXIT_TIMEOUT);
    }
    await sleepMs(delay);
    delay = Math.min(delay + 1000, 8000); // gentle backoff
    let status;
    try {
      status = await client.getAgentIdLinkStatus(start.link_id);
    } catch {
      continue; // transient; keep polling until the deadline
    }
    if (status.status === 'pending') continue;
    if (status.status === 'linked') {
      if (jsonMode) {
        console.log(JSON.stringify(status, null, 2));
      } else {
        console.error(green(`\n  ✓ AgentID linked. ${agentId} is now verified.\n`));
      }
      process.exit(0);
    }
    // failed | expired | not_found
    const why = status.error ? `: ${status.error}` : '';
    console.error(red(`\n  ✗ Link ${status.status}${why}\n`));
    process.exit(1);
  }
}

async function runStatus(
  client: RegistryClient,
  idArg: string | undefined,
  keypairFile: string | undefined,
  jsonMode: boolean,
): Promise<void> {
  let target = idArg;
  if (!target) {
    const kp = keypairOrExit(keypairFile);
    target = publicKeyToAgentId(kp.publicKey);
  }
  let res;
  try {
    res = await client.getAgentIdStatus(target);
  } catch (err) {
    console.error(red(`\n  ✗ ${err instanceof ApiError ? explainApiError(err) : String(err)}\n`));
    process.exit(1);
  }
  if (jsonMode) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  if (!res.agentid) {
    console.error(`\n  ${dim('AgentID:')} ${yellow('not linked')}  ${dim(`(${res.agent_id})`)}\n`);
    return;
  }
  const a = res.agentid;
  console.error(`\n  ${green('✓ AgentID verified')}  ${dim(`(${res.agent_id})`)}`);
  if (a.display_name) console.error(`  ${dim('name')}      ${a.display_name}`);
  if (a.email) console.error(`  ${dim('email')}     ${a.email}${a.email_verified ? green(' ✓') : ''}`);
  console.error(`  ${dim('issuer')}    ${a.issuer}`);
  console.error(`  ${dim('linked')}    ${a.linked_at}\n`);
}

async function runUnlink(
  client: RegistryClient,
  keypairFile: string | undefined,
  jsonMode: boolean,
): Promise<void> {
  const kp = keypairOrExit(keypairFile);
  let res;
  try {
    res = await client.unlinkAgentId(kp);
  } catch (err) {
    console.error(red(`\n  ✗ ${err instanceof ApiError ? explainApiError(err) : String(err)}\n`));
    process.exit(1);
  }
  if (jsonMode) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.error(res.unlinked ? green('\n  ✓ AgentID unlinked.\n') : yellow('\n  (nothing to unlink)\n'));
}
