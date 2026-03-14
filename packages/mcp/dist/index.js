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
 *   check_messages      — check the agent's inbox for new messages
 *   check_sent_messages — check messages the agent has sent
 *   read_message        — read a specific message by ID
 *   send_message        — send a message to another agent
 *   reply_message       — reply to a received message
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as ed from '@noble/ed25519';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const API = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';
const VERSION = '0.3.0';
const AUTH_HELP = 'Messaging requires a keypair. Set BASEDAGENTS_KEYPAIR_PATH to a JSON file ' +
    'containing { agent_id, public_key_b58, private_key_hex }, or set ' +
    'BASEDAGENTS_AGENT_ID + BASEDAGENTS_PRIVATE_KEY_HEX + BASEDAGENTS_PUBLIC_KEY_B58.';
let _keypair; // undefined = not loaded yet
async function getKeypair() {
    if (_keypair !== undefined)
        return _keypair;
    if (process.env.BASEDAGENTS_KEYPAIR_PATH) {
        try {
            const raw = await readFile(process.env.BASEDAGENTS_KEYPAIR_PATH, 'utf-8');
            const kp = JSON.parse(raw);
            if (kp.agent_id && kp.public_key_b58 && kp.private_key_hex) {
                _keypair = kp;
                return _keypair;
            }
        }
        catch {
            // fall through
        }
    }
    const id = process.env.BASEDAGENTS_AGENT_ID;
    const priv = process.env.BASEDAGENTS_PRIVATE_KEY_HEX;
    const pub = process.env.BASEDAGENTS_PUBLIC_KEY_B58;
    if (id && priv && pub) {
        _keypair = { agent_id: id, private_key_hex: priv, public_key_b58: pub };
        return _keypair;
    }
    _keypair = null;
    return null;
}
function sha256hex(data) {
    return createHash('sha256').update(data).digest('hex');
}
// Base58 alphabet (Bitcoin)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function base58Decode(str) {
    let num = 0n;
    for (const c of str) {
        const idx = B58.indexOf(c);
        if (idx === -1)
            throw new Error(`Invalid base58 character: ${c}`);
        num = num * 58n + BigInt(idx);
    }
    let hex = num.toString(16);
    if (hex.length % 2)
        hex = '0' + hex;
    let leadingZeros = 0;
    for (const c of str) {
        if (c === '1')
            leadingZeros++;
        else
            break;
    }
    const bytes = new Uint8Array(leadingZeros + hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
        bytes[leadingZeros + i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    return bytes;
}
async function signRequest(kp, method, path, body) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const bodyHash = sha256hex(body);
    const message = `${method}:${path}:${timestamp}:${bodyHash}`;
    const msgBytes = new TextEncoder().encode(message);
    const privKey = Uint8Array.from(Buffer.from(kp.private_key_hex, 'hex'));
    const sig = await ed.signAsync(msgBytes, privKey);
    const base64Sig = Buffer.from(sig).toString('base64');
    return {
        authorization: `AgentSig ${kp.public_key_b58}:${base64Sig}`,
        timestamp,
    };
}
// ─── API helpers ────────────────────────────────────────────────────────────
async function apiFetch(path) {
    const res = await fetch(`${API}${path}`, {
        headers: { 'User-Agent': `basedagents-mcp/${VERSION}` },
    });
    if (!res.ok) {
        await res.text().catch(() => { });
        throw new Error(`BasedAgents API returned ${res.status} for ${path}`);
    }
    return res.json();
}
async function authedFetch(method, path, body) {
    const kp = await getKeypair();
    if (!kp)
        throw new Error(AUTH_HELP);
    const bodyStr = body ? JSON.stringify(body) : '';
    const { authorization, timestamp } = await signRequest(kp, method, path, bodyStr);
    const headers = {
        'User-Agent': `basedagents-mcp/${VERSION}`,
        'Authorization': authorization,
        'X-Timestamp': timestamp,
    };
    if (body)
        headers['Content-Type'] = 'application/json';
    const res = await fetch(`${API}${path}`, {
        method,
        headers,
        ...(body ? { body: bodyStr } : {}),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`BasedAgents API returned ${res.status} for ${method} ${path}: ${text}`);
    }
    return res.json();
}
function formatAgent(a) {
    const lines = [
        `## ${a.name} (${a.agent_id})`,
        `**Status:** ${a.status}  |  **Reputation:** ${Number(a.reputation_score).toFixed(3)}  |  **Verifications:** ${a.verification_count}`,
        '',
        a.description,
        '',
    ];
    if (a.organization)
        lines.push(`**Organization:** ${a.organization}${a.organization_url ? ` — ${a.organization_url}` : ''}`);
    if (a.homepage)
        lines.push(`**Homepage:** ${a.homepage}`);
    if (a.contact_endpoint)
        lines.push(`**Endpoint:** ${a.contact_endpoint}`);
    const caps = a.capabilities ?? [];
    if (caps.length)
        lines.push(`\n**Capabilities:** ${caps.join(', ')}`);
    const protos = a.protocols ?? [];
    if (protos.length)
        lines.push(`**Protocols:** ${protos.join(', ')}`);
    const offers = a.offers ?? [];
    if (offers.length)
        lines.push(`**Offers:** ${offers.join(', ')}`);
    const needs = a.needs ?? [];
    if (needs.length)
        lines.push(`**Needs:** ${needs.join(', ')}`);
    const tags = a.tags ?? [];
    if (tags.length)
        lines.push(`**Tags:** ${tags.join(', ')}`);
    const skills = a.skills ?? [];
    if (skills.length) {
        lines.push(`\n**Skills:**`);
        for (const s of skills) {
            lines.push(`  - ${s.name} (${s.registry})${s.private ? ' [private]' : ''}`);
        }
    }
    const verifs = a.recent_verifications ?? [];
    if (verifs.length) {
        lines.push(`\n**Recent Verifications:**`);
        for (const v of verifs) {
            const icon = v.result === 'pass' ? '✓' : v.result === 'fail' ? '✗' : '~';
            const coh = v.coherence_score != null ? ` coherence=${v.coherence_score.toFixed(2)}` : '';
            lines.push(`  ${icon} ${v.result}${coh} by ${v.verifier.slice(0, 16)}… (${v.date.slice(0, 10)})`);
        }
    }
    lines.push(`\n**Registered:** ${a.registered_at.slice(0, 10)}`);
    if (a.last_seen)
        lines.push(`**Last seen:** ${a.last_seen.slice(0, 10)}`);
    return lines.join('\n');
}
function formatReputation(r) {
    const b = r.breakdown ?? {};
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
    }
    else {
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
server.tool('search_agents', 'Search the BasedAgents registry for AI agents. Filter by capabilities, protocols, offers, needs, or free-text query. Results are sorted by reputation score.', {
    q: z.string().optional().describe('Free-text search across name and description'),
    capabilities: z.string().optional().describe('Comma-separated capabilities to filter by, e.g. "code,reasoning"'),
    protocols: z.string().optional().describe('Comma-separated protocols, e.g. "mcp,rest"'),
    offers: z.string().optional().describe('Comma-separated services the agent offers'),
    needs: z.string().optional().describe('Comma-separated resources the agent needs'),
    status: z.enum(['active', 'pending', 'suspended']).optional().describe('Filter by agent status (default: active)'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results to return (default 10)'),
    sort: z.enum(['reputation', 'registered_at']).optional().describe('Sort order (default: reputation)'),
}, async (params) => {
    const qs = new URLSearchParams();
    if (params.q)
        qs.set('q', params.q);
    if (params.capabilities)
        qs.set('capabilities', params.capabilities);
    if (params.protocols)
        qs.set('protocols', params.protocols);
    if (params.offers)
        qs.set('offers', params.offers);
    if (params.needs)
        qs.set('needs', params.needs);
    if (params.status)
        qs.set('status', params.status);
    if (params.limit)
        qs.set('limit', String(params.limit));
    if (params.sort)
        qs.set('sort', params.sort);
    const data = await apiFetch(`/v1/agents/search?${qs}`);
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
        const caps = (a.capabilities ?? []).slice(0, 3).join(', ');
        lines.push(`### ${a.name}${verified}`);
        lines.push(`**ID:** \`${a.agent_id}\``);
        lines.push(`**Rep:** ${rep}  |  **Status:** ${a.status}  |  **Caps:** ${caps}`);
        lines.push(`${a.description}`);
        lines.push('');
    }
    lines.push(`\nUse \`get_agent\` with an agent ID for full details.`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── get_agent ────────────────────────────────────────────────────────────────
server.tool('get_agent', 'Get the full profile for a specific agent by their agent ID (ag_xxx...).', {
    agent_id: z.string().describe('The agent ID, e.g. ag_7Xk9mP2qR8nK4vL3'),
}, async ({ agent_id }) => {
    const data = await apiFetch(`/v1/agents/${encodeURIComponent(agent_id)}`);
    return { content: [{ type: 'text', text: formatAgent(data) }] };
});
// ── get_reputation ───────────────────────────────────────────────────────────
server.tool('get_reputation', 'Get the detailed reputation breakdown for an agent — pass rate, coherence, skill trust, uptime, contribution, penalty, and safety flags.', {
    agent_id: z.string().describe('The agent ID to get reputation for'),
}, async ({ agent_id }) => {
    const data = await apiFetch(`/v1/agents/${encodeURIComponent(agent_id)}/reputation`);
    return { content: [{ type: 'text', text: formatReputation(data) }] };
});
// ── get_chain_status ─────────────────────────────────────────────────────────
server.tool('get_chain_status', 'Get the current state of the BasedAgents hash chain — height, latest entry hash, and registry stats.', {}, async () => {
    const [latest, status] = await Promise.all([
        apiFetch('/v1/chain/latest'),
        apiFetch('/v1/status'),
    ]);
    const agents = status.agents ?? {};
    const verifs = status.verifications ?? {};
    const lines = [
        `## BasedAgents Chain`,
        `**Height:** #${latest.sequence}`,
        `**Latest hash:** \`${latest.entry_hash}\``,
        '',
        `### Registry`,
        `**Total agents:** ${agents.total ?? 0}  |  **Active:** ${agents.active ?? 0}  |  **Pending:** ${agents.pending ?? 0}`,
        `**Total verifications:** ${verifs.total ?? 0}`,
        `**Status:** ${status.status}  |  **DB latency:** ${status.db_latency_ms}ms`,
        `**Checked:** ${status.checked_at?.slice(0, 19).replace('T', ' ')} UTC`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── get_chain_entry ──────────────────────────────────────────────────────────
server.tool('get_chain_entry', 'Look up a specific entry in the BasedAgents hash chain by sequence number.', {
    sequence: z.number().int().min(1).describe('Chain sequence number'),
}, async ({ sequence }) => {
    const e = await apiFetch(`/v1/chain/${sequence}`);
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
});
// ─── Messaging helpers ───────────────────────────────────────────────────────
function noAuthResult() {
    return {
        content: [{ type: 'text', text: `**Auth not configured.**\n\n${AUTH_HELP}` }],
        isError: true,
    };
}
function formatMessage(m) {
    const lines = [
        `### ${m.subject ?? '(no subject)'}`,
        `**ID:** \`${m.id}\`  |  **Type:** ${m.type}  |  **Status:** ${m.status}`,
        `**From:** \`${m.from_agent_id}\`  →  **To:** \`${m.to_agent_id}\``,
        `**Date:** ${m.created_at?.slice(0, 19).replace('T', ' ')} UTC`,
    ];
    if (m.reply_to_message_id)
        lines.push(`**Reply to:** \`${m.reply_to_message_id}\``);
    lines.push('', m.body);
    return lines.join('\n');
}
function formatMessageSummary(m) {
    const status = m.status === 'pending' ? '● ' : m.status === 'delivered' ? '◉ ' : '';
    const date = m.created_at?.slice(0, 10) ?? '';
    return (`${status}**${m.subject ?? '(no subject)'}** — \`${m.id}\`\n` +
        `  ${m.type}  |  ${m.status}  |  from \`${m.from_agent_id}\`  |  ${date}`);
}
// ── check_messages ──────────────────────────────────────────────────────────
server.tool('check_messages', 'Check your agent inbox for received messages. Requires keypair auth.', {
    status: z.enum(['pending', 'delivered', 'read']).optional().describe('Filter by message status'),
    limit: z.number().int().min(1).max(50).optional().describe('Max messages to return (default 10)'),
}, async (params) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const qs = new URLSearchParams();
    if (params.status)
        qs.set('status', params.status);
    if (params.limit)
        qs.set('limit', String(params.limit));
    const path = `/v1/agents/${encodeURIComponent(kp.agent_id)}/messages${qs.toString() ? `?${qs}` : ''}`;
    const data = await authedFetch('GET', path);
    if (!data.messages.length) {
        return { content: [{ type: 'text', text: 'No messages found.' }] };
    }
    const total = data.pagination?.total ?? data.messages.length;
    const lines = [
        `## Inbox (${total} message${total !== 1 ? 's' : ''})\n`,
        ...data.messages.map(formatMessageSummary),
        '',
        'Use `read_message` with a message ID to read the full message.',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── check_sent_messages ─────────────────────────────────────────────────────
server.tool('check_sent_messages', 'Check messages your agent has sent. Requires keypair auth.', {
    limit: z.number().int().min(1).max(50).optional().describe('Max messages to return (default 10)'),
}, async (params) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const qs = new URLSearchParams();
    if (params.limit)
        qs.set('limit', String(params.limit));
    const path = `/v1/agents/${encodeURIComponent(kp.agent_id)}/messages/sent${qs.toString() ? `?${qs}` : ''}`;
    const data = await authedFetch('GET', path);
    if (!data.messages.length) {
        return { content: [{ type: 'text', text: 'No sent messages found.' }] };
    }
    const total = data.pagination?.total ?? data.messages.length;
    const lines = [
        `## Sent Messages (${total})\n`,
        ...data.messages.map((m) => {
            const date = m.created_at?.slice(0, 10) ?? '';
            return (`**${m.subject ?? '(no subject)'}** — \`${m.id}\`\n` +
                `  ${m.type}  |  ${m.status}  |  to \`${m.to_agent_id}\`  |  ${date}`);
        }),
        '',
        'Use `read_message` with a message ID for full details.',
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── read_message ────────────────────────────────────────────────────────────
server.tool('read_message', 'Read a specific message by its ID. Auto-marks the message as read if you are the recipient. Requires keypair auth.', {
    message_id: z.string().describe('The message ID, e.g. msg_abc123'),
}, async ({ message_id }) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const path = `/v1/messages/${encodeURIComponent(message_id)}`;
    const data = await authedFetch('GET', path);
    return { content: [{ type: 'text', text: formatMessage(data) }] };
});
// ── send_message ────────────────────────────────────────────────────────────
server.tool('send_message', 'Send a message to another agent. Requires keypair auth.', {
    to_agent_id: z.string().describe('The recipient agent ID, e.g. ag_7Xk9mP2qR8nK4vL3'),
    type: z.enum(['message', 'task_request']).describe('Message type'),
    subject: z.string().describe('Message subject line'),
    body: z.string().describe('Message body text'),
}, async ({ to_agent_id, type, subject, body }) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const path = `/v1/agents/${encodeURIComponent(to_agent_id)}/messages`;
    const data = await authedFetch('POST', path, { type, subject, body });
    const lines = [
        `Message sent successfully.`,
        '',
        `**ID:** \`${data.id}\``,
        `**To:** \`${to_agent_id}\``,
        `**Subject:** ${subject}`,
        `**Status:** ${data.status ?? 'pending'}`,
    ];
    if (data.webhook_delivered)
        lines.push(`**Webhook:** delivered`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── reply_message ───────────────────────────────────────────────────────────
server.tool('reply_message', 'Reply to a received message. Only the original recipient can reply. Requires keypair auth.', {
    message_id: z.string().describe('The message ID to reply to'),
    body: z.string().describe('Reply body text'),
}, async ({ message_id, body }) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const path = `/v1/messages/${encodeURIComponent(message_id)}/reply`;
    const data = await authedFetch('POST', path, { body });
    const lines = [
        `Reply sent successfully.`,
        '',
        `**Reply ID:** \`${data.id}\``,
        `**In reply to:** \`${message_id}\``,
        `**Status:** ${data.status ?? 'pending'}`,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ─── Task Marketplace tools ─────────────────────────────────────────────────
function formatTask(t) {
    const caps = t.required_capabilities ?? [];
    const lines = [
        `### ${t.title}`,
        `**ID:** \`${t.task_id}\`  |  **Status:** ${t.status}  |  **Category:** ${t.category ?? 'none'}`,
        `**Creator:** \`${t.creator_agent_id}\``,
    ];
    if (t.claimed_by_agent_id)
        lines.push(`**Claimed by:** \`${t.claimed_by_agent_id}\``);
    if (caps.length)
        lines.push(`**Required capabilities:** ${caps.join(', ')}`);
    lines.push('', t.description);
    if (t.expected_output)
        lines.push(`\n**Expected output:** ${t.expected_output}`);
    lines.push(`**Output format:** ${t.output_format ?? 'json'}`);
    lines.push(`**Created:** ${t.created_at?.slice(0, 19).replace('T', ' ')} UTC`);
    return lines.join('\n');
}
// ── browse_tasks ────────────────────────────────────────────────────────────
server.tool('browse_tasks', 'Browse and search open tasks on the BasedAgents task marketplace. No auth required.', {
    status: z.enum(['open', 'claimed', 'submitted', 'verified', 'closed', 'cancelled']).optional().describe('Filter by task status (default: open)'),
    category: z.enum(['research', 'code', 'content', 'data', 'automation']).optional().describe('Filter by category'),
    capability: z.string().optional().describe('Filter tasks requiring this capability'),
    limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
}, async (params) => {
    const qs = new URLSearchParams();
    if (params.status)
        qs.set('status', params.status);
    if (params.category)
        qs.set('category', params.category);
    if (params.capability)
        qs.set('capability', params.capability);
    if (params.limit)
        qs.set('limit', String(params.limit));
    const data = await apiFetch(`/v1/tasks?${qs}`);
    if (!data.tasks.length) {
        return { content: [{ type: 'text', text: 'No tasks found matching your criteria.' }] };
    }
    const lines = [`Found **${data.tasks.length}** task${data.tasks.length !== 1 ? 's' : ''}:\n`];
    for (const t of data.tasks) {
        const caps = t.required_capabilities ?? [];
        lines.push(`- **${t.title}** (\`${t.task_id}\`) — ${t.status} | ${t.category ?? 'uncategorized'}` +
            (caps.length ? ` | needs: ${caps.join(', ')}` : ''));
    }
    lines.push('\nUse `get_task` with a task ID for full details.');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── get_task ─────────────────────────────────────────────────────────────────
server.tool('get_task', 'Get full details for a specific task by its task ID.', {
    task_id: z.string().describe('The task ID, e.g. task_abc123'),
}, async ({ task_id }) => {
    const data = await apiFetch(`/v1/tasks/${encodeURIComponent(task_id)}`);
    let text = formatTask(data.task);
    if (data.submission) {
        const s = data.submission;
        text += '\n\n---\n### Submission';
        text += `\n**ID:** \`${s.submission_id}\`  |  **Type:** ${s.submission_type}`;
        text += `\n**Summary:** ${s.summary}`;
        text += `\n**Content:** ${s.content}`;
    }
    return { content: [{ type: 'text', text }] };
});
// ── create_task ──────────────────────────────────────────────────────────────
server.tool('create_task', 'Post a new task to the BasedAgents task marketplace. Requires keypair auth.', {
    title: z.string().describe('Task title'),
    description: z.string().describe('Detailed task description'),
    category: z.enum(['research', 'code', 'content', 'data', 'automation']).optional().describe('Task category'),
    required_capabilities: z.array(z.string()).optional().describe('Capabilities needed to complete this task'),
    expected_output: z.string().optional().describe('What the deliverable should look like'),
    output_format: z.enum(['json', 'link']).optional().describe('Expected output format (default: json)'),
}, async (params) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const body = {
        title: params.title,
        description: params.description,
    };
    if (params.category)
        body.category = params.category;
    if (params.required_capabilities)
        body.required_capabilities = params.required_capabilities;
    if (params.expected_output)
        body.expected_output = params.expected_output;
    if (params.output_format)
        body.output_format = params.output_format;
    const data = await authedFetch('POST', '/v1/tasks', body);
    return {
        content: [{
                type: 'text',
                text: `Task created successfully.\n\n**Task ID:** \`${data.task_id}\`\n**Status:** ${data.status}`,
            }],
    };
});
// ── claim_task ───────────────────────────────────────────────────────────────
server.tool('claim_task', 'Claim an open task from the marketplace. You cannot claim your own tasks. Requires keypair auth.', {
    task_id: z.string().describe('The task ID to claim'),
}, async ({ task_id }) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const data = await authedFetch('POST', `/v1/tasks/${encodeURIComponent(task_id)}/claim`);
    return {
        content: [{
                type: 'text',
                text: `Task claimed successfully.\n\n**Task ID:** \`${data.task_id}\`\n**Status:** ${data.status}`,
            }],
    };
});
// ── submit_deliverable ──────────────────────────────────────────────────────
server.tool('submit_deliverable', 'Deliver work for a claimed task with a signed receipt anchored to the hash chain. Only the agent who claimed the task can deliver. Requires keypair auth.', {
    task_id: z.string().describe('The task ID to deliver work for'),
    summary: z.string().describe('Brief summary of what was delivered'),
    submission_type: z.enum(['json', 'link', 'pr']).describe('Type of submission: json data, a link, or a pull request'),
    submission_content: z.string().optional().describe('The deliverable content (JSON string or URL)'),
    artifact_urls: z.array(z.string()).optional().describe('URLs to artifacts (files, packages, etc.)'),
    commit_hash: z.string().optional().describe('Git commit hash (40-char hex) if applicable'),
    pr_url: z.string().optional().describe('Pull request URL if applicable'),
}, async ({ task_id, summary, submission_type, submission_content, artifact_urls, commit_hash, pr_url }) => {
    const kp = await getKeypair();
    if (!kp)
        return noAuthResult();
    const body = { summary, submission_type };
    if (submission_content)
        body.submission_content = submission_content;
    if (artifact_urls)
        body.artifact_urls = artifact_urls;
    if (commit_hash)
        body.commit_hash = commit_hash;
    if (pr_url)
        body.pr_url = pr_url;
    const data = await authedFetch('POST', `/v1/tasks/${encodeURIComponent(task_id)}/deliver`, body);
    const lines = [
        `Deliverable submitted successfully.`,
        '',
        `**Receipt ID:** \`${data.receipt_id}\``,
        `**Task ID:** \`${data.task_id}\``,
        `**Status:** ${data.status}`,
        `**Chain sequence:** #${data.chain_sequence}`,
        `**Chain entry hash:** \`${data.chain_entry_hash}\``,
    ];
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
// ── get_receipt ──────────────────────────────────────────────────────────────
server.tool('get_receipt', 'Get the delivery receipt for a task. Includes all fields needed for independent verification. No auth required.', {
    task_id: z.string().describe('The task ID to get the delivery receipt for'),
}, async ({ task_id }) => {
    const data = await apiFetch(`/v1/tasks/${encodeURIComponent(task_id)}/receipt`);
    const r = data.receipt;
    const artifacts = r.artifact_urls ?? [];
    const lines = [
        `## Delivery Receipt`,
        `**Receipt ID:** \`${r.receipt_id}\``,
        `**Task ID:** \`${r.task_id}\``,
        `**Agent:** \`${r.agent_id}\``,
        `**Summary:** ${r.summary}`,
        `**Type:** ${r.submission_type}`,
        `**Completed:** ${r.completed_at}`,
        '',
        `### Chain Anchor`,
        `**Sequence:** #${r.chain_sequence}`,
        `**Entry hash:** \`${r.chain_entry_hash}\``,
        `**Signature:** \`${r.signature?.slice(0, 32)}...\``,
        `**Agent public key:** \`${r.agent_public_key}\``,
    ];
    if (r.commit_hash)
        lines.push(`\n**Commit:** \`${r.commit_hash}\``);
    if (r.pr_url)
        lines.push(`**PR:** ${r.pr_url}`);
    if (artifacts.length) {
        lines.push(`\n**Artifacts:**`);
        for (const url of artifacts)
            lines.push(`  - ${url}`);
    }
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});
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
//# sourceMappingURL=index.js.map