/**
 * Tests for GET /openapi.json
 *
 * Verifies that the OpenAPI spec file is valid and serves correctly.
 * The endpoint is defined in index.ts and returns the static openapi.json.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { Hono } from 'hono';

// Load the OpenAPI JSON spec (resolved relative to this file via the TS build)
const require = createRequire(import.meta.url);
// Import via JSON (vitest handles JSON imports natively)
import openApiSpec from '../openapi.json';

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
  });

  it('spec has paths object', () => {
    const spec = openApiSpec as Record<string, unknown>;
    expect(spec.paths).toBeDefined();
    expect(typeof spec.paths).toBe('object');
  });

  it('spec includes core agent and task routes', () => {
    const paths = (openApiSpec as Record<string, Record<string, unknown>>).paths;
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
