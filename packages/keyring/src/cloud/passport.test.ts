/**
 * Cloud passport (SANDBOX_SPEC §4b): blob roundtrip, shelf snapshot fidelity,
 * and full re-materialization — a vault built on machine A, snapshotted as
 * ciphertext, and rebuilt on "machine B" from passport + shelf must yield the
 * same secrets to the same agent, with no plaintext in any snapshot row.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keyring } from '../keyring.js';
import { generateKeypair, openSealedBox } from '../crypto.js';
import { publicKeyToAgentId } from '../util.js';
import { buildPassportBlob, parsePassportBlob, buildShelfSnapshot, materializeVault } from './passport.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-passport-'));

describe('cloud passport', () => {
  it('blob roundtrip preserves both keypairs and the name', async () => {
    const owner = await generateKeypair();
    const agent = await generateKeypair();
    const parsed = parsePassportBlob(buildPassportBlob(owner, agent, 'Codex agent'));
    expect(parsed.name).toBe('Codex agent');
    expect(parsed.agentId).toBe(publicKeyToAgentId(agent.publicKey));
    expect(Buffer.from(parsed.owner.privateKey)).toEqual(Buffer.from(owner.privateKey));
    expect(Buffer.from(parsed.agent.publicKey)).toEqual(Buffer.from(agent.publicKey));
  });

  it('rejects unknown versions and garbage', async () => {
    expect(() => parsePassportBlob('not-base64-json')).toThrow(/not a valid passport/);
    const v9 = Buffer.from(JSON.stringify({ v: 9 })).toString('base64');
    expect(() => parsePassportBlob(v9)).toThrow(/version 9/);
  });

  it('materializes a working vault from passport + shelf: same secret, same agent, no plaintext on the shelf', async () => {
    // Machine A: a real vault with a granted credential.
    const krA = await Keyring.init({ dir: tmp() });
    const owner = krA.ownerKeypair();
    const agent = await generateKeypair();
    const agentId = publicKeyToAgentId(agent.publicKey);
    await krA.addIdentity(owner, agentId, { name: 'cloudy' });
    const cred = await krA.addCredential(owner, { label: 'Stripe key', provider: 'stripe', env_var: 'STRIPE_KEY' }, 'sk_live_SECRET');
    await krA.createGrant(owner, cred.credential_id, agentId, {});

    // The shelf snapshot is ciphertext-only.
    const snapshot = buildShelfSnapshot(krA.vault());
    expect(snapshot).toHaveLength(1);
    expect(JSON.stringify(snapshot)).not.toContain('sk_live_SECRET');

    // Machine B: passport + shelf → a working cache.
    const passport = parsePassportBlob(buildPassportBlob(owner, agent, 'cloudy'));
    const krB = materializeVault(tmp(), passport, snapshot);
    const vaultB = krB.vault();
    expect(vaultB.owner.public_key_b58).toBe(krA.vault().owner.public_key_b58);
    expect(vaultB.identities[agentId]?.name).toBe('cloudy');
    const credB = vaultB.credentials[cred.credential_id];
    expect(credB).toBeDefined();
    expect(Object.values(vaultB.grants).some((g) => g.agent_id === agentId && g.status === 'active')).toBe(true);
    // The agent's sealed copy opens with the agent key from the passport.
    const plain = new TextDecoder().decode(openSealedBox(passport.agent.privateKey, credB.sealed[agentId]));
    expect(plain).toBe('sk_live_SECRET');
  });

  it('refuses to materialize over a vault that belongs to a different setup', async () => {
    const dir = tmp();
    await Keyring.init({ dir }); // someone else's vault
    const owner = await generateKeypair();
    const agent = await generateKeypair();
    const passport = parsePassportBlob(buildPassportBlob(owner, agent, 'x'));
    expect(() => materializeVault(dir, passport, [])).toThrow(/different setup/);
  });

  it('re-materializing refreshes the working set from the shelf', async () => {
    const krA = await Keyring.init({ dir: tmp() });
    const owner = krA.ownerKeypair();
    const agent = await generateKeypair();
    const passport = parsePassportBlob(buildPassportBlob(owner, agent, 'x'));
    const dir = tmp();
    const credA = await krA.addCredential(owner, { label: 'One' }, 'v1');
    materializeVault(dir, passport, buildShelfSnapshot(krA.vault()));
    await krA.removeCredential(owner, credA.credential_id);
    const credB = await krA.addCredential(owner, { label: 'Two' }, 'v2');
    const krB2 = materializeVault(dir, passport, buildShelfSnapshot(krA.vault()));
    expect(Object.keys(krB2.vault().credentials)).toEqual([credB.credential_id]);
  });
});
