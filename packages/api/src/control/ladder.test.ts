/**
 * Authority-ladder tests (spec v0.2 §5.1 + onboarding redesign).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * The properties under test:
 *   - the claim (magic-link click) ratifies owner + delegation + vault binding
 *     in one atomic-per-step sequence, and mints a LOOK session (method=email);
 *   - link codes and magic-link tokens are single-use and expire;
 *   - pre-passkey accounts can look but CANNOT act: no approval can complete
 *     without a stored passkey (the first approval mints it — proven here at
 *     the API level, in the browser by E2E scenario 3);
 *   - claim-pending invites hold NOTHING structurally: no owner row exists
 *     until a human claims a link code; invite spam is braked;
 *   - connect-card secrets exist server-side only as browser-sealed
 *     ciphertext, are never echoed back to the browser, and are blanked once
 *     the daemon stores them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import * as ed from '@noble/ed25519';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import { base58Encode, sha256, bytesToHex } from '../crypto/index.js';
import { base64urlEncode, base64urlDecode } from './webauthn.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { ControlStore } from './store.js';
import type { EmailMessage } from './email.js';
import ownerRoutes from './routes.js';
import approvalRoutes from './approvals.js';
import ladderRoutes from './ladder.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const SQL = [
  '0023_owner_accounts.sql',
  '0024_keyring_approvals.sql',
  '0025_owner_recovery.sql',
  '0026_owner_billing.sql',
  '0027_authority_ladder.sql',
].map((f) => readFileSync(join(MIGRATIONS, f), 'utf-8'));

const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';

// ─── byte helpers (mirrors recovery.test.ts) ───

type CborType = Parameters<typeof isoCBOR.encode>[0];

function concat(...arrs: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}

function u32be(n: number): Uint8Array<ArrayBuffer> {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]);
}

function rawToDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const enc = (part: Uint8Array): number[] => {
    let i = 0;
    while (i < part.length - 1 && part[i] === 0) i++;
    const body = part[i] & 0x80 ? [0, ...Array.from(part.slice(i))] : Array.from(part.slice(i));
    return [0x02, body.length, ...body];
  };
  const r = enc(raw.slice(0, 32));
  const s = enc(raw.slice(32));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

async function signDer(privateKey: CryptoKey, message: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  const raw = await globalThis.crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, message);
  return rawToDer(new Uint8Array(raw));
}

class Authenticator {
  private constructor(
    private privateKey: CryptoKey,
    readonly cose: Uint8Array,
    readonly credentialId: string,
  ) {}

  static async create(): Promise<Authenticator> {
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, base64urlDecode(jwk.x!)], [-3, base64urlDecode(jwk.y!)]]) as CborType,
    );
    const rawId = new Uint8Array(16);
    globalThis.crypto.getRandomValues(rawId);
    return new Authenticator(kp.privateKey, cose, base64urlEncode(rawId));
  }

  registration(challenge: string): { attestationObject: string; clientDataJSON: string } {
    const rpIdHash = sha256(te.encode(RP_ID));
    const credIdBytes = base64urlDecode(this.credentialId);
    const credIdLen = new Uint8Array([(credIdBytes.length >> 8) & 0xff, credIdBytes.length & 0xff]);
    const attested = concat(new Uint8Array(16), credIdLen, credIdBytes, this.cose);
    const authData = concat(rpIdHash, new Uint8Array([0x5d]), u32be(0), attested);
    const attestationObject = isoCBOR.encode(
      new Map<string, CborType>([['fmt', 'none'], ['attStmt', new Map<string, CborType>()], ['authData', authData]]) as CborType,
    );
    const clientDataJSON = JSON.stringify({ type: 'webauthn.create', challenge, origin: ORIGIN, crossOrigin: false });
    return { attestationObject: base64urlEncode(attestationObject), clientDataJSON: base64urlEncode(te.encode(clientDataJSON)) };
  }

  async assert(challenge: string, counter: number) {
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
let sentEmails: EmailMessage[];

function buildApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    (c.set as (k: string, v: unknown) => void)('emailSender', {
      send: async (m: EmailMessage) => { sentEmails.push(m); },
    });
    await next();
  });
  a.route('/v1/owner', ownerRoutes);
  a.route('/v1/owner', approvalRoutes);
  a.route('/v1/owner', ladderRoutes);
  return a;
}

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  // Real-shape agents table: ensureAgent inserts the NOT NULL registry columns.
  rawDb.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    public_key BLOB NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    capabilities TEXT NOT NULL,
    protocols TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    registered_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE used_signatures (
    signature_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  );`);
  for (const sql of SQL) rawDb.exec(sql);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
  sentEmails = [];
  app = buildApp();
});

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}

async function get(path: string, cookie?: string): Promise<Response> {
  return app.request(path, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} });
}

function sessionCookie(res: Response): string {
  const m = /ba_owner_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no session cookie');
  return `ba_owner_session=${m[1]}`;
}

function lastMagicToken(): string {
  const last = sentEmails[sentEmails.length - 1];
  const m = /#t=([A-Za-z0-9_-]+)/.exec(last?.text ?? '');
  if (!m) throw new Error('no magic token in last email');
  return m[1];
}

/** A fresh vault + agent keypair pair, as `keyring init` would produce. */
async function newInitIdentity() {
  const vaultPriv = ed.utils.randomPrivateKey();
  const vaultPub = await ed.getPublicKeyAsync(vaultPriv);
  const agentPriv = ed.utils.randomPrivateKey();
  const agentPub = await ed.getPublicKeyAsync(agentPriv);
  return {
    vaultPriv,
    vaultPub,
    vaultB58: base58Encode(vaultPub),
    ownerId: ownerIdFromVaultPubkey(vaultPub),
    agentB58: base58Encode(agentPub),
    agentId: `ag_${base58Encode(agentPub)}`,
    agentPriv,
  };
}

/** Run init → link → claim end to end; returns the claimed session + ids. */
async function claimFlow(email: string, agentName = 'Claude Code @ testbox') {
  const idn = await newInitIdentity();
  const linkRes = await post('/v1/owner/link', {
    vault_public_key: idn.vaultB58,
    agent_id: idn.agentId,
    agent_public_key: idn.agentB58,
    agent_name: agentName,
  });
  expect(linkRes.status).toBe(200);
  const { code } = (await linkRes.json()) as { code: string };
  expect((await post(`/v1/owner/link/${code}/claim`, { email })).status).toBe(200);
  const token = lastMagicToken();
  const finishRes = await post('/v1/owner/claim/finish', { token });
  expect(finishRes.status).toBe(200);
  return { ...idn, code, cookie: sessionCookie(finishRes), finish: (await finishRes.json()) as Record<string, unknown> };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('the claim: one email field ratifies owner + delegation + binding', () => {
  it('claims end to end and mints an email look-session', async () => {
    const { ownerId, agentId, cookie, finish, code } = await claimFlow('novice@example.com');

    expect(finish.owner_id).toBe(ownerId);
    expect(finish.agent_id).toBe(agentId);
    expect(finish.delegation_blocked).toBeNull();

    // Owner exists with the claim-verified email.
    const owner = await store.getOwner(ownerId);
    expect(owner!.email).toBe('novice@example.com');
    expect(owner!.email_verified).toBe(1);

    // Delegation active, provenance 'claim' (no assertion — pre-passkey).
    const delegation = await store.getDelegation(ownerId, agentId);
    expect(delegation!.status).toBe('active');
    expect(delegation!.authorized_via).toBe('claim');
    expect(delegation!.authorizing_assertion_id).toBeNull();

    // Vault binding active → the daemon can authenticate immediately.
    expect((await store.getActiveVaultKey(ownerId))!.vault_public_key).toBe(ownerId.slice(3));

    // The session looks (method=email, no passkey yet).
    const me = (await (await get('/v1/owner/me', cookie)).json()) as Record<string, unknown>;
    expect(me.owner_id).toBe(ownerId);
    expect(me.session_method).toBe('email');
    expect(me.has_passkey).toBe(false);

    // Link is spent.
    const status = (await (await get(`/v1/owner/link/${code}`)).json()) as { status: string };
    expect(status.status).toBe('claimed');
  });

  it('magic-link tokens and link codes are single-use; expiry closes both', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', {
      vault_public_key: idn.vaultB58, agent_id: idn.agentId, agent_public_key: idn.agentB58,
    })).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'x@example.com' });
    const token = lastMagicToken();

    // Mint a SECOND still-valid token for the same link before finishing.
    await post(`/v1/owner/link/${code}/claim`, { email: 'x@example.com' });
    const token2 = lastMagicToken();

    expect((await post('/v1/owner/claim/finish', { token })).status).toBe(200);
    expect((await post('/v1/owner/claim/finish', { token })).status).toBe(401); // token replay

    // The second token is valid but the LINK is spent → 409 (atomic claim).
    expect((await post('/v1/owner/claim/finish', { token: token2 })).status).toBe(409);

    // Expired link codes answer expired/404.
    const idn2 = await newInitIdentity();
    const { code: code2 } = (await (await post('/v1/owner/link', {
      vault_public_key: idn2.vaultB58, agent_id: idn2.agentId, agent_public_key: idn2.agentB58,
    })).json()) as { code: string };
    rawDb.prepare(`UPDATE link_codes SET expires_at = ? WHERE code = ?`)
      .run(new Date(Date.now() - 1000).toISOString(), code2);
    expect(((await (await get(`/v1/owner/link/${code2}`)).json()) as { status: string }).status).toBe('expired');
    expect((await post(`/v1/owner/link/${code2}/claim`, { email: 'y@example.com' })).status).toBe(404);
  });

  it('rejects a link whose agent_id does not match the agent key', async () => {
    const idn = await newInitIdentity();
    const res = await post('/v1/owner/link', {
      vault_public_key: idn.vaultB58,
      agent_id: 'ag_SomebodyElse',
      agent_public_key: idn.agentB58,
    });
    expect(res.status).toBe(400);
  });

  it('re-claiming with a new agent adds a delegation to the existing owner', async () => {
    const first = await claimFlow('same@example.com');
    // Same vault, second agent (a second machine/agent linking to one account).
    const agentPriv = ed.utils.randomPrivateKey();
    const agentPub = await ed.getPublicKeyAsync(agentPriv);
    const agent2 = `ag_${base58Encode(agentPub)}`;
    const { code } = (await (await post('/v1/owner/link', {
      vault_public_key: first.vaultB58, agent_id: agent2, agent_public_key: base58Encode(agentPub),
      agent_name: 'CI bot',
    })).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'same@example.com' });
    expect((await post('/v1/owner/claim/finish', { token: lastMagicToken() })).status).toBe(200);
    expect(await store.countActiveDelegations(first.ownerId)).toBe(2);
  });
});

describe('pre-passkey accounts LOOK but cannot ACT', () => {
  it('no approval can complete without a passkey; registering one unlocks the act rung', async () => {
    const { ownerId, agentId, cookie, vaultB58 } = await claimFlow('actless@example.com');

    // File a request (session action — allowed on the email rung).
    const reqRes = await post('/v1/owner/requests', { agent_id: agentId, credential_id: 'cred_vercel' }, cookie);
    expect(reqRes.status).toBe(200);
    const reqId = ((await reqRes.json()) as { id: string }).id;

    // approve/begin arms, but offers NO credentials to sign with…
    const begin = (await (await post(`/v1/owner/requests/${reqId}/approve/begin`, {}, cookie)).json()) as {
      challenge: string; nonce: string; allowCredentials: Array<{ id: string }>;
    };
    expect(begin.allowCredentials).toHaveLength(0);

    // …and a forged assertion is rejected: nothing acts without a passkey.
    const forged = await (await Authenticator.create()).assert(begin.challenge, 1);
    const approveRes = await post(`/v1/owner/requests/${reqId}/approve`, { nonce: begin.nonce, assertion: forged }, cookie);
    expect(approveRes.status).toBe(401);

    // FIRST APPROVAL MINTS: register the passkey under the email session…
    const auth = await Authenticator.create();
    const regBegin = (await (await post('/v1/owner/register/begin', { vault_public_key: vaultB58 })).json()) as {
      options: { challenge: string };
    };
    const reg = auth.registration(regBegin.options.challenge);
    expect((await post('/v1/owner/register/finish', {
      vault_public_key: vaultB58,
      attestationObject: reg.attestationObject,
      clientDataJSON: reg.clientDataJSON,
    })).status).toBe(200);

    // …then the SAME pending request approves with a fresh assertion.
    const begin2 = (await (await post(`/v1/owner/requests/${reqId}/approve/begin`, {}, cookie)).json()) as {
      challenge: string; nonce: string; allowCredentials: Array<{ id: string }>;
    };
    expect(begin2.allowCredentials).toHaveLength(1);
    const assertion = await auth.assert(begin2.challenge, 1);
    const ok = await post(`/v1/owner/requests/${reqId}/approve`, { nonce: begin2.nonce, assertion }, cookie);
    expect(ok.status).toBe(200);

    // The stored approval's signature chain is intact (owner chain verifies).
    expect((await store.verifyOwnerChain(ownerId)).ok).toBe(true);
  });
});

describe('email login (the look rung, returning users)', () => {
  it('logs in via magic link; unknown emails answer uniformly and send nothing', async () => {
    await claimFlow('returning@example.com');
    sentEmails = [];

    expect((await post('/v1/owner/login/email', { email: 'returning@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const finish = await post('/v1/owner/login/email/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    const me = (await (await get('/v1/owner/me', sessionCookie(finish))).json()) as Record<string, unknown>;
    expect(me.session_method).toBe('email');

    sentEmails = [];
    expect((await post('/v1/owner/login/email', { email: 'nobody@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(0);
  });
});

describe('agent-first invites: claim-pending is structurally nothing', () => {
  async function makeRegisteredAgent() {
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const agentId = `ag_${base58Encode(pub)}`;
    rawDb.prepare(
      `INSERT INTO agents (id, public_key, name, description, capabilities, protocols, status)
       VALUES (?, ?, 'Claude Code @ MacBook', 'test', '[]', '["mcp"]', 'active')`,
    ).run(agentId, Buffer.from(pub));
    return { agentId, priv, pub };
  }

  let nonceCounter = 0;
  async function agentPost(agent: { priv: Uint8Array; pub: Uint8Array }, path: string, bodyObj: unknown): Promise<Response> {
    const body = JSON.stringify(bodyObj);
    const ts = Math.floor(Date.now() / 1000);
    // X-Nonce makes each signature unique — without it, two identical calls in
    // the same second collide with agentAuth's used_signatures replay guard.
    const nonce = `test-nonce-${++nonceCounter}`;
    const bodyHash = bytesToHex(sha256(te.encode(body)));
    const message = `POST:${path}:${ts}:${bodyHash}:${nonce}`;
    const sig = await ed.signAsync(te.encode(message), agent.priv);
    let bin = '';
    for (const b of sig) bin += String.fromCharCode(b);
    return app.request(path, {
      method: 'POST',
      headers: {
        ...JSON_HEADERS,
        Authorization: `AgentSig ${base58Encode(agent.pub)}:${btoa(bin)}`,
        'X-Timestamp': String(ts),
        'X-Nonce': nonce,
      },
      body,
    });
  }

  it('invites, brakes, and never creates an account by itself', async () => {
    const agent = await makeRegisteredAgent();

    const res = await agentPost(agent, '/v1/owner/invites', { email: 'human@example.com' });
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].subject).toContain('wants you as its owner');

    // CLAIM-PENDING = NOTHING: no owner row exists for this email.
    expect(await store.getOwnerByEmail('human@example.com')).toBeNull();

    // Immediate re-send → backoff 429.
    expect((await agentPost(agent, '/v1/owner/invites', { email: 'human@example.com' })).status).toBe(429);

    // Invite claim verifies the email and points at init — still NO account.
    const claim = await post('/v1/owner/invites/claim', { token: lastMagicToken() });
    expect(claim.status).toBe(200);
    expect(((await claim.json()) as { next_step: string }).next_step).toContain('setup command');
    expect(await store.getOwnerByEmail('human@example.com')).toBeNull();

    // Daily cap across distinct emails.
    expect((await agentPost(agent, '/v1/owner/invites', { email: 'h2@example.com' })).status).toBe(200);
    expect((await agentPost(agent, '/v1/owner/invites', { email: 'h3@example.com' })).status).toBe(200);
    expect((await agentPost(agent, '/v1/owner/invites', { email: 'h4@example.com' })).status).toBe(429);
  });

  it('unauthenticated invite attempts are rejected', async () => {
    expect((await post('/v1/owner/invites', { email: 'x@example.com' })).status).toBe(401);
  });
});

describe('connect cards: sealed in the browser, resolved by the daemon', () => {
  async function daemonRequest(
    idn: { vaultPriv: Uint8Array; vaultPub: Uint8Array },
    method: string,
    path: string,
    bodyObj?: unknown,
  ): Promise<Response> {
    const body = bodyObj === undefined ? '' : JSON.stringify(bodyObj);
    const ts = Math.floor(Date.now() / 1000);
    const bodyHash = bytesToHex(sha256(te.encode(body)));
    const message = `${method}:${path}:${ts}:${bodyHash}`;
    const sig = await ed.signAsync(te.encode(message), idn.vaultPriv);
    let bin = '';
    for (const b of sig) bin += String.fromCharCode(b);
    const headers: Record<string, string> = {
      Authorization: `AgentSig ${base58Encode(idn.vaultPub)}:${btoa(bin)}`,
      'X-Timestamp': String(ts),
    };
    if (bodyObj !== undefined) Object.assign(headers, JSON_HEADERS);
    return app.request(path, { method, headers, body: bodyObj === undefined ? undefined : body });
  }

  it('stores ciphertext, hides it from the browser, hands it to the daemon, blanks on store', async () => {
    const idn = await newInitIdentity();
    // Claim with THIS identity so the daemon (vault key) can authenticate.
    const { code } = (await (await post('/v1/owner/link', {
      vault_public_key: idn.vaultB58, agent_id: idn.agentId, agent_public_key: idn.agentB58, agent_name: 'CC',
    })).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'seal@example.com' });
    const finish = await post('/v1/owner/claim/finish', { token: lastMagicToken() });
    const cookie = sessionCookie(finish);

    const create = await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'vercel', label: 'Vercel', env_var: 'VERCEL_TOKEN',
      sealed_secret: 'AAAA-not-a-real-secret-just-ciphertext-AAAA',
    }, cookie);
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };

    // Browser polling NEVER sees ciphertext.
    const listed = (await (await get('/v1/owner/connections', cookie)).json()) as { connections: Array<Record<string, unknown>> };
    expect(listed.connections).toHaveLength(1);
    expect(listed.connections[0].sealed_secret).toBeUndefined();
    expect(listed.connections[0].status).toBe('pending');

    // The daemon pulls the ciphertext over its vault-key channel (the binding
    // created at claim time is what lets it authenticate at all)…
    const pull = await daemonRequest(idn, 'GET', '/v1/owner/daemon/connections');
    expect(pull.status).toBe(200);
    const pulled = (await pull.json()) as { connections: Array<Record<string, unknown>> };
    expect(pulled.connections).toHaveLength(1);
    expect(pulled.connections[0].sealed_secret).toBe('AAAA-not-a-real-secret-just-ciphertext-AAAA');

    // …resolves it as stored…
    const resolve = await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/resolve`, {
      daemon_credential_id: 'cred_local_1',
    });
    expect(resolve.status).toBe(200);

    // …the card flips, the ciphertext is BLANKED at rest, re-resolve 404s.
    const after = (await (await get('/v1/owner/connections', cookie)).json()) as { connections: Array<Record<string, unknown>> };
    expect(after.connections[0].status).toBe('stored');
    const raw = rawDb.prepare(`SELECT sealed_secret FROM pending_connections WHERE id = ?`).get(id) as { sealed_secret: string };
    expect(raw.sealed_secret).toBe('');
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/resolve`, { error: 'again' })).status).toBe(404);
  });

  it('rejects a connection for an agent the owner has not claimed', async () => {
    const { cookie } = await claimFlow('other@example.com');
    const res = await post('/v1/owner/connections', {
      agent_id: 'ag_SomeStranger', provider: 'vercel', sealed_secret: 'AAAA',
    }, cookie);
    expect(res.status).toBe(400);
  });
});
