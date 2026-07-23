/**
 * Control-plane HTTP client — the local daemon side of the grant-approval loop.
 *
 * Authenticates to the hosted control plane AS the owner, using the owner's
 * Ed25519 vault key (the same key the vault seals to). Requests are AgentSig-
 * signed over "<METHOD>:<pathname>:<timestamp>:<sha256hex(body)>:<nonce>", which
 * the control plane's daemonAuth verifies against an active owner_vault_keys
 * binding. See CONTROL_PLANE.md §2 and packages/api/src/control/approvals.ts.
 */

import * as ed from '@noble/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import type { AgentKeypair } from '../crypto.js';
import { base58Encode, bytesToBase64 } from '../util.js';
import type { GrantConstraints, OwnerAssertion } from '../types.js';

export const DEFAULT_KEYRING_API =
  (typeof process !== 'undefined' ? process.env?.BASEDAGENTS_KEYRING_API : undefined)
  ?? 'https://api.basedagents.ai';

/** A passkey the control plane has on file for the owner, ready to anchor. */
export interface RemotePasskey {
  credential_id: string;
  public_key_hex: string;
  nickname: string | null;
  created_at: string;
}

/** An approved grant the daemon should apply — shaped as keyring's GrantApproval. */
export interface RemoteApproval {
  id: string;
  nonce: string;
  credential_id: string;
  agent_id: string;
  agent_pubkey: string;
  action_hash: string;
  constraints: GrantConstraints;
  assertion: OwnerAssertion;
}

export class ControlClientError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ControlClientError';
  }
}

/**
 * Actionable hint for failures that look like a filtering proxy / sandbox egress
 * policy (403, 407, or a blocked CONNECT) — the common failure when an agent
 * runs `keyring init` inside a locked-down environment. Names the proxy env var
 * only when one is set.
 */
export function proxyHint(): string {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || '';
  return '\n\nIf you are behind a proxy or in a sandboxed agent environment, outbound HTTPS may be ' +
    'filtered. Allow api.basedagents.ai through your egress policy' +
    (proxy
      ? ` — a proxy is set (${proxy}) and the keyring routes through it automatically, so the proxy itself is likely refusing this host`
      : '') + ', or pass --api <reachable url>.';
}

export class ControlClient {
  private readonly baseUrl: string;
  private readonly pubkeyB58: string;

  constructor(private readonly owner: AgentKeypair, apiUrl: string = DEFAULT_KEYRING_API) {
    this.baseUrl = apiUrl.replace(/\/$/, '');
    this.pubkeyB58 = base58Encode(owner.publicKey);
  }

  /**
   * Sign and send a request. `path` is the full pathname the server signs
   * (incl. /v1/owner). `query` is appended to the URL only — the server
   * signs pathname alone, so the query must never enter the message.
   */
  private async signedFetch<T>(method: string, path: string, body?: unknown, query = ''): Promise<T> {
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = crypto.randomUUID();
    const bodyHash = bytesToHex(sha256(new TextEncoder().encode(bodyStr)));
    const message = `${method}:${path}:${timestamp}:${bodyHash}:${nonce}`;
    const signature = await ed.signAsync(new TextEncoder().encode(message), this.owner.privateKey);

    const headers: Record<string, string> = {
      Authorization: `AgentSig ${this.pubkeyB58}:${bytesToBase64(signature)}`,
      'X-Timestamp': timestamp,
      'X-Nonce': nonce,
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}${query}`, {
        method,
        headers,
        body: body === undefined ? undefined : bodyStr,
        signal: controller.signal,
      });
    } catch (err) {
      throw new ControlClientError(
        `Could not reach the control plane at ${this.baseUrl}: ${(err as Error).message}${proxyHint()}`,
      );
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      let msg = res.statusText;
      try { const e = await res.json() as { message?: string }; if (e.message) msg = e.message; } catch { /* ignore */ }
      const hint = res.status === 403 || res.status === 407 ? proxyHint() : '';
      throw new ControlClientError(`Control plane error ${res.status}: ${msg}${hint}`, res.status);
    }
    return res.json() as Promise<T>;
  }

  /** The owner's registered passkeys + the RP config to anchor them under. */
  async getPasskeys(): Promise<{ rp_id: string; origins: string[]; passkeys: RemotePasskey[] }> {
    return this.signedFetch('GET', '/v1/owner/daemon/passkeys');
  }

  /** Pending approved grants awaiting local application. */
  async getApprovals(): Promise<RemoteApproval[]> {
    const r = await this.signedFetch<{ approvals: RemoteApproval[] }>('GET', '/v1/owner/daemon/approvals');
    return r.approvals;
  }

  /** Report a successful local apply (or a failure) for an approval. */
  async confirmApproval(id: string, result: { daemonGrantId: string } | { error: string }): Promise<void> {
    const body = 'daemonGrantId' in result
      ? { daemon_grant_id: result.daemonGrantId }
      : { error: result.error };
    await this.signedFetch('POST', `/v1/owner/daemon/approvals/${encodeURIComponent(id)}/confirm`, body);
  }

  /**
   * Pending connections awaiting local work: browser-sealed pastes (kind
   * 'sealed') and console-initiated automatic setups (kind 'provision').
   * The ?include flag is how the server knows this daemon understands
   * provision rows — older daemons never receive them.
   */
  async getConnections(): Promise<RemoteConnection[]> {
    const r = await this.signedFetch<{ connections: Array<RemoteConnection & { kind?: string }> }>(
      'GET', '/v1/owner/daemon/connections', undefined, '?include=provision,rotate',
    );
    return r.connections.map((c) => ({
      ...c,
      kind: c.kind === 'provision' || c.kind === 'rotate' ? c.kind : 'sealed',
    }));
  }

  /**
   * ATOMICALLY claim a pending connection (pending → processing) before doing
   * any local work. Returns true only for the single winner — so two daemons
   * (e.g. `init`'s post-claim watch and a separate `based sync --watch`) can
   * never both store the same sealed token as duplicate credentials/grants.
   */
  async claimConnection(id: string): Promise<boolean> {
    const r = await this.signedFetch<{ claimed: boolean }>(
      'POST', `/v1/owner/daemon/connections/${encodeURIComponent(id)}/claim`,
    );
    return r.claimed === true;
  }

  /** Resolve a pulled connection: stored locally (or failed, with a human reason). */
  async resolveConnection(id: string, result: { daemonCredentialId: string } | { error: string }): Promise<void> {
    const body = 'daemonCredentialId' in result
      ? { daemon_credential_id: result.daemonCredentialId }
      : { error: result.error };
    await this.signedFetch('POST', `/v1/owner/daemon/connections/${encodeURIComponent(id)}/resolve`, body);
  }

  /**
   * Report per-credential facts (currently: rotatability) so the console only
   * offers per-key actions this machine can actually perform. Ids and
   * booleans only — never secret values.
   */
  async reportCredentialFacts(facts: Array<{ id: string; provider: string; rotatable: boolean }>): Promise<void> {
    await this.signedFetch('POST', '/v1/owner/daemon/credential-facts', { credentials: facts });
  }

  /** Pending passport requests from the console (browser public keys only). */
  async getPassportHandoffs(): Promise<Array<{ id: string; browser_public_key: string }>> {
    const r = await this.signedFetch<{ handoffs: Array<{ id: string; browser_public_key: string }> }>(
      'GET', '/v1/owner/daemon/passport');
    return r.handoffs;
  }

  /** Deliver a passport sealed to the browser's ephemeral key. Ciphertext only. */
  async fulfillPassportHandoff(id: string, sealedPassport: string): Promise<void> {
    await this.signedFetch('POST', `/v1/owner/daemon/passport/${encodeURIComponent(id)}/fulfill`, {
      sealed_passport: sealedPassport,
    });
  }

  /** The control-plane shelf: sealed credential ciphertext for cloud re-materialization. */
  async getShelf(): Promise<{ enabled: boolean; credentials: Array<{ credential_id: string; v: number; meta: string; sealed: string; grants: string }> }> {
    return this.signedFetch('GET', '/v1/owner/daemon/shelf');
  }

  /** Whole-snapshot deposit — the server refuses until a passport exists (enabled: false). */
  async putShelfSnapshot(snapshot: Array<{ credential_id: string; v: number; meta: string; sealed: string; grants: string }>): Promise<{ ok: boolean; enabled: boolean }> {
    return this.signedFetch('PUT', '/v1/owner/daemon/shelf', { snapshot });
  }

  /**
   * Agent-first entry: invite an owner by email (MCP `invite_owner`). Signed
   * with whatever keypair this client was constructed with — for invites that
   * MUST be the AGENT's keypair, not the vault owner's.
   */
  async inviteOwner(email: string): Promise<{ ok: boolean; status: string }> {
    return this.signedFetch('POST', '/v1/owner/invites', { email });
  }
}

export interface RemoteConnection {
  id: string;
  agent_id: string;
  provider: string;
  label: string | null;
  env_var: string | null;
  /** base64 sealed box → the vault owner key; opened locally, never logged. '' for kinds 'provision'/'rotate'. */
  sealed_secret: string;
  /** 'sealed' = open + store the ciphertext; 'provision' = mint the token here; 'rotate' = replace a minted key in place. */
  kind: 'sealed' | 'provision' | 'rotate';
  /** kind 'rotate': the local credential id to rotate (set when the row was created). */
  daemon_credential_id?: string | null;
  created_at: string;
}
