/**
 * Tests for GET /openapi.json
 *
 * Verifies that the OpenAPI spec file is valid and serves correctly, and that
 * it stays in lockstep with the task routes actually registered on the Hono
 * app: every `/v1/tasks*` path+method in the spec exists on `taskRoutes`, and
 * every registered route is documented.
 */
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';

// Import via JSON (vitest handles JSON imports natively)
import openApiSpec from '../openapi.json';
import taskRoutes from './tasks.js';
import x402TaskRoutes, { X402_TIERS, openApiForEnv } from './x402-tasks.js';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const TASKS_MOUNT = '/v1/tasks'; // app.route('/v1/tasks', taskRoutes) in index.ts

/** `POST /:id/accept` on the sub-app → `post /v1/tasks/{id}/accept` as the spec spells it. */
function registeredTaskOperations(): string[] {
  const ops = new Set<string>();
  for (const route of taskRoutes.routes) {
    if (route.method === 'ALL') continue; // middleware mounted with .use(), none today
    const suffix = route.path === '/' ? '' : route.path;
    const path = `${TASKS_MOUNT}${suffix}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    ops.add(`${route.method.toLowerCase()} ${path}`);
  }
  return [...ops].sort();
}

function specTaskOperations(): string[] {
  const paths = (openApiSpec as unknown as { paths: Record<string, Record<string, unknown>> }).paths;
  const ops: string[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (path !== TASKS_MOUNT && !path.startsWith(`${TASKS_MOUNT}/`)) continue;
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.includes(method)) ops.push(`${method} ${path}`);
    }
  }
  return ops.sort();
}

describe('OpenAPI Spec — openapi.json validity', () => {
  it('spec has required OpenAPI top-level fields', () => {
    expect(openApiSpec).toBeDefined();
    expect(typeof (openApiSpec as Record<string, unknown>).openapi).toBe('string');
    expect((openApiSpec as Record<string, unknown>).openapi).toMatch(/^3\./);
  });

  it('spec has info object with title and version', () => {
    const spec = openApiSpec as Record<string, unknown>;
    expect(spec.info).toBeDefined();
    const info = spec.info as Record<string, unknown>;
    expect(typeof info.title).toBe('string');
    expect(info.title).not.toBe('');
    expect(typeof info.version).toBe('string');
    expect(info.version).toBe('0.7.0');
  });

  it('spec has paths object', () => {
    const spec = openApiSpec as Record<string, unknown>;
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
  });

  it('spec includes core agent and task routes', () => {
    const paths = (openApiSpec as unknown as Record<string, Record<string, unknown>>).paths;
    const pathKeys = Object.keys(paths);
    // Verify the spec has agent and task routes
    expect(pathKeys.some(p => p.includes('agents'))).toBe(true);
    expect(pathKeys.some(p => p.includes('tasks'))).toBe(true);
  });

  it('spec is valid JSON (no circular refs, parses without error)', () => {
    const serialized = JSON.stringify(openApiSpec);
    expect(() => JSON.parse(serialized)).not.toThrow();
    const reparsed = JSON.parse(serialized);
    expect(reparsed.openapi).toBe((openApiSpec as Record<string, unknown>).openapi);
  });
});

type Operation = { requestBody?: { content?: Record<string, { schema?: unknown }> }; responses: Record<string, unknown>; 'x-payment-info'?: { price: Record<string, string>; protocols: Array<Record<string, unknown>> } };
const specPaths = (openApiSpec as unknown as { paths: Record<string, Record<string, Operation>> }).paths;
const X402_MOUNT = '/v1/x402/tasks'; // app.route('/v1/x402/tasks', x402TaskRoutes) in index.ts

describe('OpenAPI Spec — agent discovery (x-guidance, x-payment-info)', () => {
  const info = (openApiSpec as unknown as { info: Record<string, unknown> }).info;

  it('carries agent guidance and a contact address', () => {
    const guidance = info['x-guidance'] as string;
    expect(guidance).toContain('/v1/x402/tasks');
    // Directories budget ~1000 tokens for it; ~4 characters a token.
    expect(guidance.length).toBeLessThan(4000);
    expect(info.guidance).toBeUndefined();
    expect((info.contact as { email?: string }).email).toBe('hello@basedagents.ai');
  });

  it('prices exactly the wallet-only hire endpoints, each with a 402, a JSON body and the x402 protocol', () => {
    const paid = Object.entries(specPaths).flatMap(([path, item]) =>
      Object.entries(item).filter(([, op]) => op && typeof op === 'object' && 'x-payment-info' in op).map(([method, op]) => ({ key: `${method} ${path}`, op })));
    expect(paid.map((p) => p.key).sort()).toEqual([`post ${X402_MOUNT}`, ...Object.keys(X402_TIERS).map((t) => `post ${X402_MOUNT}/${t}`)].sort());
    for (const { op } of paid) {
      const pay = op['x-payment-info']!;
      expect(pay.protocols).toEqual([{ x402: {} }]);
      expect(pay.price.currency).toBe('USDC');
      expect(op.responses['402']).toBeTruthy();
      expect(op.requestBody?.content?.['application/json']?.schema).toBeTruthy();
    }
    // A tier's documented price is the price the route charges (6-decimal USDC).
    for (const [tier, atomic] of Object.entries(X402_TIERS)) {
      expect(specPaths[`${X402_MOUNT}/${tier}`].post['x-payment-info']!.price).toEqual({ mode: 'fixed', currency: 'USDC', amount: (Number(atomic) / 1e6).toFixed(6) });
    }
    expect(specPaths[X402_MOUNT].post['x-payment-info']!.price).toEqual({ mode: 'dynamic', currency: 'USDC', min: '0.100000', max: '1000.000000' });
  });

  it('is served with the live minimum: a raised minimum moves the custom min and drops the tiers under it', () => {
    const spec = openApiSpec as unknown as { paths: Record<string, Record<string, Operation>> };
    // Every network offered and the default minimum: the file as is.
    expect(openApiForEnv(spec, { CIRCLE_API_KEY: 'k' })).toBe(spec);
    const raised = openApiForEnv(spec, { CIRCLE_API_KEY: 'k', MIN_BOUNTY_ATOMIC_A2A: '2000000' });
    expect(raised.paths[X402_MOUNT].post['x-payment-info']!.price).toMatchObject({ mode: 'dynamic', min: '2.000000', max: '1000.000000' });
    expect(raised.paths[`${X402_MOUNT}/usd-1`]).toBeUndefined();
    expect(raised.paths[`${X402_MOUNT}/usd-5`].post['x-payment-info']!.price.amount).toBe('5.000000');
    // The file itself is untouched.
    expect(specPaths[`${X402_MOUNT}/usd-1`]).toBeDefined();
    expect(specPaths[X402_MOUNT].post['x-payment-info']!.price.min).toBe('0.100000');
  });

  it('names only the networks a deposit can be paid on here: no Arc without the Circle key, no testnet in production', () => {
    type Served = {
      info: { 'x-guidance': string };
      paths: Record<string, Record<string, { description?: string; responses?: Record<string, { content?: Record<string, { schema?: { properties?: Record<string, { example?: unknown }> } }> }> }>>;
      components: { schemas: Record<string, { properties: Record<string, { enum?: string[] }> }> };
    };
    const spec = openApiSpec as unknown as Served;
    const hireOps = (s: Served) => Object.entries(s.paths).filter(([path]) => path.startsWith(X402_MOUNT)).flatMap(([, item]) => Object.values(item));
    const enums = (s: Served) => ['X402TierHireRequest', 'X402HireRequest'].map((n) => s.components.schemas[n].properties.network.enum);
    const listed = (s: Served) => s.paths[X402_MOUNT].get.responses!['200'].content!['application/json'].schema!.properties!.networks.example;
    // The file names every mainnet network, in the three wordings openApiForEnv rewrites.
    expect(spec.info['x-guidance']).toContain('pay in USDC on Base, Polygon or Arc');
    expect(spec.info['x-guidance']).toContain('USDC on Base eip155:8453, Polygon eip155:137 or Arc eip155:5042');
    for (const tier of ['', ...Object.keys(X402_TIERS).map((t) => `/${t}`)]) {
      expect(spec.paths[`${X402_MOUNT}${tier}`].post.description).toContain('(Base, then Polygon, then Arc;');
    }

    // Production without CIRCLE_API_KEY, which is what is live: Base and Polygon only.
    const live = openApiForEnv(spec, { ENVIRONMENT: 'production' });
    expect(live.info['x-guidance']).toContain('pay in USDC on Base or Polygon, or, as an agent');
    expect(live.info['x-guidance']).toContain('USDC on Base eip155:8453 or Polygon eip155:137, payTo');
    for (const op of hireOps(live)) {
      expect(op.description ?? '').not.toMatch(/\bArc\b|eip155:5042/);
    }
    expect(live.paths[`${X402_MOUNT}/usd-1`].post.description).toContain('(Base, then Polygon;');
    expect(live.info['x-guidance']).not.toMatch(/\bArc\b|eip155:5042/);
    expect(enums(live)).toEqual([['eip155:8453', 'eip155:137'], ['eip155:8453', 'eip155:137']]);
    expect(listed(live)).toEqual(['eip155:8453', 'eip155:137']);

    // With the key, production offers Arc too; still no testnet.
    const arc = openApiForEnv(spec, { ENVIRONMENT: 'production', CIRCLE_API_KEY: 'k' });
    expect(arc.info['x-guidance']).toBe(spec.info['x-guidance']);
    expect(arc.paths[`${X402_MOUNT}/usd-1`].post.description).toBe(spec.paths[`${X402_MOUNT}/usd-1`].post.description);
    expect(enums(arc)).toEqual([['eip155:8453', 'eip155:137', 'eip155:5042'], ['eip155:8453', 'eip155:137', 'eip155:5042']]);

    // Off production without the key: the testnet stays, Arc goes.
    expect(enums(openApiForEnv(spec, {}))).toEqual([['eip155:8453', 'eip155:84532', 'eip155:137'], ['eip155:8453', 'eip155:84532', 'eip155:137']]);

    // Other operations keep their wording, and the file itself is untouched.
    expect(live.paths['/v1/tasks'].post.description).toBe(spec.paths['/v1/tasks'].post.description);
    expect(enums(spec)).toEqual([['eip155:8453', 'eip155:84532', 'eip155:137', 'eip155:5042'], ['eip155:8453', 'eip155:84532', 'eip155:137', 'eip155:5042']]);
    expect(spec.info['x-guidance']).toContain('Base, Polygon or Arc');
  });

  it('links the runbook as externalDocs (the docs URL directories look for)', () => {
    expect((openApiSpec as unknown as { externalDocs: { url: string } }).externalDocs.url).toBe('https://basedagents.ai/skill.md');
  });

  it('every route on x402TaskRoutes is documented, and vice versa', () => {
    const registered = [...new Set(x402TaskRoutes.routes.filter((r) => r.method !== 'ALL').map((r) =>
      `${r.method.toLowerCase()} ${X402_MOUNT}${r.path === '/' ? '' : r.path}`.replace(/:([A-Za-z0-9_]+)/g, '{$1}')))].sort();
    const documented = Object.entries(specPaths)
      .filter(([path]) => path === X402_MOUNT || path.startsWith(`${X402_MOUNT}/`))
      .flatMap(([path, item]) => Object.keys(item).filter((m) => HTTP_METHODS.includes(m)).map((m) => `${m} ${path}`)).sort();
    expect(documented).toEqual(registered);
  });
});

describe('OpenAPI Spec — task route parity with routes/tasks.ts', () => {
  it('every route registered on taskRoutes is documented, and vice versa', () => {
    const registered = registeredTaskOperations();
    expect(registered.length).toBeGreaterThan(0);
    expect(specTaskOperations()).toEqual(registered);
  });

  it('documents the full task lifecycle', () => {
    const ops = specTaskOperations();
    for (const op of [
      'post /v1/tasks', 'get /v1/tasks', 'get /v1/tasks/{id}',
      'post /v1/tasks/{id}/claim', 'post /v1/tasks/{id}/deliver', 'post /v1/tasks/{id}/submit',
      'post /v1/tasks/{id}/accept', 'post /v1/tasks/{id}/verify', 'post /v1/tasks/{id}/revision',
      'post /v1/tasks/{id}/dispute', 'post /v1/tasks/{id}/cancel',
      'get /v1/tasks/{id}/receipt', 'get /v1/tasks/{id}/receipts', 'get /v1/tasks/{id}/payment',
    ]) {
      expect(ops).toContain(op);
    }
  });

  it('pins the payment contract: header on /accept only, /verify deprecated, 402 challenge documented', () => {
    const paths = (openApiSpec as unknown as { paths: Record<string, Record<string, Record<string, unknown>>> }).paths;

    const headerNames = (op: Record<string, unknown>) =>
      ((op.parameters ?? []) as Array<{ name: string; in: string }>).filter(p => p.in === 'header').map(p => p.name);

    // Escrow: the deposit is signed at create (402 there too); the legacy header name is never advertised.
    expect(headerNames(paths['/v1/tasks'].post)).toEqual(['PAYMENT-SIGNATURE']);
    expect(JSON.stringify(paths['/v1/tasks'].post)).not.toContain('X-PAYMENT-SIGNATURE');
    const create = paths['/v1/tasks'].post as { responses: Record<string, { headers?: Record<string, unknown> }> };
    expect(Object.keys(create.responses['402'].headers ?? {})).toContain('PAYMENT-REQUIRED');
    expect(headerNames(paths['/v1/tasks/{id}/fund'].post)).toEqual(['PAYMENT-SIGNATURE']);
    expect(headerNames(paths['/v1/tasks/{id}/accept'].post)).toEqual(['PAYMENT-SIGNATURE']);

    expect(paths['/v1/tasks/{id}/verify'].post.deprecated).toBe(true);

    const accept = paths['/v1/tasks/{id}/accept'].post as { responses: Record<string, { headers?: Record<string, unknown> }> };
    expect(accept.responses['402']).toBeDefined();
    expect(Object.keys(accept.responses['402'].headers ?? {})).toContain('PAYMENT-REQUIRED');
    expect(Object.keys(accept.responses['200'].headers ?? {})).toContain('PAYMENT-RESPONSE');

    // dispute requires a reason
    const dispute = paths['/v1/tasks/{id}/dispute'].post as { requestBody: { required: boolean; content: { 'application/json': { schema: { required: string[] } } } } };
    expect(dispute.requestBody.required).toBe(true);
    expect(dispute.requestBody.content['application/json'].schema.required).toEqual(['reason']);

    // bounty amount is atomic units
    const schemas = (openApiSpec as unknown as { components: { schemas: Record<string, { properties: Record<string, { pattern?: string }> }> } }).components.schemas;
    expect(schemas.Bounty.properties.amount.pattern).toBe('^[1-9][0-9]{0,9}$');

    // status enum includes closed
    const statusParam = ((paths['/v1/tasks'].get.parameters as Array<{ name: string; schema: { enum: string[] } }>)).find(p => p.name === 'status');
    expect(statusParam?.schema.enum).toContain('closed');
  });
});

describe('GET /openapi.json — HTTP endpoint', () => {
  it('returns 200 with application/json and valid spec', async () => {
    // Create a minimal Hono app that serves the spec (mimics index.ts behaviour)
    const app = new Hono();
    app.get('/openapi.json', (c) => c.json(openApiSpec));

    const res = await app.request('/openapi.json');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.openapi).toBe('string');
    expect(data.paths).toBeDefined();
    expect(data.info).toBeDefined();
  });
});
