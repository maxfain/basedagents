/**
 * AccessEvent construction and verification.
 *
 * Every event embeds:
 *   - the exact canonical payload string the actor signed (`signed_payload`)
 *   - the actor's pubkey + Ed25519 signature
 *   - hash-chain fields (prev_hash, entry_hash)
 *
 * so the log is independently verifiable offline: re-hash the chain, verify
 * every signature, and cross-check payload fields against the envelope.
 */

import type { AccessEvent, AccessEventType } from './types.js';
import { GENESIS_HASH } from './store.js';
import { canonicalJsonStringify, sha256Hex, randomId, nowIso, base58Decode, base58Encode } from './util.js';
import { signPayload, verifyPayload, type AgentKeypair } from './crypto.js';

/** Fields the actor signs. `action` is 'lease' for both lease and lease_denied events. */
export interface SignablePayload {
  action: string;
  agent_id: string;
  credential_id: string | null;
  grant_id: string | null;
  context: string | null;
  detail: Record<string, unknown> | null;
  timestamp: string;
  nonce: string;
}

export function buildPayload(input: {
  action: string;
  agentId: string;
  credentialId?: string | null;
  grantId?: string | null;
  context?: string | null;
  detail?: Record<string, unknown> | null;
  timestamp?: string;
}): { payload: SignablePayload; canonical: string } {
  const payload: SignablePayload = {
    action: input.action,
    agent_id: input.agentId,
    credential_id: input.credentialId ?? null,
    grant_id: input.grantId ?? null,
    context: input.context ?? null,
    detail: input.detail ?? null,
    timestamp: input.timestamp ?? nowIso(),
    nonce: randomId('nonce'),
  };
  return { payload, canonical: canonicalJsonStringify(payload) };
}

/** Compute an event's chain hash: sha256 over the canonical event minus entry_hash. */
export function computeEntryHash(event: Omit<AccessEvent, 'entry_hash'>): string {
  return sha256Hex(canonicalJsonStringify(event));
}

/**
 * Build a fully signed, chained AccessEvent.
 * The actor signs the canonical payload; the envelope echoes payload fields
 * so filters work without parsing signed_payload.
 */
export async function createEvent(input: {
  actor: AgentKeypair;
  eventType: AccessEventType;
  head: { sequence: number; entry_hash: string };
  credentialId?: string | null;
  grantId?: string | null;
  context?: string | null;
  detail?: Record<string, unknown> | null;
  /** Pre-signed payload (agent-side signature already produced), if any. */
  presigned?: { canonical: string; signature: string; payload: SignablePayload };
}): Promise<AccessEvent> {
  const agentId = `ag_${base58Encode(input.actor.publicKey)}`;
  const action = input.eventType === 'lease_denied' ? 'lease' : input.eventType;
  const { canonical, payload } = input.presigned ?? buildPayload({
    action,
    agentId,
    credentialId: input.credentialId,
    grantId: input.grantId,
    context: input.context,
    detail: input.detail,
  });
  const signature = input.presigned?.signature ?? await signPayload(input.actor.privateKey, canonical);

  const unhashed: Omit<AccessEvent, 'entry_hash'> = {
    event_id: randomId('evt'),
    sequence: input.head.sequence + 1,
    timestamp: payload.timestamp,
    event_type: input.eventType,
    agent_pubkey: base58Encode(input.actor.publicKey),
    agent_signature: signature,
    signed_payload: canonical,
    credential_id: input.credentialId ?? payload.credential_id,
    grant_id: input.grantId ?? payload.grant_id,
    requesting_context: input.context ?? payload.context,
    detail: input.detail ?? payload.detail,
    prev_hash: input.head.entry_hash,
  };

  return { ...unhashed, entry_hash: computeEntryHash(unhashed) };
}

/** Verify a full event log: chain integrity + signatures + payload consistency. */
export async function verifyEventLog(events: AccessEvent[]): Promise<{
  ok: boolean;
  events_checked: number;
  head?: { sequence: number; entry_hash: string };
  errors: Array<{ sequence: number; event_id?: string; error: string }>;
}> {
  const errors: Array<{ sequence: number; event_id?: string; error: string }> = [];
  let prevHash = GENESIS_HASH;
  let prevSequence = 0;

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

    try {
      const payload = JSON.parse(event.signed_payload) as SignablePayload;
      const expectedAction = event.event_type === 'lease_denied' ? 'lease' : event.event_type;
      if (payload.action !== expectedAction) {
        errors.push({ ...where, error: `Payload action "${payload.action}" does not match event type "${event.event_type}"` });
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
      if (`ag_${event.agent_pubkey}` !== payload.agent_id) {
        errors.push({ ...where, error: 'Payload agent_id does not match event agent_pubkey' });
      }
    } catch {
      errors.push({ ...where, error: 'signed_payload is not valid JSON' });
    }

    prevHash = event.entry_hash;
    prevSequence = event.sequence;
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
