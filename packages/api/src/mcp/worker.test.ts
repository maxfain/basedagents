/**
 * Smoke test for the assembled MCP Worker (SPEC §1/§5/§9, build-order 7).
 *
 * PROPRIETARY control-plane code — see ../control/LICENSE and LICENSING.md.
 *
 * Drives the REAL top-level Hono app (the same object `export default { fetch }`
 * wraps) via app.request, proving the three wiring invariants that only exist
 * once oauth.ts + handler.ts are mounted together behind the cookieless CORS:
 *   1. PRM is served (oauth sub-app is mounted) and its `resource` is the exact
 *      MCP_RESOURCE_URL binding.
 *   2. An unauthenticated POST /mcp is 401 with the exact WWW-Authenticate the
 *      handler's bearer middleware emits (handler sub-app is mounted).
 *   3. The CORS preflight is COOKIELESS — it must NOT carry Access-Control-Allow-
 *      Credentials (the api Worker's credentialed allow-list is a different app).
 *
 * None of these three paths touch the DB (PRM is pure config; the no-bearer 401
 * short-circuits before any token lookup; a preflight never reaches a handler),
 * so the harness passes an env with the vars but no DB binding — exactly the
 * Node/test shape the worker's guarded db middleware tolerates.
 */
import { describe, it, expect } from 'vitest';
import { app } from './worker.js';

const RESOURCE = 'https://mcp.basedagents.ai/mcp';
const ISSUER = 'https://mcp.basedagents.ai';
const ENV = {
  MCP_RESOURCE_URL: RESOURCE,
  MCP_ISSUER: ISSUER,
  API_BASE_URL: 'https://api.basedagents.ai',
  MCP_SIGNING_SECRET: 'test-signing-secret',
} as const;

describe('MCP Worker (assembled app)', () => {
  it('serves PRM with resource byte-identical to MCP_RESOURCE_URL', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource', {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string; authorization_servers: string[] };
    expect(body.resource).toBe(RESOURCE);
    expect(body.authorization_servers).toEqual([ISSUER]);
  });

  it('serves the RFC 9728 path-suffixed PRM too (oauth sub-app mounted)', async () => {
    const res = await app.request('/.well-known/oauth-protected-resource/mcp', {}, ENV);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: string };
    expect(body.resource).toBe(RESOURCE);
  });

  it('rejects an unauthenticated POST /mcp with 401 + exact WWW-Authenticate', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      },
      ENV,
    );
    expect(res.status).toBe(401);
    const www = res.headers.get('WWW-Authenticate') ?? res.headers.get('www-authenticate');
    expect(www).toBe(
      `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource", error="invalid_token"`,
    );
  });

  it('CORS preflight is cookieless — no Access-Control-Allow-Credentials', async () => {
    const res = await app.request(
      '/mcp',
      {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://claude.ai',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'authorization, content-type, mcp-protocol-version',
        },
      },
      ENV,
    );
    // The preflight is answered permissively (any origin reflected)…
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    // …but carries NO credential flag — the whole point of a bearer-only host.
    expect(res.headers.get('Access-Control-Allow-Credentials')).toBeNull();
  });
});
