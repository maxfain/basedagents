import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentIdOidcClient,
  AgentIdOidcError,
  buildAuthorizeUrl,
  createPkce,
  randomToken,
  sha256hex,
  setAgentIdFetchForTests,
} from './oidc.js';
import { base64urlEncode } from '../mcp/websec.js';
import type { AgentIdConfig } from './index.js';

const CFG: AgentIdConfig = {
  clientId: 'ba-client-123',
  clientSecret: 'shh-secret',
  issuer: 'https://auth.agentid.com',
  redirectUri: 'https://api.test/v1/agentid/callback',
  scopes: 'openid email profile',
  authorizeUrl: 'https://auth.agentid.com/v0/authorize',
  tokenUrl: 'https://auth.agentid.com/v0/token',
  jwksUrl: 'https://auth.agentid.com/v0/jwks.json',
};

const enc = new TextEncoder();

/** A fresh ES256 issuer keypair + its public JWK (with kid). */
async function makeIssuerKey(kid = 'kid-1') {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = (await crypto.subtle.exportKey('jwk', kp.publicKey)) as { x?: string; y?: string };
  return { kp, jwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, alg: 'ES256', use: 'sig' } };
}

/** Mint a signed compact ES256 JWT. */
async function mintJwt(
  privateKey: CryptoKey,
  header: Record<string, unknown>,
  claims: Record<string, unknown>,
): Promise<string> {
  const h = base64urlEncode(enc.encode(JSON.stringify(header)));
  const p = base64urlEncode(enc.encode(JSON.stringify(claims)));
  const sigRaw = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${base64urlEncode(sigRaw)}`;
}

function goodClaims(nonce: string, over: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: CFG.issuer,
    sub: 'agent-sub-abcdefghijklmnopqrstuvwxyz0123456789ABC',
    aud: CFG.clientId,
    exp: now + 300,
    iat: now,
    nonce,
    email: 'agent@agentmail.to',
    email_verified: true,
    name: 'Test Agent',
    owner_sub: 'owner-sub-9876543210',
    ...over,
  };
}

/** A client whose fetch only serves the JWKS doc. */
function clientWithJwks(jwk: unknown) {
  const fetchImpl = (async (input: string | URL) => {
    const url = String(input);
    if (url === CFG.jwksUrl) return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
  return new AgentIdOidcClient(CFG, fetchImpl);
}

describe('agentid/oidc PKCE + authorize URL', () => {
  it('createPkce produces an S256 verifier/challenge pair', () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).not.toBe(verifier);
    expect(sha256hex('a')).toMatch(/^[0-9a-f]{64}$/);
    expect(randomToken()).not.toBe(randomToken());
  });

  it('buildAuthorizeUrl carries response_type, PKCE, state, nonce, scope', () => {
    const url = new URL(buildAuthorizeUrl(CFG, { state: 'st', nonce: 'no', codeChallenge: 'ch' }));
    expect(url.origin + url.pathname).toBe(CFG.authorizeUrl);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe(CFG.clientId);
    expect(url.searchParams.get('redirect_uri')).toBe(CFG.redirectUri);
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('st');
    expect(url.searchParams.get('nonce')).toBe('no');
    expect(url.searchParams.get('code_challenge')).toBe('ch');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
  });
});

describe('agentid/oidc verifyIdToken', () => {
  beforeEach(() => setAgentIdFetchForTests(undefined));

  it('accepts a correctly-signed token and returns claims', async () => {
    const { kp, jwk } = await makeIssuerKey();
    const token = await mintJwt(kp.privateKey, { alg: 'ES256', kid: 'kid-1', typ: 'JWT' }, goodClaims('nonce-xyz'));
    const claims = await clientWithJwks(jwk).verifyIdToken(token, { nonce: 'nonce-xyz' });
    expect(claims.sub).toBe('agent-sub-abcdefghijklmnopqrstuvwxyz0123456789ABC');
    expect(claims.owner_sub).toBe('owner-sub-9876543210');
    expect(claims.email_verified).toBe(true);
  });

  it('rejects a tampered payload (signature over old payload)', async () => {
    const { kp, jwk } = await makeIssuerKey();
    const token = await mintJwt(kp.privateKey, { alg: 'ES256', kid: 'kid-1', typ: 'JWT' }, goodClaims('n'));
    const [h, p, s] = token.split('.');
    const forgedPayload = base64urlEncode(enc.encode(JSON.stringify(goodClaims('n', { sub: 'attacker' }))));
    void p;
    await expect(clientWithJwks(jwk).verifyIdToken(`${h}.${forgedPayload}.${s}`, { nonce: 'n' })).rejects.toThrow(
      AgentIdOidcError,
    );
  });

  it('rejects alg=none (alg-confusion guard)', async () => {
    const { kp, jwk } = await makeIssuerKey();
    // alg:none but still carrying a signature — must be refused on alg alone.
    const token = await mintJwt(kp.privateKey, { alg: 'none', kid: 'kid-1', typ: 'JWT' }, goodClaims('n'));
    await expect(clientWithJwks(jwk).verifyIdToken(token, { nonce: 'n' })).rejects.toThrow(/unexpected id_token alg/);
  });

  it('rejects a token signed by a different (unknown) key', async () => {
    const issuer = await makeIssuerKey('kid-1');
    const attacker = await makeIssuerKey('kid-1'); // same kid, different key
    const token = await mintJwt(attacker.kp.privateKey, { alg: 'ES256', kid: 'kid-1', typ: 'JWT' }, goodClaims('n'));
    await expect(clientWithJwks(issuer.jwk).verifyIdToken(token, { nonce: 'n' })).rejects.toThrow(/signature is invalid/);
  });

  it('rejects iss / aud / nonce / exp mismatches', async () => {
    const { kp, jwk } = await makeIssuerKey();
    const mk = (over: Record<string, unknown>) =>
      mintJwt(kp.privateKey, { alg: 'ES256', kid: 'kid-1', typ: 'JWT' }, goodClaims('n', over));

    await expect(clientWithJwks(jwk).verifyIdToken(await mk({ iss: 'https://evil.example' }), { nonce: 'n' })).rejects.toThrow(/iss mismatch/);
    await expect(clientWithJwks(jwk).verifyIdToken(await mk({ aud: 'someone-else' }), { nonce: 'n' })).rejects.toThrow(/aud/);
    await expect(clientWithJwks(jwk).verifyIdToken(await mk({ exp: Math.floor(Date.now() / 1000) - 3600 }), { nonce: 'n' })).rejects.toThrow(/expired/);
    await expect(clientWithJwks(jwk).verifyIdToken(await mk({}), { nonce: 'WRONG' })).rejects.toThrow(/nonce/);
  });

  it('accepts aud as an array containing our client_id', async () => {
    const { kp, jwk } = await makeIssuerKey();
    const token = await mintJwt(kp.privateKey, { alg: 'ES256', kid: 'kid-1', typ: 'JWT' }, goodClaims('n', { aud: ['x', CFG.clientId] }));
    const claims = await clientWithJwks(jwk).verifyIdToken(token, { nonce: 'n' });
    expect(claims.sub).toBeTruthy();
  });

  it('refetches the JWKS once when the kid is unknown (key rotation)', async () => {
    const stale = await makeIssuerKey('old-kid');
    const fresh = await makeIssuerKey('new-kid');
    let call = 0;
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url === CFG.jwksUrl) {
        call += 1;
        const jwk = call === 1 ? stale.jwk : fresh.jwk; // first serve stale, then rotated
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200 });
      }
      throw new Error('unexpected');
    }) as unknown as typeof fetch;
    const client = new AgentIdOidcClient(CFG, fetchImpl);
    const token = await mintJwt(fresh.kp.privateKey, { alg: 'ES256', kid: 'new-kid', typ: 'JWT' }, goodClaims('n'));
    const claims = await client.verifyIdToken(token, { nonce: 'n' });
    expect(claims.sub).toBeTruthy();
    expect(call).toBe(2); // one stale miss + one refetch
  });

  it('exchangeCode sends Basic auth + PKCE and returns tokens', async () => {
    let seen: { url: string; body: string; auth: string | null } | null = null;
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      seen = {
        url: String(input),
        body: String(init?.body ?? ''),
        auth: new Headers(init?.headers).get('authorization'),
      };
      return new Response(JSON.stringify({ id_token: 'a.b.c', access_token: 'tok' }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = new AgentIdOidcClient(CFG, fetchImpl);
    const res = await client.exchangeCode('the-code', 'the-verifier');
    expect(res.id_token).toBe('a.b.c');
    expect(seen!.url).toBe(CFG.tokenUrl);
    expect(seen!.auth).toBe('Basic ' + btoa('ba-client-123:shh-secret'));
    expect(seen!.body).toContain('grant_type=authorization_code');
    expect(seen!.body).toContain('code_verifier=the-verifier');
  });

  it('exchangeCode throws on a non-2xx token response', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 400 })) as unknown as typeof fetch;
    await expect(new AgentIdOidcClient(CFG, fetchImpl).exchangeCode('c', 'v')).rejects.toThrow(/token endpoint returned 400/);
  });
});
