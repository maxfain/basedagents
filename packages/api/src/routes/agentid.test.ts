import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Hono } from 'hono';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
  type TestKeypair,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import { base64urlEncode } from '../mcp/websec.js';
import { setAgentIdFetchForTests } from '../agentid/oidc.js';
import { agentIdDisabledReason } from '../agentid/index.js';
import type { AppEnv } from '../types/index.js';

const AGENTID_ENV = {
  AGENTID_ENABLED: '1',
  AGENTID_CLIENT_ID: 'ba-client',
  AGENTID_CLIENT_SECRET: 'secret',
  AGENTID_ISSUER: 'https://auth.agentid.com',
  AGENTID_REDIRECT_URI: 'https://api.test/v1/agentid/callback',
} as const;

const ISSUER = AGENTID_ENV.AGENTID_ISSUER;
const TOKEN_URL = `${ISSUER}/v0/token`;
const JWKS_URL = `${ISSUER}/v0/jwks.json`;
const enc = new TextEncoder();

async function makeIssuerKey(kid = 'kid-1') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as { x?: string; y?: string };
  return { privateKey: kp.privateKey, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256' } };
}

async function mintIdToken(
  privateKey: CryptoKey,
  args: { nonce: string; sub: string; over?: Record<string, unknown> },
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'ES256', kid: 'kid-1', typ: 'JWT' };
  const claims = {
    iss: ISSUER,
    sub: args.sub,
    aud: AGENTID_ENV.AGENTID_CLIENT_ID,
    exp: now + 300,
    iat: now,
    nonce: args.nonce,
    email: 'agent@agentmail.to',
    email_verified: true,
    name: 'Linked Agent',
    owner_sub: 'owner-abc',
    ...(args.over ?? {}),
  };
  const h = base64urlEncode(enc.encode(JSON.stringify(header)));
  const p = base64urlEncode(enc.encode(JSON.stringify(claims)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(`${h}.${p}`)));
  return `${h}.${p}.${base64urlEncode(sig)}`;
}

/** Script the OIDC token + JWKS endpoints. `idTokenFor(nonce)` builds the token lazily. */
function installOidcFetch(jwk: unknown, idTokenFor: (nonce: string) => Promise<string>) {
  let lastNonce = '';
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === TOKEN_URL) {
      const body = String(init?.body ?? '');
      // the nonce isn't in the token request; the caller sets it via the authorize URL.
      const id_token = await idTokenFor(lastNonce);
      void body;
      return new Response(JSON.stringify({ id_token, access_token: 'at' }), { status: 200 });
    }
    if (url === JWKS_URL) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    throw new Error(`unexpected fetch ${url}`);
  }) as unknown as typeof fetch;
  setAgentIdFetchForTests(fetchImpl);
  return { setNonce: (n: string) => (lastNonce = n) };
}

interface StartBody {
  ok?: boolean;
  link_id: string;
  link_url: string;
  issuer?: string;
  expires_at?: string;
  error?: string;
}
interface PollBody {
  status: string;
  agent_id?: string;
  error?: string | null;
}
interface AgentIdView {
  verified: boolean;
  issuer: string;
  email: string | null;
  email_verified: boolean;
  display_name: string | null;
  linked_at: string;
}
interface ProfileBody {
  agent_id?: string;
  agentid: AgentIdView | null;
}

async function startLink(app: Hono<AppEnv>, agent: TestKeypair) {
  const path = `/v1/agents/${agent.agentId}/agentid/link`;
  const headers = await signRequest(agent, 'POST', path, '');
  const res = await app.request(path, { method: 'POST', headers });
  const body = (await res.json()) as StartBody;
  return { res, body };
}

describe('AgentID link routes', () => {
  let db: SQLiteAdapter;

  beforeEach(() => {
    db = setupTestDb();
  });
  afterEach(() => {
    setAgentIdFetchForTests(undefined);
  });

  it('fails closed with 503 when AgentID is not configured', async () => {
    const app = createTestApp(db); // no AGENTID_* env
    const agent = await createTestAgent(db, { status: 'active' });
    const { res, body } = await startLink(app, agent);
    expect(res.status).toBe(503);
    expect(body.error).toBe('agentid_unavailable');
  });

  it('agentIdDisabledReason backs the GET /v1/status flag', async () => {
    // GET /v1/status computes `agentid` from agentIdDisabledReason(c.env); assert
    // that source of truth directly (the status route is wired on the main app).
    expect(agentIdDisabledReason(undefined)).toBe('no env bindings');
    expect(agentIdDisabledReason({})).toBe("AGENTID_ENABLED is not '1'");
    expect(agentIdDisabledReason({ AGENTID_ENABLED: '1' })).toBe('AGENTID_CLIENT_ID is not set');
    expect(
      agentIdDisabledReason({
        AGENTID_ENABLED: '1',
        AGENTID_CLIENT_ID: 'x',
        AGENTID_CLIENT_SECRET: 's',
        AGENTID_REDIRECT_URI: 'not-a-url',
      }),
    ).toBe('AGENTID_REDIRECT_URI is not a valid URL');
    expect(agentIdDisabledReason(AGENTID_ENV)).toBeNull();
  });

  it('start returns a sign-in URL + pollable link_id', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const agent = await createTestAgent(db, { status: 'active' });
    const { res, body } = await startLink(app, agent);
    expect(res.status).toBe(200);
    expect(body.link_id).toMatch(/^ail_/);
    const url = new URL(body.link_url);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/v0/authorize`);
    expect(url.searchParams.get('client_id')).toBe('ba-client');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
    expect(url.searchParams.get('nonce')).toBeTruthy();
    // poll before completion → pending
    const poll = (await (await app.request(`/v1/agentid/links/${body.link_id}`)).json()) as PollBody;
    expect(poll.status).toBe('pending');
  });

  it('rejects linking for an agent that is not the caller (403)', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const a = await createTestAgent(db, { status: 'active' });
    const b = await createTestAgent(db, { status: 'active' });
    const path = `/v1/agents/${a.agentId}/agentid/link`;
    const headers = await signRequest(b, 'POST', path, ''); // b signs for a's id
    const res = await app.request(path, { method: 'POST', headers });
    expect(res.status).toBe(403);
  });

  it('completes the full link → poll linked → profile shows verified', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const agent = await createTestAgent(db, { status: 'active' });
    const key = await makeIssuerKey();
    const sub = 'sub-happy-path-0001';
    const oidc = installOidcFetch(key.jwk, (nonce) => mintIdToken(key.privateKey, { nonce, sub }));

    const { body } = await startLink(app, agent);
    const url = new URL(body.link_url);
    const state = url.searchParams.get('state')!;
    oidc.setNonce(url.searchParams.get('nonce')!);

    const cb = await app.request(`/v1/agentid/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(cb.status).toBe(200);
    expect((await cb.text())).toContain('AgentID linked');

    const poll = (await (await app.request(`/v1/agentid/links/${body.link_id}`)).json()) as PollBody;
    expect(poll.status).toBe('linked');

    const profile = (await (await app.request(`/v1/agents/${agent.agentId}`)).json()) as ProfileBody;
    expect(profile.agentid).toMatchObject({ verified: true, email_verified: true, display_name: 'Linked Agent' });
    expect(profile.agentid).not.toBeNull();
    expect(profile.agentid!.email).toContain('*'); // masked
    expect(JSON.stringify(profile.agentid)).not.toContain('owner'); // owner_sub never exposed

    const status = (await (await app.request(`/v1/agents/${agent.agentId}/agentid`)).json()) as ProfileBody;
    expect(status.agentid!.verified).toBe(true);
  });

  it('a used/expired state cannot be replayed', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const agent = await createTestAgent(db, { status: 'active' });
    const key = await makeIssuerKey();
    const oidc = installOidcFetch(key.jwk, (nonce) => mintIdToken(key.privateKey, { nonce, sub: 'sub-replay' }));
    const { body } = await startLink(app, agent);
    const url = new URL(body.link_url);
    const state = encodeURIComponent(url.searchParams.get('state')!);
    oidc.setNonce(url.searchParams.get('nonce')!);

    const first = await app.request(`/v1/agentid/callback?code=abc&state=${state}`);
    expect(first.status).toBe(200);
    const second = await app.request(`/v1/agentid/callback?code=abc&state=${state}`);
    expect(second.status).toBe(400);
    expect(await second.text()).toContain('Link request not found');
  });

  it('refuses an AgentID already linked to a different agent', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const a = await createTestAgent(db, { status: 'active' });
    const b = await createTestAgent(db, { status: 'active' });
    const key = await makeIssuerKey();
    const sharedSub = 'sub-shared-9999';
    const oidc = installOidcFetch(key.jwk, (nonce) => mintIdToken(key.privateKey, { nonce, sub: sharedSub }));

    // a links first
    let { body } = await startLink(app, a);
    let url = new URL(body.link_url);
    oidc.setNonce(url.searchParams.get('nonce')!);
    await app.request(`/v1/agentid/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state')!)}`);

    // b tries the same AgentID sub
    ({ body } = await startLink(app, b));
    url = new URL(body.link_url);
    oidc.setNonce(url.searchParams.get('nonce')!);
    const cb = await app.request(`/v1/agentid/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
    expect(cb.status).toBe(400);
    expect(await cb.text()).toContain('Already linked');
    const bProfile = (await (await app.request(`/v1/agents/${b.agentId}`)).json()) as ProfileBody;
    expect(bProfile.agentid).toBeNull();
  });

  it('rejects a callback whose id_token nonce does not match (poll → failed)', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const agent = await createTestAgent(db, { status: 'active' });
    const key = await makeIssuerKey();
    // Always mint with the wrong nonce.
    const oidc = installOidcFetch(key.jwk, () => mintIdToken(key.privateKey, { nonce: 'WRONG', sub: 'sub-x' }));
    const { body } = await startLink(app, agent);
    const url = new URL(body.link_url);
    oidc.setNonce('WRONG');
    const cb = await app.request(`/v1/agentid/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state')!)}`);
    expect(cb.status).toBe(400);
    const poll = (await (await app.request(`/v1/agentid/links/${body.link_id}`)).json()) as PollBody;
    expect(poll.status).toBe('failed');
  });

  it('unlinks on DELETE (own agent only)', async () => {
    const app = createTestApp(db, AGENTID_ENV);
    const agent = await createTestAgent(db, { status: 'active' });
    const key = await makeIssuerKey();
    const oidc = installOidcFetch(key.jwk, (nonce) => mintIdToken(key.privateKey, { nonce, sub: 'sub-del' }));
    const { body } = await startLink(app, agent);
    const url = new URL(body.link_url);
    oidc.setNonce(url.searchParams.get('nonce')!);
    await app.request(`/v1/agentid/callback?code=abc&state=${encodeURIComponent(url.searchParams.get('state')!)}`);

    const path = `/v1/agents/${agent.agentId}/agentid`;
    const headers = await signRequest(agent, 'DELETE', path, '');
    const del = await app.request(path, { method: 'DELETE', headers });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { unlinked: boolean }).unlinked).toBe(true);
    const profile = (await (await app.request(`/v1/agents/${agent.agentId}`)).json()) as ProfileBody;
    expect(profile.agentid).toBeNull();
  });
});
