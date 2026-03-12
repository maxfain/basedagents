import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
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

// Mock skills resolver
vi.mock('../skills/resolver.js', () => ({
  resolveAllAgentSkills: vi.fn().mockResolvedValue({ updated: 0 }),
  computeSkillReputations: vi.fn().mockResolvedValue(undefined),
}));

const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

describe('GET /v1/agents/search', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns list of agents', async () => {
    await createTestAgent(db, { name: 'AgentAlpha', status: 'active' });
    await createTestAgent(db, { name: 'AgentBeta', status: 'active' });

    const res = await app.request('/v1/agents/search');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: unknown[]; pagination: { total: number } };
    expect(data.agents).toBeDefined();
    expect(data.agents.length).toBeGreaterThanOrEqual(2);
    expect(data.pagination.total).toBeGreaterThanOrEqual(2);
  });

  it('pagination works', async () => {
    // Create 5 agents
    for (let i = 0; i < 5; i++) {
      await createTestAgent(db, { name: `PaginationAgent-${i}`, status: 'active' });
    }

    const res = await app.request('/v1/agents/search?limit=2&page=1');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: unknown[]; pagination: { total: number; total_pages: number } };
    expect(data.agents.length).toBeLessThanOrEqual(2);
    expect(data.pagination.total).toBeGreaterThanOrEqual(5);
    expect(data.pagination.total_pages).toBeGreaterThanOrEqual(3);
  });

  it('text search on name works', async () => {
    await createTestAgent(db, { name: 'UniqueSearchableName', status: 'active' });
    await createTestAgent(db, { name: 'SomethingElse', status: 'active' });

    const res = await app.request('/v1/agents/search?q=UniqueSearchableName');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'UniqueSearchableName')).toBe(true);
    expect(data.agents.every(a => a.name !== 'SomethingElse')).toBe(true);
  });

  it('capabilities filter works', async () => {
    await createTestAgent(db, {
      name: 'CodeBot',
      status: 'active',
      capabilities: ['code-generation', 'debugging'],
    });
    await createTestAgent(db, {
      name: 'DataBot',
      status: 'active',
      capabilities: ['data-analysis'],
    });

    const res = await app.request('/v1/agents/search?capabilities=code-generation');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.some(a => a.name === 'CodeBot')).toBe(true);
    expect(data.agents.every(a => a.name !== 'DataBot')).toBe(true);
  });

  it('does not include suspended agents by default', async () => {
    await createTestAgent(db, { name: 'ActiveAgent', status: 'active' });
    await createTestAgent(db, { name: 'SuspendedAgent', status: 'suspended' });

    const res = await app.request('/v1/agents/search');
    expect(res.status).toBe(200);
    const data = await res.json() as { agents: Array<{ name: string }> };
    expect(data.agents.every(a => a.name !== 'SuspendedAgent')).toBe(true);
  });
});

describe('GET /v1/agents/:id', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns agent with verifications', async () => {
    const agent = await createTestAgent(db, { name: 'TestAgent', status: 'active' });
    const verifier = await createTestAgent(db, { status: 'active' });

    await db.run(
      `INSERT INTO verifications (id, verifier_id, target_id, result, coherence_score, notes, signature, structured_report, nonce, created_at)
       VALUES ('v1', ?, ?, 'pass', 0.9, NULL, 'sig', NULL, 'n1', ?)`,
      verifier.agentId, agent.agentId, new Date().toISOString()
    );

    const res = await app.request(`/v1/agents/${agent.agentId}`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.agent_id).toBe(agent.agentId);
    expect(data.name).toBe('TestAgent');
    expect(Array.isArray(data.recent_verifications)).toBe(true);
    expect((data.recent_verifications as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it('not found → 404', async () => {
    const res = await app.request('/v1/agents/ag_nonexistent123');
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('not_found');
  });
});

describe('PATCH /v1/agents/:id/profile', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let agent: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
    agent = await createTestAgent(db, { name: 'UpdateableAgent', status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('updates profile with auth', async () => {
    const patch = { description: 'Updated description for testing' };
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { description: string };
    expect(data.description).toBe('Updated description for testing');
  });

  it('clears webhook_url when set to empty string', async () => {
    // First set a webhook URL
    const setBody = JSON.stringify({ webhook_url: 'https://example.com/hook' });
    const setHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, setBody);
    await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...setHeaders },
      body: setBody,
    });

    // Now clear it with empty string
    const clearBody = JSON.stringify({ webhook_url: '' });
    const clearHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, clearBody);
    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...clearHeaders },
      body: clearBody,
    });

    expect(res.status).toBe(200);
    const data = await res.json() as { webhook_url: string | null };
    expect(data.webhook_url).toBeNull();
  });

  it('name already taken → 409', async () => {
    const other = await createTestAgent(db, { name: 'OtherAgent', status: 'active' });

    const patch = { name: 'OtherAgent' }; // same name as other agent
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(409);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('conflict');
  });

  it('trust-relevant update creates chain entry', async () => {
    const initialChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;

    const patch = { capabilities: ['new-capability', 'another-one'] };
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);

    const afterChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;
    expect(afterChainCount).toBeGreaterThan(initialChainCount);
  });

  it('cosmetic update does NOT create chain entry', async () => {
    const initialChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;

    const patch = { description: 'Changed description — purely cosmetic' };
    const bodyStr = JSON.stringify(patch);
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(200);

    const afterChainCount = (await db.all('SELECT * FROM chain WHERE agent_id = ?', agent.agentId)).length;
    expect(afterChainCount).toBe(initialChainCount);
  });

  it('without auth → 401', async () => {
    const patch = { description: 'No auth update' };
    const res = await app.request(`/v1/agents/${agent.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    expect(res.status).toBe(401);
  });

  it('cannot update another agent profile → 403', async () => {
    const other = await createTestAgent(db, { name: 'OtherAgentToEdit', status: 'active' });

    const patch = { description: 'Trying to edit someone else' };
    const bodyStr = JSON.stringify(patch);
    // Sign as 'agent' but try to update 'other.agentId'
    const authHeaders = await signRequest(agent, 'PATCH', `/v1/agents/${other.agentId}/profile`, bodyStr);

    const res = await app.request(`/v1/agents/${other.agentId}/profile`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: bodyStr,
    });

    expect(res.status).toBe(403);
  });
});

describe('GET /v1/agents/:id/reputation', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns reputation breakdown', async () => {
    const agent = await createTestAgent(db, { status: 'active' });

    const res = await app.request(`/v1/agents/${agent.agentId}/reputation`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.agent_id).toBe(agent.agentId);
    expect(typeof data.reputation_score).toBe('number');
    expect(data.breakdown).toBeDefined();
    expect(data.confidence).toBeDefined();
    expect(data.verifications_received).toBeDefined();
    expect(data.verifications_given).toBeDefined();
  });

  it('not found → 404', async () => {
    const res = await app.request('/v1/agents/ag_nonexistent999/reputation');
    expect(res.status).toBe(404);
  });
});
