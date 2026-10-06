/**
 * Persistence for AgentID links + the short-lived OIDC link challenges
 * (migration 0050). Mirrors mcp/oauth-store.ts: raw SQL through the DBAdapter,
 * ISO-8601 TEXT timestamps, single-use enforced by one atomic conditional
 * UPDATE (there are no transactions in the D1/DBAdapter model).
 */

import type { DBAdapter } from '../db/adapter.js';

/** How long a pending link challenge stays valid (the owner must sign in within). */
export const AGENTID_CHALLENGE_TTL_S = 15 * 60;

export interface AgentIdLinkRow {
  agent_id: string;
  issuer: string;
  sub: string;
  owner_sub: string | null;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  linked_at: string;
  updated_at: string;
}

export interface AgentIdChallengeRow {
  state_hash: string;
  link_id: string;
  agent_id: string;
  code_verifier: string;
  nonce: string;
  status: 'pending' | 'linked' | 'failed';
  error: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export class AgentIdStore {
  constructor(private db: DBAdapter) {}

  /** Insert a pending challenge. `stateHash` = sha256hex(state); state is never stored raw. */
  async createChallenge(input: {
    stateHash: string;
    linkId: string;
    agentId: string;
    codeVerifier: string;
    nonce: string;
    ttlSeconds?: number;
  }): Promise<void> {
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + (input.ttlSeconds ?? AGENTID_CHALLENGE_TTL_S) * 1000).toISOString();
    await this.db.run(
      `INSERT INTO agentid_link_challenges
         (state_hash, link_id, agent_id, code_verifier, nonce, status, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`,
      input.stateHash,
      input.linkId,
      input.agentId,
      input.codeVerifier,
      input.nonce,
      createdAt,
      expiresAt,
    );
  }

  async getChallengeByLinkId(linkId: string): Promise<AgentIdChallengeRow | null> {
    return this.db.get<AgentIdChallengeRow>(
      `SELECT * FROM agentid_link_challenges WHERE link_id = ?`,
      linkId,
    );
  }

  /**
   * Peek an unconsumed, unexpired challenge by state hash WITHOUT consuming it —
   * used to render the consent page. Commitment happens only after the owner
   * confirms, via consumeChallengeByState.
   */
  async getChallengeByState(stateHash: string, nowIso: string): Promise<AgentIdChallengeRow | null> {
    return this.db.get<AgentIdChallengeRow>(
      `SELECT * FROM agentid_link_challenges
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      stateHash,
      nowIso,
    );
  }

  /**
   * Atomically consume an unconsumed, unexpired challenge by its state hash.
   * Returns the row on success (single-use won), null otherwise. The UPDATE is
   * the gate; the SELECT only fetches the row data to return.
   */
  async consumeChallengeByState(stateHash: string, nowIso: string): Promise<AgentIdChallengeRow | null> {
    const row = await this.db.get<AgentIdChallengeRow>(
      `SELECT * FROM agentid_link_challenges
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      stateHash,
      nowIso,
    );
    if (!row) return null;
    const res = await this.db.run(
      `UPDATE agentid_link_challenges SET consumed_at = ?
        WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      stateHash,
      nowIso,
    );
    if (res.changes !== 1) return null;
    return row;
  }

  async markChallengeLinked(linkId: string): Promise<void> {
    await this.db.run(`UPDATE agentid_link_challenges SET status = 'linked', error = NULL WHERE link_id = ?`, linkId);
  }

  async markChallengeFailed(linkId: string, error: string): Promise<void> {
    await this.db.run(
      `UPDATE agentid_link_challenges SET status = 'failed', error = ? WHERE link_id = ?`,
      error.slice(0, 300),
      linkId,
    );
  }

  /** Opportunistic GC of expired challenges (called from the link-start hot path). */
  async gcExpiredChallenges(nowIso: string): Promise<void> {
    await this.db.run(`DELETE FROM agentid_link_challenges WHERE expires_at < ?`, nowIso);
  }

  async getLinkByAgentId(agentId: string): Promise<AgentIdLinkRow | null> {
    return this.db.get<AgentIdLinkRow>(`SELECT * FROM agentid_links WHERE agent_id = ?`, agentId);
  }

  async getLinkBySub(issuer: string, sub: string): Promise<AgentIdLinkRow | null> {
    return this.db.get<AgentIdLinkRow>(`SELECT * FROM agentid_links WHERE issuer = ? AND sub = ?`, issuer, sub);
  }

  /**
   * Insert or refresh the link for an agent. One agent ↔ one AgentID (agent_id
   * PK); one AgentID ↔ one agent (UNIQUE(issuer, sub)). A re-link to a new sub
   * replaces the row; `linked_at` is preserved as the first-link time.
   */
  async upsertLink(input: {
    agentId: string;
    issuer: string;
    sub: string;
    ownerSub: string | null;
    email: string | null;
    emailVerified: boolean;
    displayName: string | null;
    nowIso: string;
  }): Promise<void> {
    await this.db.run(
      `INSERT INTO agentid_links
         (agent_id, issuer, sub, owner_sub, email, email_verified, display_name, linked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET
         issuer = excluded.issuer,
         sub = excluded.sub,
         owner_sub = excluded.owner_sub,
         email = excluded.email,
         email_verified = excluded.email_verified,
         display_name = excluded.display_name,
         updated_at = excluded.updated_at`,
      input.agentId,
      input.issuer,
      input.sub,
      input.ownerSub,
      input.email,
      input.emailVerified ? 1 : 0,
      input.displayName,
      input.nowIso,
      input.nowIso,
    );
  }

  async deleteLinkByAgentId(agentId: string): Promise<{ changes: number }> {
    return this.db.run(`DELETE FROM agentid_links WHERE agent_id = ?`, agentId);
  }
}
