/**
 * basedagents check <package-name-or-agent-id>
 *
 * Trust checker — is this agent/package registered and trustworthy?
 * Exit code 0 = trusted, 1 = not found or untrusted (CI/CD friendly).
 */

import { RegistryClient } from '../index.js';

const R = '\x1b[0m';
const bold   = (s: string) => `\x1b[1m${s}${R}`;
const dim    = (s: string) => `\x1b[2m${s}${R}`;
const red    = (s: string) => `\x1b[31m${s}${R}`;
const green  = (s: string) => `\x1b[32m${s}${R}`;
const yellow = (s: string) => `\x1b[33m${s}${R}`;
const cyan   = (s: string) => `\x1b[36m${s}${R}`;

const API_URL = process.env.BASEDAGENTS_API_URL ?? 'https://api.basedagents.ai';

function bar(value: number, width = 20): string {
  const filled = Math.round(value * width);
  return cyan('█'.repeat(filled)) + dim('░'.repeat(width - filled));
}

function repLabel(score: number): string {
  if (score >= 0.8) return green('Excellent');
  if (score >= 0.6) return green('Good');
  if (score >= 0.4) return yellow('Fair');
  if (score >= 0.2) return yellow('Low');
  return red('Very Low');
}

type Verdict = 'TRUSTED' | 'UNVERIFIED' | 'CAUTION' | 'NOT FOUND';

function verdictColor(v: Verdict): string {
  switch (v) {
    case 'TRUSTED':    return green(v);
    case 'UNVERIFIED': return yellow(v);
    case 'CAUTION':    return red(v);
    case 'NOT FOUND':  return red(v);
  }
}

function verdictIcon(v: Verdict): string {
  return v === 'TRUSTED' ? green('✓') : v === 'UNVERIFIED' ? yellow('~') : red('✗');
}

interface AgentData {
  agent_id: string;
  name: string;
  status: string;
  reputation_score: number;
  verification_count: number;
  registered_at: string;
}

interface RepData {
  reputation_score: number;
  safety_flags: number;
  confidence: number;
  verifications_received: number;
}

export async function check(args: string[]): Promise<void> {
  const apiUrl = args.includes('--api') ? args[args.indexOf('--api') + 1] : API_URL;
  const jsonMode = args.includes('--json');
  const strict = args.includes('--strict');

  const positional = args.filter((a, i) =>
    a !== '--api' && a !== '--json' && a !== '--strict' && (i === 0 || args[i - 1] !== '--api')
  );
  const query = positional[0];

  if (!query || query === '--help' || query === '-h') {
    console.log(`
${bold('basedagents check')} ${dim('<package-name-or-agent-id>')}

Check if a package or agent is registered and trustworthy.
Exit code 0 = trusted, 1 = not found or untrusted.

${bold('Usage:')}
  basedagents check @some/mcp-server
  basedagents check ag_7Xk9mP2qR8nK4vL3
  basedagents check Hans

${bold('Options:')}
  --json        Output raw JSON
  --strict      Exit 1 unless reputation > 0.5 and 2+ verifications
  --api <url>   Use a custom registry API endpoint
`);
    process.exit(0);
  }

  if (apiUrl !== API_URL && !apiUrl.startsWith('https://')) {
    console.log(red('\n  ✗ Custom --api URL must use HTTPS\n'));
    process.exit(1);
  }

  const client = new RegistryClient(apiUrl);
  let agent: AgentData | null = null;

  // Lookup
  try {
    if (query.startsWith('ag_') || query.length > 30) {
      agent = await client.fetchJson<AgentData>(`/v1/agents/${encodeURIComponent(query)}`);
    }
  } catch { /* fall through to search */ }

  if (!agent) {
    try {
      const results = await client.fetchJson<{ agents: AgentData[] }>(
        `/v1/agents/search?q=${encodeURIComponent(query)}&limit=1`
      );
      if (results.agents?.length) {
        agent = results.agents[0];
      }
    } catch { /* not found */ }
  }

  // Not found
  if (!agent) {
    if (jsonMode) {
      console.log(JSON.stringify({ query, verdict: 'NOT FOUND', registered: false }));
      process.exit(1);
    }
    console.log('');
    console.log(`  ${verdictIcon('NOT FOUND')} ${bold(query)} — ${verdictColor('NOT FOUND')}`);
    console.log('');
    console.log(`  This package is not registered on BasedAgents.`);
    console.log(`  Registration is free: ${cyan('npx basedagents register')}`);
    console.log('');
    process.exit(1);
  }

  // Fetch reputation
  let rep: RepData | null = null;
  try {
    rep = await client.fetchJson<RepData>(`/v1/agents/${agent.agent_id}/reputation`);
  } catch { /* supplemental */ }

  // Determine verdict
  const score = rep?.reputation_score ?? agent.reputation_score;
  const verifications = rep?.verifications_received ?? agent.verification_count;
  const safetyFlags = rep?.safety_flags ?? 0;

  let verdict: Verdict;
  if (agent.status === 'suspended' || safetyFlags > 0) {
    verdict = 'CAUTION';
  } else if (agent.status === 'active' && verifications > 0) {
    verdict = 'TRUSTED';
  } else {
    verdict = 'UNVERIFIED';
  }

  // Strict mode override
  if (strict && (score < 0.5 || verifications < 2)) {
    verdict = verdict === 'TRUSTED' ? 'UNVERIFIED' : verdict;
  }

  const exitCode = verdict === 'TRUSTED' ? 0 : 1;

  if (jsonMode) {
    console.log(JSON.stringify({
      query,
      verdict,
      agent_id: agent.agent_id,
      name: agent.name,
      status: agent.status,
      reputation_score: score,
      verification_count: verifications,
      safety_flags: safetyFlags,
      registered_at: agent.registered_at,
      profile: `https://basedagents.ai/agents/${agent.agent_id}`,
    }, null, 2));
    process.exit(exitCode);
  }

  // Formatted output
  console.log('');
  console.log(`  ${verdictIcon(verdict)} ${bold(agent.name)} — ${verdictColor(verdict)}`);
  console.log('');

  const pad = 14;
  console.log(`  ${dim('Status'.padEnd(pad))} ${agent.status === 'active' ? green(agent.status) : agent.status === 'suspended' ? red(agent.status) : yellow(agent.status)}`);
  console.log(`  ${dim('Reputation'.padEnd(pad))} ${bar(score)}  ${bold(score.toFixed(4))}  ${repLabel(score)}`);
  console.log(`  ${dim('Verified'.padEnd(pad))} ${verifications} time${verifications !== 1 ? 's' : ''}`);

  if (safetyFlags > 0) {
    console.log(`  ${dim('Safety'.padEnd(pad))} ${red(`⚠ ${safetyFlags} flag${safetyFlags > 1 ? 's' : ''}`)}`);
  } else {
    console.log(`  ${dim('Safety'.padEnd(pad))} ${green('✓ No flags')}`);
  }

  console.log(`  ${dim('Registered'.padEnd(pad))} ${new Date(agent.registered_at).toISOString().slice(0, 10)}`);
  console.log('');
  console.log(`  ${dim('Profile:')} ${cyan(`https://basedagents.ai/agents/${agent.agent_id}`)}`);
  console.log('');

  process.exit(exitCode);
}
