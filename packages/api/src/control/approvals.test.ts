/**
 * Interop + adversarial tests for the Keyring grant-approval control plane.
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * The POINT of increment 2b: prove the control-plane half (this package) and the
 * daemon half (@basedagents/keyring) agree on the grant-approval contract
 * (CONTROL_PLANE.md §2 / §2.1). We run the REAL console ceremony against a
 * simulated ES256 authenticator, then feed the results into the REAL keyring
 * package and assert the two halves interoperate.
 *
 * The two load-bearing interop assertions (see the `interop` describe):
 *   (a) BYTE-PARITY of the contract: for identical inputs the control-plane
 *       grantApprovalCanonical / grantApprovalHash produce output identical to
 *       keyring's — the daemon re-derives this hash and rejects any disagreement.
 *   (b) the console-produced owner assertion is ACCEPTED by the daemon: it
 *       verifies under keyring's verifyOwnerAssertion against the console's
 *       action_hash, AND keyring's applyApprovedGrant succeeds end-to-end (grant
 *       becomes active, the grantee can lease) for an approval the same passkey
 *       signed over the daemon-form canonical.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import * as ed from '@noble/ed25519';
// The REAL daemon package — its contract is the single source of truth.
import {
  Keyring,
  generateKeypair as keyringGenerateKeypair,
  grantApprovalCanonical as keyringCanonical,
  grantApprovalHash as keyringHash,
  verifyOwnerAssertion,
  publicKeyToAgentId as keyringAgentId,
  base58Encode as keyringB58,
} from '@basedagents/keyring';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import { sha256, base58Encode, bytesToHex } from '../crypto/index.js';
import { base64urlEncode, base64urlDecode } from './webauthn.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { ControlStore } from './store.js';
import { grantApprovalCanonical, grantApprovalHash } from './grant-actions.js';
import type { GrantConstraints } from './grant-actions.js';
import ownerRoutes from './routes.js';
import approvalRoutes from './approvals.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const SQL_0023 = readFileSync(join(MIGRATIONS, '0023_owner_accounts.sql'), 'utf-8');
const SQL_0024 = readFileSync(join(MIGRATIONS, '0024_keyring_approvals.sql'), 'utf-8');

const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';

// ─── byte helpers (mirrors routes.test.ts / webauthn.test.ts) ───

type CborType = Parameters<typeof isoCBOR.encode>[0];

function concat(...arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
}

function u32be(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const encInt = (v: Uint8Array): Uint8Array => {
    let i = 0;
    while (i < v.length - 1 && v[i] === 0) i++;
    let b = v.slice(i);
    if (b[0] & 0x80) b = concat(new Uint8Array([0]), b);
    return concat(new Uint8Array([0x02, b.length]), b);
  };
  const body = concat(encInt(raw.slice(0, 32)), encInt(raw.slice(32, 64)));
  return concat(new Uint8Array([0x30, body.length]), body);
}

async function signDer(privateKey: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = new Uint8Array(
    await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message),
  );
  return rawToDer(raw);
}

// ─── simulated authenticator (ES256 passkey + real Ed25519 vault key) ───

interface AssertionBody {
  credentialId: string;
  authenticatorData: string;
  clientDataJSON: string;
  signature: string;
}

class Authenticator {
  private constructor(
    private privateKey: CryptoKey,
    readonly cose: Uint8Array,
    readonly credentialId: string,
    /** uncompressed P-256 point (0x04‖x‖y) hex — anchored in the keyring vault. */
    readonly rawPublicKeyHex: string,
    /** the OWNER's Ed25519 vault keypair — real, so the daemon can sign as the owner. */
    readonly vaultPub: Uint8Array,
    readonly vaultPriv: Uint8Array,
    readonly vaultB58: string,
    readonly ownerId: string,
  ) {}

  static async create(): Promise<Authenticator> {
    const kp = await globalThis.crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    const x = base64urlDecode(jwk.x!);
    const y = base64urlDecode(jwk.y!);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, x],
        [-3, y],
      ]) as CborType,
    );
    // Uncompressed P-256 point = 0x04 ‖ x ‖ y — the anchor form keyring expects.
    const rawPublicKeyHex = bytesToHex(concat(new Uint8Array([0x04]), x, y));

    const rawId = new Uint8Array(16);
    globalThis.crypto.getRandomValues(rawId);

    // A REAL Ed25519 vault keypair (the confidentiality root) → owner id.
    const vaultPriv = ed.utils.randomPrivateKey();
    const vaultPub = await ed.getPublicKeyAsync(vaultPriv);
    const vaultB58 = base58Encode(vaultPub);
    const ownerId = ownerIdFromVaultPubkey(vaultPub);

    return new Authenticator(
      kp.privateKey, cose, base64urlEncode(rawId), rawPublicKeyHex,
      vaultPub, vaultPriv, vaultB58, ownerId,
    );
  }

  registration(challenge: string): { attestationObject: string; clientDataJSON: string } {
    const rpIdHash = sha256(te.encode(RP_ID));
    const aaguid = new Uint8Array(16);
    const credIdBytes = base64urlDecode(this.credentialId);
    const credIdLen = new Uint8Array([(credIdBytes.length >> 8) & 0xff, credIdBytes.length & 0xff]);
    const attested = concat(aaguid, credIdLen, credIdBytes, this.cose);
    const authData = concat(rpIdHash, new Uint8Array([0x5d]), u32be(0), attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, CborType>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, CborType>()],
        ['authData', authData],
      ]) as CborType,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false });
    return {
      attestationObject: base64urlEncode(attestationObject),
      clientDataJSON: base64urlEncode(te.encode(clientDataJSON)),
    };
  }

  /** A get() assertion over `challenge` — the owner passkey signing an action hash. */
  async assert(challenge: string, counter: number): Promise<AssertionBody> {
    const rpIdHash = sha256(te.encode(RP_ID));
    const authData = concat(rpIdHash, new Uint8Array([0x05]), u32be(counter));
    const clientDataJSON = JSON.stringify({ type: 'webauthn.get', challenge, origin: ORIGIN, crossOrigin: false });
    const cdjBytes = te.encode(clientDataJSON);
    const der = await signDer(this.privateKey, concat(authData, sha256(cdjBytes)));
    return {
      credentialId: this.credentialId,
      authenticatorData: base64urlEncode(authData),
      clientDataJSON: base64urlEncode(cdjBytes),
      signature: base64urlEncode(der),
    };
  }
}

// ─── app + db harness ───

let rawDb: Database.Database;
let db: SQLiteAdapter;
let app: Hono<AppEnv>;
let store: ControlStore;

function buildApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  a.route('/v1/owner', ownerRoutes);
  a.route('/v1/owner', approvalRoutes);
  return a;
}

interface TestAgent {
  agentId: string;
  publicKeyB58: string;
  keypair: { publicKey: Uint8Array; privateKey: Uint8Array };
}
let agentCounter = 0;

async function makeAgent(): Promise<TestAgent> {
  const keypair = await keyringGenerateKeypair();
  const agentId = keyringAgentId(keypair.publicKey); // ag_<base58(pub)>
  rawDb
    .prepare(`INSERT INTO agents (id, public_key, name, status) VALUES (?, ?, ?, 'active')`)
    .run(agentId, Buffer.from(keypair.publicKey), `agent-${++agentCounter}`);
  return { agentId, publicKeyB58: base58Encode(keypair.publicKey), keypair };
}

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(path: string, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'GET', headers });
}

function sessionCookie(res: Response): string {
  const setC = res.headers.get('set-cookie');
  if (!setC) throw new Error('no Set-Cookie header on response');
  const m = /ba_owner_session=([^;]+)/.exec(setC);
  if (!m) throw new Error(`ba_owner_session not found in: ${setC}`);
  return `ba_owner_session=${m[1]}`;
}

async function register(auth: Authenticator): Promise<void> {
  const beginRes = await post('/v1/owner/register/begin', { vault_public_key: auth.vaultB58 });
  expect(beginRes.status).toBe(200);
  const begin = (await beginRes.json()) as { options: { challenge: string } };
  const reg = auth.registration(begin.options.challenge);
  const finishRes = await post('/v1/owner/register/finish', {
    vault_public_key: auth.vaultB58,
    attestationObject: reg.attestationObject,
    clientDataJSON: reg.clientDataJSON,
  });
  expect(finishRes.status).toBe(200);
}

async function login(auth: Authenticator): Promise<string> {
  const beginRes = await post('/v1/owner/login/begin', { owner_id: auth.ownerId });
  const begin = (await beginRes.json()) as { challenge: string };
  const assertion = await auth.assert(begin.challenge, 1);
  const finishRes = await post('/v1/owner/login/finish', assertion);
  expect(finishRes.status).toBe(200);
  return sessionCookie(finishRes);
}

async function actionBegin(
  cookie: string,
  action_type: string,
  params: Record<string, unknown>,
): Promise<{ challenge: string; nonce: string }> {
  const res = await post('/v1/owner/action/begin', { action_type, params }, cookie);
  expect(res.status).toBe(200);
  const b = (await res.json()) as { challenge: string; nonce: string };
  return { challenge: b.challenge, nonce: b.nonce };
}

/** Delegate `agentId` to the owner via the full action ceremony. Returns next counter. */
async function delegate(auth: Authenticator, cookie: string, agentId: string, counter: number): Promise<void> {
  const a = await actionBegin(cookie, 'create_delegation', { agent_id: agentId, label: null });
  const res = await post(
    '/v1/owner/delegations',
    { agent_id: agentId, nonce: a.nonce, assertion: await auth.assert(a.challenge, counter) },
    cookie,
  );
  expect(res.status).toBe(200);
}

/** Bind the owner's vault key via the ceremony (needed before the daemon can auth). */
async function bindVault(auth: Authenticator, cookie: string, counter: number): Promise<void> {
  const a = await actionBegin(cookie, 'bind_vault_key', { vault_public_key: auth.vaultB58 });
  const res = await post(
    '/v1/owner/vault-binding',
    { vault_public_key: auth.vaultB58, nonce: a.nonce, assertion: await auth.assert(a.challenge, counter) },
    cookie,
  );
  expect(res.status).toBe(200);
}

async function createRequest(
  cookie: string,
  agentId: string,
  credentialId: string,
  constraints: GrantConstraints,
  extra?: Record<string, unknown>,
): Promise<string> {
  const res = await post(
    '/v1/owner/requests',
    { agent_id: agentId, credential_id: credentialId, constraints, ...extra },
    cookie,
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** Run the approve_grant ceremony end to end. Returns the raw Response. */
async function approve(
  auth: Authenticator,
  cookie: string,
  requestId: string,
  agent: TestAgent,
  credentialId: string,
  constraints: GrantConstraints,
  counter: number,
  overrides?: { armConstraints?: GrantConstraints; armPubkey?: string },
): Promise<Response> {
  const a = await actionBegin(cookie, 'approve_grant', {
    agent_id: agent.agentId,
    agent_pubkey: overrides?.armPubkey ?? agent.publicKeyB58,
    credential_id: credentialId,
    constraints: overrides?.armConstraints ?? constraints,
  });
  const assertion = await auth.assert(a.challenge, counter);
  return post(`/v1/owner/requests/${requestId}/approve`, { nonce: a.nonce, assertion }, cookie);
}

// ─── daemon request signing (AgentSig over the owner's Ed25519 vault key) ───

async function daemonHeaders(
  auth: Authenticator,
  method: string,
  path: string,
  body: string,
  opts?: { priv?: Uint8Array; b58?: string },
): Promise<Record<string, string>> {
  const ts = Math.floor(Date.now() / 1000);
  const bodyHash = bytesToHex(sha256(te.encode(body)));
  const message = `${method}:${path}:${ts}:${bodyHash}`;
  const sig = await ed.signAsync(te.encode(message), opts?.priv ?? auth.vaultPriv);
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return {
    Authorization: `AgentSig ${opts?.b58 ?? auth.vaultB58}:${btoa(bin)}`,
    'X-Timestamp': String(ts),
  };
}

async function daemonGet(auth: Authenticator, path: string): Promise<Response> {
  const headers = await daemonHeaders(auth, 'GET', path, '');
  return app.request(path, { method: 'GET', headers });
}

async function daemonPost(auth: Authenticator, path: string, bodyObj: unknown): Promise<Response> {
  const body = JSON.stringify(bodyObj);
  const headers = { ...(await daemonHeaders(auth, 'POST', path, body)), ...JSON_HEADERS };
  return app.request(path, { method: 'POST', headers, body });
}

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(
    `CREATE TABLE agents (
       id TEXT PRIMARY KEY, public_key BLOB, name TEXT,
       status TEXT NOT NULL DEFAULT 'active', registered_at TEXT
     );`,
  );
  rawDb.exec(SQL_0023);
  rawDb.exec(SQL_0024);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
  agentCounter = 0;
  app = buildApp();
});

// ─────────────────────────────────────────────────────────────────────────────
// HAPPY PATH — request → approve → grant_approval queued for the daemon
// ─────────────────────────────────────────────────────────────────────────────

describe('owner: request → approve queues a daemon-ready grant_approval', () => {
  it('files a request, approves it with a fresh assertion, and queues the approval', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agent = await makeAgent();
    await delegate(auth, cookie, agent.agentId, 2);

    const constraints: GrantConstraints = { max_uses: 5, max_lease_ttl_seconds: 600 };
    const reqId = await createRequest(cookie, agent.agentId, 'cred_stripe_1', constraints, {
      credential_label: 'Stripe', provider: 'stripe',
    });

    // GET /requests surfaces the pending request.
    const listRes = await get('/v1/owner/requests?status=pending', cookie);
    const list = (await listRes.json()) as { requests: Array<{ id: string; status: string }> };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].status).toBe('pending');

    const res = await approve(auth, cookie, reqId, agent, 'cred_stripe_1', constraints, 3);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { request: { status: string }; approval_id: string };
    expect(out.request.status).toBe('approved');
    expect(out.approval_id).toMatch(/^gap_/);

    // The queued approval pins the grantee pubkey + carries the assertion parts.
    const approval = await store.getGrantApproval(out.approval_id);
    expect(approval).not.toBeNull();
    expect(approval!.status).toBe('pending_daemon');
    expect(approval!.agent_pubkey).toBe(agent.publicKeyB58);
    expect(approval!.credential_id).toBe('cred_stripe_1');
    expect(approval!.assertion_credential_id).toBe(auth.credentialId);

    // The action_hash stored equals the canonical hash of exactly those fields.
    const expectedHash = grantApprovalHash({
      owner_id: auth.ownerId,
      nonce: approval!.nonce,
      agent_id: agent.agentId,
      agent_pubkey: agent.publicKeyB58,
      credential_id: 'cred_stripe_1',
      constraints,
    });
    expect(approval!.action_hash).toBe(expectedHash);

    // The owner authority chain recorded the approve_grant assertion and verifies.
    const chain = await store.verifyOwnerChain(auth.ownerId);
    expect(chain.ok).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SERVER-ARMED CEREMONY — /approve/begin (what the console calls)
// ─────────────────────────────────────────────────────────────────────────────

describe('owner: /approve/begin arms the exact grant-approval challenge', () => {
  it('arms a challenge the console can WYSIWYS-check, then /approve accepts the assertion over it', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agent = await makeAgent();
    await delegate(auth, cookie, agent.agentId, 2);

    const constraints: GrantConstraints = { max_uses: 5, max_lease_ttl_seconds: 600, project: 'acme' };
    const reqId = await createRequest(cookie, agent.agentId, 'cred_stripe_1', constraints, {
      credential_label: 'Stripe', provider: 'stripe',
    });

    // 1. The SERVER arms the challenge from the request's own stored data — the
    //    browser passes no params it could get wrong.
    const beginRes = await post(`/v1/owner/requests/${reqId}/approve/begin`, {}, cookie);
    expect(beginRes.status).toBe(200);
    const begin = (await beginRes.json()) as {
      challenge: string; nonce: string; action_canonical: string;
      agent_pubkey: string; allowCredentials: Array<{ id: string }>;
    };

    // 2. Client-side WYSIWYS: the challenge is exactly the hash of the canonical
    //    the console shows the human. The console refuses to sign if these differ.
    expect(base64urlEncode(sha256(te.encode(begin.action_canonical)))).toBe(begin.challenge);

    // 3. The armed challenge pins the grantee's on-file pubkey + the request's
    //    constraints — exactly what the daemon re-derives before it seals (§2.1).
    expect(begin.agent_pubkey).toBe(agent.publicKeyB58);
    expect(begin.challenge).toBe(
      grantApprovalHash({
        owner_id: auth.ownerId, nonce: begin.nonce, agent_id: agent.agentId,
        agent_pubkey: agent.publicKeyB58, credential_id: 'cred_stripe_1', constraints,
      }),
    );
    expect(begin.allowCredentials.map((a) => a.id)).toContain(auth.credentialId);

    // 4. Sign the server-armed challenge; approve echoes the SAME nonce.
    const assertion = await auth.assert(begin.challenge, 3);
    const res = await post(`/v1/owner/requests/${reqId}/approve`, { nonce: begin.nonce, assertion }, cookie);
    expect(res.status).toBe(200);
    const out = (await res.json()) as { request: { status: string }; approval_id: string };
    expect(out.request.status).toBe('approved');

    // 5. The queued approval's action_hash IS the armed challenge.
    const approval = await store.getGrantApproval(out.approval_id);
    expect(approval!.action_hash).toBe(begin.challenge);
    expect(approval!.status).toBe('pending_daemon');

    // 6. Re-arming a now-decided request is refused.
    const beginAgain = await post(`/v1/owner/requests/${reqId}/approve/begin`, {}, cookie);
    expect(beginAgain.status).toBe(400);
  });

  it('404s a begin for a request the caller does not own', async () => {
    const a1 = await Authenticator.create();
    await register(a1);
    const c1 = await login(a1);
    const res = await post('/v1/owner/requests/req_does_not_exist/approve/begin', {}, c1);
    expect(res.status).toBe(404);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// INTEROP — the whole point of the increment
// ─────────────────────────────────────────────────────────────────────────────

describe('interop: control plane and @basedagents/keyring agree on the contract', () => {
  it('(a) grantApprovalCanonical/Hash are BYTE-IDENTICAL across both packages', () => {
    // A spread of vectors, including constraint-normalization edge cases.
    const vectors: Array<{
      owner_id: string; nonce: string; agent_id: string; agent_pubkey: string;
      credential_id: string; constraints: GrantConstraints;
    }> = [
      {
        owner_id: 'ow_2b3c4d', nonce: 'nonce-1', agent_id: 'ag_9x8y7z', agent_pubkey: 'PubKeyBase58AAA',
        credential_id: 'cred_1', constraints: {},
      },
      {
        owner_id: 'ow_owner', nonce: 'N-2', agent_id: 'ag_grantee', agent_pubkey: 'PubB',
        credential_id: 'cred_stripe', constraints: { max_uses: 5, max_lease_ttl_seconds: 600 },
      },
      {
        owner_id: 'ow_owner', nonce: 'N-3', agent_id: 'ag_grantee', agent_pubkey: 'PubB',
        credential_id: 'cred_gh',
        constraints: { expires_at: '2026-12-31T23:59:59.000Z', max_uses: 1, max_lease_ttl_seconds: 30, project: 'acme' },
      },
      {
        // Extra keys on the input object MUST be dropped identically by both sides.
        owner_id: 'ow_owner', nonce: 'N-4', agent_id: 'ag_grantee', agent_pubkey: 'PubB',
        credential_id: 'cred_x',
        constraints: { project: 'p', bogus: 'DROP_ME', max_uses: undefined } as GrantConstraints,
      },
    ];
    for (const v of vectors) {
      expect(grantApprovalCanonical(v)).toBe(keyringCanonical(v));
      expect(grantApprovalHash(v)).toBe(keyringHash(v));
    }
  });

  it('(b) the console-produced assertion is accepted by keyring (verifyOwnerAssertion + applyApprovedGrant)', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agent = await makeAgent();
    await delegate(auth, cookie, agent.agentId, 2);

    const constraints: GrantConstraints = { max_uses: 5, max_lease_ttl_seconds: 600 };
    const reqId = await createRequest(cookie, agent.agentId, 'cred_stripe_1', constraints);
    const res = await approve(auth, cookie, reqId, agent, 'cred_stripe_1', constraints, 3);
    expect(res.status).toBe(200);
    const { approval_id } = (await res.json()) as { approval_id: string };
    const approval = (await store.getGrantApproval(approval_id))!;

    // (b.1) The daemon's PURE verifier accepts the exact bytes the console stored,
    // against the console's own action_hash, using the passkey's anchored key.
    expect(() =>
      verifyOwnerAssertion({
        publicKeyHex: auth.rawPublicKeyHex,
        authenticatorData: approval.authenticator_data,
        clientDataJSON: approval.client_data_json,
        signature: approval.signature,
        expectedChallenge: approval.action_hash,
        expectedOrigins: [ORIGIN],
        expectedRPID: RP_ID,
      }),
    ).not.toThrow();

    // (b.2) FULL daemon apply path: a real vault owned by the SAME Ed25519 key,
    // the SAME passkey anchored, applying an approval that same passkey signed
    // over the canonical using the CONTROL-PLANE owner-id form (ow_<base58(pub)>)
    // — exactly what the console produces and what applyApprovedGrant re-derives.
    // The grant becomes active and the grantee can actually lease — proving the re-seal.
    const dir = mkdtempSync(join(tmpdir(), 'keyring-interop-'));
    try {
      const kr = await Keyring.init({
        dir,
        ownerKeypair: { publicKey: auth.vaultPub, privateKey: auth.vaultPriv },
      });
      const owner = kr.ownerKeypair();
      await kr.anchorOwnerPasskey(owner, {
        credentialId: auth.credentialId,
        publicKeyHex: auth.rawPublicKeyHex,
        rpId: RP_ID,
        origins: [ORIGIN],
      });
      const credId = (await kr.addCredential(owner, { label: 'Stripe', env_var: 'STRIPE' }, 'sk_secret_value'))
        .credential_id;

      const grantee = await keyringGenerateKeypair();
      const granteeId = keyringAgentId(grantee.publicKey);
      const granteePubkey = keyringB58(grantee.publicKey);
      const applyConstraints: GrantConstraints = { max_uses: 5, max_lease_ttl_seconds: 600 };
      const nonce = 'interop-apply-nonce';

      // Parity for the ACTUAL apply vector, then a genuine passkey signature over it.
      const daemonStmt = {
        owner_id: `ow_${kr.vault().owner.public_key_b58}`, // control-plane owner id — what the console signs
        nonce,
        agent_id: granteeId,
        agent_pubkey: granteePubkey,
        credential_id: credId,
        constraints: applyConstraints,
      };
      const controlPlaneHash = grantApprovalHash(daemonStmt);
      const keyringActionHash = keyringHash(daemonStmt);
      expect(controlPlaneHash).toBe(keyringActionHash);

      const assertion = await auth.assert(keyringActionHash, 7);
      const grant = await kr.applyApprovedGrant({
        nonce,
        credential_id: credId,
        agent_id: granteeId,
        constraints: applyConstraints,
        assertion,
      });
      expect(grant.status).toBe('active');
      expect(grant.agent_id).toBe(granteeId);

      const lease = await kr.lease(grantee, credId);
      expect(lease.value).toBe('sk_secret_value');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ADVERSARIAL — owner side
// ─────────────────────────────────────────────────────────────────────────────

describe('adversarial (owner): approve binding + request lifecycle', () => {
  it('rejects a request for an agent not delegated to this owner', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agent = await makeAgent(); // exists, but NOT delegated

    const res = await post(
      '/v1/owner/requests',
      { agent_id: agent.agentId, credential_id: 'cred_1', constraints: {} },
      cookie,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/not delegated/);
  });

  it('rejects an approve whose ARMED constraints differ from the request (WYSIWYS)', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agent = await makeAgent();
    await delegate(auth, cookie, agent.agentId, 2);

    const constraints: GrantConstraints = { max_uses: 5 };
    const reqId = await createRequest(cookie, agent.agentId, 'cred_1', constraints);

    // The owner is tricked into arming a DIFFERENT max_uses. The server rebuilds
    // the canonical from the REQUEST's constraints, so the signed hash won't match.
    const res = await approve(auth, cookie, reqId, agent, 'cred_1', constraints, 3, {
      armConstraints: { max_uses: 999 },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/does not authorize this action/);

    // Nothing was queued; the request is still pending.
    const req = await store.getKeyringRequest(reqId);
    expect(req!.status).toBe('pending');
    expect(await store.listPendingApprovals(auth.ownerId)).toHaveLength(0);
  });

  it('rejects an approve on an already-decided (denied) request', async () => {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    const agent = await makeAgent();
    await delegate(auth, cookie, agent.agentId, 2);
    const reqId = await createRequest(cookie, agent.agentId, 'cred_1', {});

    const denyRes = await post(`/v1/owner/requests/${reqId}/deny`, { reason: 'not now' }, cookie);
    expect(denyRes.status).toBe(200);
    expect(((await denyRes.json()) as { status: string }).status).toBe('denied');

    const res = await approve(auth, cookie, reqId, agent, 'cred_1', {}, 3);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/already denied/);
  });

  it('rejects reads/writes without a session cookie', async () => {
    expect((await get('/v1/owner/requests')).status).toBe(401);
    const res = await post('/v1/owner/requests', { agent_id: 'ag_x', credential_id: 'c', constraints: {} });
    expect(res.status).toBe(401);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DAEMON — pull + confirm loop, daemonAuth
// ─────────────────────────────────────────────────────────────────────────────

describe('daemon: pull, confirm, and daemonAuth', () => {
  const APPROVALS = '/v1/owner/daemon/approvals';

  /** Full owner setup: register, login, bind vault, delegate, request, approve. */
  async function seedApproval(): Promise<{ auth: Authenticator; approvalId: string; agent: TestAgent }> {
    const auth = await Authenticator.create();
    await register(auth);
    const cookie = await login(auth);
    await bindVault(auth, cookie, 2);
    const agent = await makeAgent();
    await delegate(auth, cookie, agent.agentId, 3);
    const constraints: GrantConstraints = { max_uses: 3 };
    const reqId = await createRequest(cookie, agent.agentId, 'cred_daemon', constraints);
    const res = await approve(auth, cookie, reqId, agent, 'cred_daemon', constraints, 4);
    expect(res.status).toBe(200);
    const { approval_id } = (await res.json()) as { approval_id: string };
    return { auth, approvalId: approval_id, agent };
  }

  it('pulls pending_daemon approvals shaped as keyring GrantApproval, then confirm removes them', async () => {
    const { auth, approvalId, agent } = await seedApproval();

    const pullRes = await daemonGet(auth, APPROVALS);
    expect(pullRes.status).toBe(200);
    const pulled = (await pullRes.json()) as {
      approvals: Array<{
        id: string; nonce: string; credential_id: string; agent_id: string;
        constraints: GrantConstraints;
        assertion: { credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string };
      }>;
    };
    expect(pulled.approvals).toHaveLength(1);
    const gp = pulled.approvals[0];
    expect(gp.id).toBe(approvalId);
    expect(gp.credential_id).toBe('cred_daemon');
    expect(gp.agent_id).toBe(agent.agentId);
    expect(gp.constraints).toEqual({ max_uses: 3 });
    // Shaped exactly as keyring's GrantApproval.assertion so the daemon applies it.
    expect(gp.assertion.credentialId).toBe(auth.credentialId);
    expect(gp.assertion.authenticatorData).toBeTruthy();
    expect(gp.assertion.clientDataJSON).toBeTruthy();
    expect(gp.assertion.signature).toBeTruthy();

    // Confirm with the daemon-reported grant id.
    const confRes = await daemonPost(auth, `${APPROVALS}/${approvalId}/confirm`, { daemon_grant_id: 'grant_abc123' });
    expect(confRes.status).toBe(200);
    expect(((await confRes.json()) as { status: string }).status).toBe('confirmed');
    expect((await store.getGrantApproval(approvalId))!.daemon_grant_id).toBe('grant_abc123');

    // Only pending_daemon rows are pulled — the confirmed one is gone.
    const pull2 = await daemonGet(auth, APPROVALS);
    expect(((await pull2.json()) as { approvals: unknown[] }).approvals).toHaveLength(0);
  });

  it('records a daemon-reported failure', async () => {
    const { auth, approvalId } = await seedApproval();
    const res = await daemonPost(auth, `${APPROVALS}/${approvalId}/confirm`, { error: 'credential missing in vault' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('failed');
    expect((await store.getGrantApproval(approvalId))!.failure_reason).toBe('credential missing in vault');
  });

  it('daemonAuth rejects a bad signature (401)', async () => {
    const { auth } = await seedApproval();
    // Correctly-formed header but the signature is over a DIFFERENT path.
    const headers = await daemonHeaders(auth, 'GET', '/v1/owner/daemon/WRONG', '');
    const res = await app.request(APPROVALS, { method: 'GET', headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/invalid signature/);
  });

  it('daemonAuth rejects a valid Ed25519 key that is not bound as a vault key (401)', async () => {
    await seedApproval(); // owner exists & bound, but we sign with a STRANGER key
    const strangerPriv = ed.utils.randomPrivateKey();
    const strangerPub = await ed.getPublicKeyAsync(strangerPriv);
    const strangerB58 = base58Encode(strangerPub);
    const auth = await Authenticator.create(); // only used to satisfy the helper signature
    const headers = await daemonHeaders(auth, 'GET', APPROVALS, '', { priv: strangerPriv, b58: strangerB58 });
    const res = await app.request(APPROVALS, { method: 'GET', headers });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { message: string }).message).toMatch(/not bound/);
  });

  it('daemonAuth rejects a missing Authorization header (401)', async () => {
    const res = await app.request(APPROVALS, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('only the OWNING owner may confirm an approval', async () => {
    const { approvalId } = await seedApproval();

    // A second, fully-set-up owner (different vault key) tries to confirm the first's approval.
    const other = await Authenticator.create();
    await register(other);
    const otherCookie = await login(other);
    await bindVault(other, otherCookie, 2);

    const res = await daemonPost(other, `${APPROVALS}/${approvalId}/confirm`, { daemon_grant_id: 'x' });
    expect(res.status).toBe(404);
    // The approval is untouched.
    expect((await store.getGrantApproval(approvalId))!.status).toBe('pending_daemon');
  });
});
