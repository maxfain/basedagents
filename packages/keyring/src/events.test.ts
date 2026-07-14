import { describe, it, expect } from 'vitest';
import {
  buildPayload,
  createEvent,
  computeEntryHash,
  verifyEventLog,
  type SignablePayload,
} from './events.js';
import { generateKeypair, signPayload, verifyPayload, type AgentKeypair } from './crypto.js';
import { GENESIS_HASH } from './store.js';
import { canonicalJsonStringify, publicKeyToAgentId, base58Encode } from './util.js';
import type { AccessEvent } from './types.js';

const clone = (events: AccessEvent[]): AccessEvent[] =>
  JSON.parse(JSON.stringify(events)) as AccessEvent[];

/** Recompute entry_hash after tampering — simulates an attacker hiding their edit. */
function rehash(event: AccessEvent): AccessEvent {
  const { entry_hash: _drop, ...rest } = event;
  return { ...rest, entry_hash: computeEntryHash(rest) };
}

interface ChainFixture {
  owner: AgentKeypair;
  agent: AgentKeypair;
  events: AccessEvent[];
}

/** A small realistic chain: owner admin events + agent lease/denial events. */
async function buildChain(): Promise<ChainFixture> {
  const owner = await generateKeypair();
  const agent = await generateKeypair();
  const events: AccessEvent[] = [];
  let head = { sequence: 0, entry_hash: GENESIS_HASH };
  const push = (e: AccessEvent): void => {
    events.push(e);
    head = { sequence: e.sequence, entry_hash: e.entry_hash };
  };

  push(await createEvent({
    actor: owner,
    eventType: 'vault_created',
    head,
    detail: { owner_agent_id: publicKeyToAgentId(owner.publicKey) },
  }));
  push(await createEvent({
    actor: owner,
    eventType: 'credential_added',
    head,
    credentialId: 'cred_1',
    detail: { label: 'Test credential' },
  }));
  push(await createEvent({
    actor: owner,
    eventType: 'grant_created',
    head,
    credentialId: 'cred_1',
    grantId: 'grant_1',
    detail: { agent_id: publicKeyToAgentId(agent.publicKey) },
  }));
  push(await createEvent({
    actor: agent,
    eventType: 'lease',
    head,
    credentialId: 'cred_1',
    grantId: 'grant_1',
    context: 'deploy job',
  }));
  push(await createEvent({
    actor: agent,
    eventType: 'lease_denied',
    head,
    credentialId: 'cred_1',
    grantId: 'grant_1',
    detail: { reason: 'usage cap reached (1)' },
  }));
  return { owner, agent, events };
}

// ─── buildPayload ───

describe('buildPayload', () => {
  it('defaults optional fields to null and generates a nonce', () => {
    const { payload, canonical } = buildPayload({ action: 'lease', agentId: 'ag_x' });
    expect(payload.action).toBe('lease');
    expect(payload.agent_id).toBe('ag_x');
    expect(payload.credential_id).toBeNull();
    expect(payload.grant_id).toBeNull();
    expect(payload.context).toBeNull();
    expect(payload.detail).toBeNull();
    expect(payload.nonce).toMatch(/^nonce_/);
    expect(canonical).toBe(canonicalJsonStringify(payload));
  });

  it('canonical form has sorted keys and is stable', () => {
    const { canonical } = buildPayload({ action: 'lease', agentId: 'ag_x' });
    expect(canonical.startsWith('{"action":')).toBe(true);
    const reparsed = JSON.parse(canonical) as SignablePayload;
    expect(canonicalJsonStringify(reparsed)).toBe(canonical);
  });

  it('uses a fresh nonce per call', () => {
    const a = buildPayload({ action: 'lease', agentId: 'ag_x' });
    const b = buildPayload({ action: 'lease', agentId: 'ag_x' });
    expect(a.payload.nonce).not.toBe(b.payload.nonce);
  });

  it('honors an explicit timestamp', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const { payload } = buildPayload({ action: 'lease', agentId: 'ag_x', timestamp: ts });
    expect(payload.timestamp).toBe(ts);
  });
});

// ─── createEvent ───

describe('createEvent', () => {
  it('builds a chained, signed event with a consistent envelope', async () => {
    const actor = await generateKeypair();
    const head = { sequence: 4, entry_hash: 'a'.repeat(64) };
    const event = await createEvent({
      actor,
      eventType: 'lease',
      head,
      credentialId: 'cred_9',
      grantId: 'grant_9',
      context: 'ctx',
    });
    expect(event.sequence).toBe(5);
    expect(event.prev_hash).toBe('a'.repeat(64));
    expect(event.agent_pubkey).toBe(base58Encode(actor.publicKey));
    expect(event.credential_id).toBe('cred_9');
    expect(event.grant_id).toBe('grant_9');
    expect(event.requesting_context).toBe('ctx');
    expect(event.event_id).toMatch(/^evt_/);

    const { entry_hash, ...rest } = event;
    expect(computeEntryHash(rest)).toBe(entry_hash);
    expect(await verifyPayload(actor.publicKey, event.signed_payload, event.agent_signature)).toBe(true);

    const payload = JSON.parse(event.signed_payload) as SignablePayload;
    expect(payload.action).toBe('lease');
    expect(payload.agent_id).toBe(publicKeyToAgentId(actor.publicKey));
  });

  it('lease_denied events sign the "lease" action', async () => {
    const { events } = await buildChain();
    const denied = events[events.length - 1];
    expect(denied.event_type).toBe('lease_denied');
    const payload = JSON.parse(denied.signed_payload) as SignablePayload;
    expect(payload.action).toBe('lease');
  });
});

// ─── verifyEventLog ───

describe('verifyEventLog', () => {
  it('verifies an untampered chain of events from multiple actors', async () => {
    const { events } = await buildChain();
    const result = await verifyEventLog(events);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.events_checked).toBe(5);
    expect(result.head).toEqual({
      sequence: events[4].sequence,
      entry_hash: events[4].entry_hash,
    });
    // Chain shape: sequences 1..5, each prev_hash links to the previous entry_hash.
    expect(events.map(e => e.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0].prev_hash).toBe(GENESIS_HASH);
    for (let i = 1; i < events.length; i++) {
      expect(events[i].prev_hash).toBe(events[i - 1].entry_hash);
    }
  });

  it('verifies an empty log', async () => {
    const result = await verifyEventLog([]);
    expect(result.ok).toBe(true);
    expect(result.events_checked).toBe(0);
    expect(result.head).toBeUndefined();
    expect(result.errors).toEqual([]);
  });

  it('detects a modified credential_id on a middle event (entry-hash mismatch)', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    tampered[2].credential_id = 'cred_evil';

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.sequence === 3 && /Entry hash mismatch/.test(e.error))).toBe(true);
    // The signed payload still carries the original credential_id → envelope inconsistency too.
    expect(result.errors.some(e => e.sequence === 3 && /credential_id does not match/.test(e.error))).toBe(true);
  });

  it('detects a modified middle event even when the attacker recomputes the entry hash (chain break on next event)', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    tampered[2].credential_id = 'cred_evil';
    tampered[2] = rehash(tampered[2]);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    // Recomputed hash hides the entry-hash mismatch, but the next event no longer links.
    expect(result.errors.some(e => e.sequence === 4 && /Chain break/.test(e.error))).toBe(true);
    // And the signed payload still betrays the original credential_id.
    expect(result.errors.some(e => e.sequence === 3 && /credential_id does not match/.test(e.error))).toBe(true);
  });

  it('detects reordered events', async () => {
    const { events } = await buildChain();
    const reordered = clone(events);
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];

    const result = await verifyEventLog(reordered);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /Sequence gap/.test(e.error))).toBe(true);
    expect(result.errors.some(e => /Chain break/.test(e.error))).toBe(true);
  });

  it('detects a deleted middle event as a sequence gap', async () => {
    const { events } = await buildChain();
    const truncated = clone(events);
    truncated.splice(2, 1); // drop sequence 3

    const result = await verifyEventLog(truncated);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => e.sequence === 4 && /Sequence gap: expected 3, got 4/.test(e.error))).toBe(true);
    expect(result.errors.some(e => e.sequence === 4 && /Chain break/.test(e.error))).toBe(true);
  });

  it('rejects a re-signed payload: without the actor key the signature cannot be forged', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    const last = tampered[tampered.length - 1];

    // Attacker rewrites the signed payload and mirrors the envelope + entry hash
    // so every non-cryptographic check passes — the signature is the only tell.
    const payload = JSON.parse(last.signed_payload) as SignablePayload;
    payload.credential_id = 'cred_stolen';
    last.signed_payload = canonicalJsonStringify(payload);
    last.credential_id = 'cred_stolen';
    tampered[tampered.length - 1] = rehash(last);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toMatch(/Invalid signature over signed_payload/);
  });

  it('rejects an attacker signing with their own key while claiming the victim identity', async () => {
    const { events } = await buildChain();
    const attacker = await generateKeypair();
    const tampered = clone(events);
    const last = tampered[tampered.length - 1];

    // Attacker rewrites the payload (keeping the victim agent_id inside it),
    // signs with their own key, and swaps in their pubkey so the signature checks out.
    const payload = JSON.parse(last.signed_payload) as SignablePayload;
    payload.credential_id = 'cred_stolen';
    const canonical = canonicalJsonStringify(payload);
    last.signed_payload = canonical;
    last.credential_id = 'cred_stolen';
    last.agent_pubkey = base58Encode(attacker.publicKey);
    last.agent_signature = await signPayload(attacker.privateKey, canonical);
    tampered[tampered.length - 1] = rehash(last);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    // The signature itself is valid — the identity binding is what catches it.
    expect(result.errors.some(e => /Invalid signature/.test(e.error))).toBe(false);
    expect(result.errors.some(e => /agent_id does not match event agent_pubkey/.test(e.error))).toBe(true);
  });

  it('flags an envelope credential_id that differs from the signed payload', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    tampered[3].credential_id = 'cred_other';
    tampered[3] = rehash(tampered[3]);
    // Fix the chain so only the payload/envelope check can fire on this event.
    tampered[4].prev_hash = tampered[3].entry_hash;
    tampered[4] = rehash(tampered[4]);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some(
      e => e.sequence === 4 && /Payload credential_id does not match event credential_id/.test(e.error)
    )).toBe(true);
  });

  it('flags an envelope timestamp that differs from the signed payload', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    tampered[4].timestamp = '2020-01-01T00:00:00.000Z';
    tampered[4] = rehash(tampered[4]);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some(
      e => e.sequence === 5 && /Payload timestamp does not match event timestamp/.test(e.error)
    )).toBe(true);
  });

  it('flags an event_type that does not match the signed action', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    tampered[3].event_type = 'grant_created'; // was a lease
    tampered[3] = rehash(tampered[3]);
    tampered[4].prev_hash = tampered[3].entry_hash;
    tampered[4] = rehash(tampered[4]);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some(
      e => e.sequence === 4 && /does not match event type "grant_created"/.test(e.error)
    )).toBe(true);
  });

  it('flags a signed_payload that is not valid JSON', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    tampered[4].signed_payload = 'not json at all';
    tampered[4] = rehash(tampered[4]);

    const result = await verifyEventLog(tampered);
    expect(result.ok).toBe(false);
    expect(result.errors.some(
      e => e.sequence === 5 && /signed_payload is not valid JSON/.test(e.error)
    )).toBe(true);
  });
});
