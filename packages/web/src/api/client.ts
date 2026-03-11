import type {
  ApiAgent,
  ApiAgentSearchResponse,
  ApiChainEntry,
  ApiChainRangeResponse,
  ApiChainLatestResponse,
  ApiReputationResponse,
  SearchParams,
} from './types';
import type { Agent, Verification, ChainEntry } from '../data/mockData';

export type { SearchParams } from './types';

const API_BASE = import.meta.env.VITE_API_URL || 'https://auth.ai';

// ─── Mappers: API (snake_case) → Frontend (camelCase) ───

export function mapApiAgentToAgent(a: ApiAgent): Agent {
  return {
    id: a.agent_id,
    name: a.name,
    description: a.description,
    capabilities: a.capabilities,
    protocols: a.protocols,
    offers: a.offers || [],
    needs: a.needs || [],
    homepage: a.homepage ?? undefined,
    status: a.status,
    reputationScore: a.reputation_score,
    verificationCount: a.verification_count,
    registeredAt: a.registered_at,
    lastSeen: a.last_seen || a.registered_at,
    // Chain fields not available from search/profile endpoint — use defaults
    chainSequence: 0,
    entryHash: '',
    previousHash: '',
    nonce: '',
    skills: a.skills || [],
  };
}

export function mapApiVerifications(a: ApiAgent): Verification[] {
  if (!a.recent_verifications) return [];
  return a.recent_verifications.map((v, i) => ({
    id: `v${i}`,
    verifierId: v.verifier,
    verifierName: v.verifier,
    targetId: a.agent_id,
    result: v.result,
    coherenceScore: v.coherence_score ?? 0,
    responseTimeMs: 0,
    notes: '',
    createdAt: v.date,
  }));
}

export function mapApiChainEntry(e: ApiChainEntry): ChainEntry {
  return {
    sequence: e.sequence,
    entryHash: e.entry_hash,
    previousHash: e.previous_hash,
    agentId: e.agent_id,
    agentName: e.agent_name ?? '',
    agentStatus: 'active',
    agentComment: e.agent_comment ?? null,
    timestamp: e.timestamp,
    nonce: e.nonce,
    profileHash: e.profile_hash,
  };
}

// ─── API Client ───

class FetchError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function fetchJson<T>(path: string): Promise<T> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new FetchError(res.status, body || `HTTP ${res.status}`);
  }
  return res.json();
}

export const api = {
  async getAgent(id: string): Promise<ApiAgent> {
    return fetchJson<ApiAgent>(`/v1/agents/${encodeURIComponent(id)}`);
  },

  async searchAgents(params: SearchParams = {}): Promise<ApiAgentSearchResponse> {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.capabilities) qs.set('capabilities', params.capabilities);
    if (params.protocols) qs.set('protocols', params.protocols);
    if (params.offers) qs.set('offers', params.offers);
    if (params.needs) qs.set('needs', params.needs);
    if (params.status) qs.set('status', params.status);
    if (params.page) qs.set('page', String(params.page));
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.sort) qs.set('sort', params.sort);
    const query = qs.toString();
    return fetchJson<ApiAgentSearchResponse>(`/v1/agents/search${query ? '?' + query : ''}`);
  },

  async getChainLatest(): Promise<ApiChainLatestResponse> {
    return fetchJson<ApiChainLatestResponse>('/v1/chain/latest');
  },

  async getChainEntry(sequence: number): Promise<ApiChainEntry> {
    return fetchJson<ApiChainEntry>(`/v1/chain/${sequence}`);
  },

  async getChainRange(from?: number, to?: number): Promise<ApiChainRangeResponse> {
    const qs = new URLSearchParams();
    if (from !== undefined) qs.set('from', String(from));
    if (to !== undefined) qs.set('to', String(to));
    const query = qs.toString();
    return fetchJson<ApiChainRangeResponse>(`/v1/chain${query ? '?' + query : ''}`);
  },

  async getReputation(id: string): Promise<ApiReputationResponse> {
    return fetchJson<ApiReputationResponse>(`/v1/agents/${encodeURIComponent(id)}/reputation`);
  },
};
