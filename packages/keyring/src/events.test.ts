import { describe, it, expect } from 'vitest';
import {
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

const cloneOne = (event: AccessEvent): AccessEvent =>
  JSON.parse(JSON.stringify(event)) as AccessEvent;

/** Recompute entry_hash after tampering — simulates an attacker hiding their edit. */
function rehash(event: AccessEvent): AccessEvent {
  const { entry_hash: _drop, ...rest } = event;
  return { ...rest, entry_hash: computeEntryHash(rest) };
}

/**
 * The strongest re-chaining an attacker WITHOUT any private key can do: reassign
 * sequences, relink prev_hash, and recompute every entry_hash so the hash chain is
 * internally consistent. The one thing they cannot touch is the actor's signature
 * over `signed_payload` (which still commits to the ORIGINAL sequence/prev_hash/
 * event_type/vault/nonce). This models "recompute the hashes and hope it passes".
 */
function rechain(events: AccessEvent[]): AccessEvent[] {
  let prev = GENESIS_HASH;
  return events.map((e, i) => {
    const { entry_hash: _drop, ...rest } = e;
    const relinked = { ...rest, sequence: i + 1, prev_hash: prev };
    const entry_hash = computeEntryHash(relinked);
    prev = entry_hash;
    return { ...relinked, entry_hash };
  });
}

interface ChainFixture {
  owner: AgentKeypair;
  agent: AgentKeypair;
  vaultId: string;
  events: AccessEvent[];
}

/** A small realistic chain: owner admin events + agent lease/denial events, one vault. */
async function buildChain(): Promise<ChainFixture> {
  const owner = await generateKeypair();
  const agent = await generateKeypair();
  const vaultId = publicKeyToAgentId(owner.publicKey);
  const events: AccessEvent[] = [];
  let head = { sequence: 0, entry_hash: GENESIS_HASH };
  const push = (e: AccessEvent): void => {
    events.push(e);
    head = { sequence: e.sequence, entry_hash: e.entry_hash };
  };

  push(await createEvent({
    actor: owner, vaultId, eventType: 'vault_created', head,
    detail: { owner_agent_id: vaultId },
  }));
  push(await createEvent({
    actor: owner, vaultId, eventType: 'credential_added', head,
    credentialId: 'cred_1', detail: { label: 'Test credential' },
  }));
  push(await createEvent({
    actor: owner, vaultId, eventType: 'grant_created', head,
    credentialId: 'cred_1', grantId: 'grant_1',
    detail: { agent_id: publicKeyToAgentId(agent.publicKey) },
  }));
  push(await createEvent({
    actor: agent, vaultId, eventType: 'lease', head,
    credentialId: 'cred_1', grantId: 'grant_1', context: 'deploy job',
  }));
  push(await createEvent({
    actor: agent, vaultId, eventType: 'lease_denied', head,
    credentialId: 'cred_1', grantId: 'grant_1', detail: { reason: 'usage cap reached (1)' },
  }));

  return { owner, agent, vaultId, events };
}

// ─── createEvent ───

describe('createEvent', () => {
  it('builds a chained, signed event whose signed payload commits to position, type, and vault', async () => {
    const actor = await generateKeypair();
    const vaultId = publicKeyToAgentId(actor.publicKey);
    const head = { sequence: 4, entry_hash: 'a'.repeat(64) };
    const event = await createEvent({
      actor,
      vaultId,
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

    // The signed payload is the new shape: it binds chain position, type, and vault.
    const payload = JSON.parse(event.signed_payload) as SignablePayload;
    expect(payload.event_type).toBe('lease');
    expect(payload.vault).toBe(vaultId);
    expect(payload.agent_id).toBe(publicKeyToAgentId(actor.publicKey));
    expect(payload.sequence).toBe(5);
    expect(payload.prev_hash).toBe('a'.repeat(64));
    expect(payload.timestamp).toBe(event.timestamp);
    expect(payload.nonce).toMatch(/^nonce_/);
  });

  it('honors an explicit timestamp and threads a fresh nonce per event', async () => {
    const actor = await generateKeypair();
    const vaultId = publicKeyToAgentId(actor.publicKey);
    const ts = '2026-01-01T00:00:00.000Z';
    const a = await createEvent({ actor, vaultId, eventType: 'vault_created', head: { sequence: 0, entry_hash: GENESIS_HASH }, timestamp: ts });
    const b = await createEvent({ actor, vaultId, eventType: 'credential_added', head: { sequence: a.sequence, entry_hash: a.entry_hash } });
    expect(a.timestamp).toBe(ts);
    const pa = JSON.parse(a.signed_payload) as SignablePayload;
    const pb = JSON.parse(b.signed_payload) as SignablePayload;
    expect(pa.timestamp).toBe(ts);
    expect(pa.nonce).not.toBe(pb.nonce);
  });

  it('signs the concrete event_type — lease_denied signs "lease_denied", not "lease"', async () => {
    const { events } = await buildChain();
    const denied = events[events.length - 1];
    expect(denied.event_type).toBe('lease_denied');
    const payload = JSON.parse(denied.signed_payload) as SignablePayload;
    expect(payload.event_type).toBe('lease_denied');
  });
});

// ─── verifyEventLog: happy path ───

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

  it('accepts a healthy chain against its expectedVault, expectedCount, and expectedHead', async () => {
    const { events, vaultId } = await buildChain();
    const head = { sequence: events[4].sequence, entry_hash: events[4].entry_hash };
    const result = await verifyEventLog(events, { expectedVault: vaultId, expectedCount: 5, expectedHead: head });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});

// ─── verifyEventLog: classic tamper cases ───

describe('verifyEventLog tamper detection', () => {
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

  it('detects a naively reordered pair (sequence gap + chain break)', async () => {
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

// ─── verifyEventLog: the hardened integrity guarantees ───

describe('verifyEventLog integrity guarantees (signature binds chain position)', () => {
  it('detects a reordered-and-rechained log via the signed sequence mismatch', async () => {
    const { events } = await buildChain();
    // Swap two events, then do the strongest keyless re-chain (fix sequence,
    // prev_hash, entry_hash). The hash chain is now internally consistent…
    const reordered = clone(events);
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    const attacked = rechain(reordered);

    const result = await verifyEventLog(attacked);
    expect(result.ok).toBe(false);
    // …but each moved event's SIGNED sequence no longer matches its new slot.
    expect(result.errors.some(e => /Signed sequence does not match envelope sequence/.test(e.error))).toBe(true);
    // No sequence gap / chain break / entry-hash error — re-chaining fixed those.
    expect(result.errors.some(e => /Sequence gap/.test(e.error))).toBe(false);
    expect(result.errors.some(e => /Chain break/.test(e.error))).toBe(false);
    expect(result.errors.some(e => /Entry hash mismatch/.test(e.error))).toBe(false);
  });

  it('keyless re-chaining is NOT enough to rescue a reordered log', async () => {
    const { events } = await buildChain();
    const reordered = clone(events);
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];

    // Naive reorder: caught by sequence gap / chain break.
    const naive = await verifyEventLog(reordered);
    expect(naive.ok).toBe(false);

    // After recomputing every hash chain field (all an attacker without a key can do),
    // the log is STILL rejected — the signatures over the original positions survive.
    const rechained = await verifyEventLog(rechain(reordered));
    expect(rechained.ok).toBe(false);
    expect(rechained.errors.some(e => /Signed sequence does not match envelope sequence/.test(e.error))).toBe(true);
  });

  it('detects a duplicated event (copy, bump sequence, re-chain)', async () => {
    const { events } = await buildChain();
    const withDup = clone(events);
    // Duplicate the lease event verbatim and insert the copy right after it.
    withDup.splice(4, 0, cloneOne(events[3]));
    const attacked = rechain(withDup); // re-chains + bumps subsequent sequences

    const result = await verifyEventLog(attacked);
    expect(result.ok).toBe(false);
    // The copy re-uses the original's nonce, and its signed sequence no longer fits.
    expect(result.errors.some(e => /Duplicate nonce — event replayed/.test(e.error))).toBe(true);
    expect(result.errors.some(e => /Signed sequence does not match envelope sequence/.test(e.error))).toBe(true);
  });

  it('detects a duplicate nonce (verbatim replay of a signed event)', async () => {
    const { events } = await buildChain();
    const replayed = clone(events);
    replayed.push(cloneOne(events[3])); // append a byte-for-byte replay of the lease event
    const attacked = rechain(replayed);

    const result = await verifyEventLog(attacked);
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /Duplicate nonce/.test(e.error))).toBe(true);
  });

  it('detects a relabeled event_type (lease → lease_denied) and re-chain', async () => {
    const { events } = await buildChain();
    const tampered = clone(events);
    expect(tampered[3].event_type).toBe('lease');
    tampered[3].event_type = 'lease_denied'; // relabel the honest lease as a denial
    const attacked = rechain(tampered);

    const result = await verifyEventLog(attacked);
    expect(result.ok).toBe(false);
    expect(result.errors.some(
      e => e.sequence === 4 && /Signed event_type "lease" does not match envelope "lease_denied"/.test(e.error)
    )).toBe(true);
  });

  it('detects a cross-vault splice via expectedVault (and via internal vault consistency)', async () => {
    const { events, vaultId } = await buildChain();

    // A validly-signed event from a DIFFERENT vault (different owner keypair),
    // created against vault A's head so its position/prev_hash line up perfectly.
    const ownerB = await generateKeypair();
    const vaultB = publicKeyToAgentId(ownerB.publicKey);
    const aHead = { sequence: events[4].sequence, entry_hash: events[4].entry_hash };
    const foreign = await createEvent({
      actor: ownerB,
      vaultId: vaultB,
      eventType: 'credential_added',
      head: aHead,
      credentialId: 'cred_b',
      detail: { label: 'Foreign credential' },
    });
    const spliced = [...events, foreign];

    // Its own signature/chain checks all pass — only the vault id betrays it.
    const withExpected = await verifyEventLog(spliced, { expectedVault: vaultId });
    expect(withExpected.ok).toBe(false);
    expect(withExpected.errors.some(e => /cross-vault splice/.test(e.error))).toBe(true);

    // Even without an expectedVault, the vault is pinned to the first event's vault,
    // so the foreign event is still caught.
    const pinned = await verifyEventLog(spliced);
    expect(pinned.ok).toBe(false);
    expect(pinned.errors.some(e => /cross-vault splice/.test(e.error))).toBe(true);

    // Sanity: the foreign event verifies fine as the genesis of ITS OWN vault.
    const ownB = await verifyEventLog([foreign], { expectedVault: vaultB });
    // (sequence/prev_hash won't match a fresh genesis, so this is only about the
    //  vault check not firing.)
    expect(ownB.errors.some(e => /cross-vault splice/.test(e.error))).toBe(false);
  });
});

// ─── truncation guards (external anchors) ───

describe('verifyEventLog truncation guards', () => {
  it('flags a log shorter than the head anchor count', async () => {
    const { events } = await buildChain();
    const truncated = events.slice(0, 4); // last event dropped

    // The remaining chain is internally valid…
    expect((await verifyEventLog(truncated)).ok).toBe(true);
    // …but the anchor says there should be 5 events.
    const result = await verifyEventLog(truncated, { expectedCount: 5 });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /Log truncated: 4 event\(s\) present, head anchor records 5/.test(e.error))).toBe(true);
  });

  it('flags a log that no longer reaches the recorded head', async () => {
    const { events } = await buildChain();
    const recordedHead = { sequence: events[4].sequence, entry_hash: events[4].entry_hash };
    const truncated = events.slice(0, 4);

    const result = await verifyEventLog(truncated, { expectedHead: recordedHead });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /does not reach recorded head #5/.test(e.error))).toBe(true);
  });

  it('flags a head hash that does not match the recorded head', async () => {
    const { events } = await buildChain();
    const recordedHead = { sequence: events[4].sequence, entry_hash: 'f'.repeat(64) };

    const result = await verifyEventLog(events, { expectedHead: recordedHead });
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /Event #5 does not match the recorded head hash/.test(e.error))).toBe(true);
  });
});
