/**
 * ControlStore — the data layer for the Keyring control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * Runs on Cloudflare Workers + D1 (and better-sqlite3 in tests) over the
 * `DBAdapter` interface, which exposes only get/all/run/exec — NO transactions.
 * Every security-critical state change is therefore a SINGLE atomic conditional
 * write verified by `.changes`, never a TOCTOU SELECT-then-INSERT/UPDATE
 * (CONTROL_PLANE.md §4). Owner authority events are hash-chained (§5).
 *
 * Ids/tokens use crypto.getRandomValues (Workers-safe; no node:crypto). Owner
 * ids are derived from the vault key (see ./identity.ts), everything else is a
 * prefixed random id. Times are stored as ISO-8601 strings.
 */
import type { DBAdapter } from '../db/adapter.js';
import type { GrantConstraints } from './grant-actions.js';
import {
  base58Encode,
  sha256,
  bytesToHex,
  canonicalJsonStringify,
  GENESIS_HASH,
} from '../crypto/index.js';

// ─── Row interfaces (match the 0023 schema columns) ───

export interface OwnerRow {
  id: string;
  email: string | null;
  email_verified: number;
  display_name: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  /** Billing (migration 0026): 'free' | 'pro' | 'team'. */
  plan: string;
  /** 'active' | 'past_due' | 'canceled'. */
  plan_status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_end: string | null;
}

export interface CredentialRow {
  id: string;
  owner_id: string;
  credential_id: string;
  /** COSE public key bytes (BLOB), normalized to Uint8Array on read. */
  public_key: Uint8Array;
  signature_counter: number;
  /** Parsed from the stored JSON array; null when absent. */
  transports: string[] | null;
  aaguid: string | null;
  backed_up: number;
  nickname: string | null;
  created_at: string;
  last_used_at: string | null;
  /** 'active' | 'revoked' — revoked passkeys fail login and every action. */
  status: string;
  revoked_at: string | null;
}

export interface ChallengeRow {
  id: string;
  owner_id: string | null;
  challenge: string;
  purpose: string;
  action_type: string | null;
  action_hash: string | null;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export interface SessionRow {
  id: string;
  owner_id: string;
  token_hash: string;
  credential_id: string | null;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_seen_at: string | null;
  user_agent: string | null;
  ip_hash: string | null;
}

export interface ActionAssertionRow {
  id: string;
  owner_id: string;
  credential_id: string;
  action_type: string;
  action_hash: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  sequence: number;
  prev_hash: string;
  entry_hash: string;
  created_at: string;
}

export interface VaultKeyRow {
  id: string;
  owner_id: string;
  vault_public_key: string;
  status: string;
  binding_assertion_id: string | null;
  bound_at: string;
  rotated_at: string | null;
}

export interface DelegationRow {
  id: string;
  owner_id: string;
  agent_id: string;
  label: string | null;
  status: string;
  authorizing_assertion_id: string;
  revoke_assertion_id: string | null;
  created_at: string;
  revoked_at: string | null;
}

// ── Keyring approvals (migration 0024) ──

export interface KeyringRequestRow {
  id: string;
  owner_id: string;
  agent_id: string;
  credential_id: string;
  credential_label: string | null;
  provider: string | null;
  /** JSON text — the requested constraints (only the recognized keys). */
  constraints: string;
  note: string | null;
  status: string; // pending | approved | denied
  created_at: string;
  decided_at: string | null;
  decision_assertion_id: string | null;
  deny_reason: string | null;
}

export interface GrantApprovalRow {
  id: string;
  owner_id: string;
  request_id: string;
  agent_id: string;
  /** base58 Ed25519 — the pinned sealing target the owner signed. */
  agent_pubkey: string;
  credential_id: string;
  /** JSON text — the exact approved constraints. */
  constraints: string;
  nonce: string;
  action_hash: string;
  /** WebAuthn credential id of the passkey that signed the approval. */
  assertion_credential_id: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
  /** action_assertions.id of the hash-chained assertion that authorized this. */
  assertion_id: string;
  status: string; // pending_daemon | confirmed | failed
  created_at: string;
  confirmed_at: string | null;
  daemon_grant_id: string | null;
  failure_reason: string | null;
}

// ─── local helpers ───

function nowIsoString(): string {
  return new Date().toISOString();
}

function randomBytes(n: number): Uint8Array {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return bytes;
}

/** Prefixed random id, e.g. cred_<base58(16 random bytes)>. */
function randomId(prefix: string): string {
  return `${prefix}${base58Encode(randomBytes(16))}`;
}

/** URL-safe base64 without padding (WebAuthn/challenge encoding). */
function base64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function sha256Hex(input: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(input)));
}

/** Normalize a SQLite BLOB (Buffer / Uint8Array / number[]) to a plain Uint8Array copy. */
function toUint8Array(v: unknown): Uint8Array {
  if (v == null) throw new Error('Expected BLOB bytes, got null/undefined');
  // Buffer is a Uint8Array subclass; new Uint8Array(...) copies the byte values.
  if (v instanceof Uint8Array) return new Uint8Array(v);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Unexpected type for BLOB bytes');
}

function isUniqueViolation(e: unknown): boolean {
  const err = e as { message?: unknown; code?: unknown };
  const msg = typeof err?.message === 'string' ? err.message : '';
  const code = typeof err?.code === 'string' ? err.code : '';
  return msg.includes('UNIQUE constraint failed') || code.includes('SQLITE_CONSTRAINT');
}

type RawRow = Record<string, unknown>;
const asStr = (v: unknown): string => v as string;
const asNullableStr = (v: unknown): string | null => (v == null ? null : (v as string));

function mapOwnerRow(r: RawRow): OwnerRow {
  return {
    id: asStr(r.id),
    email: asNullableStr(r.email),
    email_verified: Number(r.email_verified),
    display_name: asNullableStr(r.display_name),
    status: asStr(r.status),
    created_at: asStr(r.created_at),
    updated_at: asStr(r.updated_at),
    plan: asStr(r.plan ?? 'free'),
    plan_status: asStr(r.plan_status ?? 'active'),
    stripe_customer_id: asNullableStr(r.stripe_customer_id),
    stripe_subscription_id: asNullableStr(r.stripe_subscription_id),
    current_period_end: asNullableStr(r.current_period_end),
  };
}

function mapCredentialRow(r: RawRow): CredentialRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    credential_id: asStr(r.credential_id),
    public_key: toUint8Array(r.public_key),
    signature_counter: Number(r.signature_counter),
    transports: r.transports == null ? null : (JSON.parse(r.transports as string) as string[]),
    aaguid: asNullableStr(r.aaguid),
    backed_up: Number(r.backed_up),
    nickname: asNullableStr(r.nickname),
    created_at: asStr(r.created_at),
    last_used_at: asNullableStr(r.last_used_at),
    status: asStr(r.status ?? 'active'),
    revoked_at: asNullableStr(r.revoked_at),
  };
}

function mapChallengeRow(r: RawRow): ChallengeRow {
  return {
    id: asStr(r.id),
    owner_id: asNullableStr(r.owner_id),
    challenge: asStr(r.challenge),
    purpose: asStr(r.purpose),
    action_type: asNullableStr(r.action_type),
    action_hash: asNullableStr(r.action_hash),
    created_at: asStr(r.created_at),
    expires_at: asStr(r.expires_at),
    consumed_at: asNullableStr(r.consumed_at),
  };
}

function mapSessionRow(r: RawRow): SessionRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    token_hash: asStr(r.token_hash),
    credential_id: asNullableStr(r.credential_id),
    created_at: asStr(r.created_at),
    expires_at: asStr(r.expires_at),
    revoked_at: asNullableStr(r.revoked_at),
    last_seen_at: asNullableStr(r.last_seen_at),
    user_agent: asNullableStr(r.user_agent),
    ip_hash: asNullableStr(r.ip_hash),
  };
}

function mapActionAssertionRow(r: RawRow): ActionAssertionRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    credential_id: asStr(r.credential_id),
    action_type: asStr(r.action_type),
    action_hash: asStr(r.action_hash),
    authenticator_data: asStr(r.authenticator_data),
    client_data_json: asStr(r.client_data_json),
    signature: asStr(r.signature),
    sequence: Number(r.sequence),
    prev_hash: asStr(r.prev_hash),
    entry_hash: asStr(r.entry_hash),
    created_at: asStr(r.created_at),
  };
}

function mapVaultKeyRow(r: RawRow): VaultKeyRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    vault_public_key: asStr(r.vault_public_key),
    status: asStr(r.status),
    binding_assertion_id: asNullableStr(r.binding_assertion_id),
    bound_at: asStr(r.bound_at),
    rotated_at: asNullableStr(r.rotated_at),
  };
}

function mapDelegationRow(r: RawRow): DelegationRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    agent_id: asStr(r.agent_id),
    label: asNullableStr(r.label),
    status: asStr(r.status),
    authorizing_assertion_id: asStr(r.authorizing_assertion_id),
    revoke_assertion_id: asNullableStr(r.revoke_assertion_id),
    created_at: asStr(r.created_at),
    revoked_at: asNullableStr(r.revoked_at),
  };
}

function mapKeyringRequestRow(r: RawRow): KeyringRequestRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    agent_id: asStr(r.agent_id),
    credential_id: asStr(r.credential_id),
    credential_label: asNullableStr(r.credential_label),
    provider: asNullableStr(r.provider),
    constraints: asStr(r.constraints),
    note: asNullableStr(r.note),
    status: asStr(r.status),
    created_at: asStr(r.created_at),
    decided_at: asNullableStr(r.decided_at),
    decision_assertion_id: asNullableStr(r.decision_assertion_id),
    deny_reason: asNullableStr(r.deny_reason),
  };
}

function mapGrantApprovalRow(r: RawRow): GrantApprovalRow {
  return {
    id: asStr(r.id),
    owner_id: asStr(r.owner_id),
    request_id: asStr(r.request_id),
    agent_id: asStr(r.agent_id),
    agent_pubkey: asStr(r.agent_pubkey),
    credential_id: asStr(r.credential_id),
    constraints: asStr(r.constraints),
    nonce: asStr(r.nonce),
    action_hash: asStr(r.action_hash),
    assertion_credential_id: asStr(r.assertion_credential_id),
    authenticator_data: asStr(r.authenticator_data),
    client_data_json: asStr(r.client_data_json),
    signature: asStr(r.signature),
    assertion_id: asStr(r.assertion_id),
    status: asStr(r.status),
    created_at: asStr(r.created_at),
    confirmed_at: asNullableStr(r.confirmed_at),
    daemon_grant_id: asNullableStr(r.daemon_grant_id),
    failure_reason: asNullableStr(r.failure_reason),
  };
}

/**
 * The canonical, hash-covered view of an action-assertion event: every stored
 * column EXCEPT entry_hash itself. entry_hash = sha256Hex(canonicalJson(this)).
 * canonicalJsonStringify sorts keys, so field order here is irrelevant.
 */
function actionAssertionEvent(row: Omit<ActionAssertionRow, 'entry_hash'>): Record<string, unknown> {
  return {
    id: row.id,
    owner_id: row.owner_id,
    credential_id: row.credential_id,
    action_type: row.action_type,
    action_hash: row.action_hash,
    authenticator_data: row.authenticator_data,
    client_data_json: row.client_data_json,
    signature: row.signature,
    sequence: row.sequence,
    prev_hash: row.prev_hash,
    created_at: row.created_at,
  };
}

// ─── input types ───

export interface CreateOwnerInput {
  ownerId: string;
  email?: string;
  displayName?: string;
}

export interface AddCredentialInput {
  ownerId: string;
  credentialId: string;
  publicKey: Uint8Array;
  counter: number;
  aaguid?: string;
  backedUp: boolean;
  transports?: string[];
  nickname?: string;
}

export interface CreateChallengeInput {
  ownerId?: string;
  purpose: 'register' | 'login' | 'action' | 'recovery';
  actionType?: string;
  actionHash?: string;
  ttlSeconds: number;
}

export interface CreateSessionInput {
  ownerId: string;
  tokenHash: string;
  credentialId?: string;
  ttlSeconds: number;
  userAgent?: string;
  ipHash?: string;
}

export interface AppendActionAssertionInput {
  ownerId: string;
  credentialId: string;
  actionType: string;
  actionHash: string;
  authenticatorData: string;
  clientDataJson: string;
  signature: string;
}

export interface CreateVaultBindingInput {
  ownerId: string;
  vaultPublicKey: string;
  bindingAssertionId: string;
}

export interface CreateDelegationInput {
  ownerId: string;
  agentId: string;
  label?: string;
  authorizingAssertionId: string;
}

export interface RevokeDelegationInput {
  delegationId: string;
  revokeAssertionId: string;
  nowIso: string;
}

export interface CreateKeyringRequestInput {
  ownerId: string;
  agentId: string;
  credentialId: string;
  credentialLabel?: string;
  provider?: string;
  /** Recognized constraint keys only — stored as JSON text. */
  constraints: GrantConstraints;
  note?: string;
}

export interface SetRequestDecisionInput {
  id: string;
  status: 'approved' | 'denied';
  assertionId?: string;
  denyReason?: string;
  nowIso: string;
}

export interface CreateGrantApprovalInput {
  ownerId: string;
  requestId: string;
  agentId: string;
  agentPubkey: string;
  credentialId: string;
  /** Recognized constraint keys only — stored as JSON text. */
  constraints: GrantConstraints;
  nonce: string;
  actionHash: string;
  assertionCredentialId: string;
  authenticatorData: string;
  clientDataJson: string;
  signature: string;
  assertionId: string;
}

// ─── ControlStore ───

export class ControlStore {
  constructor(private db: DBAdapter) {}

  // ── Owners ──

  async createOwner({ ownerId, email, displayName }: CreateOwnerInput): Promise<OwnerRow> {
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO owners (id, email, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?)`,
      ownerId,
      email ?? null,
      displayName ?? null,
      now,
      now
    );
    const row = await this.getOwner(ownerId);
    if (!row) throw new Error(`createOwner: owner ${ownerId} not found after insert`);
    return row;
  }

  async getOwner(ownerId: string): Promise<OwnerRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owners WHERE id = ?`, ownerId);
    return r ? mapOwnerRow(r) : null;
  }

  async getOwnerByEmail(email: string): Promise<OwnerRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owners WHERE email = ?`, email);
    return r ? mapOwnerRow(r) : null;
  }

  // ── WebAuthn credentials ──

  async addCredential(input: AddCredentialInput): Promise<CredentialRow> {
    const id = randomId('cred_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO owner_webauthn_credentials
         (id, owner_id, credential_id, public_key, signature_counter,
          transports, aaguid, backed_up, nickname, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.ownerId,
      input.credentialId,
      Buffer.from(input.publicKey),
      input.counter,
      input.transports ? JSON.stringify(input.transports) : null,
      input.aaguid ?? null,
      input.backedUp ? 1 : 0,
      input.nickname ?? null,
      now
    );
    const row = await this.getCredentialByRowId(id);
    if (!row) throw new Error(`addCredential: credential ${id} not found after insert`);
    return row;
  }

  private async getCredentialByRowId(id: string): Promise<CredentialRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_webauthn_credentials WHERE id = ?`,
      id
    );
    return r ? mapCredentialRow(r) : null;
  }

  /**
   * ACTIVE credentials only — this getter is the authority lookup for login
   * and every action ceremony, so a passkey revoked by recovery rotation must
   * be invisible here (it would otherwise keep authorizing actions).
   */
  async getCredentialByCredentialId(credentialId: string): Promise<CredentialRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_webauthn_credentials WHERE credential_id = ? AND status = 'active'`,
      credentialId
    );
    return r ? mapCredentialRow(r) : null;
  }

  /** Active credentials only (login/action allowCredentials, /me, daemon anchor list). */
  async listCredentials(ownerId: string): Promise<CredentialRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM owner_webauthn_credentials
       WHERE owner_id = ? AND status = 'active'
       ORDER BY created_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapCredentialRow);
  }

  /**
   * Recovery rotation: revoke every OTHER credential of this owner in one
   * conditional write. Returns how many were revoked.
   */
  async revokeOtherCredentials(ownerId: string, keepRowId: string, nowIso: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE owner_webauthn_credentials
       SET status = 'revoked', revoked_at = ?
       WHERE owner_id = ? AND id != ? AND status = 'active'`,
      nowIso,
      ownerId,
      keepRowId
    );
    return res.changes;
  }

  /**
   * ATOMIC monotonic signature-counter bump — the ONLY way the counter changes.
   * Defends against cloned/replayed authenticators (CONTROL_PLANE.md §4). Returns
   * true iff the counter advanced (or the no-counter 0→0 case).
   *
   *   UPDATE owner_webauthn_credentials SET signature_counter=?, last_used_at=?
   *     WHERE id=? AND signature_counter < ?   -> changes === 1
   *
   * Special case: an authenticator that does not implement a counter always
   * reports 0. When newCounter === 0 AND the stored counter is 0, we still allow
   * it (touching last_used_at) — but a stored counter > 0 that suddenly reports 0
   * is a clone and is rejected.
   */
  async advanceCounter(credentialRowId: string, newCounter: number): Promise<boolean> {
    const now = nowIsoString();
    const res = await this.db.run(
      `UPDATE owner_webauthn_credentials
         SET signature_counter = ?, last_used_at = ?
       WHERE id = ? AND signature_counter < ?`,
      newCounter,
      now,
      credentialRowId,
      newCounter
    );
    if (res.changes === 1) return true;

    // No-counter authenticator: allow only when the stored counter is also 0.
    if (newCounter === 0) {
      const res0 = await this.db.run(
        `UPDATE owner_webauthn_credentials
           SET last_used_at = ?
         WHERE id = ? AND signature_counter = 0`,
        now,
        credentialRowId
      );
      return res0.changes === 1;
    }
    return false;
  }

  // ── Challenges (single-use) ──

  async createChallenge(
    input: CreateChallengeInput
  ): Promise<{ id: string; challenge: string }> {
    const id = randomId('chl_');
    const challenge = base64urlEncode(randomBytes(32));
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    await this.db.run(
      `INSERT INTO webauthn_challenges
         (id, owner_id, challenge, purpose, action_type, action_hash,
          created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      id,
      input.ownerId ?? null,
      challenge,
      input.purpose,
      input.actionType ?? null,
      input.actionHash ?? null,
      createdAt,
      expiresAt
    );
    return { id, challenge };
  }

  /**
   * ATOMIC single-use consume. The guard is a single conditional UPDATE; only the
   * winner of a concurrent race sees changes === 1 (CONTROL_PLANE.md §4). Returns
   * the row iff it was unconsumed AND unexpired AND the purpose matches; else null.
   *
   *   UPDATE webauthn_challenges SET consumed_at=?
   *     WHERE challenge=? AND purpose=? AND consumed_at IS NULL AND expires_at > ?
   *
   * ISO-8601 UTC strings compare lexicographically, so `expires_at > nowIso` is a
   * valid freshness check.
   */
  async consumeChallenge(
    challenge: string,
    purpose: string,
    nowIso: string
  ): Promise<ChallengeRow | null> {
    const res = await this.db.run(
      `UPDATE webauthn_challenges
         SET consumed_at = ?
       WHERE challenge = ? AND purpose = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      challenge,
      purpose,
      nowIso
    );
    if (res.changes !== 1) return null;
    const r = await this.db.get<RawRow>(
      `SELECT * FROM webauthn_challenges WHERE challenge = ?`,
      challenge
    );
    return r ? mapChallengeRow(r) : null;
  }

  // ── Sessions ("sessions to look") ──

  async createSession(input: CreateSessionInput): Promise<SessionRow> {
    const id = randomId('ses_');
    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + input.ttlSeconds * 1000).toISOString();
    await this.db.run(
      `INSERT INTO owner_sessions
         (id, owner_id, token_hash, credential_id, created_at, expires_at,
          revoked_at, last_seen_at, user_agent, ip_hash)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      id,
      input.ownerId,
      input.tokenHash,
      input.credentialId ?? null,
      createdAt,
      expiresAt,
      createdAt,
      input.userAgent ?? null,
      input.ipHash ?? null
    );
    const row = await this.getSessionByRowId(id);
    if (!row) throw new Error(`createSession: session ${id} not found after insert`);
    return row;
  }

  private async getSessionByRowId(id: string): Promise<SessionRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owner_sessions WHERE id = ?`, id);
    return r ? mapSessionRow(r) : null;
  }

  /** Returns the session iff it is neither revoked nor expired; otherwise null. */
  async getSessionByTokenHash(tokenHash: string): Promise<SessionRow | null> {
    const now = nowIsoString();
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_sessions
       WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`,
      tokenHash,
      now
    );
    return r ? mapSessionRow(r) : null;
  }

  async touchSession(id: string, nowIso: string): Promise<void> {
    await this.db.run(`UPDATE owner_sessions SET last_seen_at = ? WHERE id = ?`, nowIso, id);
  }

  async revokeSession(id: string, nowIso: string): Promise<void> {
    await this.db.run(`UPDATE owner_sessions SET revoked_at = ? WHERE id = ?`, nowIso, id);
  }

  /** Recovery rotation: kill every live look-session for this owner. */
  async revokeAllSessionsForOwner(ownerId: string, nowIso: string): Promise<number> {
    const res = await this.db.run(
      `UPDATE owner_sessions SET revoked_at = ? WHERE owner_id = ? AND revoked_at IS NULL`,
      nowIso,
      ownerId
    );
    return res.changes;
  }

  // ── Recovery (CONTROL_PLANE.md §6 — authority rotation, never secrets) ──

  /**
   * Store a new recovery code (sha256 hex of the normalized plaintext). Any
   * previously open code is superseded first, so at most one is redeemable.
   */
  async createRecoveryCode(ownerId: string, codeHash: string): Promise<{ id: string; created_at: string }> {
    const now = nowIsoString();
    await this.db.run(
      `UPDATE owner_recovery_codes SET superseded_at = ?
       WHERE owner_id = ? AND used_at IS NULL AND superseded_at IS NULL`,
      now,
      ownerId
    );
    const id = randomId('rc_');
    await this.db.run(
      `INSERT INTO owner_recovery_codes (id, owner_id, code_hash, created_at, used_at, superseded_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`,
      id,
      ownerId,
      codeHash,
      now
    );
    return { id, created_at: now };
  }

  /** The open (unused, unsuperseded) code's metadata — for /me status display. */
  async getOpenRecoveryCode(ownerId: string): Promise<{ id: string; created_at: string } | null> {
    const r = await this.db.get<RawRow>(
      `SELECT id, created_at FROM owner_recovery_codes
       WHERE owner_id = ? AND used_at IS NULL AND superseded_at IS NULL
       ORDER BY created_at DESC, id DESC LIMIT 1`,
      ownerId
    );
    return r ? { id: asStr(r.id), created_at: asStr(r.created_at) } : null;
  }

  /**
   * ATOMICALLY consume the recovery code (single-use, §4): the conditional
   * UPDATE only matches an open code with exactly this hash for this owner.
   */
  async consumeRecoveryCode(ownerId: string, codeHash: string, nowIso: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE owner_recovery_codes SET used_at = ?
       WHERE owner_id = ? AND code_hash = ? AND used_at IS NULL AND superseded_at IS NULL`,
      nowIso,
      ownerId,
      codeHash
    );
    return res.changes === 1;
  }

  /** True iff an open code with this hash exists (pre-check only — finish consumes). */
  async peekRecoveryCode(ownerId: string, codeHash: string): Promise<boolean> {
    const r = await this.db.get<RawRow>(
      `SELECT id FROM owner_recovery_codes
       WHERE owner_id = ? AND code_hash = ? AND used_at IS NULL AND superseded_at IS NULL`,
      ownerId,
      codeHash
    );
    return r != null;
  }

  async createRecoveryToken(ownerId: string, tokenHash: string, ttlSeconds: number): Promise<void> {
    const now = new Date();
    await this.db.run(
      `INSERT INTO owner_recovery_tokens (id, owner_id, token_hash, created_at, expires_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
      randomId('rt_'),
      ownerId,
      tokenHash,
      now.toISOString(),
      new Date(now.getTime() + ttlSeconds * 1000).toISOString()
    );
  }

  /** The live (unconsumed, unexpired) token row, or null. Does NOT consume. */
  async getLiveRecoveryToken(tokenHash: string): Promise<{ owner_id: string } | null> {
    const r = await this.db.get<RawRow>(
      `SELECT owner_id FROM owner_recovery_tokens
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      tokenHash,
      nowIsoString()
    );
    return r ? { owner_id: asStr(r.owner_id) } : null;
  }

  /** ATOMICALLY consume the magic-link token (single-use, unexpired). */
  async consumeRecoveryToken(tokenHash: string, nowIso: string): Promise<boolean> {
    const res = await this.db.run(
      `UPDATE owner_recovery_tokens SET consumed_at = ?
       WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?`,
      nowIso,
      tokenHash,
      nowIso
    );
    return res.changes === 1;
  }

  // ── Billing (migration 0026 — plan state; NEVER consulted on security paths) ──

  /** The agent is the unit of scale: how many ACTIVE delegations this owner holds. */
  async countActiveDelegations(ownerId: string): Promise<number> {
    const r = await this.db.get<RawRow>(
      `SELECT COUNT(*) AS n FROM delegations WHERE owner_id = ? AND status = 'active'`,
      ownerId
    );
    return Number(r?.n ?? 0);
  }

  async getOwnerByStripeCustomerId(customerId: string): Promise<OwnerRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owners WHERE stripe_customer_id = ?`, customerId);
    return r ? mapOwnerRow(r) : null;
  }

  async setStripeCustomerId(ownerId: string, customerId: string): Promise<void> {
    await this.db.run(
      `UPDATE owners SET stripe_customer_id = ?, updated_at = ? WHERE id = ?`,
      customerId,
      nowIsoString(),
      ownerId
    );
  }

  async updateOwnerBilling(input: {
    ownerId: string;
    plan: 'free' | 'pro' | 'team';
    planStatus: 'active' | 'past_due' | 'canceled';
    stripeSubscriptionId?: string | null;
    currentPeriodEnd?: string | null;
  }): Promise<void> {
    await this.db.run(
      `UPDATE owners
       SET plan = ?, plan_status = ?, stripe_subscription_id = ?, current_period_end = ?, updated_at = ?
       WHERE id = ?`,
      input.plan,
      input.planStatus,
      input.stripeSubscriptionId ?? null,
      input.currentPeriodEnd ?? null,
      nowIsoString(),
      input.ownerId
    );
  }

  /**
   * ATOMIC idempotency claim for a Stripe webhook event: the INSERT succeeds
   * exactly once per event id; a replay hits the UNIQUE constraint and returns
   * false (§4 conditional-write discipline).
   */
  async claimStripeEvent(eventId: string, type: string): Promise<boolean> {
    try {
      await this.db.run(
        `INSERT INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)`,
        eventId,
        type,
        nowIsoString()
      );
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('UNIQUE') || msg.includes('SQLITE_CONSTRAINT')) return false;
      throw e;
    }
  }

  // ── E2E test outbox (Task 2 — only ever written in E2E=1 environments) ──

  async appendTestOutbox(recipient: string, subject: string, body: string): Promise<void> {
    await this.db.run(
      `INSERT INTO test_outbox (recipient, subject, body) VALUES (?, ?, ?)`,
      recipient,
      subject,
      body
    );
  }

  async listTestOutbox(recipient?: string): Promise<Array<{ recipient: string; subject: string; body: string; created_at: string }>> {
    const rows = recipient
      ? await this.db.all<RawRow>(
          `SELECT recipient, subject, body, created_at FROM test_outbox WHERE recipient = ? ORDER BY id DESC`,
          recipient
        )
      : await this.db.all<RawRow>(`SELECT recipient, subject, body, created_at FROM test_outbox ORDER BY id DESC`);
    return rows.map((r) => ({
      recipient: asStr(r.recipient),
      subject: asStr(r.subject),
      body: asStr(r.body),
      created_at: asStr(r.created_at),
    }));
  }

  // ── Action assertions (hash-chained, CONTROL_PLANE.md §5) ──

  /**
   * Append an owner action to the per-owner hash chain.
   *   sequence  = prev.sequence + 1  (1 for the first)
   *   prev_hash = prev.entry_hash    (64 zeros genesis for the first)
   *   entry_hash = sha256Hex(canonicalJson(event-without-entry_hash))
   *
   * UNIQUE(owner_id, sequence) is the atomicity guard: a concurrent double-append
   * to the same sequence loses the INSERT race. On that uniqueness error we
   * re-read the head and retry ONCE; a persistent conflict surfaces a clear error.
   */
  async appendActionAssertion(
    input: AppendActionAssertionInput
  ): Promise<ActionAssertionRow> {
    let lastConflict: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const head = await this.getOwnerChainHead(input.ownerId);
      const sequence = head.sequence + 1;
      const prevHash = head.entry_hash;
      const id = randomId('aa_');
      const createdAt = nowIsoString();
      const base: Omit<ActionAssertionRow, 'entry_hash'> = {
        id,
        owner_id: input.ownerId,
        credential_id: input.credentialId,
        action_type: input.actionType,
        action_hash: input.actionHash,
        authenticator_data: input.authenticatorData,
        client_data_json: input.clientDataJson,
        signature: input.signature,
        sequence,
        prev_hash: prevHash,
        created_at: createdAt,
      };
      const entryHash = sha256Hex(canonicalJsonStringify(actionAssertionEvent(base)));
      try {
        await this.db.run(
          `INSERT INTO action_assertions
             (id, owner_id, credential_id, action_type, action_hash,
              authenticator_data, client_data_json, signature,
              sequence, prev_hash, entry_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          base.id,
          base.owner_id,
          base.credential_id,
          base.action_type,
          base.action_hash,
          base.authenticator_data,
          base.client_data_json,
          base.signature,
          base.sequence,
          base.prev_hash,
          entryHash,
          base.created_at
        );
        return { ...base, entry_hash: entryHash };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
        lastConflict = e;
        // A concurrent append took this sequence — loop re-reads the head once.
      }
    }
    throw new Error(
      `appendActionAssertion: chain-append conflict for owner ${input.ownerId} ` +
        `(concurrent writer won the sequence twice)` +
        (lastConflict instanceof Error ? `: ${lastConflict.message}` : '')
    );
  }

  /** The current chain head; {0, 64-zeros genesis} when the owner has no events. */
  async getOwnerChainHead(
    ownerId: string
  ): Promise<{ sequence: number; entry_hash: string }> {
    const r = await this.db.get<RawRow>(
      `SELECT sequence, entry_hash FROM action_assertions
       WHERE owner_id = ? ORDER BY sequence DESC LIMIT 1`,
      ownerId
    );
    if (!r) return { sequence: 0, entry_hash: GENESIS_HASH };
    return { sequence: Number(r.sequence), entry_hash: asStr(r.entry_hash) };
  }

  /**
   * Verify the per-owner chain: sequences are 1..N contiguous, each prev_hash
   * links to the previous entry_hash, and every entry_hash recomputes from the
   * stored fields (so a tampered column is detected).
   */
  async verifyOwnerChain(ownerId: string): Promise<{ ok: boolean; errors: string[] }> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM action_assertions WHERE owner_id = ? ORDER BY sequence ASC`,
      ownerId
    );
    const errors: string[] = [];
    let prev = GENESIS_HASH;
    let expectedSeq = 1;
    for (const raw of rows) {
      const row = mapActionAssertionRow(raw);
      if (row.sequence !== expectedSeq) {
        errors.push(
          `owner ${ownerId}: expected sequence ${expectedSeq}, got ${row.sequence}`
        );
      }
      if (row.prev_hash !== prev) {
        errors.push(
          `owner ${ownerId}: sequence ${row.sequence} prev_hash mismatch ` +
            `(expected ${prev}, got ${row.prev_hash})`
        );
      }
      const recomputed = sha256Hex(canonicalJsonStringify(actionAssertionEvent(row)));
      if (recomputed !== row.entry_hash) {
        errors.push(
          `owner ${ownerId}: sequence ${row.sequence} entry_hash mismatch ` +
            `(recomputed ${recomputed}, stored ${row.entry_hash}) — tampered`
        );
      }
      prev = row.entry_hash;
      expectedSeq = row.sequence + 1;
    }
    return { ok: errors.length === 0, errors };
  }

  // ── Vault-key binding ──

  async createVaultBinding(input: CreateVaultBindingInput): Promise<VaultKeyRow> {
    const id = randomId('vk_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO owner_vault_keys
         (id, owner_id, vault_public_key, status, binding_assertion_id, bound_at, rotated_at)
       VALUES (?, ?, ?, 'active', ?, ?, NULL)`,
      id,
      input.ownerId,
      input.vaultPublicKey,
      input.bindingAssertionId ?? null,
      now
    );
    const row = await this.getVaultKeyByRowId(id);
    if (!row) throw new Error(`createVaultBinding: vault key ${id} not found after insert`);
    return row;
  }

  private async getVaultKeyByRowId(id: string): Promise<VaultKeyRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM owner_vault_keys WHERE id = ?`, id);
    return r ? mapVaultKeyRow(r) : null;
  }

  async getActiveVaultKey(ownerId: string): Promise<VaultKeyRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM owner_vault_keys
       WHERE owner_id = ? AND status = 'active'
       ORDER BY bound_at DESC, id DESC LIMIT 1`,
      ownerId
    );
    return r ? mapVaultKeyRow(r) : null;
  }

  // ── Delegations (owner -> agent edge) ──

  async createDelegation(input: CreateDelegationInput): Promise<DelegationRow> {
    const id = randomId('del_');
    const now = nowIsoString();
    try {
      await this.db.run(
        `INSERT INTO delegations
           (id, owner_id, agent_id, label, status,
            authorizing_assertion_id, revoke_assertion_id, created_at, revoked_at)
         VALUES (?, ?, ?, ?, 'active', ?, NULL, ?, NULL)`,
        id,
        input.ownerId,
        input.agentId,
        input.label ?? null,
        input.authorizingAssertionId,
        now
      );
    } catch (e) {
      if (isUniqueViolation(e)) {
        throw new Error(
          `already delegated: owner ${input.ownerId} already has a delegation for agent ${input.agentId}`
        );
      }
      throw e;
    }
    const row = await this.getDelegationByRowId(id);
    if (!row) throw new Error(`createDelegation: delegation ${id} not found after insert`);
    return row;
  }

  private async getDelegationByRowId(id: string): Promise<DelegationRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM delegations WHERE id = ?`, id);
    return r ? mapDelegationRow(r) : null;
  }

  async getDelegation(ownerId: string, agentId: string): Promise<DelegationRow | null> {
    const r = await this.db.get<RawRow>(
      `SELECT * FROM delegations WHERE owner_id = ? AND agent_id = ?`,
      ownerId,
      agentId
    );
    return r ? mapDelegationRow(r) : null;
  }

  async listDelegationsByOwner(ownerId: string): Promise<DelegationRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM delegations WHERE owner_id = ? ORDER BY created_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapDelegationRow);
  }

  async listDelegationsByAgent(agentId: string): Promise<DelegationRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM delegations WHERE agent_id = ? ORDER BY created_at ASC, id ASC`,
      agentId
    );
    return rows.map(mapDelegationRow);
  }

  async revokeDelegation(input: RevokeDelegationInput): Promise<DelegationRow> {
    await this.db.run(
      `UPDATE delegations
         SET status = 'revoked', revoke_assertion_id = ?, revoked_at = ?
       WHERE id = ?`,
      input.revokeAssertionId,
      input.nowIso,
      input.delegationId
    );
    const row = await this.getDelegationByRowId(input.delegationId);
    if (!row) throw new Error(`revokeDelegation: delegation ${input.delegationId} not found`);
    return row;
  }

  // ── Agents (open registry — read-only cross-reference) ──

  /**
   * The grantee's Ed25519 public key from the open `agents` table, or null if the
   * agent is unknown / has no key on file. Used to PIN the sealing target in the
   * grant-approval action (CONTROL_PLANE.md §2.1): the owner signs base58(this).
   */
  async getAgentPublicKey(agentId: string): Promise<Uint8Array | null> {
    const r = await this.db.get<RawRow>(
      `SELECT public_key FROM agents WHERE id = ?`,
      agentId
    );
    if (!r || r.public_key == null) return null;
    return toUint8Array(r.public_key);
  }

  // ── Keyring requests (approvals inbox, migration 0024) ──

  async createKeyringRequest(input: CreateKeyringRequestInput): Promise<KeyringRequestRow> {
    const id = randomId('req_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO keyring_requests
         (id, owner_id, agent_id, credential_id, credential_label, provider,
          constraints, note, status, created_at, decided_at, decision_assertion_id, deny_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL)`,
      id,
      input.ownerId,
      input.agentId,
      input.credentialId,
      input.credentialLabel ?? null,
      input.provider ?? null,
      JSON.stringify(input.constraints ?? {}),
      input.note ?? null,
      now
    );
    const row = await this.getKeyringRequest(id);
    if (!row) throw new Error(`createKeyringRequest: request ${id} not found after insert`);
    return row;
  }

  async getKeyringRequest(id: string): Promise<KeyringRequestRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM keyring_requests WHERE id = ?`, id);
    return r ? mapKeyringRequestRow(r) : null;
  }

  async listKeyringRequests(ownerId: string, status?: string): Promise<KeyringRequestRow[]> {
    const rows = status
      ? await this.db.all<RawRow>(
          `SELECT * FROM keyring_requests
           WHERE owner_id = ? AND status = ?
           ORDER BY created_at DESC, id DESC`,
          ownerId,
          status
        )
      : await this.db.all<RawRow>(
          `SELECT * FROM keyring_requests
           WHERE owner_id = ?
           ORDER BY created_at DESC, id DESC`,
          ownerId
        );
    return rows.map(mapKeyringRequestRow);
  }

  /** Record an owner's approve/deny decision. Idempotency is enforced by the
   * route (it only decides a request whose status is still 'pending'). */
  async setRequestDecision(input: SetRequestDecisionInput): Promise<KeyringRequestRow> {
    await this.db.run(
      `UPDATE keyring_requests
         SET status = ?, decided_at = ?, decision_assertion_id = ?, deny_reason = ?
       WHERE id = ?`,
      input.status,
      input.nowIso,
      input.assertionId ?? null,
      input.denyReason ?? null,
      input.id
    );
    const row = await this.getKeyringRequest(input.id);
    if (!row) throw new Error(`setRequestDecision: request ${input.id} not found`);
    return row;
  }

  // ── Grant approvals (ready for the daemon, migration 0024) ──

  async createGrantApproval(input: CreateGrantApprovalInput): Promise<GrantApprovalRow> {
    const id = randomId('gap_');
    const now = nowIsoString();
    await this.db.run(
      `INSERT INTO grant_approvals
         (id, owner_id, request_id, agent_id, agent_pubkey, credential_id, constraints,
          nonce, action_hash, assertion_credential_id, authenticator_data,
          client_data_json, signature, assertion_id, status, created_at,
          confirmed_at, daemon_grant_id, failure_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_daemon', ?, NULL, NULL, NULL)`,
      id,
      input.ownerId,
      input.requestId,
      input.agentId,
      input.agentPubkey,
      input.credentialId,
      JSON.stringify(input.constraints ?? {}),
      input.nonce,
      input.actionHash,
      input.assertionCredentialId,
      input.authenticatorData,
      input.clientDataJson,
      input.signature,
      input.assertionId,
      now
    );
    const row = await this.getGrantApproval(id);
    if (!row) throw new Error(`createGrantApproval: approval ${id} not found after insert`);
    return row;
  }

  async getGrantApproval(id: string): Promise<GrantApprovalRow | null> {
    const r = await this.db.get<RawRow>(`SELECT * FROM grant_approvals WHERE id = ?`, id);
    return r ? mapGrantApprovalRow(r) : null;
  }

  /** The approvals the daemon still needs to apply for an owner. */
  async listPendingApprovals(ownerId: string): Promise<GrantApprovalRow[]> {
    const rows = await this.db.all<RawRow>(
      `SELECT * FROM grant_approvals
       WHERE owner_id = ? AND status = 'pending_daemon'
       ORDER BY created_at ASC, id ASC`,
      ownerId
    );
    return rows.map(mapGrantApprovalRow);
  }

  /**
   * Mark an approval confirmed by the daemon — atomic conditional so a confirm
   * can only transition a pending_daemon row (never resurrect a failed one or
   * double-confirm). Returns the row iff it transitioned, else null.
   */
  async confirmGrantApproval(input: {
    id: string;
    daemonGrantId: string;
    nowIso: string;
  }): Promise<GrantApprovalRow | null> {
    const res = await this.db.run(
      `UPDATE grant_approvals
         SET status = 'confirmed', confirmed_at = ?, daemon_grant_id = ?
       WHERE id = ? AND status = 'pending_daemon'`,
      input.nowIso,
      input.daemonGrantId,
      input.id
    );
    if (res.changes !== 1) return null;
    return this.getGrantApproval(input.id);
  }

  /** Mark an approval failed (the daemon rejected/could not apply it). */
  async failGrantApproval(input: {
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<GrantApprovalRow | null> {
    const res = await this.db.run(
      `UPDATE grant_approvals
         SET status = 'failed', confirmed_at = ?, failure_reason = ?
       WHERE id = ? AND status = 'pending_daemon'`,
      input.nowIso,
      input.reason,
      input.id
    );
    if (res.changes !== 1) return null;
    return this.getGrantApproval(input.id);
  }
}
