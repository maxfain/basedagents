import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Keyring, KeyringError, deriveEnvVarName } from './keyring.js';
import { generateKeypair, verifyPayload, type AgentKeypair } from './crypto.js';
import {
  publicKeyToAgentId, base58Encode, canonicalJsonStringify, sha256Hex, bytesToBase64,
} from './util.js';
import type { AccessEvent, VaultFile } from './types.js';

const tempDirs: string[] = [];

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyring-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  dir: string;
  keyring: Keyring;
  owner: AgentKeypair;
}

async function initVault(): Promise<Fixture> {
  const dir = tmpDir();
  const keyring = await Keyring.init({ dir });
  return { dir, keyring, owner: keyring.ownerKeypair() };
}

async function newAgent(): Promise<{ keypair: AgentKeypair; agentId: string }> {
  const keypair = await generateKeypair();
  return { keypair, agentId: publicKeyToAgentId(keypair.publicKey) };
}

async function expectCode(promise: Promise<unknown>, code: KeyringError['code']): Promise<KeyringError> {
  const err = await promise.then(
    () => { throw new Error(`Expected rejection with code "${code}", but the promise resolved`); },
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(KeyringError);
  expect((err as KeyringError).code).toBe(code);
  return err as KeyringError;
}

function lastEvent(keyring: Keyring): AccessEvent {
  const events = keyring.timeline();
  expect(events.length).toBeGreaterThan(0);
  return events[events.length - 1];
}

// ─── init / open ───

describe('Keyring.init / Keyring.open', () => {
  it('creates the vault, owner key, and a signed genesis event', async () => {
    const { dir, keyring, owner } = await initVault();

    expect(fs.existsSync(path.join(dir, 'vault.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'owner.json'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'events.jsonl'))).toBe(true);

    const vault = keyring.vault();
    expect(vault.version).toBe(1);
    expect(vault.owner.agent_id).toBe(publicKeyToAgentId(owner.publicKey));
    expect(vault.owner.public_key_b58).toBe(base58Encode(owner.publicKey));

    const events = keyring.timeline();
    expect(events).toHaveLength(1);
    expect(events[0].event_type).toBe('vault_created');
    expect(events[0].sequence).toBe(1);
    expect(events[0].prev_hash).toBe('0'.repeat(64));
    expect(events[0].agent_pubkey).toBe(base58Encode(owner.publicKey));

    expect((await keyring.verifyLog()).ok).toBe(true);
  });

  it('init twice on the same directory throws duplicate', async () => {
    const { dir } = await initVault();
    await expectCode(Keyring.init({ dir }), 'duplicate');
  });

  it('open on a missing directory throws', () => {
    expect(() => Keyring.open(tmpDir())).toThrow(/No keyring vault/);
  });

  it('open on an existing vault works', async () => {
    const { dir, owner } = await initVault();
    const reopened = Keyring.open(dir);
    expect(reopened.vault().owner.agent_id).toBe(publicKeyToAgentId(owner.publicKey));
  });
});

// ─── deriveEnvVarName ───

describe('deriveEnvVarName', () => {
  it('converts a label to SCREAMING_SNAKE_CASE', () => {
    expect(deriveEnvVarName('Stripe secret (prod)')).toBe('STRIPE_SECRET_PROD');
  });

  it('prefixes a leading digit with an underscore', () => {
    expect(deriveEnvVarName('42 wallets api key')).toBe('_42_WALLETS_API_KEY');
  });

  it('falls back to _SECRET when nothing usable remains', () => {
    expect(deriveEnvVarName('***')).toBe('_SECRET');
  });

  it('keeps an already-clean name', () => {
    expect(deriveEnvVarName('already_GOOD_name')).toBe('ALREADY_GOOD_NAME');
  });
});

// ─── addCredential ───

describe('addCredential', () => {
  it('derives env_var from the label when omitted', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Stripe secret (prod)' }, 'sk_live_1');
    expect(cred.env_var).toBe('STRIPE_SECRET_PROD');
    expect(cred.credential_id).toMatch(/^cred_/);
  });

  it('keeps an explicit env_var', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Stripe', env_var: 'MY_STRIPE_KEY' }, 'sk_live_2');
    expect(cred.env_var).toBe('MY_STRIPE_KEY');
  });

  it('rejects an empty or whitespace label', async () => {
    const { keyring, owner } = await initVault();
    await expectCode(keyring.addCredential(owner, { label: '' }, 's3cret'), 'invalid_input');
    await expectCode(keyring.addCredential(owner, { label: '   ' }, 's3cret'), 'invalid_input');
  });

  it('rejects an empty secret', async () => {
    const { keyring, owner } = await initVault();
    await expectCode(keyring.addCredential(owner, { label: 'Empty' }, ''), 'invalid_input');
  });

  it('returns the credential without sealed material and emits a credential_added event', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'GitHub token', provider: 'github' }, 'ghp_abc');
    expect('sealed' in cred).toBe(false);

    const event = lastEvent(keyring);
    expect(event.event_type).toBe('credential_added');
    expect(event.credential_id).toBe(cred.credential_id);
    expect(event.detail?.label).toBe('GitHub token');
  });

  it('never writes the plaintext secret to vault.json or events.jsonl', async () => {
    const { dir, keyring, owner } = await initVault();
    const secret = 'ba-test-plaintext-must-not-touch-disk-x9f2';
    const cred = await keyring.addCredential(
      owner,
      { label: 'Stripe live key', provider: 'stripe' },
      secret,
    );
    const agent = await newAgent();
    await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    const lease = await keyring.lease(agent.keypair, cred.credential_id);
    expect(lease.value).toBe(secret); // it IS retrievable by the grantee…

    const vaultRaw = fs.readFileSync(path.join(dir, 'vault.json'), 'utf-8');
    const eventsRaw = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8');
    const headRaw = fs.readFileSync(path.join(dir, 'head.json'), 'utf-8');
    // …but the plaintext never touches disk, in any encoding we store.
    const secretB64 = bytesToBase64(new TextEncoder().encode(secret));
    for (const raw of [vaultRaw, eventsRaw, headRaw]) {
      expect(raw.includes(secret)).toBe(false);
      expect(raw.includes(secretB64)).toBe(false);
    }
    // Sanity check that we read the real files.
    expect(vaultRaw.includes('Stripe live key')).toBe(true);
    expect(eventsRaw.includes(cred.credential_id)).toBe(true);
  });
});

// ─── Owner-op authorization ───

describe('owner-only operations', () => {
  it('reject a non-owner keypair with code not_owner', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Guarded' }, 's3cret');
    const intruder = await generateKeypair();

    await expectCode(keyring.addCredential(intruder, { label: 'Sneaky' }, 'value'), 'not_owner');
    await expectCode(keyring.createGrant(intruder, cred.credential_id, 'ci-bot'), 'not_owner');
    await expectCode(keyring.killSwitch(intruder, 'anyone'), 'not_owner');
    await expectCode(keyring.exportLog(intruder), 'not_owner');
    await expectCode(keyring.updateCredentialSecret(intruder, cred.credential_id, 'new'), 'not_owner');
    await expectCode(keyring.addIdentity(intruder, publicKeyToAgentId(intruder.publicKey)), 'not_owner');
  });
});

// ─── addIdentity ───

describe('addIdentity', () => {
  it('registers an identity with a name', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    const identity = await keyring.addIdentity(owner, agent.agentId, { name: 'ci-bot' });
    expect(identity.agent_id).toBe(agent.agentId);
    expect(identity.name).toBe('ci-bot');
    expect(keyring.vault().identities[agent.agentId]).toBeDefined();
    expect(lastEvent(keyring).event_type).toBe('identity_added');
  });

  it('rejects a duplicate name case-insensitively', async () => {
    const { keyring, owner } = await initVault();
    const a = await newAgent();
    const b = await newAgent();
    await keyring.addIdentity(owner, a.agentId, { name: 'ci-bot' });
    await expectCode(keyring.addIdentity(owner, b.agentId, { name: 'CI-Bot' }), 'duplicate');
  });

  it('rejects reserved names (owner, __proto__, constructor, prototype) in any casing', async () => {
    const { keyring, owner } = await initVault();
    const a = await newAgent();
    for (const name of ['owner', 'Owner', '__proto__', 'constructor', 'Constructor', 'prototype', 'PROTOTYPE']) {
      await expectCode(keyring.addIdentity(owner, a.agentId, { name }), 'invalid_input');
    }
    // None of the rejected names leaked into the identity map.
    expect(Object.keys(keyring.vault().identities)).toEqual([]);
  });

  it('rejects names starting with ag_', async () => {
    const { keyring, owner } = await initVault();
    const a = await newAgent();
    await expectCode(keyring.addIdentity(owner, a.agentId, { name: 'ag_impostor' }), 'invalid_input');
  });

  it('rejects a duplicate agent_id', async () => {
    const { keyring, owner } = await initVault();
    const a = await newAgent();
    await keyring.addIdentity(owner, a.agentId);
    await expectCode(keyring.addIdentity(owner, a.agentId, { name: 'again' }), 'duplicate');
  });

  it('rejects a malformed agent id', async () => {
    const { keyring, owner } = await initVault();
    await expect(keyring.addIdentity(owner, 'not-an-agent-id')).rejects.toThrow(/Invalid agent ID/);
  });
});

// ─── createGrant ───

describe('createGrant', () => {
  it('resolves the credential by id, env_var, and label', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(
      owner, { label: 'Supabase key', env_var: 'SUPABASE_KEY' }, 'sbp_1',
    );
    const [a, b, c] = [await newAgent(), await newAgent(), await newAgent()];

    const byId = await keyring.createGrant(owner, cred.credential_id, a.agentId);
    const byEnv = await keyring.createGrant(owner, 'SUPABASE_KEY', b.agentId);
    const byLabel = await keyring.createGrant(owner, 'supabase KEY', c.agentId); // label, case-insensitive

    for (const grant of [byId, byEnv, byLabel]) {
      expect(grant.credential_id).toBe(cred.credential_id);
      expect(grant.status).toBe('active');
      expect(grant.use_count).toBe(0);
    }
  });

  it('resolves the grantee by identity name', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Named grant' }, 's');
    const agent = await newAgent();
    await keyring.addIdentity(owner, agent.agentId, { name: 'ci-bot' });
    const grant = await keyring.createGrant(owner, cred.credential_id, 'ci-bot');
    expect(grant.agent_id).toBe(agent.agentId);
  });

  it('auto-registers a bare ag_ id and seals a copy to the grantee', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Auto reg' }, 's');
    const agent = await newAgent();
    expect(keyring.vault().identities[agent.agentId]).toBeUndefined();

    await keyring.createGrant(owner, cred.credential_id, agent.agentId);

    const vault = keyring.vault();
    expect(vault.identities[agent.agentId]).toBeDefined();
    expect(vault.credentials[cred.credential_id].sealed[agent.agentId]).toBeDefined();
    expect(lastEvent(keyring).event_type).toBe('grant_created');
  });

  it('rejects a duplicate active grant for the same identity + credential', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Dup' }, 's');
    const agent = await newAgent();
    await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await expectCode(keyring.createGrant(owner, cred.credential_id, agent.agentId), 'duplicate');
  });

  it('rejects invalid constraints', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Constrained' }, 's');
    const agent = await newAgent();

    await expectCode(
      keyring.createGrant(owner, cred.credential_id, agent.agentId, { expires_at: 'not-a-date' }),
      'invalid_input',
    );
    await expectCode(
      keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_lease_ttl_seconds: 0 }),
      'invalid_input',
    );
    await expectCode(
      keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_lease_ttl_seconds: -5 }),
      'invalid_input',
    );
    await expectCode(
      keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_uses: 0 }),
      'invalid_input',
    );
    await expectCode(
      keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_uses: 1.5 }),
      'invalid_input',
    );
  });

  it('rejects granting to the owner', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Own goal' }, 's');
    await expectCode(
      keyring.createGrant(owner, cred.credential_id, publicKeyToAgentId(owner.publicKey)),
      'invalid_input',
    );
  });

  it('rejects an unknown credential reference', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    await expectCode(keyring.createGrant(owner, 'cred_nope', agent.agentId), 'unknown_credential');
  });
});

// ─── lease: happy path ───

describe('lease', () => {
  it('returns the secret value with a default 900s TTL and records a signed lease event', async () => {
    const { keyring, owner } = await initVault();
    const secret = 'ghp_leaseme123';
    const cred = await keyring.addCredential(owner, { label: 'GitHub token' }, secret);
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);

    const lease = await keyring.lease(agent.keypair, cred.credential_id, { context: 'deploy' });

    expect(lease.value).toBe(secret);
    expect(lease.ttl_seconds).toBe(900);
    expect(lease.agent_id).toBe(agent.agentId);
    expect(lease.grant_id).toBe(grant.grant_id);
    expect(Date.parse(lease.expires_at) - Date.parse(lease.issued_at)).toBe(900 * 1000);
    expect('sealed' in lease.credential).toBe(false);

    // use_count incremented and persisted.
    expect(keyring.vault().grants[grant.grant_id].use_count).toBe(1);

    // A signed lease AccessEvent was appended.
    const event = lastEvent(keyring);
    expect(event.event_type).toBe('lease');
    expect(event.event_id).toBe(lease.access_event_id);
    expect(event.agent_pubkey).toBe(base58Encode(agent.keypair.publicKey));
    expect(event.credential_id).toBe(cred.credential_id);
    expect(event.grant_id).toBe(grant.grant_id);
    expect(event.requesting_context).toBe('deploy');
    expect(await verifyPayload(agent.keypair.publicKey, event.signed_payload, event.agent_signature)).toBe(true);
  });

  it('clamps the TTL to the grant max_lease_ttl_seconds', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Short lived' }, 's');
    const agent = await newAgent();
    await keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_lease_ttl_seconds: 60 });

    const requested = await keyring.lease(agent.keypair, cred.credential_id, { ttlSeconds: 3600 });
    expect(requested.ttl_seconds).toBe(60);

    const defaulted = await keyring.lease(agent.keypair, cred.credential_id);
    expect(defaulted.ttl_seconds).toBe(60);
  });

  it('honors a requested TTL below the grant max', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Flexible' }, 's');
    const agent = await newAgent();
    await keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_lease_ttl_seconds: 600 });

    const lease = await keyring.lease(agent.keypair, cred.credential_id, { ttlSeconds: 120 });
    expect(lease.ttl_seconds).toBe(120);

    // With no grant max, a short request is honored as-is.
    const cred2 = await keyring.addCredential(owner, { label: 'Unbounded' }, 's2');
    await keyring.createGrant(owner, cred2.credential_id, agent.agentId);
    const lease2 = await keyring.lease(agent.keypair, cred2.credential_id, { ttlSeconds: 100 });
    expect(lease2.ttl_seconds).toBe(100);
  });

  it('increments use_count across leases', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Counter' }, 's');
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);

    await keyring.lease(agent.keypair, cred.credential_id);
    await keyring.lease(agent.keypair, cred.credential_id);
    expect(keyring.vault().grants[grant.grant_id].use_count).toBe(2);
  });

  it('denies a non-finite TTL with invalid_input BEFORE mutating use_count (no successful lease)', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'TTL guard' }, 's');
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);

    // NaN and -Infinity are not positive finite TTLs → denied before any state change.
    for (const bad of [Number.NaN, Number.NEGATIVE_INFINITY, -5, 0]) {
      await expectCode(keyring.lease(agent.keypair, cred.credential_id, { ttlSeconds: bad }), 'invalid_input');
    }

    // use_count is untouched and no `lease` (success) event was ever written…
    expect(keyring.vault().grants[grant.grant_id].use_count).toBe(0);
    expect(keyring.timeline({ event_type: 'lease' })).toHaveLength(0);
    // …only signed denials.
    expect(keyring.timeline({ event_type: 'lease_denied' })).toHaveLength(4);
    expect((await keyring.verifyLog()).ok).toBe(true);
  });
});

// ─── lease: denials ───

describe('lease denials', () => {
  function expectDenialEvent(
    keyring: Keyring,
    agent: { keypair: AgentKeypair },
    reasonPattern: RegExp,
  ): AccessEvent {
    const event = lastEvent(keyring);
    expect(event.event_type).toBe('lease_denied');
    expect(event.agent_pubkey).toBe(base58Encode(agent.keypair.publicKey));
    expect(String((event.detail as { reason?: string } | null)?.reason)).toMatch(reasonPattern);
    return event;
  }

  it('denies with no_grant when the identity has no grant, and records the denial', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Not yours' }, 's');
    const agent = await newAgent();

    await expectCode(keyring.lease(agent.keypair, cred.credential_id), 'no_grant');

    const event = expectDenialEvent(keyring, agent, /no grant/);
    expect(event.credential_id).toBe(cred.credential_id);
    expect(event.grant_id).toBeNull();
  });

  it('denies with grant_revoked after revocation', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Revoked' }, 's');
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await keyring.revokeGrant(owner, grant.grant_id, 'compromised');

    await expectCode(keyring.lease(agent.keypair, cred.credential_id), 'grant_revoked');
    expectDenialEvent(keyring, agent, /revoked/);
  });

  it('denies with grant_expired on an expired grant (past expires_at is allowed at creation)', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Expired' }, 's');
    const agent = await newAgent();
    const past = new Date(Date.now() - 60_000).toISOString();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId, { expires_at: past });
    expect(grant.status).toBe('active'); // creation with a past expiry is allowed…

    await expectCode(keyring.lease(agent.keypair, cred.credential_id), 'grant_expired');
    const event = expectDenialEvent(keyring, agent, /expired/);
    expect(event.grant_id).toBe(grant.grant_id);
  });

  it('denies with usage_cap when max_uses is exhausted', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'One shot' }, 's');
    const agent = await newAgent();
    await keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_uses: 1 });

    await keyring.lease(agent.keypair, cred.credential_id); // uses the single allowed lease
    await expectCode(keyring.lease(agent.keypair, cred.credential_id), 'usage_cap');
    expectDenialEvent(keyring, agent, /usage cap/);
  });

  it('denies an unknown credential with a null credential_id in the denial event', async () => {
    const { keyring } = await initVault();
    const agent = await newAgent();

    await expectCode(keyring.lease(agent.keypair, 'NO_SUCH_CRED'), 'unknown_credential');

    const event = expectDenialEvent(keyring, agent, /unknown credential: NO_SUCH_CRED/);
    expect(event.credential_id).toBeNull();
    expect(event.grant_id).toBeNull();
  });

  it('keeps the event log verifiable after denials', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Audit' }, 's');
    const agent = await newAgent();
    await expectCode(keyring.lease(agent.keypair, cred.credential_id), 'no_grant');
    await expectCode(keyring.lease(agent.keypair, 'nope'), 'unknown_credential');
    expect((await keyring.verifyLog()).ok).toBe(true);
  });
});

// ─── listForAgent ───

describe('listForAgent', () => {
  it('lists active grants with metadata and never the secret value', async () => {
    const { keyring, owner } = await initVault();
    const secret = 'super-secret-value-abc';
    const cred = await keyring.addCredential(
      owner, { label: 'Listable', provider: 'github', scope: 'repo:acme' }, secret,
    );
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId, { max_uses: 5 });

    const views = keyring.listForAgent(agent.keypair);
    expect(views).toHaveLength(1);
    expect(views[0].credential_id).toBe(cred.credential_id);
    expect(views[0].label).toBe('Listable');
    expect(views[0].grant_id).toBe(grant.grant_id);
    expect(views[0].constraints.max_uses).toBe(5);
    expect(JSON.stringify(views).includes(secret)).toBe(false);
  });

  it('hides expired, capped, and revoked grants', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();

    const expired = await keyring.addCredential(owner, { label: 'A expired' }, 's1');
    await keyring.createGrant(owner, expired.credential_id, agent.agentId, {
      expires_at: new Date(Date.now() - 1000).toISOString(),
    });

    const capped = await keyring.addCredential(owner, { label: 'B capped' }, 's2');
    await keyring.createGrant(owner, capped.credential_id, agent.agentId, { max_uses: 1 });
    await keyring.lease(agent.keypair, capped.credential_id); // exhaust the cap

    const revoked = await keyring.addCredential(owner, { label: 'C revoked' }, 's3');
    const revokedGrant = await keyring.createGrant(owner, revoked.credential_id, agent.agentId);
    await keyring.revokeGrant(owner, revokedGrant.grant_id);

    const alive = await keyring.addCredential(owner, { label: 'D alive' }, 's4');
    await keyring.createGrant(owner, alive.credential_id, agent.agentId);

    const views = keyring.listForAgent(agent.keypair);
    expect(views.map(v => v.credential_id)).toEqual([alive.credential_id]);
  });

  it('shows nothing to an agent with no grants', async () => {
    const { keyring, owner } = await initVault();
    await keyring.addCredential(owner, { label: 'Private' }, 's');
    const stranger = await newAgent();
    expect(keyring.listForAgent(stranger.keypair)).toEqual([]);
  });
});

// ─── revokeGrant ───

describe('revokeGrant', () => {
  it('is instant: removes the sealed copy and blocks new leases', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Revocable' }, 's');
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    expect(keyring.vault().credentials[cred.credential_id].sealed[agent.agentId]).toBeDefined();

    const revoked = await keyring.revokeGrant(owner, grant.grant_id, 'rotation');
    expect(revoked.status).toBe('revoked');
    expect(revoked.revoked_at).toBeDefined();
    expect(revoked.revoke_reason).toBe('rotation');

    const vault = keyring.vault();
    expect(vault.credentials[cred.credential_id].sealed[agent.agentId]).toBeUndefined();
    // The owner copy survives.
    expect(vault.credentials[cred.credential_id].sealed[vault.owner.agent_id]).toBeDefined();

    await expectCode(keyring.lease(agent.keypair, cred.credential_id), 'grant_revoked');
    expect(lastEvent(keyring).event_type).toBe('lease_denied');
  });

  it('revoking twice throws', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Twice' }, 's');
    const agent = await newAgent();
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await keyring.revokeGrant(owner, grant.grant_id);
    await expectCode(keyring.revokeGrant(owner, grant.grant_id), 'grant_revoked');
  });

  it('revoking an unknown grant throws', async () => {
    const { keyring, owner } = await initVault();
    await expectCode(keyring.revokeGrant(owner, 'grant_nope'), 'unknown_grant');
  });
});

// ─── updateCredentialSecret ───

describe('updateCredentialSecret', () => {
  it('re-seals to the owner and active grantees only', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Rotated' }, 'v1-old');
    const alice = await newAgent();
    const bob = await newAgent();
    await keyring.createGrant(owner, cred.credential_id, alice.agentId);
    const bobGrant = await keyring.createGrant(owner, cred.credential_id, bob.agentId);
    await keyring.revokeGrant(owner, bobGrant.grant_id);

    await keyring.updateCredentialSecret(owner, cred.credential_id, 'v2-new');

    const vault = keyring.vault();
    const sealedKeys = Object.keys(vault.credentials[cred.credential_id].sealed).sort();
    expect(sealedKeys).toEqual([vault.owner.agent_id, alice.agentId].sort());
    // The revoked identity's copy is NOT recreated.
    expect(sealedKeys).not.toContain(bob.agentId);

    // The active grantee leases the new value.
    const lease = await keyring.lease(alice.keypair, cred.credential_id);
    expect(lease.value).toBe('v2-new');

    expect(lastEvent(keyring).event_type).toBe('lease');
    expect(keyring.timeline({ event_type: 'credential_updated' })).toHaveLength(1);
  });

  it('rejects an empty secret', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'NoEmpty' }, 'v1');
    await expectCode(keyring.updateCredentialSecret(owner, cred.credential_id, ''), 'invalid_input');
  });

  it('does NOT re-seal the rotated secret to expired or usage-capped grants', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Rotating' }, 'v1-old');
    const active = await newAgent();
    const expired = await newAgent();
    const capped = await newAgent();

    await keyring.createGrant(owner, cred.credential_id, active.agentId);
    await keyring.createGrant(owner, cred.credential_id, expired.agentId, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await keyring.createGrant(owner, cred.credential_id, capped.agentId, { max_uses: 1 });
    await keyring.lease(capped.keypair, cred.credential_id); // exhaust the cap

    await keyring.updateCredentialSecret(owner, cred.credential_id, 'v2-new');

    const vault = keyring.vault();
    const sealed = vault.credentials[cred.credential_id].sealed;
    // Only the owner and the still-authorizing grantee receive the rotated secret.
    expect(Object.keys(sealed).sort()).toEqual([vault.owner.agent_id, active.agentId].sort());
    // The expired and capped identities' sealed copies are dropped, not refreshed.
    expect(sealed[expired.agentId]).toBeUndefined();
    expect(sealed[capped.agentId]).toBeUndefined();

    // The still-valid grantee leases the NEW value.
    const lease = await keyring.lease(active.keypair, cred.credential_id);
    expect(lease.value).toBe('v2-new');

    // The expired/capped grantees are still denied — they never obtain the rotated secret.
    await expectCode(keyring.lease(expired.keypair, cred.credential_id), 'grant_expired');
    await expectCode(keyring.lease(capped.keypair, cred.credential_id), 'usage_cap');
  });
});

// ─── killSwitch ───

describe('killSwitch', () => {
  it('revokes every active grant for the identity and removes its sealed copies', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    await keyring.addIdentity(owner, agent.agentId, { name: 'rogue' });
    const cred1 = await keyring.addCredential(owner, { label: 'One' }, 's1');
    const cred2 = await keyring.addCredential(owner, { label: 'Two' }, 's2');
    const g1 = await keyring.createGrant(owner, cred1.credential_id, agent.agentId);
    const g2 = await keyring.createGrant(owner, cred2.credential_id, agent.agentId);

    const result = await keyring.killSwitch(owner, 'rogue', 'agent went rogue');

    expect(result.agent_id).toBe(agent.agentId);
    expect(result.revoked_grant_ids.sort()).toEqual([g1.grant_id, g2.grant_id].sort());

    const vault = keyring.vault();
    expect(vault.grants[g1.grant_id].status).toBe('revoked');
    expect(vault.grants[g2.grant_id].status).toBe('revoked');
    expect(vault.grants[g1.grant_id].revoke_reason).toBe('agent went rogue');
    expect(vault.credentials[cred1.credential_id].sealed[agent.agentId]).toBeUndefined();
    expect(vault.credentials[cred2.credential_id].sealed[agent.agentId]).toBeUndefined();

    const event = lastEvent(keyring);
    expect(event.event_type).toBe('kill_switch');
    expect((event.detail as { revoked_grant_ids?: string[] }).revoked_grant_ids?.sort())
      .toEqual([g1.grant_id, g2.grant_id].sort());

    await expectCode(keyring.lease(agent.keypair, cred1.credential_id), 'grant_revoked');
  });

  it('returns an empty list for an identity with no active grants', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    await keyring.addIdentity(owner, agent.agentId, { name: 'idle' });
    const result = await keyring.killSwitch(owner, 'idle');
    expect(result.revoked_grant_ids).toEqual([]);
  });
});

// ─── Prototype safety ───

describe('prototype-pollution safety', () => {
  it('resolveAgent on an inherited Object.prototype key throws unknown_identity (not a silent hit)', async () => {
    const { keyring } = await initVault();
    const vault = keyring.vault();
    for (const ref of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'prototype']) {
      const err = (() => { try { keyring.resolveAgent(vault, ref); return null; } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(KeyringError);
      expect((err as KeyringError).code).toBe('unknown_identity');
    }
  });

  it('resolveCredential on an inherited Object.prototype key throws unknown_credential', async () => {
    const { keyring, owner } = await initVault();
    await keyring.addCredential(owner, { label: 'Real cred' }, 's');
    const vault = keyring.vault();
    for (const ref of ['constructor', '__proto__', 'toString', 'prototype']) {
      const err = (() => { try { keyring.resolveCredential(vault, ref); return null; } catch (e) { return e; } })();
      expect(err).toBeInstanceOf(KeyringError);
      expect((err as KeyringError).code).toBe('unknown_credential');
    }
  });

  it('killSwitch on "constructor" throws unknown_identity rather than silently no-op-ing', async () => {
    const { keyring, owner } = await initVault();
    await expectCode(keyring.killSwitch(owner, 'constructor'), 'unknown_identity');
    await expectCode(keyring.removeIdentity(owner, '__proto__'), 'unknown_identity');
  });

  it('addIdentity rejects reserved/prototype names', async () => {
    const { keyring, owner } = await initVault();
    const a = await newAgent();
    for (const name of ['owner', '__proto__', 'constructor', 'prototype']) {
      await expectCode(keyring.addIdentity(owner, a.agentId, { name }), 'invalid_input');
    }
    // The identity map stays clean and its prototype is not polluted.
    expect(Object.keys(keyring.vault().identities)).toEqual([]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

// ─── Reference resolution ambiguity ───

describe('resolveCredential ambiguity', () => {
  it('rejects a cross-kind ambiguous reference (one credential label equals another credential env_var)', async () => {
    const { keyring, owner } = await initVault();
    // Credential A is named "TOKEN" (by label); its own env_var is something else.
    const a = await keyring.addCredential(owner, { label: 'TOKEN', env_var: 'CRED_A_ENV' }, 'a-secret');
    // Credential B exposes env_var "TOKEN".
    const b = await keyring.addCredential(owner, { label: 'Bee cred', env_var: 'TOKEN' }, 'b-secret');
    expect(a.credential_id).not.toBe(b.credential_id);

    const vault = keyring.vault();
    const err = (() => { try { keyring.resolveCredential(vault, 'TOKEN'); return null; } catch (e) { return e; } })();
    expect(err).toBeInstanceOf(KeyringError);
    expect((err as KeyringError).code).toBe('unknown_credential');
    expect((err as KeyringError).message).toMatch(/ambiguous/);

    // The same ambiguity surfaces through the lease path (recorded as a denial).
    const agent = await newAgent();
    await expectCode(keyring.lease(agent.keypair, 'TOKEN'), 'unknown_credential');
    // …and each credential is still resolvable unambiguously by its own id.
    expect(keyring.resolveCredential(vault, a.credential_id).credential_id).toBe(a.credential_id);
    expect(keyring.resolveCredential(vault, b.credential_id).credential_id).toBe(b.credential_id);
  });
});

// ─── removeCredential / removeIdentity ───

describe('removeCredential', () => {
  it('removes the credential and all of its grants', async () => {
    const { keyring, owner } = await initVault();
    const doomed = await keyring.addCredential(owner, { label: 'Doomed' }, 's1');
    const kept = await keyring.addCredential(owner, { label: 'Kept' }, 's2');
    const agent = await newAgent();
    const doomedGrant = await keyring.createGrant(owner, doomed.credential_id, agent.agentId);
    const keptGrant = await keyring.createGrant(owner, kept.credential_id, agent.agentId);

    await keyring.removeCredential(owner, doomed.credential_id);

    const vault = keyring.vault();
    expect(vault.credentials[doomed.credential_id]).toBeUndefined();
    expect(vault.grants[doomedGrant.grant_id]).toBeUndefined();
    // Unrelated credential and grant untouched.
    expect(vault.credentials[kept.credential_id]).toBeDefined();
    expect(vault.grants[keptGrant.grant_id]).toBeDefined();
    expect(lastEvent(keyring).event_type).toBe('credential_removed');
  });
});

describe('removeIdentity', () => {
  it('is blocked while active grants exist, works after revoke', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Held' }, 's');
    const agent = await newAgent();
    await keyring.addIdentity(owner, agent.agentId, { name: 'holder' });
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);

    await expectCode(keyring.removeIdentity(owner, 'holder'), 'invalid_input');

    await keyring.revokeGrant(owner, grant.grant_id);
    await keyring.removeIdentity(owner, 'holder');
    expect(keyring.vault().identities[agent.agentId]).toBeUndefined();
    expect(lastEvent(keyring).event_type).toBe('identity_removed');
  });

  it('throws for an unknown identity', async () => {
    const { keyring, owner } = await initVault();
    await expectCode(keyring.removeIdentity(owner, 'ghost'), 'unknown_identity');
  });
});

// ─── Grant requests ───

describe('grant requests', () => {
  it('createRequest creates a pending request', async () => {
    const { keyring } = await initVault();
    const agent = await newAgent();
    const request = await keyring.createRequest(agent.keypair, 'github', { scope: 'repo:acme', note: 'CI needs it' });
    expect(request.status).toBe('pending');
    expect(request.agent_id).toBe(agent.agentId);
    expect(request.provider).toBe('github');
    expect(keyring.requestsView('pending')).toHaveLength(1);
    expect(lastEvent(keyring).event_type).toBe('request_created');
  });

  it('a duplicate pending request for the same provider+scope returns the same request', async () => {
    const { keyring } = await initVault();
    const agent = await newAgent();
    const first = await keyring.createRequest(agent.keypair, 'github', { scope: 'repo:acme' });
    const dup = await keyring.createRequest(agent.keypair, 'github', { scope: 'repo:acme' });
    expect(dup.request_id).toBe(first.request_id);

    // A different scope is a different request.
    const other = await keyring.createRequest(agent.keypair, 'github', { scope: 'repo:other' });
    expect(other.request_id).not.toBe(first.request_id);
  });

  it('approveRequest creates a grant and the grantee can lease', async () => {
    const { keyring, owner } = await initVault();
    const secret = 'ghp_approved123';
    const cred = await keyring.addCredential(owner, { label: 'GH token', provider: 'github' }, secret);
    const agent = await newAgent();
    const request = await keyring.createRequest(agent.keypair, 'github');

    const { request: approved, grant } = await keyring.approveRequest(
      owner, request.request_id, cred.credential_id, { max_uses: 3 },
    );

    expect(approved.status).toBe('approved');
    expect(approved.resolved_at).toBeDefined();
    expect(approved.grant_id).toBe(grant.grant_id);
    expect(approved.credential_id).toBe(cred.credential_id);
    expect(grant.agent_id).toBe(agent.agentId);
    expect(grant.constraints.max_uses).toBe(3);
    expect(lastEvent(keyring).event_type).toBe('request_approved');

    const lease = await keyring.lease(agent.keypair, cred.credential_id);
    expect(lease.value).toBe(secret);
  });

  it('denyRequest marks the request denied with a reason', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    const request = await keyring.createRequest(agent.keypair, 'stripe');

    const denied = await keyring.denyRequest(owner, request.request_id, 'no production access');
    expect(denied.status).toBe('denied');
    expect(denied.deny_reason).toBe('no production access');
    expect(denied.resolved_at).toBeDefined();
    expect(lastEvent(keyring).event_type).toBe('request_denied');
  });

  it('approving or denying a non-pending request throws', async () => {
    const { keyring, owner } = await initVault();
    const cred = await keyring.addCredential(owner, { label: 'Approve once' }, 's');
    const agent = await newAgent();
    const request = await keyring.createRequest(agent.keypair, 'github');
    await keyring.approveRequest(owner, request.request_id, cred.credential_id);

    await expectCode(keyring.approveRequest(owner, request.request_id, cred.credential_id), 'duplicate');
    await expectCode(keyring.denyRequest(owner, request.request_id), 'duplicate');
    await expectCode(keyring.approveRequest(owner, 'req_nope', cred.credential_id), 'unknown_request');
  });

  it('rejects an empty provider', async () => {
    const { keyring } = await initVault();
    const agent = await newAgent();
    await expectCode(keyring.createRequest(agent.keypair, '  '), 'invalid_input');
  });
});

// ─── leaseAll ───

describe('leaseAll', () => {
  it('leases every granted credential', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    const cred1 = await keyring.addCredential(owner, { label: 'First' }, 'value-1');
    const cred2 = await keyring.addCredential(owner, { label: 'Second' }, 'value-2');
    await keyring.createGrant(owner, cred1.credential_id, agent.agentId);
    await keyring.createGrant(owner, cred2.credential_id, agent.agentId);

    const { leases, denied } = await keyring.leaseAll(agent.keypair, { context: 'based run' });
    expect(denied).toEqual([]);
    expect(leases).toHaveLength(2);
    const byId = new Map(leases.map(l => [l.credential.credential_id, l.value]));
    expect(byId.get(cred1.credential_id)).toBe('value-1');
    expect(byId.get(cred2.credential_id)).toBe('value-2');
  });

  it('reports per-credential denials without aborting the rest', async () => {
    const { dir, keyring, owner } = await initVault();
    const agent = await newAgent();
    const good = await keyring.addCredential(owner, { label: 'Good' }, 'ok-value');
    const broken = await keyring.addCredential(owner, { label: 'Broken' }, 'lost-value');
    await keyring.createGrant(owner, good.credential_id, agent.agentId);
    await keyring.createGrant(owner, broken.credential_id, agent.agentId);

    // Simulate a corrupted vault: the agent's sealed copy for one credential is gone.
    const vaultPath = path.join(dir, 'vault.json');
    const vaultFile = JSON.parse(fs.readFileSync(vaultPath, 'utf-8')) as VaultFile;
    delete vaultFile.credentials[broken.credential_id].sealed[agent.agentId];
    fs.writeFileSync(vaultPath, JSON.stringify(vaultFile, null, 2));

    const { leases, denied } = await keyring.leaseAll(agent.keypair);
    expect(leases).toHaveLength(1);
    expect(leases[0].credential.credential_id).toBe(good.credential_id);
    expect(denied).toHaveLength(1);
    expect(denied[0].credential_id).toBe(broken.credential_id);
    expect(denied[0].reason).toMatch(/no sealed copy/);
  });

  it('attempts every active grant — expired/capped ones yield denials AND lease_denied events', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    const good = await keyring.addCredential(owner, { label: 'Good' }, 'g-value');
    const expired = await keyring.addCredential(owner, { label: 'Expired' }, 'e-value');
    const capped = await keyring.addCredential(owner, { label: 'Capped' }, 'c-value');
    await keyring.createGrant(owner, good.credential_id, agent.agentId);
    await keyring.createGrant(owner, expired.credential_id, agent.agentId, {
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    });
    await keyring.createGrant(owner, capped.credential_id, agent.agentId, { max_uses: 1 });
    await keyring.lease(agent.keypair, capped.credential_id); // exhaust the cap

    const { leases, denied } = await keyring.leaseAll(agent.keypair, { context: 'based run' });

    // The healthy credential still leases; the expired/capped grants are NOT silently skipped.
    expect(leases.map(l => l.credential.credential_id)).toEqual([good.credential_id]);
    expect(denied.map(d => d.credential_id).sort()).toEqual([expired.credential_id, capped.credential_id].sort());
    expect(denied.find(d => d.credential_id === expired.credential_id)?.reason).toMatch(/expired/);
    expect(denied.find(d => d.credential_id === capped.credential_id)?.reason).toMatch(/usage cap/);

    // Each denial is a signed, attributable lease_denied event in the log.
    const deniedEvents = keyring.timeline({ event_type: 'lease_denied' });
    expect(deniedEvents.some(e => e.credential_id === expired.credential_id)).toBe(true);
    expect(deniedEvents.some(e => e.credential_id === capped.credential_id)).toBe(true);
    expect((await keyring.verifyLog()).ok).toBe(true);
  });
});

// ─── timeline ───

describe('timeline', () => {
  async function timelineFixture(): Promise<Fixture & {
    alice: { keypair: AgentKeypair; agentId: string };
    bob: { keypair: AgentKeypair; agentId: string };
    credId: string;
  }> {
    const fixture = await initVault();
    const { keyring, owner } = fixture;
    const alice = await newAgent();
    const bob = await newAgent();
    await keyring.addIdentity(owner, alice.agentId, { name: 'alice' });
    const cred = await keyring.addCredential(owner, { label: 'Timeline cred' }, 's');
    await keyring.createGrant(owner, cred.credential_id, alice.agentId);
    await keyring.createGrant(owner, cred.credential_id, bob.agentId);
    await keyring.lease(alice.keypair, cred.credential_id);
    await keyring.lease(alice.keypair, cred.credential_id);
    await keyring.lease(bob.keypair, cred.credential_id);
    return { ...fixture, alice, bob, credId: cred.credential_id };
  }

  it('filters by agent id and by identity name', async () => {
    const { keyring, alice } = await timelineFixture();

    const byId = keyring.timeline({ agent: alice.agentId });
    expect(byId.length).toBe(2);
    expect(byId.every(e => e.agent_pubkey === alice.agentId.slice(3))).toBe(true);

    const byName = keyring.timeline({ agent: 'alice' });
    expect(byName).toEqual(byId);
  });

  it('filters by credential_id', async () => {
    const { keyring, credId } = await timelineFixture();
    const events = keyring.timeline({ credential_id: credId });
    expect(events.length).toBeGreaterThanOrEqual(6); // added + 2 grants + 3 leases
    expect(events.every(e => e.credential_id === credId)).toBe(true);
  });

  it('filters by event_type', async () => {
    const { keyring } = await timelineFixture();
    const leases = keyring.timeline({ event_type: 'lease' });
    expect(leases).toHaveLength(3);
    expect(leases.every(e => e.event_type === 'lease')).toBe(true);
  });

  it('limit returns only the most recent events', async () => {
    const { keyring } = await timelineFixture();
    const all = keyring.timeline();
    const limited = keyring.timeline({ limit: 3 });
    expect(limited).toEqual(all.slice(-3));
  });
});

// ─── verifyLog / exportLog ───

describe('verifyLog', () => {
  it('verifies an untampered log across many operations', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    const cred = await keyring.addCredential(owner, { label: 'Verified' }, 's');
    const grant = await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await keyring.lease(agent.keypair, cred.credential_id);
    await keyring.revokeGrant(owner, grant.grant_id);

    const result = await keyring.verifyLog();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.events_checked).toBe(keyring.timeline().length);
  });

  it('detects tampering after editing events.jsonl on disk', async () => {
    const { dir, keyring, owner } = await initVault();
    const agent = await newAgent();
    const cred = await keyring.addCredential(owner, { label: 'Tamper me' }, 's');
    await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await keyring.lease(agent.keypair, cred.credential_id);
    expect((await keyring.verifyLog()).ok).toBe(true);

    const eventsPath = path.join(dir, 'events.jsonl');
    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const middle = JSON.parse(lines[1]) as AccessEvent;
    middle.credential_id = 'cred_forged';
    lines[1] = JSON.stringify(middle);
    fs.writeFileSync(eventsPath, lines.join('\n') + '\n');

    const result = await keyring.verifyLog();
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('detects tail truncation of events.jsonl via the head.json anchor', async () => {
    const { dir, keyring, owner } = await initVault();
    const agent = await newAgent();
    const cred = await keyring.addCredential(owner, { label: 'Anchored' }, 's');
    await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await keyring.lease(agent.keypair, cred.credential_id);
    expect((await keyring.verifyLog()).ok).toBe(true);

    const eventsPath = path.join(dir, 'events.jsonl');
    const lines = fs.readFileSync(eventsPath, 'utf-8').trim().split('\n');
    const anchor = JSON.parse(fs.readFileSync(path.join(dir, 'head.json'), 'utf-8')) as { count: number };
    expect(anchor.count).toBe(lines.length);

    // Drop the last complete event line, leaving head.json untouched.
    fs.writeFileSync(eventsPath, lines.slice(0, -1).join('\n') + '\n');

    // The surviving chain is internally valid, but the anchor still records the
    // original length/head — so verifyLog flags the truncation.
    const result = await keyring.verifyLog();
    expect(result.ok).toBe(false);
    expect(result.errors.some(e => /Log truncated/.test(e.error) || /does not reach recorded head/.test(e.error))).toBe(true);
  });
});

describe('exportLog', () => {
  it('exports a signed log whose hash and signature verify', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    const cred = await keyring.addCredential(owner, { label: 'Exported' }, 's');
    await keyring.createGrant(owner, cred.credential_id, agent.agentId);
    await keyring.lease(agent.keypair, cred.credential_id);

    const exported = await keyring.exportLog(owner);
    const events = keyring.timeline();

    expect(exported.format).toBe('basedagents-keyring-log/v1');
    expect(exported.vault_owner).toEqual(keyring.vault().owner);
    expect(exported.events).toEqual(events);
    expect(exported.head).toEqual({
      sequence: events[events.length - 1].sequence,
      entry_hash: events[events.length - 1].entry_hash,
    });
    expect(exported.events_hash).toBe(sha256Hex(canonicalJsonStringify(exported.events)));

    const signable = canonicalJsonStringify({
      format: exported.format,
      exported_at: exported.exported_at,
      vault_owner: exported.vault_owner,
      head: exported.head,
      events_hash: exported.events_hash,
    });
    expect(await verifyPayload(owner.publicKey, signable, exported.export_signature)).toBe(true);

    // The signature binds the exact export — any change breaks it.
    const forged = canonicalJsonStringify({
      format: exported.format,
      exported_at: exported.exported_at,
      vault_owner: exported.vault_owner,
      head: exported.head,
      events_hash: sha256Hex('forged'),
    });
    expect(await verifyPayload(owner.publicKey, forged, exported.export_signature)).toBe(false);
  });
});

// ─── Views ───

describe('agentsView / credentialsView', () => {
  it('agentsView reports grant counts, lease totals, and last access', async () => {
    const { keyring, owner } = await initVault();
    const agent = await newAgent();
    await keyring.addIdentity(owner, agent.agentId, { name: 'ci-bot' });
    const cred1 = await keyring.addCredential(owner, { label: 'Viewed one' }, 's1');
    const cred2 = await keyring.addCredential(owner, { label: 'Viewed two' }, 's2');
    await keyring.createGrant(owner, cred1.credential_id, agent.agentId);
    const g2 = await keyring.createGrant(owner, cred2.credential_id, agent.agentId);
    await keyring.revokeGrant(owner, g2.grant_id);
    await keyring.lease(agent.keypair, cred1.credential_id);
    await keyring.lease(agent.keypair, cred1.credential_id);

    const summaries = keyring.agentsView();
    expect(summaries).toHaveLength(1);
    const summary = summaries[0];
    expect(summary.agent_id).toBe(agent.agentId);
    expect(summary.name).toBe('ci-bot');
    expect(summary.is_owner).toBe(false);
    expect(summary.active_grants).toBe(1);
    expect(summary.revoked_grants).toBe(1);
    expect(summary.total_leases).toBe(2);
    expect(summary.last_access).toBeDefined();
    expect(summary.daily_leases.reduce((a, b) => a + b, 0)).toBe(2);
    expect(summary.grants).toHaveLength(2);
    expect(summary.grants.map(g => g.credential_label).sort()).toEqual(['Viewed one', 'Viewed two']);
  });

  it('credentialsView exposes the holders reverse index with last_access after lease', async () => {
    const { keyring, owner } = await initVault();
    const alice = await newAgent();
    const bob = await newAgent();
    await keyring.addIdentity(owner, alice.agentId, { name: 'alice' });
    const cred = await keyring.addCredential(owner, { label: 'Held cred' }, 's');
    const aliceGrant = await keyring.createGrant(owner, cred.credential_id, alice.agentId);
    const bobGrant = await keyring.createGrant(owner, cred.credential_id, bob.agentId);
    await keyring.revokeGrant(owner, bobGrant.grant_id);
    await keyring.lease(alice.keypair, cred.credential_id);

    const view = keyring.credentialsView();
    expect(view).toHaveLength(1);
    const summary = view[0];
    expect(summary.credential_id).toBe(cred.credential_id);
    expect('sealed' in summary).toBe(false);
    expect(summary.holders).toHaveLength(2);

    // Active holders sort before revoked ones.
    expect(summary.holders[0].agent_id).toBe(alice.agentId);
    expect(summary.holders[0].name).toBe('alice');
    expect(summary.holders[0].grant_id).toBe(aliceGrant.grant_id);
    expect(summary.holders[0].status).toBe('active');
    expect(summary.holders[0].use_count).toBe(1);
    expect(summary.holders[0].last_leased).toBeDefined();

    expect(summary.holders[1].agent_id).toBe(bob.agentId);
    expect(summary.holders[1].status).toBe('revoked');
    expect(summary.holders[1].last_leased).toBeUndefined();
  });
});
