/**
 * Browser-side re-implementation of the @basedagents/keyring core, for the
 * live demo on /keyring. Mirrors packages/keyring/src/crypto.ts and events.ts
 * exactly — same sealed-box construction, same canonical JSON, same
 * hash-chained signed AccessEvent envelope — with an in-memory vault instead
 * of files on disk. Everything here runs in the visitor's browser.
 *
 * Sealed-box construction (versioned, v1):
 *   recipient X25519 pub = edwardsToMontgomeryPub(ed25519 pub)
 *   shared               = x25519(ephemeral priv, recipient X25519 pub)
 *   key                  = HKDF-SHA256(shared, salt = ephPub ‖ recipPub,
 *                            info = "basedagents-keyring/v1/sealed-box", 32)
 *   box                  = 0x01 ‖ ephPub(32) ‖ nonce(24) ‖ XChaCha20-Poly1305(...)
 */

import * as ed from '@noble/ed25519';
import { x25519, edwardsToMontgomeryPub, edwardsToMontgomeryPriv } from '@noble/curves/ed25519';
import { xchacha20poly1305 } from '@noble/ciphers/chacha';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { sha512 } from '@noble/hashes/sha512';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';

// @noble/ed25519 v2 needs a SHA-512 implementation; wire in @noble/hashes.
ed.etc.sha512Sync = (...msgs) => {
  const h = sha512.create();
  for (const m of msgs) h.update(m);
  return h.digest();
};

// ─── Encoding helpers (no Buffer in the browser) ───

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  for (const b of bytes) { if (b !== 0) break; zeros++; }
  let num = 0n;
  for (const b of bytes) num = num * 256n + BigInt(b);
  const chars: string[] = [];
  while (num > 0n) { chars.unshift(BASE58_ALPHABET[Number(num % 58n)]); num = num / 58n; }
  for (let i = 0; i < zeros; i++) chars.unshift('1');
  return chars.join('');
}

export function base58Decode(str: string): Uint8Array {
  let zeros = 0;
  for (const c of str) { if (c !== '1') break; zeros++; }
  let num = 0n;
  for (const c of str) {
    const idx = BASE58_ALPHABET.indexOf(c);
    if (idx === -1) throw new Error(`Invalid base58 character: ${c}`);
    num = num * 58n + BigInt(idx);
  }
  const hex = num === 0n ? '' : num.toString(16);
  const padded = hex.length % 2 ? '0' + hex : hex;
  const result = new Uint8Array(zeros + padded.length / 2);
  for (let i = 0; i < padded.length; i += 2) result[zeros + i / 2] = parseInt(padded.substring(i, i + 2), 16);
  return result;
}

/** Canonical JSON — recursively sorted keys, compact separators. Signature payloads only. */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalJsonStringify).join(',') + ']';
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return '{' + Object.keys(record).sort().map(k => JSON.stringify(k) + ':' + canonicalJsonStringify(record[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

export function sha256Hex(data: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(data)));
}

function randomId(prefix: string): string {
  return `${prefix}_${base58Encode(randomBytes(16))}`;
}

// ─── Sealed boxes (identical to packages/keyring/src/crypto.ts) ───

const SEALED_BOX_VERSION = 0x01;
const HKDF_INFO = 'basedagents-keyring/v1/sealed-box';
const EPH_PUB_LENGTH = 32;
const NONCE_LENGTH = 24;

export interface AgentKeypair { publicKey: Uint8Array; privateKey: Uint8Array; }

export async function generateKeypair(): Promise<AgentKeypair> {
  const privateKey = ed.utils.randomPrivateKey();
  const publicKey = await ed.getPublicKeyAsync(privateKey);
  return { publicKey, privateKey };
}

function concatBytes(...arrays: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrays.reduce((n, a) => n + a.length, 0));
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

function deriveKey(shared: Uint8Array, ephPub: Uint8Array, recipPub: Uint8Array): Uint8Array {
  return hkdf(sha256, shared, concatBytes(ephPub, recipPub), HKDF_INFO, 32);
}

/** Seal plaintext to an Ed25519 public key. Anyone can seal; only the keyholder can open. */
export function sealToPublicKey(recipientEdPublicKey: Uint8Array, plaintext: Uint8Array): string {
  const recipX = edwardsToMontgomeryPub(recipientEdPublicKey);
  const ephPriv = x25519.utils.randomPrivateKey();
  const ephPub = x25519.getPublicKey(ephPriv);
  const key = deriveKey(x25519.getSharedSecret(ephPriv, recipX), ephPub, recipX);
  const nonce = randomBytes(NONCE_LENGTH);
  const ciphertext = xchacha20poly1305(key, nonce).encrypt(plaintext);
  return bytesToBase64(concatBytes(Uint8Array.of(SEALED_BOX_VERSION), ephPub, nonce, ciphertext));
}

/** Open a sealed box with the recipient's Ed25519 private key. */
export function openSealedBox(recipientEdPrivateKey: Uint8Array, sealedB64: string): Uint8Array {
  const box = base64ToBytes(sealedB64);
  if (box[0] !== SEALED_BOX_VERSION) throw new Error(`Unsupported sealed box version: ${box[0]}`);
  const ephPub = box.slice(1, 1 + EPH_PUB_LENGTH);
  const nonce = box.slice(1 + EPH_PUB_LENGTH, 1 + EPH_PUB_LENGTH + NONCE_LENGTH);
  const ciphertext = box.slice(1 + EPH_PUB_LENGTH + NONCE_LENGTH);
  const xPriv = edwardsToMontgomeryPriv(recipientEdPrivateKey);
  const xPub = x25519.getPublicKey(xPriv);
  const key = deriveKey(x25519.getSharedSecret(xPriv, ephPub), ephPub, xPub);
  return xchacha20poly1305(key, nonce).decrypt(ciphertext);
}

// ─── Object model (subset of packages/keyring/src/types.ts) ───

export interface DemoIdentity {
  agent_id: string;
  name: string;
  is_owner: boolean;
  keypair: AgentKeypair; // demo only — in the real vault, agent private keys never enter it
}

export interface DemoCredential {
  credential_id: string;
  label: string;
  env_var: string;
  created_at: string;
  /** agent_id → base64 sealed box. The only place the secret exists — always ciphertext. */
  sealed: Record<string, string>;
}

export interface DemoGrant {
  grant_id: string;
  agent_id: string;
  credential_id: string;
  constraints: { max_lease_ttl_seconds: number; max_uses: number };
  status: 'active' | 'revoked';
  use_count: number;
  created_at: string;
  revoked_at?: string;
}

export type DemoEventType =
  | 'vault_created' | 'identity_added' | 'credential_added'
  | 'grant_created' | 'grant_revoked' | 'kill_switch' | 'lease' | 'lease_denied';

/** Same envelope as packages/keyring AccessEvent. */
export interface DemoAccessEvent {
  event_id: string;
  sequence: number;
  timestamp: string;
  event_type: DemoEventType;
  agent_pubkey: string;      // base58 Ed25519 pubkey of the actor
  agent_signature: string;   // base64 Ed25519 signature over signed_payload
  signed_payload: string;    // exact canonical JSON string the actor signed
  credential_id: string | null;
  grant_id: string | null;
  requesting_context: string | null;
  detail: Record<string, unknown> | null;
  prev_hash: string;
  entry_hash: string;
}

export interface VerifyLogResult {
  ok: boolean;
  events_checked: number;
  errors: Array<{ sequence: number; error: string }>;
}

export const GENESIS_HASH = '0'.repeat(64);
export const DEFAULT_LEASE_TTL_SECONDS = 900;

export class LeaseDeniedError extends Error {
  event: DemoAccessEvent;
  constructor(reason: string, event: DemoAccessEvent) { super(reason); this.event = event; }
}

// ─── The demo vault ───

export class DemoVault {
  owner!: DemoIdentity;
  identities: DemoIdentity[] = [];
  credentials: DemoCredential[] = [];
  grants: DemoGrant[] = [];
  events: DemoAccessEvent[] = [];
  private tampered: { sequence: number; original: string | null } | null = null;

  /** Create the owner plus two agent identities with real Ed25519 keypairs. */
  async init(agentNames: string[] = ['ci-bot', 'deploy-bot']): Promise<void> {
    this.owner = { agent_id: '', name: 'owner', is_owner: true, keypair: await generateKeypair() };
    this.owner.agent_id = `ag_${base58Encode(this.owner.keypair.publicKey)}`;
    this.identities = [this.owner];
    await this.appendEvent(this.owner.keypair, 'vault_created', {});
    for (const name of agentNames) {
      const keypair = await generateKeypair();
      const identity: DemoIdentity = { agent_id: `ag_${base58Encode(keypair.publicKey)}`, name, is_owner: false, keypair };
      this.identities.push(identity);
      await this.appendEvent(this.owner.keypair, 'identity_added', { detail: { name, agent_id: identity.agent_id } });
    }
  }

  identity(ref: string): DemoIdentity {
    const found = this.identities.find(i => i.name === ref || i.agent_id === ref);
    if (!found) throw new Error(`Unknown identity: ${ref}`);
    return found;
  }

  nameForPubkey(pubkeyB58: string): string {
    return this.identities.find(i => i.agent_id === `ag_${pubkeyB58}`)?.name ?? 'unknown';
  }

  /** Seal a secret to the owner's key. The plaintext never enters vault state. */
  async addCredential(label: string, envVar: string, secret: string): Promise<DemoCredential> {
    const credential: DemoCredential = {
      credential_id: randomId('cred'),
      label,
      env_var: envVar,
      created_at: new Date().toISOString(),
      sealed: { [this.owner.agent_id]: sealToPublicKey(this.owner.keypair.publicKey, new TextEncoder().encode(secret)) },
    };
    this.credentials.push(credential);
    await this.appendEvent(this.owner.keypair, 'credential_added', {
      credentialId: credential.credential_id, detail: { label, env_var: envVar },
    });
    return credential;
  }

  /** Open the owner's sealed copy and re-seal to the grantee's public key. */
  async createGrant(credentialId: string, agentRef: string, constraints: { maxUses: number; maxTtlSeconds: number }): Promise<DemoGrant> {
    const credential = this.credentials.find(c => c.credential_id === credentialId);
    if (!credential) throw new Error('Unknown credential');
    const grantee = this.identity(agentRef);
    const plaintext = openSealedBox(this.owner.keypair.privateKey, credential.sealed[this.owner.agent_id]);
    credential.sealed[grantee.agent_id] = sealToPublicKey(grantee.keypair.publicKey, plaintext);
    const grant: DemoGrant = {
      grant_id: randomId('grant'),
      agent_id: grantee.agent_id,
      credential_id: credentialId,
      constraints: { max_lease_ttl_seconds: constraints.maxTtlSeconds, max_uses: constraints.maxUses },
      status: 'active',
      use_count: 0,
      created_at: new Date().toISOString(),
    };
    this.grants.push(grant);
    await this.appendEvent(this.owner.keypair, 'grant_created', {
      credentialId, grantId: grant.grant_id,
      detail: { agent: grantee.name, max_uses: constraints.maxUses, max_lease_ttl_seconds: constraints.maxTtlSeconds },
    });
    return grant;
  }

  /**
   * Lease a credential as an agent: check the grant, enforce constraints, open
   * the agent's sealed copy with its own private key, sign the AccessEvent.
   * Denials are themselves signed lease_denied events, then thrown.
   */
  async lease(agentRef: string, credentialId: string, context: string): Promise<{ value: string; ttlSeconds: number; expiresAt: Date; event: DemoAccessEvent }> {
    const agent = this.identity(agentRef);
    const credential = this.credentials.find(c => c.credential_id === credentialId);
    if (!credential) throw new Error('Unknown credential');

    const deny = async (reason: string, grantId?: string): Promise<never> => {
      const event = await this.appendEvent(agent.keypair, 'lease_denied', {
        credentialId, grantId: grantId ?? null, context, detail: { reason },
      });
      throw new LeaseDeniedError(reason, event);
    };

    const grant = this.grants.find(g => g.agent_id === agent.agent_id && g.credential_id === credentialId);
    if (!grant) return deny('no grant for this identity');
    if (grant.status === 'revoked') return deny('grant was revoked', grant.grant_id);
    if (grant.use_count >= grant.constraints.max_uses) {
      return deny(`usage cap reached (max_uses = ${grant.constraints.max_uses})`, grant.grant_id);
    }
    const sealed = credential.sealed[agent.agent_id];
    if (!sealed) return deny('no sealed copy for this identity', grant.grant_id);

    const value = new TextDecoder().decode(openSealedBox(agent.keypair.privateKey, sealed));
    const ttlSeconds = Math.min(grant.constraints.max_lease_ttl_seconds, DEFAULT_LEASE_TTL_SECONDS);
    grant.use_count += 1;
    const event = await this.appendEvent(agent.keypair, 'lease', {
      credentialId, grantId: grant.grant_id, context,
      detail: { ttl_seconds: ttlSeconds, use_count: grant.use_count },
    });
    return { value, ttlSeconds, expiresAt: new Date(Date.now() + ttlSeconds * 1000), event };
  }

  /** Revoke every grant an identity holds and delete its sealed copies. */
  async killSwitch(agentRef: string): Promise<number> {
    const agent = this.identity(agentRef);
    let revoked = 0;
    for (const grant of this.grants) {
      if (grant.agent_id !== agent.agent_id || grant.status !== 'active') continue;
      grant.status = 'revoked';
      grant.revoked_at = new Date().toISOString();
      const credential = this.credentials.find(c => c.credential_id === grant.credential_id);
      if (credential) delete credential.sealed[agent.agent_id];
      revoked++;
    }
    await this.appendEvent(this.owner.keypair, 'kill_switch', {
      context: `kill ${agent.name}`, detail: { agent: agent.name, revoked_grants: revoked },
    });
    return revoked;
  }

  /** Build, sign, hash, and append an AccessEvent — same shape as events.ts. */
  private async appendEvent(actor: AgentKeypair, eventType: DemoEventType, input: {
    credentialId?: string | null; grantId?: string | null; context?: string | null; detail?: Record<string, unknown> | null;
  }): Promise<DemoAccessEvent> {
    const head = this.events.length
      ? { sequence: this.events[this.events.length - 1].sequence, entry_hash: this.events[this.events.length - 1].entry_hash }
      : { sequence: 0, entry_hash: GENESIS_HASH };
    // Same SignablePayload shape as the shipped package (events.ts): the
    // signature commits to the event's chain position, its concrete
    // event_type, and the vault id — so reordering, duplication, relabeling,
    // and cross-vault splicing are all detectable.
    const payload = {
      event_type: eventType,
      vault: this.owner.agent_id,
      agent_id: `ag_${base58Encode(actor.publicKey)}`,
      credential_id: input.credentialId ?? null,
      grant_id: input.grantId ?? null,
      context: input.context ?? null,
      detail: input.detail ?? null,
      sequence: head.sequence + 1,
      prev_hash: head.entry_hash,
      timestamp: new Date().toISOString(),
      nonce: randomId('nonce'),
    };
    const canonical = canonicalJsonStringify(payload);
    const signature = bytesToBase64(await ed.signAsync(new TextEncoder().encode(canonical), actor.privateKey));
    const unhashed: Omit<DemoAccessEvent, 'entry_hash'> = {
      event_id: randomId('evt'),
      sequence: head.sequence + 1,
      timestamp: payload.timestamp,
      event_type: eventType,
      agent_pubkey: base58Encode(actor.publicKey),
      agent_signature: signature,
      signed_payload: canonical,
      credential_id: payload.credential_id,
      grant_id: payload.grant_id,
      requesting_context: payload.context,
      detail: payload.detail,
      prev_hash: head.entry_hash,
    };
    const event: DemoAccessEvent = { ...unhashed, entry_hash: sha256Hex(canonicalJsonStringify(unhashed)) };
    this.events.push(event);
    return event;
  }

  /** Full offline verification: chain integrity, signatures, payload consistency. */
  async verifyLog(): Promise<VerifyLogResult> {
    const errors: Array<{ sequence: number; error: string }> = [];
    let prevHash = GENESIS_HASH;
    let prevSequence = 0;
    let vaultId: string | undefined;
    const seenNonces = new Set<string>();
    for (const event of this.events) {
      if (event.sequence !== prevSequence + 1) errors.push({ sequence: event.sequence, error: `Sequence gap: expected ${prevSequence + 1}` });
      if (event.prev_hash !== prevHash) errors.push({ sequence: event.sequence, error: 'Chain break: prev_hash does not match previous entry_hash' });
      const { entry_hash, ...rest } = event;
      if (sha256Hex(canonicalJsonStringify(rest)) !== entry_hash) {
        errors.push({ sequence: event.sequence, error: 'Entry hash mismatch — event was modified' });
      }
      const valid = await ed.verifyAsync(
        base64ToBytes(event.agent_signature),
        new TextEncoder().encode(event.signed_payload),
        base58Decode(event.agent_pubkey),
      ).catch(() => false);
      if (!valid) errors.push({ sequence: event.sequence, error: 'Invalid signature over signed_payload' });
      try {
        const payload = JSON.parse(event.signed_payload) as {
          event_type: string; vault: string; agent_id: string;
          sequence: number; prev_hash: string; context: string | null; nonce: string;
        };
        if (payload.event_type !== event.event_type) errors.push({ sequence: event.sequence, error: 'Signed event_type does not match envelope (relabeled)' });
        if (payload.sequence !== event.sequence) errors.push({ sequence: event.sequence, error: 'Signed sequence does not match envelope (event moved)' });
        if (payload.prev_hash !== event.prev_hash) errors.push({ sequence: event.sequence, error: 'Signed prev_hash does not match envelope (event re-chained)' });
        if (payload.context !== event.requesting_context) errors.push({ sequence: event.sequence, error: 'Payload context does not match event requesting_context' });
        if (payload.agent_id !== `ag_${event.agent_pubkey}`) errors.push({ sequence: event.sequence, error: 'Payload agent_id does not match event agent_pubkey' });
        if (vaultId === undefined) vaultId = payload.vault;
        else if (payload.vault !== vaultId) errors.push({ sequence: event.sequence, error: 'Event belongs to a different vault (cross-vault splice)' });
        if (seenNonces.has(payload.nonce)) errors.push({ sequence: event.sequence, error: 'Duplicate nonce — event replayed' });
        seenNonces.add(payload.nonce);
      } catch {
        errors.push({ sequence: event.sequence, error: 'signed_payload is not valid JSON' });
      }
      prevHash = event.entry_hash;
      prevSequence = event.sequence;
    }
    return { ok: errors.length === 0, events_checked: this.events.length, errors };
  }

  /** Mutate a logged field in memory (for the tamper-detection demo). */
  tamper(sequence: number): void {
    const event = this.events.find(e => e.sequence === sequence);
    if (!event || this.tampered) return;
    this.tampered = { sequence, original: event.requesting_context };
    event.requesting_context = 'routine health check';
  }

  untamper(): void {
    if (!this.tampered) return;
    const event = this.events.find(e => e.sequence === this.tampered!.sequence);
    if (event) event.requesting_context = this.tampered.original;
    this.tampered = null;
  }

  get isTampered(): boolean { return this.tampered !== null; }
}
