/**
 * Billing tests (coder brief Task 1 acceptance).
 *
 * PROPRIETARY control-plane code — see ./LICENSE and LICENSING.md.
 *
 * The rules under test, in the brief's own words:
 *   - the agent is the unit of scale: the 4th active delegation is blocked on
 *     Free; Pro is unlimited;
 *   - security actions are NEVER paywalled: revoke and daemon pull/confirm
 *     work on past_due, canceled, and over-limit accounts;
 *   - downgrade over-limit: existing agents keep working, no new
 *     delegations/approvals until under limit;
 *   - webhooks are the only writer of plan state, verified by signature and
 *     idempotent by event id (replay causes no double-processing);
 *   - getEntitlements is the single source of truth.
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import * as ed from '@noble/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { AppEnv } from '../types/index.js';
import { base58Encode } from '../crypto/index.js';
import { base64urlEncode, base64urlDecode } from './webauthn.js';
import { ownerIdFromVaultPubkey } from './identity.js';
import { ControlStore } from './store.js';
import { getEntitlements } from './billing.js';
import ownerRoutes from './routes.js';
import approvalRoutes from './approvals.js';
import { billingRoutes, stripeWebhookRoutes } from './billing.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(__dirname, '..', '..', 'migrations');
const SQL = ['0023_owner_accounts.sql', '0024_keyring_approvals.sql', '0025_owner_recovery.sql', '0026_owner_billing.sql', '0027_authority_ladder.sql']
  .map((f) => readFileSync(join(MIGRATIONS, f), 'utf-8'));

const te = new TextEncoder();
const RP_ID = 'basedagents.ai';
const ORIGIN = 'https://app.basedagents.ai';
const WEBHOOK_SECRET = 'whsec_test_secret';
const STRIPE_ENV = {
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
  STRIPE_PRICE_PRO_MONTHLY: 'price_month',
  STRIPE_PRICE_PRO_YEARLY: 'price_year',
};

// ─── byte helpers (mirrors approvals.test.ts) ───

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

// ─── simulated authenticator (trimmed from approvals.test.ts) ───

class Authenticator {
  private constructor(
    private privateKey: CryptoKey,
    readonly cose: Uint8Array,
    readonly credentialId: string,
    readonly vaultB58: string,
    readonly ownerId: string,
  ) {}

  static async create(): Promise<Authenticator> {
    const kp = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const jwk = await globalThis.crypto.subtle.exportKey('jwk', kp.publicKey);
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([[1, 2], [3, -7], [-1, 1], [-2, base64urlDecode(jwk.x!)], [-3, base64urlDecode(jwk.y!)]]) as CborType,
    );
    const rawId = new Uint8Array(16);
    globalThis.crypto.getRandomValues(rawId);
    const vaultPriv = ed.utils.randomPrivateKey();
    const vaultPub = await ed.getPublicKeyAsync(vaultPriv);
    return new Authenticator(kp.privateKey, cose, base64urlEncode(rawId), base58Encode(vaultPub), ownerIdFromVaultPubkey(vaultPub));
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
let agentCounter = 0;
let ceremonyCounter = 0;

function buildApp(): Hono<AppEnv> {
  const a = new Hono<AppEnv>();
  a.use('*', async (c, next) => {
    c.set('db', db);
    await next();
  });
  a.route('/v1/owner', ownerRoutes);
  a.route('/v1/owner', approvalRoutes);
  a.route('/v1/owner', billingRoutes);
  a.route('/v1', stripeWebhookRoutes);
  return a;
}

beforeEach(() => {
  rawDb = new Database(':memory:');
  rawDb.pragma('foreign_keys = ON');
  rawDb.exec(`CREATE TABLE agents (
    id TEXT PRIMARY KEY, public_key BLOB, name TEXT,
    status TEXT NOT NULL DEFAULT 'active', registered_at TEXT
  );`);
  for (const sql of SQL) rawDb.exec(sql);
  db = new SQLiteAdapter(rawDb);
  store = new ControlStore(db);
  agentCounter = 0;
  ceremonyCounter = 0;
  app = buildApp();
});

afterEach(() => vi.unstubAllGlobals());

const JSON_HEADERS = { 'Content-Type': 'application/json' };

async function post(path: string, body: unknown, cookie?: string, env?: Record<string, string>): Promise<Response> {
  const headers: Record<string, string> = { ...JSON_HEADERS };
  if (cookie) headers.Cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) }, env);
}

async function get(path: string, cookie?: string, env?: Record<string, string>): Promise<Response> {
  return app.request(path, { method: 'GET', headers: cookie ? { Cookie: cookie } : {} }, env);
}

function sessionCookie(res: Response): string {
  const m = /ba_owner_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m) throw new Error('no session cookie');
  return `ba_owner_session=${m[1]}`;
}

async function registerAndLogin(auth: Authenticator): Promise<string> {
  const beginRes = await post('/v1/owner/register/begin', { vault_public_key: auth.vaultB58, email: 'max@example.com' });
  const begin = (await beginRes.json()) as { options: { challenge: string } };
  const reg = auth.registration(begin.options.challenge);
  await post('/v1/owner/register/finish', { vault_public_key: auth.vaultB58, attestationObject: reg.attestationObject, clientDataJSON: reg.clientDataJSON });
  const loginBegin = (await (await post('/v1/owner/login/begin', { owner_id: auth.ownerId })).json()) as { challenge: string };
  const res = await post('/v1/owner/login/finish', await auth.assert(loginBegin.challenge, ++ceremonyCounter));
  expect(res.status).toBe(200);
  return sessionCookie(res);
}

async function makeAgent(): Promise<{ agentId: string; publicKeyB58: string }> {
  const priv = ed.utils.randomPrivateKey();
  const pub = await ed.getPublicKeyAsync(priv);
  const agentId = `ag_${base58Encode(pub)}`;
  rawDb.prepare(`INSERT INTO agents (id, public_key, name, status) VALUES (?, ?, ?, 'active')`)
    .run(agentId, Buffer.from(pub), `agent-${++agentCounter}`);
  return { agentId, publicKeyB58: base58Encode(pub) };
}

/** Run the create_delegation ceremony; returns the raw Response. */
async function delegate(auth: Authenticator, cookie: string, agentId: string): Promise<Response> {
  const a = (await (await post('/v1/owner/action/begin', { action_type: 'create_delegation', params: { agent_id: agentId, label: null } }, cookie)).json()) as { challenge: string; nonce: string };
  return post('/v1/owner/delegations', { agent_id: agentId, nonce: a.nonce, assertion: await auth.assert(a.challenge, ++ceremonyCounter) }, cookie);
}

async function revokeDelegation(auth: Authenticator, cookie: string, delegationId: string): Promise<Response> {
  const a = (await (await post('/v1/owner/action/begin', { action_type: 'revoke_delegation', params: { delegation_id: delegationId } }, cookie)).json()) as { challenge: string; nonce: string };
  return post(`/v1/owner/delegations/${delegationId}/revoke`, { nonce: a.nonce, assertion: await auth.assert(a.challenge, ++ceremonyCounter) }, cookie);
}

/** Stripe's webhook signature scheme: v1 = HMAC-SHA256(`${t}.${payload}`, secret). */
function stripeSignature(payload: string, secret: string, t = Math.floor(Date.now() / 1000)): string {
  const v1 = bytesToHex(hmac(sha256, te.encode(secret), te.encode(`${t}.${payload}`)));
  return `t=${t},v1=${v1}`;
}

async function sendWebhook(event: Record<string, unknown>, opts?: { badSignature?: boolean }): Promise<Response> {
  const payload = JSON.stringify(event);
  const sig = opts?.badSignature ? stripeSignature(payload, 'whsec_WRONG') : stripeSignature(payload, WEBHOOK_SECRET);
  return app.request('/v1/stripe/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': sig },
    body: payload,
  }, STRIPE_ENV);
}

let eventCounter = 0;
function subscriptionEvent(type: string, customerId: string, status: string, id?: string): Record<string, unknown> {
  return {
    id: id ?? `evt_${++eventCounter}`,
    object: 'event',
    type,
    data: { object: { object: 'subscription', id: 'sub_1', customer: customerId, status, items: { data: [{ current_period_end: 1893456000 }] } } },
  };
}

// ─────────────────────────────────────────────────────────────────────────────

describe('getEntitlements — the single source of truth', () => {
  it('maps plan/status to limits, degrading past_due and canceled to Free limits', () => {
    expect(getEntitlements({ plan: 'free', plan_status: 'active' })).toEqual({ maxAgents: 3, retentionDays: 30, anomalyFlags: false });
    expect(getEntitlements({ plan: 'pro', plan_status: 'active' })).toEqual({ maxAgents: Infinity, retentionDays: 365, anomalyFlags: true });
    expect(getEntitlements({ plan: 'pro', plan_status: 'past_due' }).maxAgents).toBe(3);
    expect(getEntitlements({ plan: 'pro', plan_status: 'canceled' }).maxAgents).toBe(3);
    expect(getEntitlements({ plan: 'team', plan_status: 'active' }).maxAgents).toBe(Infinity);
  });
});

describe('enforcement point #1: delegation creation', () => {
  it('Free allows 3 agents and blocks the 4th with 402 plan_limit; Pro is unlimited', async () => {
    const auth = await Authenticator.create();
    const cookie = await registerAndLogin(auth);

    for (let i = 0; i < 3; i++) {
      expect((await delegate(auth, cookie, (await makeAgent()).agentId)).status).toBe(200);
    }
    const fourth = await delegate(auth, cookie, (await makeAgent()).agentId);
    expect(fourth.status).toBe(402);
    expect(((await fourth.json()) as { error: string }).error).toBe('plan_limit');

    // Upgrade (direct plan write — webhook paths tested below) → 4th succeeds.
    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'pro', planStatus: 'active' });
    expect((await delegate(auth, cookie, (await makeAgent()).agentId)).status).toBe(200);
  });
});

describe('downgrade over-limit: existing works, new is paused, security is never gated', () => {
  it('4-agent Pro owner downgraded to Free keeps all 4 working but cannot add or approve; revoke still works and restores approvals', async () => {
    const auth = await Authenticator.create();
    const cookie = await registerAndLogin(auth);
    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'pro', planStatus: 'active' });

    const agents = [];
    for (let i = 0; i < 4; i++) {
      const agent = await makeAgent();
      agents.push(agent);
      expect((await delegate(auth, cookie, agent.agentId)).status).toBe(200);
    }

    // Stripe subscription dies → Free.
    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'free', planStatus: 'canceled' });

    // Existing delegations all intact.
    const me = (await (await get('/v1/owner/me', cookie)).json()) as { delegations: Array<{ id: string; status: string }> };
    expect(me.delegations.filter((d) => d.status === 'active')).toHaveLength(4);

    // No 5th agent.
    expect((await delegate(auth, cookie, (await makeAgent()).agentId)).status).toBe(402);

    // No new grant approvals while over limit (the begin arm is gated too).
    const reqRes = await post('/v1/owner/requests', { agent_id: agents[0].agentId, credential_id: 'cred_x' }, cookie);
    expect(reqRes.status).toBe(200);
    const reqId = ((await reqRes.json()) as { id: string }).id;
    const beginGated = await post(`/v1/owner/requests/${reqId}/approve/begin`, {}, cookie);
    expect(beginGated.status).toBe(402);

    // SECURITY IS NEVER GATED: revoke works on the canceled account…
    const revokeRes = await revokeDelegation(auth, cookie, me.delegations[0].id);
    expect(revokeRes.status).toBe(200);

    // …and dropping to 3 active (within Free) un-pauses approvals.
    const beginOk = await post(`/v1/owner/requests/${reqId}/approve/begin`, {}, cookie);
    expect(beginOk.status).toBe(200);
  });

  it('past_due gates creation at Free limits but existing delegations and revoke keep working', async () => {
    const auth = await Authenticator.create();
    const cookie = await registerAndLogin(auth);
    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'pro', planStatus: 'active' });
    for (let i = 0; i < 3; i++) expect((await delegate(auth, cookie, (await makeAgent()).agentId)).status).toBe(200);

    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'pro', planStatus: 'past_due' });

    expect((await delegate(auth, cookie, (await makeAgent()).agentId)).status).toBe(402); // 4th blocked at Free limit
    const me = (await (await get('/v1/owner/me', cookie)).json()) as { delegations: Array<{ id: string }> };
    expect((await revokeDelegation(auth, cookie, me.delegations[0].id)).status).toBe(200); // security unaffected
  });
});

describe('the Stripe webhook: signature, idempotency, plan-state transitions', () => {
  it('rejects a bad signature and answers 503 when unconfigured', async () => {
    const bad = await sendWebhook(subscriptionEvent('customer.subscription.updated', 'cus_1', 'active'), { badSignature: true });
    expect(bad.status).toBe(400);
    const unconfigured = await app.request('/v1/stripe/webhook', { method: 'POST', body: '{}' });
    expect(unconfigured.status).toBe(503);
  });

  it('checkout.session.completed upgrades the owner (webhook, not redirect), then subscription.updated syncs period end', async () => {
    const auth = await Authenticator.create();
    await registerAndLogin(auth);

    const checkout = {
      id: `evt_${++eventCounter}`,
      object: 'event',
      type: 'checkout.session.completed',
      data: { object: { object: 'checkout.session', client_reference_id: auth.ownerId, customer: 'cus_42', subscription: 'sub_42' } },
    };
    expect((await sendWebhook(checkout)).status).toBe(200);

    let owner = await store.getOwner(auth.ownerId);
    expect(owner!.plan).toBe('pro');
    expect(owner!.plan_status).toBe('active');
    expect(owner!.stripe_customer_id).toBe('cus_42');

    expect((await sendWebhook(subscriptionEvent('customer.subscription.updated', 'cus_42', 'active'))).status).toBe(200);
    owner = await store.getOwner(auth.ownerId);
    expect(owner!.current_period_end).toBe(new Date(1893456000 * 1000).toISOString());
  });

  it('subscription.updated past_due and subscription.deleted downgrade correctly', async () => {
    const auth = await Authenticator.create();
    await registerAndLogin(auth);
    await store.setStripeCustomerId(auth.ownerId, 'cus_7');
    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'pro', planStatus: 'active' });

    await sendWebhook(subscriptionEvent('customer.subscription.updated', 'cus_7', 'past_due'));
    expect((await store.getOwner(auth.ownerId))!.plan_status).toBe('past_due');

    await sendWebhook(subscriptionEvent('customer.subscription.deleted', 'cus_7', 'canceled'));
    const owner = await store.getOwner(auth.ownerId);
    expect(owner!.plan).toBe('free');
    expect(owner!.plan_status).toBe('canceled');
  });

  it('replaying the same event id is acknowledged but not reprocessed', async () => {
    const auth = await Authenticator.create();
    await registerAndLogin(auth);
    await store.setStripeCustomerId(auth.ownerId, 'cus_9');

    const event = subscriptionEvent('customer.subscription.updated', 'cus_9', 'active', 'evt_replayed');
    expect((await sendWebhook(event)).status).toBe(200);
    expect((await store.getOwner(auth.ownerId))!.plan).toBe('pro');

    // Manually flip state, then replay: a reprocessed event would overwrite it.
    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'free', planStatus: 'canceled' });
    const replay = await sendWebhook(event);
    expect(replay.status).toBe(200);
    expect(((await replay.json()) as { duplicate?: boolean }).duplicate).toBe(true);
    expect((await store.getOwner(auth.ownerId))!.plan).toBe('free'); // untouched
  });
});

describe('GET /billing (console settings data)', () => {
  it('reports plan, entitlements (null = unlimited), and usage', async () => {
    const auth = await Authenticator.create();
    const cookie = await registerAndLogin(auth);
    expect((await delegate(auth, cookie, (await makeAgent()).agentId)).status).toBe(200);

    const free = (await (await get('/v1/owner/billing', cookie)).json()) as Record<string, unknown>;
    expect(free.plan).toBe('free');
    expect((free.entitlements as { max_agents: number | null }).max_agents).toBe(3);
    expect(free.active_agents).toBe(1);
    expect(free.billing_configured).toBe(false); // no STRIPE_SECRET_KEY in this env

    await store.updateOwnerBilling({ ownerId: auth.ownerId, plan: 'pro', planStatus: 'active' });
    const pro = (await (await get('/v1/owner/billing', cookie, STRIPE_ENV)).json()) as Record<string, unknown>;
    expect((pro.entitlements as { max_agents: number | null }).max_agents).toBeNull(); // unlimited
    expect(pro.billing_configured).toBe(true);
  });

  it('checkout answers 503 when Stripe is unconfigured', async () => {
    const auth = await Authenticator.create();
    const cookie = await registerAndLogin(auth);
    expect((await post('/v1/owner/billing/checkout', { interval: 'monthly' }, cookie)).status).toBe(503);
  });
});
