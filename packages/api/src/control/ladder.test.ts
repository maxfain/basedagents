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
  '0029_provision_connections.sql',
  '0030_cloud_passport.sql',
  '0031_credential_facts.sql',
  '0032_daemon_kill_confirm.sql',
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

/** The vault-key proof-of-possession the /link route now requires (base64). */
async function vaultSig(vaultPriv: Uint8Array, vaultB58: string, agentId: string, agentB58: string): Promise<string> {
  const canonical = `keyring-link:v1:${vaultB58}:${agentId}:${agentB58}`;
  const sig = await ed.signAsync(te.encode(canonical), vaultPriv);
  let bin = '';
  for (const b of sig) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Build a signed /link body from an init identity (optionally a second agent). */
async function linkBody(
  idn: { vaultPriv: Uint8Array; vaultB58: string; agentId: string; agentB58: string },
  agentName?: string,
) {
  return {
    vault_public_key: idn.vaultB58,
    agent_id: idn.agentId,
    agent_public_key: idn.agentB58,
    ...(agentName ? { agent_name: agentName } : {}),
    vault_signature: await vaultSig(idn.vaultPriv, idn.vaultB58, idn.agentId, idn.agentB58),
  };
}

/** Run init → link → claim end to end; returns the claimed session + ids. */
async function claimFlow(email: string, agentName = 'Claude Code @ testbox') {
  const idn = await newInitIdentity();
  const linkRes = await post('/v1/owner/link', await linkBody(idn, agentName));
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
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn))).json()) as { code: string };
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
    const { code: code2 } = (await (await post('/v1/owner/link', await linkBody(idn2))).json()) as { code: string };
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
      vault_signature: await vaultSig(idn.vaultPriv, idn.vaultB58, 'ag_SomebodyElse', idn.agentB58),
    });
    expect(res.status).toBe(400); // agent_id/key mismatch is checked before the signature
  });

  it('re-claiming with a new agent adds a delegation to the existing owner', async () => {
    const first = await claimFlow('same@example.com');
    // Same vault, second agent (a second machine/agent linking to one account).
    const agentPriv = ed.utils.randomPrivateKey();
    const agentPub = await ed.getPublicKeyAsync(agentPriv);
    const agent2 = `ag_${base58Encode(agentPub)}`;
    const { code } = (await (await post('/v1/owner/link', await linkBody(
      { vaultPriv: first.vaultPriv, vaultB58: first.vaultB58, agentId: agent2, agentB58: base58Encode(agentPub) },
      'CI bot',
    ))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'same@example.com' });
    expect((await post('/v1/owner/claim/finish', { token: lastMagicToken() })).status).toBe(200);
    expect(await store.countActiveDelegations(first.ownerId)).toBe(2);
  });

  it('/link requires proof of the vault private key (account-takeover guard)', async () => {
    const idn = await newInitIdentity();
    // Missing signature → schema rejects.
    expect((await post('/v1/owner/link', {
      vault_public_key: idn.vaultB58, agent_id: idn.agentId, agent_public_key: idn.agentB58,
    })).status).toBe(400);
    // Present but signed by the WRONG (attacker's) key → 401. This is the exact
    // takeover attempt: an attacker who knows a victim's public vault key but
    // not the private key cannot mint a link code for it.
    const attacker = await newInitIdentity();
    expect((await post('/v1/owner/link', {
      vault_public_key: idn.vaultB58,
      agent_id: idn.agentId,
      agent_public_key: idn.agentB58,
      vault_signature: await vaultSig(attacker.vaultPriv, idn.vaultB58, idn.agentId, idn.agentB58),
    })).status).toBe(401);
  });

  it('an existing account can only be re-claimed by its own verified email — at BOTH layers', async () => {
    const first = await claimFlow('owner-a@example.com');
    // Same vault, a fresh agent, but the claim email is a DIFFERENT person.
    const other = await newInitIdentity();
    const link = (await (await post('/v1/owner/link', await linkBody(
      { vaultPriv: first.vaultPriv, vaultB58: first.vaultB58, agentId: other.agentId, agentB58: other.agentB58 },
    ))).json()) as { code: string };

    // Layer 1 (fail-fast): the mismatch is rejected at claim SUBMISSION,
    // before any email goes out.
    sentEmails = [];
    const submit = await post(`/v1/owner/link/${link.code}/claim`, { email: 'attacker@evil.com' });
    expect(submit.status).toBe(409);
    expect(sentEmails).toHaveLength(0);

    // Layer 2 (belt-and-suspenders): even a magic-link token that somehow
    // exists for the wrong email is refused at finish — forge one directly
    // in the store, bypassing the submission guard.
    const linkRow = await store.getLinkCode(link.code);
    const forged = base64urlEncode((() => { const b = new Uint8Array(32); globalThis.crypto.getRandomValues(b); return b; })());
    await store.createMagicLinkToken({
      tokenHash: bytesToHex(sha256(te.encode(forged))),
      purpose: 'claim',
      email: 'attacker@evil.com',
      linkCodeId: linkRow!.id,
      ttlSeconds: 900,
    });
    const res = await post('/v1/owner/claim/finish', { token: forged });
    expect(res.status).toBe(409);
    // No session was minted for the victim's account.
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('re-claiming a REVOKED agent reactivates its delegation instead of 500ing', async () => {
    const { ownerId, agentId, vaultPriv, vaultB58, agentB58 } = await claimFlow('revoker@example.com');
    // Kill the delegation (as the console would), leaving the row present.
    rawDb.prepare(`UPDATE delegations SET status='revoked', revoked_at=? WHERE owner_id=? AND agent_id=?`)
      .run(new Date().toISOString(), ownerId, agentId);
    expect((await store.getDelegation(ownerId, agentId))!.status).toBe('revoked');

    // Re-run init for the SAME agent → the claim must reactivate, not collide.
    const { code } = (await (await post('/v1/owner/link', await linkBody(
      { vaultPriv, vaultB58, agentId, agentB58 },
    ))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'revoker@example.com' });
    const res = await post('/v1/owner/claim/finish', { token: lastMagicToken() });
    expect(res.status).toBe(200);
    expect((await store.getDelegation(ownerId, agentId))!.status).toBe('active');
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

describe('the /start browser door (Get started)', () => {
  it('returning account: magic link → look session', async () => {
    await claimFlow('back@example.com');
    sentEmails = [];

    expect((await post('/v1/owner/start/email', { email: 'back@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    expect(await finish.json()).toEqual({ has_account: true });
    const me = (await (await get('/v1/owner/me', sessionCookie(finish))).json()) as Record<string, unknown>;
    expect(me.session_method).toBe('email');
  });

  it('first-time visitor: email is sent, finish yields no account + no session (setup stays on the machine)', async () => {
    sentEmails = [];
    // Unlike /login/email, /start emails ANY address (the finish page is useful
    // either way) — but a brand-new address gets no session, just the command
    // plus a start code that carries the verified email to the claim.
    expect((await post('/v1/owner/start/email', { email: 'brand-new@example.com' })).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    const body = (await finish.json()) as Record<string, unknown>;
    expect(body.has_account).toBe(false);
    expect(body.start_code).toMatch(/^st_/);
    expect(finish.headers.get('set-cookie')).toBeNull();
  });
});

describe('the start code: browser-door email rides the prompt into the claim', () => {
  /** /start email → magic-link click → the start code the console would render. */
  async function startCodeFor(email: string): Promise<string> {
    sentEmails = [];
    expect((await post('/v1/owner/start/email', { email })).status).toBe(200);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    expect(finish.status).toBe(200);
    const body = (await finish.json()) as { has_account: boolean; start_code?: string };
    expect(body.has_account).toBe(false);
    expect(body.start_code).toBeDefined();
    return body.start_code!;
  }

  it('pre-addresses the claim end to end — and the click still ratifies', async () => {
    const startCode = await startCodeFor('door@example.com');

    // init forwards the code; the link comes back pre-addressed (masked).
    const idn = await newInitIdentity();
    const linkRes = await post('/v1/owner/link', { ...(await linkBody(idn, 'Claude Code @ laptop')), start_code: startCode });
    expect(linkRes.status).toBe(200);
    const linkJson = (await linkRes.json()) as { code: string; email_hint?: string };
    expect(linkJson.email_hint).toBe('d•••@example.com');

    // The unauthenticated status endpoint shows ONLY the masked form.
    const statusRes = await get(`/v1/owner/link/${linkJson.code}`);
    const statusText = await statusRes.text();
    expect(statusText).toContain('d•••@example.com');
    expect(statusText).not.toContain('door@example.com');

    // One-click claim: no email in the body — it goes to the attached address.
    sentEmails = [];
    expect((await post(`/v1/owner/link/${linkJson.code}/claim`, {})).status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe('door@example.com');

    // The magic-link click is still the ratifying moment — nothing was
    // claimed before it, and after it the owner carries the door email.
    const finishRes = await post('/v1/owner/claim/finish', { token: lastMagicToken() });
    expect(finishRes.status).toBe(200);
    const owner = await store.getOwner(idn.ownerId);
    expect(owner!.email).toBe('door@example.com');
    expect(owner!.email_verified).toBe(1);
  });

  it('is single-use: a second /link with the same code gets no hint', async () => {
    const startCode = await startCodeFor('once@example.com');
    const first = await post('/v1/owner/link', { ...(await linkBody(await newInitIdentity())), start_code: startCode });
    expect(((await first.json()) as { email_hint?: string }).email_hint).toBe('o•••@example.com');

    const second = await post('/v1/owner/link', { ...(await linkBody(await newInitIdentity())), start_code: startCode });
    expect(second.status).toBe(200); // degrade, never fail init
    expect(((await second.json()) as { email_hint?: string }).email_hint).toBeUndefined();
  });

  it('a stale or bogus code degrades silently to the email field', async () => {
    const res = await post('/v1/owner/link', { ...(await linkBody(await newInitIdentity())), start_code: 'st_bogus' });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { code: string; email_hint?: string };
    expect(json.email_hint).toBeUndefined();

    // No attached address + no typed address = a clean 400, not a send.
    sentEmails = [];
    expect((await post(`/v1/owner/link/${json.code}/claim`, {})).status).toBe(400);
    expect(sentEmails).toHaveLength(0);
  });

  it('"use a different email": a typed address beats the attached one', async () => {
    const startCode = await startCodeFor('first@example.com');
    const linkRes = await post('/v1/owner/link', { ...(await linkBody(await newInitIdentity())), start_code: startCode });
    const { code } = (await linkRes.json()) as { code: string };

    sentEmails = [];
    expect((await post(`/v1/owner/link/${code}/claim`, { email: 'second@example.com' })).status).toBe(200);
    expect(sentEmails[0].to).toBe('second@example.com');
  });
});

describe('re-claims: the account email wins and mismatches fail fast', () => {
  /** /start email → magic-link click → the start code the console would render. */
  async function mintStartCode(email: string): Promise<string> {
    sentEmails = [];
    expect((await post('/v1/owner/start/email', { email })).status).toBe(200);
    const finish = await post('/v1/owner/start/finish', { token: lastMagicToken() });
    const body = (await finish.json()) as { start_code?: string };
    expect(body.start_code).toBeDefined();
    return body.start_code!;
  }

  it('pre-addresses a claimed vault to its own email — a start code for another address is ignored, not burned', async () => {
    const owned = await claimFlow('alice@example.com');
    const startCode = await mintStartCode('zed@example.com');

    // Re-link the SAME vault (new link code): pre-addressed to the account.
    const relink = await post('/v1/owner/link', { ...(await linkBody(owned)), start_code: startCode });
    expect(relink.status).toBe(200);
    const relinkJson = (await relink.json()) as { code: string; email_hint?: string; re_claim?: boolean };
    expect(relinkJson.re_claim).toBe(true);
    expect(relinkJson.email_hint).toBe('a•••@example.com'); // the account's, NOT the start code's

    // Status carries re_claim for the console copy.
    const status = (await (await get(`/v1/owner/link/${relinkJson.code}`)).json()) as Record<string, unknown>;
    expect(status.re_claim).toBe(true);

    // One-click claim goes to the account email; the click re-ratifies.
    sentEmails = [];
    expect((await post(`/v1/owner/link/${relinkJson.code}/claim`, {})).status).toBe(200);
    expect(sentEmails[0].to).toBe('alice@example.com');
    expect((await post('/v1/owner/claim/finish', { token: lastMagicToken() })).status).toBe(200);

    // The ignored start code is still alive for a genuine first claim.
    const freshLink = await post('/v1/owner/link', { ...(await linkBody(await newInitIdentity())), start_code: startCode });
    expect(((await freshLink.json()) as { email_hint?: string }).email_hint).toBe('z•••@example.com');
  });

  it('rejects a mismatched typed email at submission — before any email is sent', async () => {
    const owned = await claimFlow('original2@example.com');
    const relink = await post('/v1/owner/link', await linkBody(owned));
    const { code } = (await relink.json()) as { code: string };

    sentEmails = [];
    const res = await post(`/v1/owner/link/${code}/claim`, { email: 'stranger@example.com' });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toContain('use the email you first claimed it with');
    expect(sentEmails).toHaveLength(0); // no inbox round trip wasted
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

  it('agent-first entry works for an UNREGISTERED agent (register-on-invite)', async () => {
    // A keyring agent that only ran `init` has a keypair but no agents row.
    const priv = ed.utils.randomPrivateKey();
    const pub = await ed.getPublicKeyAsync(priv);
    const agentId = `ag_${base58Encode(pub)}`;
    expect(rawDb.prepare(`SELECT 1 FROM agents WHERE id = ?`).get(agentId)).toBeUndefined();

    const res = await agentPost({ priv, pub }, '/v1/owner/invites', { email: 'first@example.com' });
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    // The invite registered a minimal agent row on first use — nothing storable.
    expect(rawDb.prepare(`SELECT status FROM agents WHERE id = ?`).get(agentId)).toMatchObject({ status: 'active' });
    expect(await store.getOwnerByEmail('first@example.com')).toBeNull();
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
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
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

  it('provision kind: no secret in flight, hidden from old daemons, delivered on request', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'provision@example.com' });
    const finish = await post('/v1/owner/claim/finish', { token: lastMagicToken() });
    const cookie = sessionCookie(finish);

    // The schema is strict in both directions: provision never carries a
    // secret, sealed always does, and only recipe-backed providers provision.
    expect((await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'vercel', kind: 'provision', sealed_secret: 'AAAA',
    }, cookie)).status).toBe(400);
    expect((await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'vercel',
    }, cookie)).status).toBe(400);
    expect((await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'railway', kind: 'provision',
    }, cookie)).status).toBe(400);

    const create = await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'vercel', kind: 'provision', label: 'Vercel', env_var: 'VERCEL_TOKEN',
    }, cookie);
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };

    // An old daemon (no ?include) never receives the provision row…
    const oldPull = (await (await daemonRequest(idn, 'GET', '/v1/owner/daemon/connections')).json()) as { connections: unknown[] };
    expect(oldPull.connections).toHaveLength(0);

    // …a new daemon asks for it; the signature covers the pathname only, so
    // the query rides outside the signed message (exactly what the client does).
    const path = '/v1/owner/daemon/connections';
    const ts = Math.floor(Date.now() / 1000);
    const bodyHash = bytesToHex(sha256(te.encode('')));
    const sig = await ed.signAsync(te.encode(`GET:${path}:${ts}:${bodyHash}`), idn.vaultPriv);
    let bin = '';
    for (const b of sig) bin += String.fromCharCode(b);
    const pullRes = await app.request(`${path}?include=provision`, {
      method: 'GET',
      headers: { Authorization: `AgentSig ${base58Encode(idn.vaultPub)}:${btoa(bin)}`, 'X-Timestamp': String(ts) },
    });
    expect(pullRes.status).toBe(200);
    const pulled = (await pullRes.json()) as { connections: Array<Record<string, unknown>> };
    expect(pulled.connections).toHaveLength(1);
    expect(pulled.connections[0].kind).toBe('provision');
    expect(pulled.connections[0].sealed_secret).toBe('');

    // Claim + resolve ride the same rails as sealed rows.
    const claim = (await (await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/claim`)).json()) as { claimed: boolean };
    expect(claim.claimed).toBe(true);
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/resolve`, {
      daemon_credential_id: 'cred_prov_1',
    })).status).toBe(200);
    const after = (await (await get('/v1/owner/connections', cookie)).json()) as { connections: Array<Record<string, unknown>> };
    expect(after.connections[0].status).toBe('stored');
    expect(after.connections[0].kind).toBe('provision');

    // Supabase provisions since 0.6.2 — the gate must track the daemon's list.
    expect((await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'supabase', kind: 'provision', label: 'Supabase',
    }, cookie)).status).toBe(200);
  });

  it('rotate kind: born with its target, gated per-kind for daemons, target survives a failed resolve', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'rotate@example.com' });
    const cookie = sessionCookie(await post('/v1/owner/claim/finish', { token: lastMagicToken() }));

    // Schema: rotate requires its target and never a secret; the provider gate applies.
    expect((await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'vercel', kind: 'rotate',
    }, cookie)).status).toBe(400);
    expect((await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'railway', kind: 'rotate', rotate_credential_id: 'cred_x',
    }, cookie)).status).toBe(400);

    const create = await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'supabase', kind: 'rotate', label: 'Supabase', rotate_credential_id: 'cred_sb_9',
    }, cookie);
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };

    // The console sees the target id (metadata) and the kind.
    const mine = (await (await get('/v1/owner/connections', cookie)).json()) as { connections: Array<Record<string, unknown>> };
    expect(mine.connections[0].kind).toBe('rotate');
    expect(mine.connections[0].daemon_credential_id).toBe('cred_sb_9');

    // An old daemon (?include=provision) never receives a rotate row…
    const path = '/v1/owner/daemon/connections';
    const daemonPull = async (query: string) => {
      const ts = Math.floor(Date.now() / 1000);
      const bodyHash = bytesToHex(sha256(te.encode('')));
      const sig = await ed.signAsync(te.encode(`GET:${path}:${ts}:${bodyHash}`), idn.vaultPriv);
      let bin = '';
      for (const b of sig) bin += String.fromCharCode(b);
      const res = await app.request(`${path}${query}`, {
        method: 'GET',
        headers: { Authorization: `AgentSig ${base58Encode(idn.vaultPub)}:${btoa(bin)}`, 'X-Timestamp': String(ts) },
      });
      return (await res.json()) as { connections: Array<Record<string, unknown>> };
    };
    expect((await daemonPull('?include=provision')).connections).toHaveLength(0);

    // …a current daemon asks for it by name and gets the target with it.
    const pulled = await daemonPull('?include=provision,rotate');
    expect(pulled.connections).toHaveLength(1);
    expect(pulled.connections[0].kind).toBe('rotate');
    expect(pulled.connections[0].daemon_credential_id).toBe('cred_sb_9');

    // A FAILED resolve keeps the target on the row, so the console can pin
    // the failure to the right key.
    const claim = (await (await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/claim`)).json()) as { claimed: boolean };
    expect(claim.claimed).toBe(true);
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/resolve`, {
      error: 'rotate it in the Supabase dashboard',
    })).status).toBe(200);
    const after = (await (await get('/v1/owner/connections', cookie)).json()) as { connections: Array<Record<string, unknown>> };
    expect(after.connections[0].status).toBe('failed');
    expect(after.connections[0].daemon_credential_id).toBe('cred_sb_9');
  });

  it('an abandoned claim expires to failed on the next read — never an eternal spinner', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'reaper@example.com' });
    const cookie = sessionCookie(await post('/v1/owner/claim/finish', { token: lastMagicToken() }));

    // Two rotations: one whose daemon dies mid-work, one claimed just now.
    const mk = async (target: string) => ((await (await post('/v1/owner/connections', {
      agent_id: idn.agentId, provider: 'vercel', kind: 'rotate', label: 'Vercel', rotate_credential_id: target,
    }, cookie)).json()) as { id: string }).id;
    const staleId = await mk('cred_dead');
    const freshId = await mk('cred_live');
    for (const id of [staleId, freshId]) {
      const claim = (await (await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${id}/claim`)).json()) as { claimed: boolean };
      expect(claim.claimed).toBe(true);
    }
    // The claim stamped resolved_at; backdate the dead daemon's past the window.
    rawDb.prepare(`UPDATE pending_connections SET resolved_at = ? WHERE id = ?`)
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), staleId);

    // The console's next poll reaps the stale claim only — plain-words reason,
    // target preserved so the failure pins to the right key.
    const mine = (await (await get('/v1/owner/connections', cookie)).json()) as { connections: Array<Record<string, unknown>> };
    const stale = mine.connections.find((r) => r.id === staleId)!;
    const fresh = mine.connections.find((r) => r.id === freshId)!;
    expect(stale.status).toBe('failed');
    expect(stale.failure_reason).toContain('Try again');
    expect(stale.daemon_credential_id).toBe('cred_dead');
    expect(fresh.status).toBe('processing');

    // A daemon that finally wakes up cannot resurrect the reaped row.
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/connections/${staleId}/resolve`, {
      daemon_credential_id: 'cred_dead',
    })).status).toBe(404);
  });

  it('credential facts: daemon-reported, upserted, owner-readable — ids and booleans only', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'facts@example.com' });
    const cookie = sessionCookie(await post('/v1/owner/claim/finish', { token: lastMagicToken() }));

    // The daemon reports what its vault knows: the pasted key can't rotate,
    // the minted one can.
    expect((await daemonRequest(idn, 'POST', '/v1/owner/daemon/credential-facts', {
      credentials: [
        { id: 'cred_pasted', provider: 'vercel', rotatable: false },
        { id: 'cred_minted', provider: 'supabase', rotatable: true },
      ],
    })).status).toBe(200);

    const read = async () => ((await (await get('/v1/owner/credential-facts', cookie)).json()) as
      { facts: Array<{ credential_id: string; provider: string; rotatable: boolean }> }).facts;
    let facts = await read();
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.credential_id === 'cred_pasted')?.rotatable).toBe(false);
    expect(facts.find((f) => f.credential_id === 'cred_minted')?.rotatable).toBe(true);

    // Re-reporting upserts in place (the pasted key was upgraded to minted).
    expect((await daemonRequest(idn, 'POST', '/v1/owner/daemon/credential-facts', {
      credentials: [{ id: 'cred_pasted', provider: 'vercel', rotatable: true }],
    })).status).toBe(200);
    facts = await read();
    expect(facts).toHaveLength(2);
    expect(facts.find((f) => f.credential_id === 'cred_pasted')?.rotatable).toBe(true);

    // Shape is enforced — a report is ids and booleans, nothing free-form.
    expect((await daemonRequest(idn, 'POST', '/v1/owner/daemon/credential-facts', {
      credentials: [{ id: 'cred_x', provider: 'vercel', rotatable: 'yes' }],
    })).status).toBe(400);
  });

  it('revocation orders: the daemon pulls console kills, confirms once with counts, and /me tells the truth', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'killswitch@example.com' });
    const cookie = sessionCookie(await post('/v1/owner/claim/finish', { token: lastMagicToken() }));

    // No revoked delegations yet → nothing owed.
    const pull = async () => ((await (await daemonRequest(idn, 'GET', '/v1/owner/daemon/revocations')).json()) as
      { revocations: Array<Record<string, unknown>> }).revocations;
    expect(await pull()).toHaveLength(0);

    // The console kill switch revoked the delegation (state transition mirrors
    // routes.ts' /delegations/:id/revoke without re-running the passkey ceremony).
    rawDb.prepare(`UPDATE delegations SET status='revoked', revoked_at=? WHERE owner_id=? AND agent_id=?`)
      .run(new Date().toISOString(), ownerIdFromVaultPubkey(idn.vaultPub), idn.agentId);

    // The daemon now owes the local half…
    const owed = await pull();
    expect(owed).toHaveLength(1);
    expect(owed[0].agent_id).toBe(idn.agentId);
    const delegationId = owed[0].delegation_id as string;

    // …executes it and confirms with counts only.
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/revocations/${delegationId}/confirm`, {
      revoked_grants: 2, burned: 1, burn_failures: 0, residuals: 3,
    })).status).toBe(200);
    expect(await pull()).toHaveLength(0); // confirmed orders stop appearing

    // The console reads the honest state off /me.
    const me = (await (await get('/v1/owner/me', cookie)).json()) as
      { delegations: Array<{ id: string; status: string; daemon_confirmed_at: string | null; daemon_kill_report: string | null }> };
    const dead = me.delegations.find((d) => d.id === delegationId)!;
    expect(dead.status).toBe('revoked');
    expect(dead.daemon_confirmed_at).toBeTruthy();
    expect(JSON.parse(dead.daemon_kill_report!)).toEqual({ revoked_grants: 2, burned: 1, burn_failures: 0, residuals: 3 });

    // Confirm is one-shot; the report shape is enforced.
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/revocations/${delegationId}/confirm`, {
      revoked_grants: 0, burned: 0, burn_failures: 0, residuals: 0,
    })).status).toBe(404);
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/revocations/${delegationId}/confirm`, {
      revoked_grants: 'two', burned: 0, burn_failures: 0, residuals: 0,
    })).status).toBe(400);
  });

  it('cloud passport: handoff is ciphertext-only and one-shot; shelf gates on a fulfilled passport', async () => {
    const idn = await newInitIdentity();
    const { code } = (await (await post('/v1/owner/link', await linkBody(idn, 'CC'))).json()) as { code: string };
    await post(`/v1/owner/link/${code}/claim`, { email: 'passport@example.com' });
    const finish = await post('/v1/owner/claim/finish', { token: lastMagicToken() });
    const cookie = sessionCookie(finish);

    // Before any passport: shelf deposits are refused, reads come back empty.
    const putBefore = (await (await daemonRequest(idn, 'PUT', '/v1/owner/daemon/shelf', { snapshot: [] })).json()) as { enabled: boolean };
    expect(putBefore.enabled).toBe(false);
    const shelfBefore = (await (await daemonRequest(idn, 'GET', '/v1/owner/daemon/shelf')).json()) as { enabled: boolean; credentials: unknown[] };
    expect(shelfBefore.enabled).toBe(false);

    // Console files a handoff — a public key only, no secret in either direction.
    const create = await post('/v1/owner/passport', { browser_public_key: 'B'.repeat(44) }, cookie);
    expect(create.status).toBe(200);
    const { id } = (await create.json()) as { id: string };
    const pending = (await (await get(`/v1/owner/passport/${id}`, cookie)).json()) as { status: string; sealed_passport: string | null };
    expect(pending.status).toBe('pending');
    expect(pending.sealed_passport).toBeNull();

    // Daemon pulls the request and fulfills it with sealed ciphertext.
    const pulled = (await (await daemonRequest(idn, 'GET', '/v1/owner/daemon/passport')).json()) as { handoffs: Array<Record<string, unknown>> };
    expect(pulled.handoffs).toHaveLength(1);
    expect(pulled.handoffs[0].browser_public_key).toBe('B'.repeat(44));
    expect((await daemonRequest(idn, 'POST', `/v1/owner/daemon/passport/${id}/fulfill`, { sealed_passport: 'SEALED-TO-BROWSER' })).status).toBe(200);

    // The console consumes it EXACTLY once; the plane blanks the ciphertext.
    const got = (await (await get(`/v1/owner/passport/${id}`, cookie)).json()) as { status: string; sealed_passport: string | null };
    expect(got.status).toBe('fulfilled');
    expect(got.sealed_passport).toBe('SEALED-TO-BROWSER');
    const again = (await (await get(`/v1/owner/passport/${id}`, cookie)).json()) as { status: string; sealed_passport: string | null };
    expect(again.status).toBe('consumed');
    expect(again.sealed_passport).toBeNull();
    const raw = rawDb.prepare(`SELECT sealed_passport FROM passport_handoffs WHERE id = ?`).get(id) as { sealed_passport: string };
    expect(raw.sealed_passport).toBe('');

    // Shelf now enabled: snapshot semantics — absence deletes.
    const row = (cid: string) => ({ credential_id: cid, v: 1, meta: '{"label":"x"}', sealed: '{"ow":"AAA"}', grants: '[]' });
    const put1 = (await (await daemonRequest(idn, 'PUT', '/v1/owner/daemon/shelf', { snapshot: [row('cred_a'), row('cred_b')] })).json()) as { ok: boolean; enabled: boolean };
    expect(put1).toEqual({ ok: true, enabled: true });
    const shelf1 = (await (await daemonRequest(idn, 'GET', '/v1/owner/daemon/shelf')).json()) as { enabled: boolean; credentials: Array<{ credential_id: string }> };
    expect(shelf1.credentials.map((r) => r.credential_id)).toEqual(['cred_a', 'cred_b']);
    await daemonRequest(idn, 'PUT', '/v1/owner/daemon/shelf', { snapshot: [row('cred_a')] });
    const shelf2 = (await (await daemonRequest(idn, 'GET', '/v1/owner/daemon/shelf')).json()) as { enabled: boolean; credentials: Array<{ credential_id: string }> };
    expect(shelf2.credentials.map((r) => r.credential_id)).toEqual(['cred_a']);
  });
});
