import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  RegistryClient,
  generateKeypair,
  publicKeyToAgentId,
  type Agent,
  type ReputationBreakdown,
} from './index.js';

// ─── Helpers ───

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'ag_TestAgent123',
    name: 'TestAgent',
    description: 'A test agent',
    status: 'active',
    reputation_score: 0.8,
    verification_count: 10,
    capabilities: ['code'],
    protocols: ['https'],
    created_at: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeReputation(agentId = 'ag_TestAgent123'): ReputationBreakdown {
  return {
    agent_id: agentId,
    reputation_score: 0.8,
    confidence: 0.9,
    penalty: 0,
    safety_flags: 0,
    breakdown: {
      pass_rate: 0.85,
      coherence: 0.80,
      contribution: 0.75,
      uptime: 0.90,
      skill_trust: 0.70,
    },
    weights: {
      pass_rate: 0.3,
      coherence: 0.2,
      contribution: 0.2,
      uptime: 0.2,
      skill_trust: 0.1,
      penalty: 0,
    },
    verifications_received: 20,
    verifications_given: 15,
  };
}

function makeMockResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

// ─── Tests ───

describe('RegistryClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // ── searchAgents ──

  describe('searchAgents()', () => {
    it('sends a GET request to /v1/agents/search', async () => {
      const payload = { agents: [makeAgent()], total: 1, page: 1 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.searchAgents({});

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/agents/search');
    });

    it('passes query parameters in the URL', async () => {
      const payload = { agents: [], total: 0, page: 1 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(payload));

      const client = new RegistryClient('https://api.test.local');
      await client.searchAgents({ q: 'hello', status: 'active', page: 2 });

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('q=hello');
      expect(url).toContain('status=active');
      expect(url).toContain('page=2');
    });

    it('returns parsed agents array', async () => {
      const agents = [makeAgent({ name: 'AgentOne' }), makeAgent({ name: 'AgentTwo' })];
      mockFetch.mockResolvedValueOnce(makeMockResponse({ agents, total: 2, page: 1 }));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.searchAgents();

      expect(result.agents).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.agents[0].name).toBe('AgentOne');
    });
  });

  // ── getAgent ──

  describe('getAgent()', () => {
    it('sends GET to /v1/agents/:id', async () => {
      const agent = makeAgent();
      mockFetch.mockResolvedValueOnce(makeMockResponse(agent));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getAgent('ag_TestAgent123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/agents/ag_TestAgent123');
      expect(result.name).toBe('TestAgent');
    });

    it('throws on 404', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Not found' }, 404));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.getAgent('ag_missing')).rejects.toThrow('404');
    });

    it('throws on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.getAgent('ag_test')).rejects.toThrow('Network error');
    });
  });

  // ── getReputation ──

  describe('getReputation()', () => {
    it('sends GET to /v1/agents/:id/reputation', async () => {
      const rep = makeReputation();
      mockFetch.mockResolvedValueOnce(makeMockResponse(rep));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getReputation('ag_TestAgent123');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('https://api.test.local/v1/agents/ag_TestAgent123/reputation');
      expect(result.reputation_score).toBe(0.8);
    });

    it('returns full reputation breakdown', async () => {
      const rep = makeReputation('ag_SomeAgent');
      mockFetch.mockResolvedValueOnce(makeMockResponse(rep));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.getReputation('ag_SomeAgent');

      expect(result.agent_id).toBe('ag_SomeAgent');
      expect(result.breakdown).toHaveProperty('pass_rate');
      expect(result.breakdown).toHaveProperty('coherence');
    });
  });

  // ── updateProfile ──

  describe('updateProfile()', () => {
    it('sends PATCH to /v1/agents/:id/profile with auth headers', async () => {
      const kp = await generateKeypair();
      const agentId = publicKeyToAgentId(kp.publicKey);
      const updatedAgent = makeAgent({ name: 'UpdatedAgent' });
      mockFetch.mockResolvedValueOnce(makeMockResponse(updatedAgent));

      const client = new RegistryClient('https://api.test.local');
      await client.updateProfile(kp, { name: 'UpdatedAgent' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain(`/v1/agents/${agentId}/profile`);
      expect(init.method).toBe('PATCH');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);
      expect(init.headers?.['X-Timestamp']).toBeDefined();
    });

    it('throws on 400 error', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Validation failed' }, 400));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.updateProfile(kp, { name: '' })).rejects.toThrow('400');
    });
  });

  // ── register ──

  describe('register()', () => {
    it('solves PoW and submits registration', async () => {
      const kp = await generateKeypair();
      const challenge = 'dGVzdC1jaGFsbGVuZ2U='; // base64 test string

      // Step 1: init response (low difficulty for test speed)
      const initPayload = { challenge_id: 'chal_123', challenge, difficulty: 4 };
      // Step 2: complete response
      const completePayload = { agent: makeAgent() };

      mockFetch
        .mockResolvedValueOnce(makeMockResponse(initPayload))
        .mockResolvedValueOnce(makeMockResponse(completePayload));

      const client = new RegistryClient('https://api.test.local');
      const agent = await client.register(kp, {
        name: 'TestAgent',
        description: 'A test agent',
        capabilities: ['code'],
        protocols: ['https'],
      });

      expect(agent.name).toBe('TestAgent');

      // Verify init was called first
      expect(mockFetch).toHaveBeenCalledTimes(2);
      const [initUrl, initOpts] = mockFetch.mock.calls[0];
      expect(initUrl).toContain('/v1/register/init');
      expect(initOpts.method).toBe('POST');

      // Verify complete was called with all required fields
      const [completeUrl, completeOpts] = mockFetch.mock.calls[1];
      expect(completeUrl).toContain('/v1/register/complete');
      const completeBody = JSON.parse(completeOpts.body);
      expect(completeBody.challenge_id).toBe('chal_123');
      expect(completeBody.nonce).toMatch(/^[0-9a-f]{8}$/);
      expect(completeBody.signature).toBeDefined();
      expect(completeBody.profile.name).toBe('TestAgent');
    });

    it('throws when init fails', async () => {
      const kp = await generateKeypair();
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Server error' }, 500));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.register(kp, {
        name: 'TestAgent',
        description: 'desc',
        capabilities: ['code'],
        protocols: ['https'],
      })).rejects.toThrow('500');
    });
  });

  // ── submitVerification ──

  describe('submitVerification()', () => {
    it('sends POST to /v1/verify/submit with auth headers', async () => {
      const kp = await generateKeypair();
      const responsePayload = { ok: true, verification_id: 'v_123', target_reputation_delta: 0.01 };
      mockFetch.mockResolvedValueOnce(makeMockResponse(responsePayload));

      const client = new RegistryClient('https://api.test.local');
      const result = await client.submitVerification(kp, {
        assignment_id: 'a_123',
        target_id: 'ag_target',
        result: 'pass',
        coherence_score: 0.9,
        notes: 'Excellent',
      });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toContain('/v1/verify/submit');
      expect(init.method).toBe('POST');
      expect(init.headers?.Authorization).toMatch(/^AgentSig /);

      const body = JSON.parse(init.body);
      expect(body.assignment_id).toBe('a_123');
      expect(body.target_id).toBe('ag_target');
      expect(body.result).toBe('pass');
      expect(body.signature).toBeDefined(); // Report signed before submission
      expect(body.nonce).toBeDefined();
    });
  });

  // ── Error handling ──

  describe('error handling', () => {
    it('throws with status code on API error', async () => {
      mockFetch.mockResolvedValueOnce(makeMockResponse({ message: 'Bad request' }, 400));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.searchAgents()).rejects.toThrow('400');
    });

    it('propagates network errors', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('Failed to fetch'));

      const client = new RegistryClient('https://api.test.local');
      await expect(client.searchAgents()).rejects.toThrow('Failed to fetch');
    });
  });
});
