/**
 * Keyring — scoped, revocable credentials bound to cryptographic agent identities.
 *
 * Owner operations (add credential, grant, revoke, kill switch, approvals) require
 * the vault owner's keypair. Agent operations (list, lease, request) require the
 * agent's keypair — every lease is a signed, attributable event.
 *
 * Revocation semantics (KEYRING_SPEC §7): revoking a grant instantly removes the
 * identity's ability to obtain new leases AND deletes that identity's sealed copy
 * of the secret. Outstanding leases die with their TTL (≤15 min by default).
 * Burning the key at the provider is a separate operation (Provisioner, v0.2).
 */

import type {
  VaultFile, KnownIdentity, Credential, CredentialPublic, CredentialMeta,
  Grant, GrantConstraints, GrantRequest, Lease, AccessEvent,
  AgentSummary, CredentialSummary, AgentCredentialView, TimelineFilter,
  VerifyLogResult, SignedLogExport,
} from './types.js';
import { DEFAULT_LEASE_TTL_SECONDS } from './types.js';
import { VaultStore } from './store.js';
import type { AccessEventType } from './types.js';
import {
  sealToPublicKey, openSealedBox, signPayload,
  generateKeypair, type AgentKeypair,
} from './crypto.js';
import { createEvent, verifyEventLog } from './events.js';
import {
  publicKeyToAgentId, agentIdToPublicKey, base58Encode,
  canonicalJsonStringify, sha256Hex, randomId, nowIso,
} from './util.js';

/** Days of history in the agents-view sparkline. */
const SPARKLINE_DAYS = 14;

export class KeyringError extends Error {
  constructor(message: string, readonly code:
    | 'not_owner' | 'unknown_identity' | 'unknown_credential' | 'unknown_grant' | 'unknown_request'
    | 'duplicate' | 'no_grant' | 'grant_revoked' | 'grant_expired' | 'usage_cap'
    | 'no_sealed_copy' | 'bad_signature' | 'invalid_input'
  ) {
    super(message);
    this.name = 'KeyringError';
  }
}

function stripSealed(credential: Credential): CredentialPublic {
  const { sealed: _sealed, ...pub } = credential;
  return pub;
}

/** Own-property lookup on a JSON-derived map — never resolves inherited
 * Object.prototype members (`constructor`, `toString`, …). */
function pick<T>(map: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : undefined;
}

/** Reserved names that must not be usable as identity names or record keys. */
const RESERVED_NAMES = new Set(['owner', '__proto__', 'constructor', 'prototype']);

function grantIsExpired(grant: Grant, at: number): boolean {
  return grant.constraints.expires_at !== undefined && Date.parse(grant.constraints.expires_at) <= at;
}

function grantAtUsageCap(grant: Grant): boolean {
  return grant.constraints.max_uses !== undefined && grant.use_count >= grant.constraints.max_uses;
}

/** Derive an env-var name from a label: "Stripe secret (prod)" → "STRIPE_SECRET_PROD". */
export function deriveEnvVarName(label: string): string {
  const name = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return /^[0-9]/.test(name) ? `_${name}` : name || '_SECRET';
}

export class Keyring {
  constructor(readonly store: VaultStore) {}

  // ─── Lifecycle ───

  /** Open an existing vault (throws if none exists at the directory). */
  static open(dir?: string): Keyring {
    const store = new VaultStore(dir);
    store.readVault(); // validate early
    return new Keyring(store);
  }

  static vaultExists(dir?: string): boolean {
    return new VaultStore(dir).exists();
  }

  /**
   * Create a new vault. Generates an owner keypair unless one is supplied
   * (e.g. to reuse an existing BasedAgents identity as the owner).
   */
  static async init(options?: { dir?: string; ownerKeypair?: AgentKeypair }): Promise<Keyring> {
    const store = new VaultStore(options?.dir);
    if (store.exists()) {
      throw new KeyringError(`A vault already exists at ${store.dir}`, 'duplicate');
    }
    const owner = options?.ownerKeypair ?? await generateKeypair();

    return store.withLock(async () => {
      // Re-check under the lock so a concurrent init can't clobber an existing vault.
      if (store.exists() || store.ownerKeyExists()) {
        throw new KeyringError(`A vault already exists at ${store.dir}`, 'duplicate');
      }
      const ownerAgentId = publicKeyToAgentId(owner.publicKey);
      store.writeOwnerKey(owner);
      const vault: VaultFile = {
        version: 1,
        created_at: nowIso(),
        owner: {
          agent_id: ownerAgentId,
          public_key_b58: base58Encode(owner.publicKey),
        },
        identities: {},
        credentials: {},
        grants: {},
        requests: {},
      };
      store.writeVault(vault);
      const event = await createEvent({
        actor: owner,
        vaultId: ownerAgentId,
        eventType: 'vault_created',
        head: store.chainHead(),
        detail: { owner_agent_id: ownerAgentId },
      });
      store.appendEvent(event);
      return new Keyring(store);
    });
  }

  /**
   * Build, sign, and append an AccessEvent under the current lock. The actor's
   * signature commits to the vault id and the event's chain position; see
   * events.ts. Returns the appended event.
   */
  private async emit(vault: VaultFile, actor: AgentKeypair, eventType: AccessEventType, fields?: {
    credentialId?: string | null;
    grantId?: string | null;
    context?: string | null;
    detail?: Record<string, unknown> | null;
  }): Promise<AccessEvent> {
    const event = await createEvent({
      actor,
      vaultId: vault.owner.agent_id,
      eventType,
      head: this.store.chainHead(),
      credentialId: fields?.credentialId,
      grantId: fields?.grantId,
      context: fields?.context,
      detail: fields?.detail,
    });
    this.store.appendEvent(event);
    return event;
  }

  /** Load the owner keypair stored alongside the vault. */
  ownerKeypair(): AgentKeypair {
    return this.store.readOwnerKey();
  }

  vault(): VaultFile {
    return this.store.readVault();
  }

  private assertOwner(vault: VaultFile, keypair: AgentKeypair): void {
    if (base58Encode(keypair.publicKey) !== vault.owner.public_key_b58) {
      throw new KeyringError('This operation requires the vault owner keypair', 'not_owner');
    }
  }

  // ─── Reference resolution ───

  /** Resolve an agent reference — agent ID or local identity name. */
  resolveAgent(vault: VaultFile, ref: string): string {
    if (pick(vault.identities, ref)) return ref;
    if (ref === vault.owner.agent_id) return ref;
    const lower = ref.toLowerCase();
    const matches = Object.values(vault.identities).filter(i => i.name?.toLowerCase() === lower);
    if (matches.length === 1) return matches[0].agent_id;
    if (matches.length > 1) {
      throw new KeyringError(`Identity name "${ref}" is ambiguous`, 'unknown_identity');
    }
    if (ref.startsWith('ag_')) {
      agentIdToPublicKey(ref); // validates shape
      return ref;
    }
    throw new KeyringError(`Unknown identity: ${ref}`, 'unknown_identity');
  }

  /**
   * Resolve a credential reference — credential ID, env var name, or label.
   * All three lookups are computed before returning, so a reference that could
   * mean two different credentials (e.g. one credential's label equals
   * another's env var) is rejected as ambiguous rather than silently picking one.
   */
  resolveCredential(vault: VaultFile, ref: string): Credential {
    const byId = pick(vault.credentials, ref);
    const all = Object.values(vault.credentials);
    const lower = ref.toLowerCase();
    const byEnv = all.filter(c => c.env_var === ref);
    const byLabel = all.filter(c => c.label.toLowerCase() === lower);

    const candidates = new Map<string, Credential>();
    if (byId) candidates.set(byId.credential_id, byId);
    for (const c of byEnv) candidates.set(c.credential_id, c);
    for (const c of byLabel) candidates.set(c.credential_id, c);

    if (candidates.size === 1) return [...candidates.values()][0];
    if (candidates.size > 1) {
      throw new KeyringError(`Credential reference "${ref}" is ambiguous — use the credential ID`, 'unknown_credential');
    }
    throw new KeyringError(`Unknown credential: ${ref}`, 'unknown_credential');
  }

  // ─── Owner operations ───

  /** Register a known identity so it can receive grants. */
  async addIdentity(
    owner: AgentKeypair,
    agentId: string,
    options?: { name?: string; keypairPath?: string }
  ): Promise<KnownIdentity> {
    const name = options?.name;
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      agentIdToPublicKey(agentId); // validates
      if (pick(vault.identities, agentId)) {
        throw new KeyringError(`Identity ${agentId} already added`, 'duplicate');
      }
      if (name) {
        if (name.startsWith('ag_')) {
          throw new KeyringError('Identity names must not start with "ag_"', 'invalid_input');
        }
        if (RESERVED_NAMES.has(name.toLowerCase())) {
          throw new KeyringError(`Identity name "${name}" is reserved`, 'invalid_input');
        }
        const clash = Object.values(vault.identities).some(i => i.name?.toLowerCase() === name.toLowerCase());
        if (clash) {
          throw new KeyringError(`Identity name "${name}" is already in use`, 'duplicate');
        }
      }
      const identity: KnownIdentity = {
        agent_id: agentId,
        name,
        keypair_path: options?.keypairPath,
        added_at: nowIso(),
      };
      vault.identities[agentId] = identity;
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'identity_added', {
        detail: { agent_id: agentId, name: name ?? null },
      });
      return identity;
    });
  }

  /** Remove a known identity. Fails if it still holds active grants (revoke or kill first). */
  async removeIdentity(owner: AgentKeypair, agentRef: string): Promise<void> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const agentId = this.resolveAgent(vault, agentRef);
      if (!pick(vault.identities, agentId)) {
        throw new KeyringError(`Unknown identity: ${agentRef}`, 'unknown_identity');
      }
      const active = Object.values(vault.grants).filter(g => g.agent_id === agentId && g.status === 'active');
      if (active.length > 0) {
        throw new KeyringError(
          `Identity ${agentId} still holds ${active.length} active grant(s) — revoke them or run the kill switch first`,
          'invalid_input'
        );
      }
      delete vault.identities[agentId];
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'identity_removed', { detail: { agent_id: agentId } });
    });
  }

  /**
   * Add a credential by manual paste. The secret is immediately sealed to the
   * owner's public key; the plaintext argument is never persisted.
   */
  async addCredential(owner: AgentKeypair, meta: CredentialMeta, secret: string): Promise<CredentialPublic> {
    if (!meta.label?.trim()) throw new KeyringError('Credential label is required', 'invalid_input');
    if (!secret) throw new KeyringError('Secret value must not be empty', 'invalid_input');
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const now = nowIso();
      const plaintext = new TextEncoder().encode(secret);
      const credential: Credential = {
        ...meta,
        label: meta.label.trim(),
        env_var: meta.env_var?.trim() || deriveEnvVarName(meta.label),
        credential_id: randomId('cred'),
        created_at: now,
        updated_at: now,
        sealed: {
          [vault.owner.agent_id]: sealToPublicKey(owner.publicKey, plaintext),
        },
      };
      plaintext.fill(0);
      vault.credentials[credential.credential_id] = credential;
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'credential_added', {
        credentialId: credential.credential_id,
        detail: { label: credential.label, provider: credential.provider ?? null, env_var: credential.env_var ?? null },
      });
      return stripSealed(credential);
    });
  }

  /**
   * Replace a credential's secret value (e.g. after a manual rotation at the provider).
   * Re-seals to the owner and to every identity whose grant currently authorizes a
   * lease — the "re-encryption happens on next write" point from KEYRING_SPEC §3.
   * Grants that are revoked, expired, or at their usage cap do NOT receive a fresh
   * sealed copy of the rotated secret (and any stale copy is dropped).
   */
  async updateCredentialSecret(owner: AgentKeypair, credentialRef: string, secret: string): Promise<CredentialPublic> {
    if (!secret) throw new KeyringError('Secret value must not be empty', 'invalid_input');
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const credential = this.resolveCredential(vault, credentialRef);
      const plaintext = new TextEncoder().encode(secret);
      const now = Date.now();
      const sealed: Record<string, string> = {
        [vault.owner.agent_id]: sealToPublicKey(owner.publicKey, plaintext),
      };
      for (const grant of Object.values(vault.grants)) {
        if (grant.credential_id !== credential.credential_id) continue;
        if (grant.status !== 'active' || grantIsExpired(grant, now) || grantAtUsageCap(grant)) continue;
        sealed[grant.agent_id] = sealToPublicKey(agentIdToPublicKey(grant.agent_id), plaintext);
      }
      plaintext.fill(0);
      credential.sealed = sealed;
      credential.updated_at = nowIso();
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'credential_updated', {
        credentialId: credential.credential_id,
        detail: { label: credential.label, resealed_to: Object.keys(sealed).length },
      });
      return stripSealed(credential);
    });
  }

  /** Remove a credential and all its grants. */
  async removeCredential(owner: AgentKeypair, credentialRef: string): Promise<void> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const credential = this.resolveCredential(vault, credentialRef);
      const removedGrants = Object.values(vault.grants)
        .filter(g => g.credential_id === credential.credential_id)
        .map(g => g.grant_id);
      for (const grantId of removedGrants) delete vault.grants[grantId];
      delete vault.credentials[credential.credential_id];
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'credential_removed', {
        credentialId: credential.credential_id,
        detail: { label: credential.label, removed_grant_ids: removedGrants },
      });
    });
  }

  /**
   * Validate constraints, re-seal the secret to the grantee, and add the grant
   * to the vault object. Caller holds the lock and persists vault + event.
   */
  private applyGrant(
    vault: VaultFile,
    owner: AgentKeypair,
    credentialRef: string,
    agentRef: string,
    constraints: GrantConstraints
  ): { grant: Grant; credential: Credential } {
    if (constraints.expires_at !== undefined && Number.isNaN(Date.parse(constraints.expires_at))) {
      throw new KeyringError(`Invalid expires_at: ${constraints.expires_at}`, 'invalid_input');
    }
    if (constraints.max_lease_ttl_seconds !== undefined && constraints.max_lease_ttl_seconds <= 0) {
      throw new KeyringError('max_lease_ttl_seconds must be positive', 'invalid_input');
    }
    if (constraints.max_uses !== undefined && (!Number.isInteger(constraints.max_uses) || constraints.max_uses <= 0)) {
      throw new KeyringError('max_uses must be a positive integer', 'invalid_input');
    }
    const credential = this.resolveCredential(vault, credentialRef);
    const agentId = this.resolveAgent(vault, agentRef);
    if (agentId === vault.owner.agent_id) {
      throw new KeyringError('The owner already holds every credential — grants are for agent identities', 'invalid_input');
    }
    if (!pick(vault.identities, agentId)) {
      // Auto-register bare agent IDs so `based grant <cred> ag_xxx` just works.
      vault.identities[agentId] = { agent_id: agentId, added_at: nowIso() };
    }
    const existing = Object.values(vault.grants).find(
      g => g.agent_id === agentId && g.credential_id === credential.credential_id && g.status === 'active'
    );
    if (existing) {
      throw new KeyringError(
        `Identity ${agentId} already has an active grant (${existing.grant_id}) for this credential`,
        'duplicate'
      );
    }

    const ownerBox = credential.sealed[vault.owner.agent_id];
    if (!ownerBox) throw new KeyringError('Vault is corrupt: owner sealed copy missing', 'no_sealed_copy');
    const plaintext = openSealedBox(owner.privateKey, ownerBox);
    credential.sealed[agentId] = sealToPublicKey(agentIdToPublicKey(agentId), plaintext);
    plaintext.fill(0);

    const grant: Grant = {
      grant_id: randomId('grant'),
      agent_id: agentId,
      credential_id: credential.credential_id,
      constraints,
      status: 'active',
      use_count: 0,
      created_at: nowIso(),
    };
    vault.grants[grant.grant_id] = grant;
    credential.updated_at = nowIso();
    return { grant, credential };
  }

  /**
   * Grant a credential to an identity. Opens the owner's sealed copy and re-seals
   * the secret to the grantee's public key — all client-side.
   */
  async createGrant(
    owner: AgentKeypair,
    credentialRef: string,
    agentRef: string,
    constraints: GrantConstraints = {}
  ): Promise<Grant> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const { grant, credential } = this.applyGrant(vault, owner, credentialRef, agentRef, constraints);
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'grant_created', {
        credentialId: credential.credential_id,
        grantId: grant.grant_id,
        detail: {
          agent_id: grant.agent_id,
          label: credential.label,
          constraints: constraints as unknown as Record<string, unknown>,
        },
      });
      return grant;
    });
  }

  /**
   * Revoke a grant. Instant: no new leases. Also deletes the identity's sealed
   * copy (unless another active grant for the same pair exists), so the secret
   * cannot be re-obtained even by reading the vault file.
   */
  async revokeGrant(owner: AgentKeypair, grantId: string, reason?: string): Promise<Grant> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const grant = pick(vault.grants, grantId);
      if (!grant) throw new KeyringError(`Unknown grant: ${grantId}`, 'unknown_grant');
      if (grant.status === 'revoked') {
        throw new KeyringError(`Grant ${grantId} is already revoked`, 'grant_revoked');
      }
      grant.status = 'revoked';
      grant.revoked_at = nowIso();
      if (reason) grant.revoke_reason = reason;

      const stillActive = Object.values(vault.grants).some(
        g => g.grant_id !== grantId && g.agent_id === grant.agent_id
          && g.credential_id === grant.credential_id && g.status === 'active'
      );
      if (!stillActive) {
        const credential = pick(vault.credentials, grant.credential_id);
        if (credential) delete credential.sealed[grant.agent_id];
      }
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'grant_revoked', {
        credentialId: grant.credential_id,
        grantId: grant.grant_id,
        detail: { agent_id: grant.agent_id, reason: reason ?? null },
      });
      return grant;
    });
  }

  /**
   * Kill switch — revoke every active grant an identity holds, in one operation.
   * Provider-side burns are v0.2 (Provisioner); this closes the vault side instantly.
   */
  async killSwitch(owner: AgentKeypair, agentRef: string, reason?: string): Promise<{ agent_id: string; revoked_grant_ids: string[] }> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const agentId = this.resolveAgent(vault, agentRef);
      const revoked: string[] = [];
      const now = nowIso();
      for (const grant of Object.values(vault.grants)) {
        if (grant.agent_id !== agentId || grant.status !== 'active') continue;
        grant.status = 'revoked';
        grant.revoked_at = now;
        grant.revoke_reason = reason ?? 'kill_switch';
        revoked.push(grant.grant_id);
        const credential = pick(vault.credentials, grant.credential_id);
        if (credential) delete credential.sealed[agentId];
      }
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'kill_switch', {
        detail: { agent_id: agentId, revoked_grant_ids: revoked, reason: reason ?? null },
      });
      return { agent_id: agentId, revoked_grant_ids: revoked };
    });
  }

  /** Approve a pending grant request against an existing credential. */
  async approveRequest(
    owner: AgentKeypair,
    requestId: string,
    credentialRef: string,
    constraints: GrantConstraints = {}
  ): Promise<{ request: GrantRequest; grant: Grant }> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const request = pick(vault.requests, requestId);
      if (!request) throw new KeyringError(`Unknown request: ${requestId}`, 'unknown_request');
      if (request.status !== 'pending') {
        throw new KeyringError(`Request ${requestId} is already ${request.status}`, 'duplicate');
      }
      const { grant, credential } = this.applyGrant(vault, owner, credentialRef, request.agent_id, constraints);
      request.status = 'approved';
      request.resolved_at = nowIso();
      request.credential_id = grant.credential_id;
      request.grant_id = grant.grant_id;
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'grant_created', {
        credentialId: credential.credential_id,
        grantId: grant.grant_id,
        detail: {
          agent_id: grant.agent_id,
          label: credential.label,
          constraints: constraints as unknown as Record<string, unknown>,
        },
      });
      await this.emit(vault, owner, 'request_approved', {
        credentialId: grant.credential_id,
        grantId: grant.grant_id,
        detail: { request_id: requestId, agent_id: request.agent_id },
      });
      return { request, grant };
    });
  }

  /** Deny a pending grant request. */
  async denyRequest(owner: AgentKeypair, requestId: string, reason?: string): Promise<GrantRequest> {
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      this.assertOwner(vault, owner);
      const request = pick(vault.requests, requestId);
      if (!request) throw new KeyringError(`Unknown request: ${requestId}`, 'unknown_request');
      if (request.status !== 'pending') {
        throw new KeyringError(`Request ${requestId} is already ${request.status}`, 'duplicate');
      }
      request.status = 'denied';
      request.resolved_at = nowIso();
      if (reason) request.deny_reason = reason;
      this.store.writeVault(vault);
      await this.emit(vault, owner, 'request_denied', {
        detail: { request_id: requestId, agent_id: request.agent_id, reason: reason ?? null },
      });
      return request;
    });
  }

  // ─── Agent operations ───

  /** List credentials this identity holds active grants for. Labels and metadata only — never values. */
  listForAgent(agentKeypair: AgentKeypair): AgentCredentialView[] {
    const vault = this.store.readVault();
    const agentId = publicKeyToAgentId(agentKeypair.publicKey);
    const now = Date.now();
    const views: AgentCredentialView[] = [];
    for (const grant of Object.values(vault.grants)) {
      if (grant.agent_id !== agentId || grant.status !== 'active') continue;
      if (grantIsExpired(grant, now) || grantAtUsageCap(grant)) continue;
      const credential = vault.credentials[grant.credential_id];
      if (!credential) continue;
      views.push({
        credential_id: credential.credential_id,
        label: credential.label,
        provider: credential.provider,
        env_var: credential.env_var,
        scope: credential.scope,
        grant_id: grant.grant_id,
        constraints: grant.constraints,
        use_count: grant.use_count,
      });
    }
    return views.sort((a, b) => a.label.localeCompare(b.label));
  }

  /**
   * Lease a credential: verify the grant and constraints, open the identity's
   * sealed copy, append an AccessEvent the agent signs (binding the access to
   * this vault and this chain position), and return the decrypted value with
   * TTL metadata. The value lives in memory only — it is never written to disk.
   *
   * Denied attempts are also recorded (lease_denied) with the denial reason.
   */
  async lease(
    agentKeypair: AgentKeypair,
    credentialRef: string,
    options?: { context?: string; ttlSeconds?: number }
  ): Promise<Lease> {
    const agentId = publicKeyToAgentId(agentKeypair.publicKey);
    const context = options?.context ?? null;

    return this.store.withLock(async () => {
      const vault = this.store.readVault();

      // Resolve the credential; unknown refs are recorded as denials with no credential_id.
      let credential: Credential;
      try {
        credential = this.resolveCredential(vault, credentialRef);
      } catch (err) {
        await this.recordDenial(vault, agentKeypair, null, null, context, `unknown credential: ${credentialRef}`);
        throw err;
      }

      const grants = Object.values(vault.grants).filter(
        g => g.agent_id === agentId && g.credential_id === credential.credential_id
      );
      const active = grants.find(g => g.status === 'active');

      const deny = async (reason: string, code: ConstructorParameters<typeof KeyringError>[1], grantId?: string): Promise<never> => {
        await this.recordDenial(vault, agentKeypair, credential.credential_id, grantId ?? null, context, reason);
        throw new KeyringError(`Lease denied for "${credential.label}": ${reason}`, code);
      };

      if (!active) {
        if (grants.some(g => g.status === 'revoked')) {
          return deny('grant was revoked', 'grant_revoked');
        }
        return deny('no grant for this identity', 'no_grant');
      }
      if (grantIsExpired(active, Date.now())) {
        return deny('grant expired', 'grant_expired', active.grant_id);
      }
      if (grantAtUsageCap(active)) {
        return deny(`usage cap reached (${active.constraints.max_uses})`, 'usage_cap', active.grant_id);
      }
      const sealedBox = pick(credential.sealed, agentId);
      if (!sealedBox) {
        return deny('no sealed copy for this identity (re-grant to re-seal)', 'no_sealed_copy', active.grant_id);
      }

      const maxTtl = active.constraints.max_lease_ttl_seconds ?? DEFAULT_LEASE_TTL_SECONDS;
      const requested = options?.ttlSeconds ?? Math.min(DEFAULT_LEASE_TTL_SECONDS, maxTtl);
      const ttlSeconds = Math.min(requested, maxTtl);
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        return deny('requested TTL must be a positive number', 'invalid_input', active.grant_id);
      }

      // The agent proves key possession by opening its sealed copy.
      let value: string;
      try {
        const plaintext = openSealedBox(agentKeypair.privateKey, sealedBox);
        value = new TextDecoder().decode(plaintext);
        plaintext.fill(0);
      } catch {
        return deny('sealed box could not be opened with this keypair', 'bad_signature', active.grant_id);
      }

      active.use_count += 1;
      this.store.writeVault(vault);

      // The agent signs the AccessEvent — attributable, and bound to this chain slot.
      const event = await this.emit(vault, agentKeypair, 'lease', {
        credentialId: credential.credential_id,
        grantId: active.grant_id,
        context,
        detail: active.constraints.project ? { project: active.constraints.project } : null,
      });

      const issuedAt = Date.parse(event.timestamp);
      return {
        lease_id: randomId('lease'),
        credential: stripSealed(credential),
        grant_id: active.grant_id,
        agent_id: agentId,
        value,
        ttl_seconds: ttlSeconds,
        issued_at: event.timestamp,
        expires_at: new Date(issuedAt + ttlSeconds * 1000).toISOString(),
        access_event_id: event.event_id,
      };
    });
  }

  private async recordDenial(
    vault: VaultFile,
    agentKeypair: AgentKeypair,
    credentialId: string | null,
    grantId: string | null,
    context: string | null,
    reason: string
  ): Promise<void> {
    await this.emit(vault, agentKeypair, 'lease_denied', {
      credentialId,
      grantId,
      context,
      detail: { reason },
    });
  }

  /**
   * Lease every credential this identity has a grant for — the `based run` path.
   * Every active grant is attempted (including expired / usage-capped ones) so
   * that each failure produces a signed lease_denied event and a visible denial,
   * rather than being silently skipped.
   */
  async leaseAll(
    agentKeypair: AgentKeypair,
    options?: { context?: string; ttlSeconds?: number }
  ): Promise<{ leases: Lease[]; denied: Array<{ credential_id: string; label: string; reason: string }> }> {
    const agentId = publicKeyToAgentId(agentKeypair.publicKey);
    const vault = this.store.readVault();
    const targets = new Map<string, string>(); // credential_id -> label
    for (const grant of Object.values(vault.grants)) {
      if (grant.agent_id !== agentId || grant.status !== 'active') continue;
      const credential = pick(vault.credentials, grant.credential_id);
      if (credential) targets.set(credential.credential_id, credential.label);
    }

    const leases: Lease[] = [];
    const denied: Array<{ credential_id: string; label: string; reason: string }> = [];
    for (const [credentialId, label] of targets) {
      try {
        leases.push(await this.lease(agentKeypair, credentialId, options));
      } catch (err) {
        denied.push({ credential_id: credentialId, label, reason: (err as Error).message });
      }
    }
    return { leases, denied };
  }

  /** Create a pending grant request for the owner to approve (KEYRING_SPEC §4). */
  async createRequest(
    agentKeypair: AgentKeypair,
    provider: string,
    options?: { scope?: string; note?: string }
  ): Promise<GrantRequest> {
    if (!provider?.trim()) throw new KeyringError('Provider is required', 'invalid_input');
    const agentId = publicKeyToAgentId(agentKeypair.publicKey);
    return this.store.withLock(async () => {
      const vault = this.store.readVault();
      const duplicate = Object.values(vault.requests).find(
        r => r.agent_id === agentId && r.status === 'pending'
          && r.provider === provider.trim() && r.scope === options?.scope
      );
      if (duplicate) return duplicate;

      const request: GrantRequest = {
        request_id: randomId('req'),
        agent_id: agentId,
        provider: provider.trim(),
        scope: options?.scope,
        note: options?.note,
        status: 'pending',
        created_at: nowIso(),
      };
      vault.requests[request.request_id] = request;
      this.store.writeVault(vault);
      await this.emit(vault, agentKeypair, 'request_created', {
        detail: {
          request_id: request.request_id,
          provider: request.provider,
          scope: request.scope ?? null,
          note: request.note ?? null,
        },
      });
      return request;
    });
  }

  // ─── Views (read-only) ───

  agentsView(): AgentSummary[] {
    const vault = this.store.readVault();
    const events = this.store.readEvents();

    const leaseStats = new Map<string, { total: number; last?: string; daily: number[] }>();
    const dayMs = 24 * 60 * 60 * 1000;
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    for (const event of events) {
      if (event.event_type !== 'lease') continue;
      const agentId = `ag_${event.agent_pubkey}`;
      const stats = leaseStats.get(agentId) ?? { total: 0, daily: new Array<number>(SPARKLINE_DAYS).fill(0) };
      stats.total += 1;
      if (!stats.last || event.timestamp > stats.last) stats.last = event.timestamp;
      const dayIndex = SPARKLINE_DAYS - 1 - Math.floor((today.getTime() + dayMs - Date.parse(event.timestamp)) / dayMs);
      if (dayIndex >= 0 && dayIndex < SPARKLINE_DAYS) stats.daily[dayIndex] += 1;
      leaseStats.set(agentId, stats);
    }

    const summarize = (agentId: string, name: string | undefined, isOwner: boolean, addedAt?: string): AgentSummary => {
      const grants = Object.values(vault.grants).filter(g => g.agent_id === agentId);
      const stats = leaseStats.get(agentId);
      return {
        agent_id: agentId,
        name,
        is_owner: isOwner,
        added_at: addedAt,
        active_grants: grants.filter(g => g.status === 'active').length,
        revoked_grants: grants.filter(g => g.status === 'revoked').length,
        total_leases: stats?.total ?? 0,
        last_access: stats?.last,
        daily_leases: stats?.daily ?? new Array<number>(SPARKLINE_DAYS).fill(0),
        grants: grants
          .map(g => ({ ...g, credential_label: vault.credentials[g.credential_id]?.label ?? '(removed)' }))
          .sort((a, b) => b.created_at.localeCompare(a.created_at)),
      };
    };

    const summaries = Object.values(vault.identities).map(i => summarize(i.agent_id, i.name, false, i.added_at));
    summaries.sort((a, b) => (b.last_access ?? '').localeCompare(a.last_access ?? '') || a.agent_id.localeCompare(b.agent_id));
    return summaries;
  }

  credentialsView(): CredentialSummary[] {
    const vault = this.store.readVault();
    const events = this.store.readEvents();

    const lastLeaseByGrant = new Map<string, string>();
    for (const event of events) {
      if (event.event_type !== 'lease' || !event.grant_id) continue;
      const prev = lastLeaseByGrant.get(event.grant_id);
      if (!prev || event.timestamp > prev) lastLeaseByGrant.set(event.grant_id, event.timestamp);
    }

    return Object.values(vault.credentials).map(credential => ({
      ...stripSealed(credential),
      holders: Object.values(vault.grants)
        .filter(g => g.credential_id === credential.credential_id)
        .map(g => ({
          agent_id: g.agent_id,
          name: vault.identities[g.agent_id]?.name,
          grant_id: g.grant_id,
          status: g.status,
          constraints: g.constraints,
          use_count: g.use_count,
          last_leased: lastLeaseByGrant.get(g.grant_id),
        }))
        .sort((a, b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1)),
    })).sort((a, b) => a.label.localeCompare(b.label));
  }

  requestsView(status?: GrantRequest['status']): GrantRequest[] {
    const vault = this.store.readVault();
    return Object.values(vault.requests)
      .filter(r => !status || r.status === status)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  /** The AccessEvent stream, filterable by agent / credential / type / project / time. */
  timeline(filter: TimelineFilter = {}): AccessEvent[] {
    const events = this.store.readEvents();
    let agentPubkey: string | undefined;
    if (filter.agent) {
      const vault = this.store.readVault();
      const agentId = this.resolveAgent(vault, filter.agent);
      agentPubkey = agentId.slice(3);
    }
    let filtered = events.filter(event => {
      if (agentPubkey && event.agent_pubkey !== agentPubkey) return false;
      if (filter.credential_id && event.credential_id !== filter.credential_id) return false;
      if (filter.event_type && event.event_type !== filter.event_type) return false;
      if (filter.project && (event.detail as { project?: string } | null)?.project !== filter.project) return false;
      if (filter.since && event.timestamp < filter.since) return false;
      if (filter.until && event.timestamp > filter.until) return false;
      return true;
    });
    if (filter.limit && filter.limit > 0) filtered = filtered.slice(-filter.limit);
    return filtered;
  }

  /** Verify the whole event log: hash chain, signatures, payload consistency. */
  async verifyLog(options?: { expectedHead?: { sequence: number; entry_hash: string } }): Promise<VerifyLogResult> {
    const vault = this.store.readVault();
    const anchor = this.store.readHeadAnchor();
    return verifyEventLog(this.store.readEvents(), {
      expectedVault: vault.owner.agent_id,
      expectedCount: anchor?.count,
      expectedHead: options?.expectedHead
        ?? (anchor ? { sequence: anchor.sequence, entry_hash: anchor.entry_hash } : undefined),
    });
  }

  /** Export the AccessEvent stream as signed JSON (Looptail ingestion format). */
  async exportLog(owner: AgentKeypair): Promise<SignedLogExport> {
    const vault = this.store.readVault();
    this.assertOwner(vault, owner);
    const events = this.store.readEvents();
    const head = events.length
      ? { sequence: events[events.length - 1].sequence, entry_hash: events[events.length - 1].entry_hash }
      : null;
    const eventsHash = sha256Hex(canonicalJsonStringify(events));
    const exportedAt = nowIso();
    const signable = canonicalJsonStringify({
      format: 'basedagents-keyring-log/v1',
      exported_at: exportedAt,
      vault_owner: vault.owner,
      head,
      events_hash: eventsHash,
    });
    return {
      format: 'basedagents-keyring-log/v1',
      exported_at: exportedAt,
      vault_owner: vault.owner,
      head,
      events,
      events_hash: eventsHash,
      export_signature: await signPayload(owner.privateKey, signable),
    };
  }
}
