#!/usr/bin/env node
/**
 * BasedAgents Keyring MCP Server (KEYRING_SPEC §4)
 *
 * Exposes the local keyring vault to any MCP-compatible runtime
 * (Claude Code, Codex, Cursor, etc.) via stdio transport. The server acts
 * AS one agent identity — every lease it obtains is signed with that
 * identity's keypair and recorded in the vault's hash-chained access log.
 *
 * Tools:
 *   keyring_list    — list credentials this identity holds grants for (never values)
 *   keyring_lease   — obtain a short-lived lease on a credential (returns the value)
 *   keyring_request — ask the vault owner for access to a provider
 *   keyring_whoami  — show the acting identity and vault location (debugging)
 *
 * Identity configuration (either):
 *   BASEDAGENTS_KEYPAIR_PATH      — JSON keypair file
 *   BASEDAGENTS_PRIVATE_KEY_HEX + BASEDAGENTS_PUBLIC_KEY_B58
 *
 * Vault location: ~/.basedagents/keyring, override with BASEDAGENTS_KEYRING_DIR.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Keyring, KeyringError } from '../keyring.js';
import { runBrokered, renderBrokered } from './broker.js';
import { defaultVaultDir, loadKeypairFile } from '../store.js';
import type { AgentKeypair } from '../crypto.js';
import type { GrantConstraints } from '../types.js';
import { DEFAULT_LEASE_TTL_SECONDS } from '../types.js';
import { publicKeyToAgentId, hexToBytes, base58Decode } from '../util.js';

const VERSION = '0.4.0';

// ─── Identity / keypair ─────────────────────────────────────────────────────

const IDENTITY_HELP =
  'This MCP server acts as one agent identity. Configure its keypair one of two ways:\n\n' +
  '1. Set `BASEDAGENTS_KEYPAIR_PATH` to a JSON keypair file — either ' +
  '`{ public_key_b58, private_key_hex }` or `{ publicKey, privateKey }` (both hex).\n' +
  '2. Set both `BASEDAGENTS_PRIVATE_KEY_HEX` and `BASEDAGENTS_PUBLIC_KEY_B58`.';

let _keypair: AgentKeypair | null | undefined; // undefined = not loaded yet
let _keypairError: string | null = null;

function validateKeypair(kp: AgentKeypair): AgentKeypair {
  if (kp.publicKey.length !== 32) throw new Error('public key must be 32 bytes');
  if (kp.privateKey.length !== 32) throw new Error('private key must be 32 bytes');
  return kp;
}

/** Load the acting identity's keypair lazily (memoized). Returns null if unconfigured. */
function getKeypair(): AgentKeypair | null {
  if (_keypair !== undefined) return _keypair;

  const keypairPath = process.env.BASEDAGENTS_KEYPAIR_PATH;
  if (keypairPath) {
    try {
      _keypair = validateKeypair(loadKeypairFile(keypairPath));
      return _keypair;
    } catch (err) {
      _keypairError = `Failed to load keypair from ${keypairPath}: ${(err as Error).message}`;
    }
  }

  const priv = process.env.BASEDAGENTS_PRIVATE_KEY_HEX;
  const pub = process.env.BASEDAGENTS_PUBLIC_KEY_B58;
  if (priv && pub) {
    try {
      _keypair = validateKeypair({ publicKey: base58Decode(pub), privateKey: hexToBytes(priv) });
      return _keypair;
    } catch (err) {
      _keypairError = `Failed to parse BASEDAGENTS_PRIVATE_KEY_HEX/BASEDAGENTS_PUBLIC_KEY_B58: ${(err as Error).message}`;
    }
  }

  _keypair = null;
  return null;
}

// ─── Result helpers ─────────────────────────────────────────────────────────

function textResult(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: 'text' as const, text }], isError: true };
}

function noIdentityResult() {
  const lines = ['**Agent identity not configured.**', '', IDENTITY_HELP];
  if (_keypairError) lines.push('', `Last error: ${_keypairError}`);
  return errorResult(lines.join('\n'));
}

/** Open the vault, or explain how to create one. Never throws. */
function tryOpenVault():
  | { kr: Keyring; error?: undefined }
  | { kr?: undefined; error: ReturnType<typeof errorResult> } {
  if (!Keyring.vaultExists()) {
    return {
      error: errorResult(
        `**No keyring vault found.**\n\n` +
        `There is no vault at \`${defaultVaultDir()}\`. The human owner of this machine ` +
        `needs to run \`based init\` to create one (or set \`BASEDAGENTS_KEYRING_DIR\` ` +
        `to point at an existing vault).`
      ),
    };
  }
  try {
    return { kr: Keyring.open() };
  } catch (err) {
    return { error: errorResult(`**Could not open the keyring vault.**\n\n${(err as Error).message}`) };
  }
}

const ERROR_HINTS: Partial<Record<KeyringError['code'], string>> = {
  no_grant: 'This identity has no grant for that credential. Use `keyring_request` to ask the vault owner for access.',
  grant_revoked: 'The owner revoked this grant. Use `keyring_request` to ask for access again.',
  grant_expired: 'The grant has expired. Use `keyring_request` to ask the owner to re-grant.',
  usage_cap: 'The grant\'s usage cap is exhausted. Ask the owner to re-grant with a higher cap.',
  unknown_credential: 'Use `keyring_list` to see the credentials this identity can reference (by id, env var, or label).',
  no_sealed_copy: 'Ask the owner to re-grant this credential so the secret is re-sealed to this identity.',
  value_release_disabled:
    'Raw value release is off for this grant. Use `keyring_run` (inject secrets into a command) or ' +
    '`keyring_render` (fill a file) so the value never enters this conversation — that is the intended path.',
};

/** Map a KeyringError to a clean isError result; rethrow anything else. */
function keyringErrorResult(err: unknown, extra?: string) {
  if (!(err instanceof KeyringError)) throw err;
  const lines = [`**${err.message}**`, '', `Code: \`${err.code}\``];
  const hint = ERROR_HINTS[err.code];
  if (hint) lines.push('', hint);
  if (extra) lines.push('', extra);
  return errorResult(lines.join('\n'));
}

// ─── Formatting ─────────────────────────────────────────────────────────────

function formatConstraints(constraints: GrantConstraints, useCount: number): string {
  const parts: string[] = [];
  if (constraints.expires_at) parts.push(`expires ${constraints.expires_at}`);
  if (constraints.max_lease_ttl_seconds !== undefined) {
    parts.push(`max lease TTL ${constraints.max_lease_ttl_seconds}s`);
  }
  if (constraints.max_uses !== undefined) parts.push(`uses ${useCount}/${constraints.max_uses}`);
  else parts.push(`uses ${useCount}`);
  if (constraints.project) parts.push(`project ${constraints.project}`);
  return parts.join('  |  ');
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'basedagents-keyring',
  version: VERSION,
});

// ── keyring_list ────────────────────────────────────────────────────────────
server.tool(
  'keyring_list',
  'List the credentials this agent identity holds active grants for — labels, providers, env vars, and grant constraints. Never returns secret values; use keyring_lease to obtain one.',
  {},
  async () => {
    const kp = getKeypair();
    if (!kp) return noIdentityResult();
    const opened = tryOpenVault();
    if (opened.error) return opened.error;

    const agentId = publicKeyToAgentId(kp.publicKey);
    const views = opened.kr.listForAgent(kp);

    if (!views.length) {
      return textResult(
        `## Credentials for \`${agentId}\`\n\n` +
        'No credentials granted to this identity. Use `keyring_request` to ask the owner for access.'
      );
    }

    const lines = [
      `## Credentials for \`${agentId}\``,
      '',
      `${views.length} credential${views.length !== 1 ? 's' : ''} granted. ` +
      'Secret values are never listed — use `keyring_lease` to obtain a short-lived lease.',
      '',
    ];
    for (const view of views) {
      const meta = [
        view.provider ? `**Provider:** ${view.provider}` : '',
        view.env_var ? `**Env var:** \`${view.env_var}\`` : '',
        view.scope ? `**Scope:** ${view.scope}` : '',
      ].filter(Boolean).join('  |  ');
      lines.push(`### ${view.label}`);
      if (meta) lines.push(meta);
      lines.push(`**Credential ID:** \`${view.credential_id}\``);
      lines.push(`**Grant:** \`${view.grant_id}\` — ${formatConstraints(view.constraints, view.use_count)}`);
      lines.push('');
    }
    return textResult(lines.join('\n'));
  }
);

// ── keyring_lease (DEMOTED — Custody Fix 1) ──────────────────────────────────
// Returning a raw secret into a tool result puts it in the conversation
// transcript forever. Prefer keyring_run / keyring_render, which inject the
// value without the model ever seeing it. This tool is refused unless the owner
// explicitly enabled raw value release for the grant (unsafe_value_release).
server.tool(
  'keyring_lease',
  'DISCOURAGED — returns a raw secret into the conversation (it then lives in the transcript forever). Prefer keyring_run (run a command with secrets injected into its environment) or keyring_render (fill a file). Refused unless the owner enabled raw value release for the grant.',
  {
    ref: z.string().describe('Credential reference — credential_id (cred_...), env var name, or label'),
    context: z.string().optional().describe('What the secret will be used for — recorded in the signed access log'),
    ttl_seconds: z.number().int().min(1).optional().describe(
      `Requested lease TTL in seconds (clamped to the grant's max; default ${DEFAULT_LEASE_TTL_SECONDS})`
    ),
  },
  async ({ ref, context, ttl_seconds }) => {
    const kp = getKeypair();
    if (!kp) return noIdentityResult();
    const opened = tryOpenVault();
    if (opened.error) return opened.error;

    try {
      const lease = await opened.kr.lease(kp, ref, {
        context,
        ttlSeconds: ttl_seconds,
        requireValueRelease: true,
      });
      const cred = lease.credential;
      const meta = [
        cred.provider ? `**Provider:** ${cred.provider}` : '',
        cred.env_var ? `**Env var:** \`${cred.env_var}\`` : '',
        cred.scope ? `**Scope:** ${cred.scope}` : '',
      ].filter(Boolean).join('  |  ');
      const lines = [
        `> ⚠️ **Raw secret below — it is now in this conversation.** The owner enabled raw value`,
        `> release for this grant. Prefer \`keyring_run\`/\`keyring_render\` next time so the value`,
        `> never enters the transcript. Do not echo or repeat this value.`,
        '',
        `## Leased: ${cred.label}`,
        '',
        '**Value:**',
        '',
        '```',
        lease.value,
        '```',
        '',
      ];
      if (meta) lines.push(meta);
      lines.push(`**Credential ID:** \`${cred.credential_id}\``);
      lines.push(`**Lease:** \`${lease.lease_id}\` — TTL ${lease.ttl_seconds}s, expires ${lease.expires_at}`);
      lines.push(`**Access recorded:** signed event \`${lease.access_event_id}\` in the vault access log`);
      lines.push('');
      lines.push(
        `In-memory use only. Do not write this value to disk, logs, or version control. ` +
        `Lease expires at ${lease.expires_at}; lease again after that.`
      );
      return textResult(lines.join('\n'));
    } catch (err) {
      return keyringErrorResult(err, 'This denial was recorded as a signed event in the vault access log.');
    }
  }
);

// ── keyring_run (PRIMARY — Custody Fix 1) ────────────────────────────────────
// The daemon spawns the child itself, injecting leased secrets into the child's
// ENVIRONMENT (never argv). The model orchestrates; only the daemon touches the
// values. Captured output is redacted before it is returned (see broker.ts), so
// a command that echoes a secret cannot leak it into the transcript.
server.tool(
  'keyring_run',
  'Run a command with credentials injected into its environment by the Keyring daemon — you never see the secret values. This is the PRIMARY way to use a credential. The daemon leases each ref, spawns the command with the secrets in its environment (never in argv), and returns stdout/stderr/exit code with the values redacted. One signed run event is recorded; purpose is required.',
  {
    credential_refs: z.array(z.string()).min(1).describe(
      'Credentials to inject — credential_id (cred_...), env var name, or label. Each is leased and injected under its env var name.'
    ),
    command: z.array(z.string()).min(1).describe(
      'The command and its arguments as an array, e.g. ["npm","run","deploy"]. NEVER put a secret in here — secrets go into the environment, not argv.'
    ),
    purpose: z.string().min(1).describe('Why this command needs these secrets — recorded in the signed run event.'),
    cwd: z.string().optional().describe("Working directory for the command (default: the daemon's cwd)."),
    ttl_seconds: z.number().int().min(1).optional().describe('Lease TTL for the injected secrets.'),
  },
  async ({ credential_refs, command, purpose, cwd, ttl_seconds }) => {
    const kp = getKeypair();
    if (!kp) return noIdentityResult();
    const opened = tryOpenVault();
    if (opened.error) return opened.error;
    const r = await runBrokered(opened.kr, kp, { credential_refs, command, purpose, cwd, ttl_seconds });
    return r.isError ? errorResult(r.text) : textResult(r.text);
  }
);

// ── keyring_render (Custody Fix 1) ───────────────────────────────────────────
// Fill {{keyring:REF}} placeholders in a template and write the result to a
// file, without the model ever seeing the values (see broker.ts).
server.tool(
  'keyring_render',
  'Fill {{keyring:REF}} placeholders in a template with real secret values and write the result to a file — you never see the values. Use for deploy/config files that must contain a secret. Provide the template as inline `content` or a `template_path`; the daemon leases each referenced credential, substitutes, and writes `dest_path`. Returns which refs were filled, never the values.',
  {
    dest_path: z.string().describe('Where to write the rendered file.'),
    content: z.string().optional().describe('Template text containing {{keyring:REF}} placeholders. Provide this OR template_path.'),
    template_path: z.string().optional().describe('Path to a template file with {{keyring:REF}} placeholders. Provide this OR content.'),
    purpose: z.string().optional().describe('Why — recorded in the signed render event.'),
  },
  async ({ dest_path, content, template_path, purpose }) => {
    const kp = getKeypair();
    if (!kp) return noIdentityResult();
    const opened = tryOpenVault();
    if (opened.error) return opened.error;
    const r = await renderBrokered(opened.kr, kp, { dest_path, content, template_path, purpose });
    return r.isError ? errorResult(r.text) : textResult(r.text);
  }
);

// ── keyring_request ─────────────────────────────────────────────────────────
server.tool(
  'keyring_request',
  'Ask the vault owner for access to a provider (e.g. "stripe", "github"). Creates a pending grant request in the owner\'s approvals inbox — the owner approves or denies it out-of-band.',
  {
    provider: z.string().describe('Provider slug being requested, e.g. "supabase", "stripe", "github"'),
    scope: z.string().optional().describe('Scope descriptor, e.g. "read-only", "repo:acme/site"'),
    note: z.string().optional().describe('Free-form note to the owner explaining why access is needed'),
  },
  async ({ provider, scope, note }) => {
    const kp = getKeypair();
    if (!kp) return noIdentityResult();
    const opened = tryOpenVault();
    if (opened.error) return opened.error;

    try {
      // The core silently returns an existing pending duplicate — detect that
      // up front so the output can say so (same match rule as the core).
      const agentId = publicKeyToAgentId(kp.publicKey);
      const existing = opened.kr.requestsView('pending').find(
        r => r.agent_id === agentId && r.provider === provider.trim() && r.scope === scope
      );
      const request = await opened.kr.createRequest(kp, provider, { scope, note });
      const alreadyPending = existing?.request_id === request.request_id;
      const lines = [
        alreadyPending
          ? '## Request already pending'
          : '## Access request created',
        '',
        `**Request ID:** \`${request.request_id}\``,
        `**Status:** ${request.status}`,
        `**Provider:** ${request.provider}` +
          (request.scope ? `  |  **Scope:** ${request.scope}` : ''),
      ];
      if (request.note) lines.push(`**Note:** ${request.note}`);
      lines.push(`**Requested by:** \`${request.agent_id}\`  |  **Created:** ${request.created_at}`);
      lines.push('');
      lines.push(
        `The vault owner can approve this with \`based approve ${request.request_id} --credential <cred>\` ` +
        'or from the admin UI (`based admin`).'
      );
      return textResult(lines.join('\n'));
    } catch (err) {
      return keyringErrorResult(err);
    }
  }
);

// ── invite_owner ────────────────────────────────────────────────────────────
//
// Agent-first entry (onboarding redesign §2b): the agent asks its human, in
// conversation, for an email — the invite email is framed FROM the agent.
// Until the human claims and finishes setup on their own machine, this agent
// can hold nothing and access nothing (claim-pending is structural at the
// control plane). Invites are rate-limited server-side; the tool surfaces
// those brakes as friendly errors.
server.tool(
  'invite_owner',
  "Invite a human to take ownership of this agent by email. Use when you have no vault/owner set up yet: ask the user for their email in conversation, then call this. They receive an email framed from this agent; nothing is storable or leasable until they accept and run the setup command on their machine.",
  { email: z.string().email().describe("The human's email address (ask them in conversation first)") },
  async ({ email }) => {
    const kp = getKeypair();
    if (!kp) return noIdentityResult();
    const api = process.env.BASEDAGENTS_KEYRING_API || 'https://api.basedagents.ai';
    try {
      const { ControlClient } = await import('../cli/control-client.js');
      await new ControlClient(kp, api).inviteOwner(email);
      return textResult(
        `## Invite sent\n\n` +
        `**${email}** has been invited to take control of this agent (valid 72 hours).\n\n` +
        `Tell the user: check your inbox for "wants you as its owner", accept, and run the ` +
        `setup command it shows on this machine. Until then this agent cannot hold or lease anything.`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('429') || /rate|limit|recently|tomorrow/i.test(msg)) {
        return textResult(`## Invite not sent\n\n${msg}\n\nWait before retrying — invites are deliberately rate-limited.`);
      }
      return textResult(`## Invite failed\n\n${msg}`);
    }
  }
);

// ── keyring_whoami ──────────────────────────────────────────────────────────
server.tool(
  'keyring_whoami',
  'Show the agent identity this server acts as and the vault directory it uses. Useful for debugging setups.',
  {},
  async () => {
    const kp = getKeypair();
    const lines = ['## Keyring identity', ''];
    if (kp) {
      lines.push(`**Agent ID:** \`${publicKeyToAgentId(kp.publicKey)}\``);
    } else {
      lines.push('**Agent ID:** not configured', '', IDENTITY_HELP);
      if (_keypairError) lines.push('', `Last error: ${_keypairError}`);
      lines.push('');
    }
    lines.push(`**Vault dir:** \`${defaultVaultDir()}\``);
    lines.push(`**Vault exists:** ${Keyring.vaultExists() ? 'yes' : 'no — run `based init` to create one'}`);
    return textResult(lines.join('\n'));
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}

main().catch(err => {
  process.stderr.write(`[basedagents-keyring-mcp] Fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
