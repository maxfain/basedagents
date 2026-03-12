import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { sign } from '@noble/ed25519';
import {
  setupTestDb,
  createTestApp,
  createTestAgent,
  signRequest,
} from '../test-helpers.js';
import type { SQLiteAdapter } from '../db/sqlite-adapter.js';
import type { TestKeypair } from '../test-helpers.js';

// Mock twitter
vi.mock('../lib/twitter.js', () => ({
  postTweet: vi.fn(),
  registrationTweet: vi.fn(() => 'mock tweet'),
  firstVerificationTweet: vi.fn(() => 'mock tweet'),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

// Mock skills resolver to avoid DB issues
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

/**
 * Build the JSON body and signature for a verification submission.
 */
async function buildVerificationBody(
  verifierKeypair: TestKeypair,
  targetId: string,
  result: 'pass' | 'fail' | 'timeout',
  options: {
    nonce?: string;
    assignmentId?: string;
    coherenceScore?: number;
    structuredReport?: Record<string, unknown> | null;
  } = {}
) {
  const assignmentId = options.assignmentId ?? crypto.randomUUID();
  const nonce = options.nonce ?? crypto.randomUUID();
  const coherenceScore = options.coherenceScore ?? (result === 'pass' ? 0.9 : 0.1);
  const structuredReport = options.structuredReport === undefined
    ? undefined
    : options.structuredReport;

  // Build the report data that needs to be signed
  const reportData = JSON.stringify({
    assignment_id: assignmentId,
    target_id: targetId,
    result,
    response_time_ms: 150,
    coherence_score: coherenceScore,
    notes: 'test verification',
    nonce,
  });

  const reportBytes = new TextEncoder().encode(reportData);
  const sigBytes = await sign(reportBytes, verifierKeypair.privateKey);
  const signature = btoa(String.fromCharCode(...sigBytes));

  return {
    assignment_id: assignmentId,
    target_id: targetId,
    result,
    response_time_ms: 150,
    coherence_score: coherenceScore,
    notes: 'test verification',
    signature,
    structured_report: structuredReport,
    nonce,
  };
}

describe('POST /v1/verify/submit', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let verifier: TestKeypair & { name: string };
  let target: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    mockFetch.mockReset();
    mockFetch.mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal('fetch', mockFetch);

    verifier = await createTestAgent(db, { reputationScore: 0.5, status: 'active' });
    target = await createTestAgent(db, { reputationScore: 0, status: 'pending' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('full verification flow returns ok with reputation delta', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.verification_id).toBeDefined();
    expect(typeof data.target_reputation_delta).toBe('number');
    expect(typeof data.verifier_reputation_delta).toBe('number');
  });

  it('self-verification → 400', async () => {
    const body = await buildVerificationBody(verifier, verifier.agentId, 'pass');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('bad_request');
  });

  it('duplicate nonce → 400', async () => {
    const sharedNonce = crypto.randomUUID();
    const body1 = await buildVerificationBody(verifier, target.agentId, 'pass', { nonce: sharedNonce });
    const bodyStr1 = JSON.stringify(body1);
    const authHeaders1 = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr1);

    // First submission succeeds
    const res1 = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders1 },
      body: bodyStr1,
    });
    expect(res1.status).toBe(200);

    // Need a second target to avoid the self-verification ban
    const target2 = await createTestAgent(db, { reputationScore: 0, status: 'pending' });
    // Re-sign with same nonce but different target — nonce collision should still fail
    const body2 = await buildVerificationBody(verifier, target2.agentId, 'pass', { nonce: sharedNonce });
    const bodyStr2 = JSON.stringify(body2);
    const authHeaders2 = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr2);

    const res2 = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders2 },
      body: bodyStr2,
    });
    expect(res2.status).toBe(400);
    const data = await res2.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('nonce');
  });

  it('invalid report signature → 400', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');

    // Corrupt the signature
    body.signature = btoa('invalidsignature'.repeat(4));

    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(400);
    const data = await res.json() as { message: string };
    expect(data.message.toLowerCase()).toContain('signature');
  });

  it('target not found → 404', async () => {
    const fakeTargetId = 'ag_nonexistentXYZ123';
    const body = await buildVerificationBody(verifier, fakeTargetId, 'pass');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(404);
  });

  it('status transition: pending → active after first pass verification', async () => {
    // Verify target starts as pending
    const before = await db.get<{ status: string }>(
      'SELECT status FROM agents WHERE id = ?', target.agentId
    );
    expect(before!.status).toBe('pending');

    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(200);

    const after = await db.get<{ status: string }>(
      'SELECT status FROM agents WHERE id = ?', target.agentId
    );
    expect(after!.status).toBe('active');
  });

  it('reputation delta is returned in response', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(typeof data.target_reputation_delta).toBe('number');
  });

  it('webhook is fired when target has webhook_url', async () => {
    // Create target with webhook_url
    const webhookTarget = await createTestAgent(db, {
      reputationScore: 0,
      status: 'pending',
      webhookUrl: 'https://webhook.example.com/events',
    });

    const body = await buildVerificationBody(verifier, webhookTarget.agentId, 'pass');
    const bodyStr = JSON.stringify(body);
    const authHeaders = await signRequest(verifier, 'POST', '/v1/verify/submit', bodyStr);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });
    expect(res.status).toBe(200);

    // Give fire-and-forget webhooks a tick to execute
    await new Promise(r => setTimeout(r, 10));

    // fetch should have been called with the webhook URL
    const webhookCalls = mockFetch.mock.calls.filter(
      ([url]: [string]) => url === 'https://webhook.example.com/events'
    );
    expect(webhookCalls.length).toBeGreaterThan(0);
  });

  it('unauthorized request (no auth header) → 401', async () => {
    const body = await buildVerificationBody(verifier, target.agentId, 'pass');
    const bodyStr = JSON.stringify(body);

    const res = await app.request('/v1/verify/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bodyStr,
    });
    expect(res.status).toBe(401);
  });
});
