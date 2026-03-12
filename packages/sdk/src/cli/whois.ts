/**
 * basedagents whois <name-or-id>
 *
 * Look up an agent by ID or name and print a full profile summary.
 */

import { RegistryClient } from '../index.js';

// ─── ANSI ───
const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

const API_URL = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';

type AgentStatus = 'active' | 'pending' | 'suspended' | 'revoked';

interface AgentProfile {
  agent_id: string;
  name: string;
  description: string;
  status: AgentStatus;
  reputation_score: number;
  verification_count: number;
  capabilities: string[];
  protocols: string[];
  offers?: string[];
  needs?: string[];
  homepage?: string;
  contact_endpoint?: string;
  organization?: string;
  organization_url?: string;
  logo_url?: string;
  version?: string;
  tags?: string[];
  skills?: Array<{ name: string; registry: string; trust_score?: number }>;
  registered_at: string;
  last_seen?: string;
  recent_verifications?: Array<{
    verifier: string;
    result: string;
    coherence_score: number | null;
    date: string;
  }>;
}

interface ReputationData {
  reputation_score: number;
  breakdown: {
    pass_rate: number;
    coherence: number;
    contribution: number;
    uptime: number;
    skill_trust: number;
  };
  penalty: number;
  safety_flags: number;
  confidence: number;
  verifications_received: number;
  verifications_given: number;
}

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return cyan('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

function statusColor(status: AgentStatus): string {
  switch (status) {
    case 'active':    return green(status);
    case 'pending':   return yellow(status);
    case 'suspended': return red(status);
    case 'revoked':   return red(status);
    default:          return status;
  }
}

function repLabel(score: number): string {
  if (score >= 0.8) return green('Excellent');
  if (score >= 0.6) return green('Good');
  if (score >= 0.4) return yellow('Fair');
  if (score >= 0.2) return yellow('Low');
  return red('Very Low');
}

function row(label: string, value: string, labelWidth = 16): string {
  return `  ${dim(label.padEnd(labelWidth))} ${value}`;
}

export async function whois(args: string[]): Promise<void> {
  // Support --api <url> to point at a custom registry endpoint
  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;

  // Strip flag args so positional query parsing isn't confused
  const positional = args.filter((a, i) =>
    a !== '--api' && a !== '--json' && (i === 0 || args[i - 1] !== '--api')
  );
  const query = positional[0];

  if (!query || query === '--help' || query === '-h') {
    console.log(`
${bold('basedagents whois')} ${dim('<agent-id-or-name>')}

Look up any registered agent by their ID or name.

${bold('Usage:')}
  basedagents whois ag_7Xk9mP2qR8nK4vL3
  basedagents whois Hans
  basedagents whois "Mariano's claudebot"

${bold('Options:')}
  --json        Output raw JSON instead of formatted text
  --api <url>   Use a custom registry API endpoint
`);
    process.exit(0);
  }

  // Warn when using a custom API endpoint
  if (apiUrl !== API_URL && !apiUrl.startsWith('https://')) {
    console.log(red('\n  ✗ Custom --api URL must use HTTPS\n'));
    process.exit(1);
  }
  if (apiUrl !== API_URL) {
    console.log(yellow(`\n  ⚠  Using custom API: ${apiUrl}`));
    console.log(yellow('     Make sure you trust this endpoint.\n'));
  }

  const jsonMode = args.includes('--json');
  const client = new RegistryClient(apiUrl);

  let agent: AgentProfile | null = null;

  try {
    // Try direct ID lookup first (starts with ag_ or is long enough to be one)
    if (query.startsWith('ag_') || query.length > 30) {
      agent = await client.fetchJson<AgentProfile>(`/v1/agents/${encodeURIComponent(query)}`);
    }
  } catch {
    // fall through to name search
  }

  if (!agent) {
    try {
      const results = await client.fetchJson<{ agents: AgentProfile[] }>(
        `/v1/agents/search?q=${encodeURIComponent(query)}&limit=1`
      );
      if (!results.agents?.length) {
        console.log(red(`\n  No agent found matching "${query}"\n`));
        process.exit(1);
      }
      agent = results.agents[0];
    } catch (err) {
      console.log(red(`\n  Lookup failed: ${err instanceof Error ? err.message : 'unknown error'}\n`));
      process.exit(1);
    }
  }

  if (jsonMode) {
    console.log(JSON.stringify(agent, null, 2));
    return;
  }

  // ── Fetch reputation in parallel ──
  let rep: ReputationData | null = null;
  try {
    rep = await client.fetchJson<ReputationData>(`/v1/agents/${agent.agent_id}/reputation`);
  } catch { /* reputation is supplemental — don't fail */ }

  // ── Header ──
  console.log('');
  console.log('─'.repeat(56));
  console.log(` ${bold(agent.name)}  ${statusColor(agent.status as AgentStatus)}`);
  console.log('─'.repeat(56));
  console.log('');

  // ── Identity ──
  console.log(row('Agent ID',    cyan(agent.agent_id)));
  if (agent.version)      console.log(row('Version',     agent.version));
  if (agent.organization) console.log(row('Organization',
    agent.organization_url ? `${agent.organization} — ${cyan(agent.organization_url)}` : agent.organization));
  if (agent.homepage)     console.log(row('Homepage',    cyan(agent.homepage)));
  if (agent.contact_endpoint) console.log(row('Endpoint', cyan(agent.contact_endpoint)));
  console.log('');

  // ── Description ──
  const descWords = agent.description.split(' ');
  let line = '';
  const descLines: string[] = [];
  for (const word of descWords) {
    if ((line + ' ' + word).length > 52) { descLines.push(line); line = word; }
    else line = line ? line + ' ' + word : word;
  }
  if (line) descLines.push(line);
  for (const l of descLines) console.log(`  ${l}`);
  console.log('');

  // ── Capabilities & Protocols ──
  if (agent.capabilities?.length) console.log(row('Capabilities', agent.capabilities.join(', ')));
  if (agent.protocols?.length)    console.log(row('Protocols',    agent.protocols.join(', ')));
  if (agent.offers?.length)       console.log(row('Offers',       agent.offers.join(', ')));
  if (agent.needs?.length)        console.log(row('Needs',        agent.needs.join(', ')));
  if (agent.tags?.length)         console.log(row('Tags',         agent.tags.join(', ')));
  console.log('');

  // ── Skills ──
  if (agent.skills?.length) {
    console.log(`  ${dim('Skills')}:`);
    for (const s of agent.skills) {
      const trust = s.trust_score != null
        ? `  ${bar(s.trust_score, 10)} ${Math.round(s.trust_score * 100)}%`
        : '';
      console.log(`    ${cyan(s.name)}  ${dim(s.registry)}${trust}`);
    }
    console.log('');
  }

  // ── Reputation ──
  console.log('─'.repeat(56));
  console.log(` ${bold('Reputation')}`);
  console.log('─'.repeat(56));
  console.log('');

  if (rep) {
    const score = rep.reputation_score;
    console.log(`  ${bar(score, 30)}  ${bold(score.toFixed(4))}  ${repLabel(score)}`);
    console.log(`  ${dim('Confidence')}    ${Math.round(rep.confidence * 100)}%  (${rep.verifications_received} verifications received)`);
    console.log('');
    const bd = rep.breakdown;
    const rows: [string, number][] = [
      ['Pass rate',    bd.pass_rate],
      ['Coherence',    bd.coherence],
      ['Contribution', bd.contribution],
      ['Uptime',       bd.uptime],
      ['Skill trust',  bd.skill_trust],
    ];
    for (const [label, val] of rows) {
      console.log(`  ${dim(label.padEnd(14))} ${bar(val, 16)} ${String(Math.round(val * 100)).padStart(3)}%`);
    }
    console.log('');
    if (rep.safety_flags > 0) {
      console.log(`  ${red(`⚠  ${rep.safety_flags} safety flag${rep.safety_flags > 1 ? 's' : ''}`)}`);
    } else {
      console.log(`  ${green('✓  No safety flags')}`);
    }
    if (rep.penalty > 0) {
      console.log(`  ${red(`⚠  Penalty: -${Math.round(rep.penalty * 100)}%`)}`);
    }
  } else {
    console.log(`  ${dim('No reputation data yet.')}`);
  }
  console.log('');

  // ── Recent verifications ──
  if (agent.recent_verifications?.length) {
    console.log('─'.repeat(56));
    console.log(` ${bold('Recent Verifications')}`);
    console.log('─'.repeat(56));
    console.log('');
    for (const v of agent.recent_verifications) {
      const icon  = v.result === 'pass' ? green('✓') : v.result === 'fail' ? red('✗') : yellow('~');
      const coh   = v.coherence_score != null ? dim(`  coherence ${Math.round(v.coherence_score * 100)}%`) : '';
      const date  = v.date.slice(0, 10);
      const verif = v.verifier.slice(0, 20) + '…';
      console.log(`  ${icon} ${v.result.padEnd(7)} ${dim(date)}  by ${cyan(verif)}${coh}`);
    }
    console.log('');
  }

  // ── Footer ──
  console.log('─'.repeat(56));
  console.log(row('Registered', new Date(agent.registered_at).toISOString().slice(0, 10)));
  if (agent.last_seen) console.log(row('Last seen', new Date(agent.last_seen).toISOString().slice(0, 10)));
  console.log(row('Profile', cyan(`https://basedagents.ai/agents/${agent.agent_id}`)));
  console.log('─'.repeat(56));
  console.log('');
}
