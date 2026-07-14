/**
 * AccessEvent construction and verification.
 *
 * Every event embeds the exact canonical payload string the actor signed
 * (`signed_payload`), the actor's pubkey + Ed25519 signature, and hash-chain
 * fields (prev_hash, entry_hash).
 *
 * The signed payload commits to the event's chain position (sequence,
 * prev_hash), its concrete event_type, and the vault it belongs to. This is
 * what makes the log tamper-evident against an attacker who has write access
 * to the vault files but does NOT hold a private key: they cannot reorder,
 * duplicate, relabel, or splice events without invalidating a signature they
 * cannot reproduce. (Deleting trailing events — truncation — is caught
 * separately via the store's head anchor and signed exports; see store.ts and
 * Keyring.verifyLog.)
 */

import type { AccessEvent, AccessEventType } from './types.js';
import { GENESIS_HASH } from './store.js';
import { canonicalJsonStringify, sha256Hex, randomId, nowIso, base58Decode, base58Encode } from './util.js';
import { signPayload, verifyPayload, type AgentKeypair } from './crypto.js';

/** The exact fields an actor signs. Commits to chain position, type, and vault. */
export interface SignablePayload {
  event_type: AccessEventType;
  vault: string;
  agent_id: string;
  credential_id: string | null;
  grant_id: string | null;
  context: string | null;
  detail: Record<string, unknown> | null;
  sequence: number;
  prev_hash: string;
  timestamp: string;
  nonce: string;
}

/** Compute an event's chain hash: sha256 over the canonical event minus entry_hash. */
export function computeEntryHash(event: Omit<AccessEvent, 'entry_hash'>): string {
  return sha256Hex(canonicalJsonStringify(event));
}

/**
 * Build a fully signed, chained AccessEvent.
 *
 * The actor signs a payload that includes the chain position (sequence,
 * prev_hash), the concrete event_type, and the vault id — so the signature
 * binds the event to exactly this slot in exactly this vault. In this
 * local-first library the acting keypair is always available at call time
 * (the owner for admin ops, the agent for leases/requests), so signing happens
 * here rather than being handed in pre-signed.
 */
export async function createEvent(input: {
  actor: AgentKeypair;
  vaultId: string;
  eventType: AccessEventType;
  head: { sequence: number; entry_hash: string };
  credentialId?: string | null;
  grantId?: string | null;
  context?: string | null;
  detail?: Record<string, unknown> | null;
  timestamp?: string;
}): Promise<AccessEvent> {
  const agentPubkey = base58Encode(input.actor.publicKey);
  const sequence = input.head.sequence + 1;
  const prevHash = input.head.entry_hash;

  const payload: SignablePayload = {
    event_type: input.eventType,
    vault: input.vaultId,
    agent_id: `ag_${agentPubkey}`,
    credential_id: input.credentialId ?? null,
    grant_id: input.grantId ?? null,
    context: input.context ?? null,
    detail: input.detail ?? null,
    sequence,
    prev_hash: prevHash,
    timestamp: input.timestamp ?? nowIso(),
    nonce: randomId('nonce'),
  };
  const canonical = canonicalJsonStringify(payload);
  const signature = await signPayload(input.actor.privateKey, canonical);

  const unhashed: Omit<AccessEvent, 'entry_hash'> = {
    event_id: randomId('evt'),
    sequence,
    timestamp: payload.timestamp,
    event_type: input.eventType,
    agent_pubkey: agentPubkey,
    agent_signature: signature,
    signed_payload: canonical,
    credential_id: payload.credential_id,
    grant_id: payload.grant_id,
    requesting_context: payload.context,
    detail: payload.detail,
    prev_hash: prevHash,
  };

  return { ...unhashed, entry_hash: computeEntryHash(unhashed) };
}

export interface VerifyOptions {
  /** If set, every event's signed vault id must equal this (cross-vault splice guard). */
  expectedVault?: string;
  /** If set, the log must still contain this head (truncation guard from a signed export). */
  expectedHead?: { sequence: number; entry_hash: string };
  /** If set, the live log must be at least this long (truncation guard from the store anchor). */
  expectedCount?: number;
}

/** Verify a full event log: chain integrity + signatures + payload consistency. */
export async function verifyEventLog(events: AccessEvent[], options: VerifyOptions = {}): Promise<{
  ok: boolean;
  events_checked: number;
  head?: { sequence: number; entry_hash: string };
  errors: Array<{ sequence: number; event_id?: string; error: string }>;
}> {
  const errors: Array<{ sequence: number; event_id?: string; error: string }> = [];
  let prevHash = GENESIS_HASH;
  let prevSequence = 0;
  let vaultId: string | undefined = options.expectedVault;
  const seenNonces = new Set<string>();

  for (const event of events) {
    const where = { sequence: event.sequence, event_id: event.event_id };

    if (event.sequence !== prevSequence + 1) {
      errors.push({ ...where, error: `Sequence gap: expected ${prevSequence + 1}, got ${event.sequence}` });
    }
    if (event.prev_hash !== prevHash) {
      errors.push({ ...where, error: 'Chain break: prev_hash does not match previous entry_hash' });
    }

    const { entry_hash, ...rest } = event;
    const recomputed = computeEntryHash(rest);
    if (recomputed !== entry_hash) {
      errors.push({ ...where, error: 'Entry hash mismatch — event was modified' });
    }

    try {
      const pubkey = base58Decode(event.agent_pubkey);
      const valid = await verifyPayload(pubkey, event.signed_payload, event.agent_signature);
      if (!valid) {
        errors.push({ ...where, error: 'Invalid signature over signed_payload' });
      }
    } catch (err) {
      errors.push({ ...where, error: `Signature check failed: ${(err as Error).message}` });
    }

    let payload: SignablePayload | null = null;
    try {
      payload = JSON.parse(event.signed_payload) as SignablePayload;
    } catch {
      errors.push({ ...where, error: 'signed_payload is not valid JSON' });
    }
    if (payload) {
      if (payload.event_type !== event.event_type) {
        errors.push({ ...where, error: `Signed event_type "${payload.event_type}" does not match envelope "${event.event_type}"` });
      }
      if (payload.sequence !== event.sequence) {
        errors.push({ ...where, error: 'Signed sequence does not match envelope sequence (event moved)' });
      }
      if (payload.prev_hash !== event.prev_hash) {
        errors.push({ ...where, error: 'Signed prev_hash does not match envelope prev_hash (event re-chained)' });
      }
      if (payload.timestamp !== event.timestamp) {
        errors.push({ ...where, error: 'Payload timestamp does not match event timestamp' });
      }
      if (payload.credential_id !== event.credential_id) {
        errors.push({ ...where, error: 'Payload credential_id does not match event credential_id' });
      }
      if (payload.grant_id !== event.grant_id) {
        errors.push({ ...where, error: 'Payload grant_id does not match event grant_id' });
      }
      if (payload.context !== event.requesting_context) {
        errors.push({ ...where, error: 'Payload context does not match event requesting_context' });
      }
      if (canonicalJsonStringify(payload.detail ?? null) !== canonicalJsonStringify(event.detail ?? null)) {
        errors.push({ ...where, error: 'Payload detail does not match event detail' });
      }
      if (`ag_${event.agent_pubkey}` !== payload.agent_id) {
        errors.push({ ...where, error: 'Payload agent_id does not match event agent_pubkey' });
      }
      if (vaultId === undefined) {
        vaultId = payload.vault; // pin to the first event's vault (the genesis owner)
      } else if (payload.vault !== vaultId) {
        errors.push({ ...where, error: 'Event belongs to a different vault (cross-vault splice)' });
      }
      if (seenNonces.has(payload.nonce)) {
        errors.push({ ...where, error: 'Duplicate nonce — event replayed' });
      }
      seenNonces.add(payload.nonce);
    }

    prevHash = event.entry_hash;
    prevSequence = event.sequence;
  }

  // Truncation guards — the chain above is internally valid even after trailing
  // events are deleted, so we cross-check length/head against external anchors.
  if (options.expectedCount !== undefined && events.length < options.expectedCount) {
    errors.push({
      sequence: events.length,
      error: `Log truncated: ${events.length} event(s) present, head anchor records ${options.expectedCount}`,
    });
  }
  if (options.expectedHead) {
    const match = events.find(e => e.sequence === options.expectedHead!.sequence);
    if (!match) {
      errors.push({ sequence: options.expectedHead.sequence, error: `Log truncated: does not reach recorded head #${options.expectedHead.sequence}` });
    } else if (match.entry_hash !== options.expectedHead.entry_hash) {
      errors.push({ sequence: options.expectedHead.sequence, error: `Event #${options.expectedHead.sequence} does not match the recorded head hash` });
    }
  }

  return {
    ok: errors.length === 0,
    events_checked: events.length,
    head: events.length
      ? { sequence: events[events.length - 1].sequence, entry_hash: events[events.length - 1].entry_hash }
      : undefined,
    errors,
  };
}
