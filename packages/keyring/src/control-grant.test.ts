import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { Keyring, KeyringError } from './keyring.js';
import { generateKeypair, type AgentKeypair } from './crypto.js';
import { publicKeyToAgentId, base58Encode } from './util.js';
import { grantApprovalHash, base64urlEncode } from './control-actions.js';
import type { GrantApproval, GrantConstraints } from './types.js';

const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';
const subtle = globalThis.crypto.subtle;

function rawToDer(raw: Uint8Array): Uint8Array {
  const enc = (b: Uint8Array): number[] => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    const v = Array.from(b.slice(i));
    if (v[0] & 0x80) v.unshift(0);
    return [0x02, v.length, ...v];
  };
  const body = [...enc(raw.slice(0, 32)), ...enc(raw.slice(32, 64))];
  return new Uint8Array([0x30, body.length, ...body]);
}

interface Passkey {
  credentialId: string;
  publicKeyHex: string;
  sign(challenge: string, counter?: number): Promise<{ credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string }>;
}
async function makePasskey(): Promise<Passkey> {
  const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const raw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  const credentialId = base64urlEncode(crypto.getRandomValues(new Uint8Array(16)));
  return {
    credentialId,
    publicKeyHex: bytesToHex(raw),
    async sign(challenge, counter = 0) {
      const authData = new Uint8Array([
        ...sha256(new TextEncoder().encode(RP_ID)), 0x05,
        (counter >>> 24) & 0xff, (counter >>> 16) & 0xff, (counter >>> 8) & 0xff, counter & 0xff,
      ]);
      const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN }));
      const message = new Uint8Array([...authData, ...sha256(clientDataJSON)]);
      const rawSig = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, message));
      return {
        credentialId,
        authenticatorData: base64urlEncode(authData),
        clientDataJSON: base64urlEncode(clientDataJSON),
        signature: base64urlEncode(rawToDer(rawSig)),
      };
    },
  };
}

/** Build an approval the owner passkey genuinely signs for a given grantee/constraints. */
async function signApproval(
  kr: Keyring, passkey: Passkey, credentialId: string, agent: AgentKeypair, constraints: GrantConstraints, nonce: string,
): Promise<GrantApproval> {
  const agentId = publicKeyToAgentId(agent.publicKey);
  const hash = grantApprovalHash({
    owner_id: kr.vault().owner.agent_id,
    nonce, agent_id: agentId, agent_pubkey: base58Encode(agent.publicKey),
    credential_id: credentialId, constraints,
  });
  const assertion = await passkey.sign(hash);
  return { nonce, credential_id: credentialId, agent_id: agentId, constraints, assertion };
}

describe('applyApprovedGrant — daemon re-verifies owner passkey (CONTROL_PLANE.md §2)', () => {
  let dir: string;
  let kr: Keyring;
  let owner: AgentKeypair;
  let passkey: Passkey;
  let credId: string;
  let agentA: AgentKeypair;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-cp-'));
    kr = await Keyring.init({ dir });
    owner = kr.ownerKeypair();
    passkey = await makePasskey();
    await kr.anchorOwnerPasskey(owner, { credentialId: passkey.credentialId, publicKeyHex: passkey.publicKeyHex, rpId: RP_ID, origins: [ORIGIN] });
    credId = (await kr.addCredential(owner, { label: 'Stripe', env_var: 'STRIPE' }, 'sk_secret_value')).credential_id;
    agentA = await generateKeypair();
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('applies a genuinely owner-signed approval and re-seals to the grantee', async () => {
    const approval = await signApproval(kr, passkey, credId, agentA, { max_uses: 5, max_lease_ttl_seconds: 600 }, 'n1');
    const grant = await kr.applyApprovedGrant(approval);
    expect(grant.status).toBe('active');
    expect(grant.agent_id).toBe(publicKeyToAgentId(agentA.publicKey));

    // The grantee can actually lease the secret — proves the re-seal happened.
    const lease = await kr.lease(agentA, credId);
    expect(lease.value).toBe('sk_secret_value');

    // The access log attributes authority to the passkey, not a local CLI grant.
    const ev = kr.timeline({ event_type: 'grant_created' }).at(-1)!;
    expect((ev.detail as { authorized_by?: string }).authorized_by).toBe('owner_passkey');
    expect((ev.detail as { passkey_credential_id?: string }).passkey_credential_id).toBe(passkey.credentialId);
  });

  it('REJECTS a redirected seal target — assertion signed for agent A, approval names agent B', async () => {
    const constraints = { max_uses: 5 };
    // Owner genuinely signs an approval for agent A.
    const signedForA = await signApproval(kr, passkey, credId, agentA, constraints, 'n1');
    // A compromised control plane swaps the grantee to attacker-controlled B, keeping A's assertion.
    const agentB = await generateKeypair();
    const tampered: GrantApproval = { ...signedForA, agent_id: publicKeyToAgentId(agentB.publicKey) };

    await expect(kr.applyApprovedGrant(tampered)).rejects.toMatchObject({ code: 'bad_signature' });
    // Nothing sealed to B.
    await expect(kr.lease(agentB, credId)).rejects.toBeInstanceOf(KeyringError);
  });

  it('REJECTS tampered constraints (owner signed max_uses 5, relayed as 1000)', async () => {
    const signed = await signApproval(kr, passkey, credId, agentA, { max_uses: 5 }, 'n1');
    const tampered: GrantApproval = { ...signed, constraints: { max_uses: 1000 } };
    await expect(kr.applyApprovedGrant(tampered)).rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('REJECTS an assertion from a passkey that is not anchored', async () => {
    const stranger = await makePasskey();
    const agentId = publicKeyToAgentId(agentA.publicKey);
    const hash = grantApprovalHash({ owner_id: kr.vault().owner.agent_id, nonce: 'n1', agent_id: agentId, agent_pubkey: base58Encode(agentA.publicKey), credential_id: credId, constraints: {} });
    const assertion = await stranger.sign(hash);
    await expect(kr.applyApprovedGrant({ nonce: 'n1', credential_id: credId, agent_id: agentId, constraints: {}, assertion }))
      .rejects.toMatchObject({ code: 'not_anchored' });
  });

  it('REJECTS an approval whose assertion was signed by a different (but anchored) attack — wrong key', async () => {
    // Anchor a second passkey, but sign with a THIRD unrelated key while claiming the anchored credentialId.
    const anchored2 = await makePasskey();
    await kr.anchorOwnerPasskey(owner, { credentialId: anchored2.credentialId, publicKeyHex: anchored2.publicKeyHex, rpId: RP_ID, origins: [ORIGIN] });
    const imposter = await makePasskey();
    const agentId = publicKeyToAgentId(agentA.publicKey);
    const hash = grantApprovalHash({ owner_id: kr.vault().owner.agent_id, nonce: 'n1', agent_id: agentId, agent_pubkey: base58Encode(agentA.publicKey), credential_id: credId, constraints: {} });
    const sig = await imposter.sign(hash);
    // Present the imposter's signature under the anchored credential id.
    const assertion = { ...sig, credentialId: anchored2.credentialId };
    await expect(kr.applyApprovedGrant({ nonce: 'n1', credential_id: credId, agent_id: agentId, constraints: {}, assertion }))
      .rejects.toMatchObject({ code: 'bad_signature' });
  });

  it('REJECTS replay of an already-applied approval', async () => {
    const approval = await signApproval(kr, passkey, credId, agentA, {}, 'n1');
    await kr.applyApprovedGrant(approval);
    await expect(kr.applyApprovedGrant(approval)).rejects.toMatchObject({ code: 'duplicate' });
    expect(kr.timeline({ event_type: 'grant_created' })).toHaveLength(1);
  });

  it('anchorOwnerPasskey rejects a non-owner and a malformed key', async () => {
    const notOwner = await generateKeypair();
    await expect(kr.anchorOwnerPasskey(notOwner, { credentialId: 'x', publicKeyHex: passkey.publicKeyHex, rpId: RP_ID, origins: [ORIGIN] }))
      .rejects.toMatchObject({ code: 'not_owner' });
    await expect(kr.anchorOwnerPasskey(owner, { credentialId: 'x', publicKeyHex: 'deadbeef', rpId: RP_ID, origins: [ORIGIN] }))
      .rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('the applied approval keeps the log chain valid and free of plaintext', async () => {
    await kr.applyApprovedGrant(await signApproval(kr, passkey, credId, agentA, {}, 'n1'));
    expect((await kr.verifyLog()).ok).toBe(true);
    const raw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8') + fs.readFileSync(path.join(dir, 'vault.json'), 'utf-8');
    expect(raw).not.toContain('sk_secret_value');
  });
});
