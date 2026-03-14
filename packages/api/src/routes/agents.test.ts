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

  it('resolves agent by name (case-insensitive)', async () => {
    const agent = await createTestAgent(db, { name: 'HansTheAgent', status: 'active' });

    // Exact name
    const res1 = await app.request('/v1/agents/HansTheAgent');
    expect(res1.status).toBe(200);
    const data1 = await res1.json() as Record<string, unknown>;
    expect(data1.agent_id).toBe(agent.agentId);

    // Different casing
    const res2 = await app.request('/v1/agents/hanstheagent');
    expect(res2.status).toBe(200);
    const data2 = await res2.json() as Record<string, unknown>;
    expect(data2.agent_id).toBe(agent.agentId);
  });

  it('returns 404 for unknown name', async () => {
    const res = await app.request('/v1/agents/NonExistentAgentName');
    expect(res.status).toBe(404);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('not_found');
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

describe('Wallet Endpoints', () => {
  let db: SQLiteAdapter;
  let app: ReturnType<typeof createTestApp>;
  let agent: TestKeypair & { name: string };
  let otherAgent: TestKeypair & { name: string };

  beforeEach(async () => {
    db = setupTestDb();
    app = createTestApp(db);
    vi.stubGlobal('fetch', mockFetch);
    agent = await createTestAgent(db, { name: 'WalletAgent', status: 'active' });
    otherAgent = await createTestAgent(db, { name: 'OtherWalletAgent', status: 'active' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('GET /v1/agents/:id/wallet returns wallet info', async () => {
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.agent_id).toBe(agent.agentId);
    expect(data.wallet_address).toBeNull();
    expect(data.wallet_network).toBe('eip155:8453');
  });

  it('PATCH /v1/agents/:id/wallet updates wallet', async () => {
    const body = JSON.stringify({
      wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, body);
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.wallet_address).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(data.wallet_network).toBe('eip155:8453');
  });

  it('PATCH /v1/agents/:id/wallet rejects other agent → 403', async () => {
    const body = JSON.stringify({
      wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const headers = await signRequest(otherAgent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, body);
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(403);
  });

  it('agent profile response includes wallet_address and wallet_network', async () => {
    await db.run(
      'UPDATE agents SET wallet_address = ? WHERE id = ?',
      '0x1111111111111111111111111111111111111111', agent.agentId
    );

    const res = await app.request(`/v1/agents/${agent.agentId}`);
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, unknown>;
    expect(data.wallet_address).toBe('0x1111111111111111111111111111111111111111');
    expect(data.wallet_network).toBe('eip155:8453');
  });

  it('GET /v1/agents/:id/wallet returns 404 for unknown agent', async () => {
    const res = await app.request('/v1/agents/ag_nonexistent/wallet');
    expect(res.status).toBe(404);
  });

  it('PATCH /v1/agents/:id/wallet rejects invalid network → 400', async () => {
    const body = JSON.stringify({
      wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      wallet_network: 'not-a-valid-network',
    });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, body);
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('bad_request');
  });

  it('PATCH /v1/agents/:id/wallet rejects invalid address → 400', async () => {
    const body = JSON.stringify({
      wallet_address: 'not-an-evm-address',
    });
    const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, body);
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    expect(res.status).toBe(400);
    const data = await res.json() as { error: string };
    expect(data.error).toBe('bad_request');
  });

  it('PATCH /v1/agents/:id/wallet accepts all ALLOWED_WALLET_NETWORKS', async () => {
    const ALLOWED = [
      'eip155:8453',
      'eip155:84532',
      'eip155:1',
      'eip155:137',
      'eip155:42161',
      'eip155:10',
    ];

    for (const network of ALLOWED) {
      const body = JSON.stringify({
        wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        wallet_network: network,
      });
      const headers = await signRequest(agent, 'PATCH', `/v1/agents/${agent.agentId}/wallet`, body);
      const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
      });
      expect(res.status).toBe(200);
      const data = await res.json() as Record<string, unknown>;
      expect(data.wallet_network).toBe(network);
    }
  });

  it('PATCH /v1/agents/:id/wallet without auth → 401', async () => {
    const body = JSON.stringify({
      wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
    });
    const res = await app.request(`/v1/agents/${agent.agentId}/wallet`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
    expect(res.status).toBe(401);
  });
});
