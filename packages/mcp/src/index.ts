#!/usr/bin/env node
/**
 * BasedAgents MCP Server
 *
 * Exposes the BasedAgents registry to any MCP-compatible runtime
 * (Claude, OpenClaw, LangChain, etc.) via stdio transport.
 *
 * Tools:
 *   search_agents       — find agents by capability, protocol, name, etc.
 *   get_agent           — get full profile for a specific agent
 *   get_reputation      — detailed reputation breakdown for an agent
 *   get_chain_status    — current chain height + latest entry
 *   get_chain_entry     — look up a specific chain entry by sequence number
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const API = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';
const VERSION = '0.1.0';

// ─── API helpers ────────────────────────────────────────────────────────────

async function apiFetch(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    headers: { 'User-Agent': `basedagents-mcp/${VERSION}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`API error ${res.status}: ${body || path}`);
  }
  return res.json();
}

function formatAgent(a: Record<string, unknown>): string {
  const lines: string[] = [
    `## ${a.name} (${a.agent_id})`,
    `**Status:** ${a.status}  |  **Reputation:** ${Number(a.reputation_score).toFixed(3)}  |  **Verifications:** ${a.verification_count}`,
    '',
    a.description as string,
    '',
  ];

  if (a.organization) lines.push(`**Organization:** ${a.organization}${a.organization_url ? ` — ${a.organization_url}` : ''}`);
  if (a.homepage)     lines.push(`**Homepage:** ${a.homepage}`);
  if (a.contact_endpoint) lines.push(`**Endpoint:** ${a.contact_endpoint}`);

  const caps = (a.capabilities as string[] | undefined) ?? [];
  if (caps.length) lines.push(`\n**Capabilities:** ${caps.join(', ')}`);

  const protos = (a.protocols as string[] | undefined) ?? [];
  if (protos.length) lines.push(`**Protocols:** ${protos.join(', ')}`);

  const offers = (a.offers as string[] | undefined) ?? [];
  if (offers.length) lines.push(`**Offers:** ${offers.join(', ')}`);

  const needs = (a.needs as string[] | undefined) ?? [];
  if (needs.length) lines.push(`**Needs:** ${needs.join(', ')}`);

  const tags = (a.tags as string[] | undefined) ?? [];
  if (tags.length) lines.push(`**Tags:** ${tags.join(', ')}`);

  const skills = (a.skills as Array<{ name: string; registry: string; private?: boolean }> | undefined) ?? [];
  if (skills.length) {
    lines.push(`\n**Skills:**`);
    for (const s of skills) {
      lines.push(`  - ${s.name} (${s.registry})${s.private ? ' [private]' : ''}`);
    }
  }

  const verifs = (a.recent_verifications as Array<{ verifier: string; result: string; coherence_score: number | null; date: string }> | undefined) ?? [];
  if (verifs.length) {
    lines.push(`\n**Recent Verifications:**`);
    for (const v of verifs) {
      const icon = v.result === 'pass' ? '✓' : v.result === 'fail' ? '✗' : '~';
      const coh = v.coherence_score != null ? ` coherence=${v.coherence_score.toFixed(2)}` : '';
      lines.push(`  ${icon} ${v.result}${coh} by ${v.verifier.slice(0, 16)}… (${v.date.slice(0, 10)})`);
    }
  }

  lines.push(`\n**Registered:** ${(a.registered_at as string).slice(0, 10)}`);
  if (a.last_seen) lines.push(`**Last seen:** ${(a.last_seen as string).slice(0, 10)}`);

  return lines.join('\n');
}

function formatReputation(r: Record<string, unknown>): string {
  const b = r.breakdown as Record<string, number> ?? {};
  const lines = [
    `## Reputation: ${Number(r.reputation_score).toFixed(4)}`,
    `**Confidence:** ${Math.round(Number(r.confidence) * 100)}%  |  **Raw score:** ${Number(r.raw_score).toFixed(4)}`,
    `**Verifications received:** ${r.verifications_received}  |  **Given:** ${r.verifications_given}`,
    '',
    '### Breakdown',
    `| Component     | Score |`,
    `|---|---|`,
    `| Pass rate     | ${Math.round((b.pass_rate ?? 0) * 100)}% |`,
    `| Coherence     | ${Math.round((b.coherence ?? 0) * 100)}% |`,
    `| Contribution  | ${Math.round((b.contribution ?? 0) * 100)}% |`,
    `| Uptime        | ${Math.round((b.uptime ?? 0) * 100)}% |`,
    `| Skill trust   | ${Math.round((b.skill_trust ?? 0) * 100)}% |`,
  ];

  if (Number(r.penalty ?? 0) > 0) {
    lines.push(`\n⚠️ **Penalty:** -${Math.round(Number(r.penalty) * 100)}% (safety/auth violations)`);
  }
  if (Number(r.safety_flags ?? 0) > 0) {
    lines.push(`🚩 **Safety flags:** ${r.safety_flags}`);
  } else {
    lines.push(`\n✓ No safety flags`);
  }

  return lines.join('\n');
}

// ─── Server ─────────────────────────────────────────────────────────────────

const server = new McpServer({
  name: 'basedagents',
  version: VERSION,
});

// ── search_agents ────────────────────────────────────────────────────────────
server.tool(
  'search_agents',
  'Search the BasedAgents registry for AI agents. Filter by capabilities, protocols, offers, needs, or free-text query. Results are sorted by reputation score.',
  {
    q:            z.string().optional().describe('Free-text search across name and description'),
    capabilities: z.string().optional().describe('Comma-separated capabilities to filter by, e.g. "code,reasoning"'),
    protocols:    z.string().optional().describe('Comma-separated protocols, e.g. "mcp,rest"'),
    offers:       z.string().optional().describe('Comma-separated services the agent offers'),
    needs:        z.string().optional().describe('Comma-separated resources the agent needs'),
    status:       z.enum(['active', 'pending', 'suspended']).optional().describe('Filter by agent status (default: active)'),
    limit:        z.number().int().min(1).max(50).optional().describe('Max results to return (default 10)'),
    sort:         z.enum(['reputation', 'registered_at']).optional().describe('Sort order (default: reputation)'),
  },
  async (params) => {
    const qs = new URLSearchParams();
    if (params.q)            qs.set('q', params.q);
    if (params.capabilities) qs.set('capabilities', params.capabilities);
    if (params.protocols)    qs.set('protocols', params.protocols);
    if (params.offers)       qs.set('offers', params.offers);
    if (params.needs)        qs.set('needs', params.needs);
    if (params.status)       qs.set('status', params.status);
    if (params.limit)        qs.set('limit', String(params.limit));
    if (params.sort)         qs.set('sort', params.sort);

    const data = await apiFetch(`/v1/agents/search?${qs}`) as {
      agents: Record<string, unknown>[];
      pagination: { total: number; page: number; total_pages: number };
    };

    if (!data.agents.length) {
      return { content: [{ type: 'text', text: 'No agents found matching your criteria.' }] };
    }

    const lines = [
      `Found **${data.pagination.total}** agent${data.pagination.total !== 1 ? 's' : ''}` +
      ` (showing ${data.agents.length}):\n`,
    ];

    for (const a of data.agents) {
      const rep = Number(a.reputation_score).toFixed(3);
      const verified = Number(a.verification_count) > 0 ? ' ✓' : '';
      const caps = ((a.capabilities as string[] | undefined) ?? []).slice(0, 3).join(', ');
      lines.push(`### ${a.name}${verified}`);
      lines.push(`**ID:** \`${a.agent_id}\``);
      lines.push(`**Rep:** ${rep}  |  **Status:** ${a.status}  |  **Caps:** ${caps}`);
      lines.push(`${a.description}`);
      lines.push('');
    }

    lines.push(`\nUse \`get_agent\` with an agent ID for full details.`);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── get_agent ────────────────────────────────────────────────────────────────
server.tool(
  'get_agent',
  'Get the full profile for a specific agent by their agent ID (ag_xxx...).',
  {
    agent_id: z.string().describe('The agent ID, e.g. ag_7Xk9mP2qR8nK4vL3'),
  },
  async ({ agent_id }) => {
    const data = await apiFetch(`/v1/agents/${encodeURIComponent(agent_id)}`) as Record<string, unknown>;
    return { content: [{ type: 'text', text: formatAgent(data) }] };
  }
);

// ── get_reputation ───────────────────────────────────────────────────────────
server.tool(
  'get_reputation',
  'Get the detailed reputation breakdown for an agent — pass rate, coherence, skill trust, uptime, contribution, penalty, and safety flags.',
  {
    agent_id: z.string().describe('The agent ID to get reputation for'),
  },
  async ({ agent_id }) => {
    const data = await apiFetch(`/v1/agents/${encodeURIComponent(agent_id)}/reputation`) as Record<string, unknown>;
    return { content: [{ type: 'text', text: formatReputation(data) }] };
  }
);

// ── get_chain_status ─────────────────────────────────────────────────────────
server.tool(
  'get_chain_status',
  'Get the current state of the BasedAgents hash chain — height, latest entry hash, and registry stats.',
  {},
  async () => {
    const [latest, status] = await Promise.all([
      apiFetch('/v1/chain/latest') as Promise<Record<string, unknown>>,
      apiFetch('/v1/status') as Promise<Record<string, unknown>>,
    ]);

    const agents = status.agents as Record<string, number> ?? {};
    const verifs = status.verifications as Record<string, unknown> ?? {};

    const lines = [
      `## BasedAgents Chain`,
      `**Height:** #${latest.sequence}`,
      `**Latest hash:** \`${latest.entry_hash}\``,
      '',
      `### Registry`,
      `**Total agents:** ${agents.total ?? 0}  |  **Active:** ${agents.active ?? 0}  |  **Pending:** ${agents.pending ?? 0}`,
      `**Total verifications:** ${verifs.total ?? 0}`,
      `**Status:** ${status.status}  |  **DB latency:** ${status.db_latency_ms}ms`,
      `**Checked:** ${(status.checked_at as string | undefined)?.slice(0, 19).replace('T', ' ')} UTC`,
    ];

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ── get_chain_entry ──────────────────────────────────────────────────────────
server.tool(
  'get_chain_entry',
  'Look up a specific entry in the BasedAgents hash chain by sequence number.',
  {
    sequence: z.number().int().min(1).describe('Chain sequence number'),
  },
  async ({ sequence }) => {
    const e = await apiFetch(`/v1/chain/${sequence}`) as Record<string, unknown>;

    const lines = [
      `## Chain Entry #${e.sequence}`,
      `**Agent:** ${e.agent_name ?? 'unknown'} (\`${e.agent_id}\`)`,
      `**Entry hash:** \`${e.entry_hash}\``,
      `**Previous hash:** \`${e.previous_hash}\``,
      `**PoW nonce:** ${e.nonce}`,
      `**Profile hash:** \`${e.profile_hash}\``,
      `**Timestamp:** ${e.timestamp}`,
      e.entry_type ? `**Type:** ${e.entry_type}` : '',
    ].filter(Boolean);

    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

// ─── Start ──────────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Server runs until stdin closes
}

main().catch(err => {
  process.stderr.write(`[basedagents-mcp] Fatal: ${err.message}\n`);
  process.exit(1);
});
