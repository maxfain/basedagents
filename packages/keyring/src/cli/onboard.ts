/**
 * `npx @basedagents/keyring init` — the base-case onboarding (redesign Move 1+2).
 *
 * One command, run where the agent already lives (the terminal):
 *   1. create (or reuse) the local vault — the owner keypair never leaves here;
 *   2. create an agent identity, auto-named "Claude Code @ <hostname>";
 *   3. offer to register the MCP server with Claude Code (`claude mcp add`);
 *   4. create a link code at the control plane and open ONE browser page —
 *      "Take control of this agent" — where a single email field claims it;
 *   5. wait for the claim, then print the mirror confirmation.
 *
 * No signup form, no naming questions, no scope questions. Flags for the
 * advanced door: --name, --api, --no-link (vault+identity only), --no-browser,
 * --bare (the original vault-only init), --yes (skip prompts).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { Keyring } from '../keyring.js';
import { generateKeypair } from '../crypto.js';
import { publicKeyToAgentId, base58Encode } from '../util.js';
import { parseFlags, loadKeypairChecked } from './shared.js';
import { confirm } from './prompt.js';
import { DEFAULT_KEYRING_API } from './control-client.js';

const POLL_INTERVAL_MS = 3000;
const POLL_TIMEOUT_MS = 30 * 60 * 1000; // matches the link code's 30m TTL

function detectAgentName(): string {
  // The command is designed to be pasted into Claude Code; if another agent
  // runs it, --name is the override. Hostname keeps two machines distinct.
  return `Claude Code @ ${os.hostname()}`;
}

/** Best-effort browser open; silence is fine (the URL is printed regardless). */
function openBrowser(url: string): void {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.unref();
  } catch {
    /* printed URL is the fallback */
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

export async function cmdInit(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, {
    value: ['owner-keypair', 'name', 'api'],
    switch: ['bare', 'no-link', 'no-browser', 'yes'],
  });
  const api = flags.values['api'] ?? DEFAULT_KEYRING_API;

  // 1. Vault — create, or quietly reuse an existing one (re-running the paste
  //    command must never destroy anything).
  let kr: Keyring;
  let vaultCreated = false;
  try {
    kr = Keyring.open(dir);
    console.log(`✓ Using your existing vault (${kr.store.dir})`);
  } catch {
    const ownerKeypairPath = flags.values['owner-keypair'];
    const ownerKeypair = ownerKeypairPath ? loadKeypairChecked(ownerKeypairPath) : undefined;
    kr = await Keyring.init({ dir, ownerKeypair });
    vaultCreated = true;
    console.log('✓ Vault created');
    console.log(`  Everything sensitive stays in ${kr.store.dir} — nothing secret ever leaves this machine.`);
  }
  const vault = kr.vault();

  if (flags.switches.has('bare')) {
    if (vaultCreated) {
      console.log('');
      console.log(`⚠ Back up ${kr.store.ownerKeyPath}`);
      console.log('  It is the only key that can open this vault.');
    }
    return;
  }

  // 2. Agent identity — auto-named, no questions.
  const agentName = flags.values['name'] ?? detectAgentName();
  const existing = Object.values(vault.identities).find((i) => i.name === agentName);
  let agentId: string;
  let keypairPath: string;
  if (existing?.keypair_path && fs.existsSync(existing.keypair_path)) {
    agentId = existing.agent_id;
    keypairPath = existing.keypair_path;
    console.log(`✓ Agent already set up: ${agentName}`);
  } else {
    const keypair = await generateKeypair();
    agentId = publicKeyToAgentId(keypair.publicKey);
    const keysDir = path.join(kr.store.dir, 'keys');
    fs.mkdirSync(keysDir, { recursive: true });
    keypairPath = path.join(keysDir, `${agentId.slice(0, 14)}-keypair.json`);
    fs.writeFileSync(
      keypairPath,
      JSON.stringify(
        {
          agent_id: agentId,
          public_key_b58: base58Encode(keypair.publicKey),
          private_key_hex: Buffer.from(keypair.privateKey).toString('hex'),
        },
        null,
        2,
      ) + '\n',
      { mode: 0o600 },
    );
    await kr.addIdentity(kr.ownerKeypair(), agentId, { name: agentName, keypairPath });
    console.log(`✓ Agent set up: ${agentName}`);
  }
  const agentPublicKeyB58 = agentId.slice(3); // ag_<base58 pub>

  // 3. MCP config for Claude Code (with permission — we never edit config silently).
  const mcpArgs = [
    'mcp', 'add', 'basedagents-keyring',
    '--env', `BASEDAGENTS_KEYPAIR_PATH=${keypairPath}`,
    ...(dir ? ['--env', `BASEDAGENTS_KEYRING_DIR=${kr.store.dir}`] : []),
    '--', 'npx', '-y', '@basedagents/keyring', 'mcp',
  ];
  const mcpCommand = `claude ${mcpArgs.map((a) => (a.includes(' ') ? JSON.stringify(a) : a)).join(' ')}`;
  let mcpConfigured = false;
  const wantMcp = flags.switches.has('yes') || (await confirm('Add the keyring to Claude Code (writes MCP config)?'));
  if (wantMcp) {
    try {
      execFileSync('claude', mcpArgs, { stdio: 'ignore' });
      mcpConfigured = true;
      console.log('✓ Claude Code can now use the keyring (MCP configured)');
    } catch {
      console.log('· Could not run `claude` here — add it yourself with:');
      console.log(`    ${mcpCommand}`);
    }
  } else {
    console.log('· Skipped. Add it later with:');
    console.log(`    ${mcpCommand}`);
  }

  if (flags.switches.has('no-link')) return;

  // 4. The one browser page.
  console.log('');
  const link = await postJson(`${api}/v1/owner/link`, {
    vault_public_key: vault.owner.public_key_b58,
    agent_id: agentId,
    agent_public_key: agentPublicKeyB58,
    agent_name: agentName,
  });
  if (link.status !== 200 || typeof link.json.url !== 'string') {
    console.log(`⚠ Could not reach ${api} (${link.status}). Set up later with: based init --api <url>`);
    return;
  }
  const url = link.json.url as string;
  const code = link.json.code as string;

  console.log('Take control of this agent — open:');
  console.log('');
  console.log(`    ${url}`);
  console.log('');
  if (!flags.switches.has('no-browser')) openBrowser(url);
  console.log('Waiting for you to finish in the browser (Ctrl-C is safe — nothing is lost)…');

  // 5. Wait for the claim.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let claimed = false;
  while (Date.now() < deadline) {
    await new Promise<void>((r) => setTimeout(r, POLL_INTERVAL_MS));
    try {
      const res = await fetch(`${api}/v1/owner/link/${code}`);
      const status = ((await res.json()) as { status?: string }).status;
      if (status === 'claimed') {
        claimed = true;
        break;
      }
      if (status === 'expired') break;
    } catch {
      /* transient network — keep polling */
    }
  }

  console.log('');
  if (claimed) {
    console.log(`✓ ${agentName} is set up.`);
    console.log('');
    console.log('  Finish connecting things in the browser page you already have open.');
    console.log(`  Pull everything down with:  based sync --watch 30`);
    console.log(`  Cut it all off anytime:     based kill "${agentName}"`);
    if (!mcpConfigured) {
      console.log('');
      console.log('  (Remember to add the MCP config so Claude Code can use it.)');
    }
  } else {
    console.log('· The browser step was not finished. Run `based init` again for a fresh link —');
    console.log('  your vault and agent are saved and will be reused.');
  }
}
