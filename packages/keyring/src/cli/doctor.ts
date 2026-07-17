/**
 * based doctor — two checks for "will Keyring actually work here?":
 *
 *  1. Ambient-access sweep (Custody Fix 2): every way the agent can already act
 *     as you WITHOUT going through Keyring — .env files, logged-in provider CLIs,
 *     token-shaped env vars, ~/.netrc. Exits nonzero when any exist (CI gate).
 *
 *  2. Network reachability (homepage spec §4.6): cloud agent sandboxes
 *     (Codex-style) often open egress only during their SETUP phase and block it
 *     during the TASK phase. When that signature is detected (registry / API /
 *     generic HTTPS all blocked), print the install-during-setup + allowlist
 *     pattern instead of leaving the agent with a raw 403.
 *
 * Vault-independent; never reads secret values.
 */

import { runSweep } from '../sweep.js';

interface NetProbe { url: string; label: string; reached: boolean; blocked: boolean }

/** HEAD/GET a host with a short timeout; a 403/407 or a blocked CONNECT counts as "blocked". */
async function probe(url: string, label: string): Promise<NetProbe> {
  try {
    const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(4000) });
    const blocked = res.status === 403 || res.status === 407;
    return { url, label, reached: !blocked, blocked };
  } catch (err) {
    // A proxy-denied CONNECT surfaces as a thrown fetch error, often naming the
    // proxy / 403 / tunnel. Treat that as blocked; treat a plain DNS/timeout as
    // inconclusive (not counted as blocked) to avoid false positives offline.
    const m = String((err as Error)?.message ?? err).toLowerCase();
    const blocked = /\b(403|407|proxy|tunnel|forbidden|connect tunnel|egress)\b/.test(m);
    return { url, label, reached: false, blocked };
  }
}

async function checkNetwork(): Promise<{ restricted: boolean; probes: NetProbe[] }> {
  const probes = await Promise.all([
    probe('https://registry.npmjs.org/basedagents', 'npm registry'),
    probe('https://api.basedagents.ai/', 'BasedAgents API'),
    probe('https://example.com/', 'generic HTTPS'),
  ]);
  // The phase-blocked signature: two or more of the three are outright blocked
  // (403/407/denied CONNECT). One lone failure is more likely a transient hiccup.
  const restricted = probes.filter((p) => p.blocked).length >= 2;
  return { restricted, probes };
}

function printSandboxGuidance(): void {
  console.log('⚠ Network looks phase-restricted — egress is blocked or 403-ing right now.');
  console.log('  Common in cloud agent sandboxes (Codex-style) that open the network only during setup.');
  console.log('  To use Keyring here:');
  console.log('    1. Install it during SETUP, not task time — add it to the project so the');
  console.log('       environment\'s own `npm ci` fetches it while the network is open:');
  console.log('         npm install --save-dev basedagents @basedagents/keyring');
  console.log('       Then `npx basedagents keyring init` resolves the local copy — no registry call.');
  console.log('    2. Register during setup (network open): npx basedagents register');
  console.log('       — the human claim can happen any time afterward.');
  console.log('    3. Allowlist two hosts for the task phase: api.basedagents.ai and app.basedagents.ai.');
  console.log('  Full guide: https://basedagents.ai/docs/agents#sandboxes');
}

export async function cmdDoctor(_args: string[], _dir: string | undefined): Promise<void> {
  const { findings, scanned } = runSweep();

  console.log('based doctor — ambient access sweep');
  console.log(`  project: ${scanned.cwd}`);
  console.log(`  home:    ${scanned.home}`);
  console.log('');

  if (findings.length === 0) {
    console.log('✓ No ungoverned credentials found — everything your agent can act through goes via Keyring.');
  } else {
    console.log(`⚠ ${findings.length} ungoverned path(s): your agent can act as you WITHOUT Keyring.`);
    console.log('');
    for (const f of findings) {
      console.log(`  • ${f.title}`);
      console.log(`      ${f.detail}`);
      console.log(`      → ${f.remedy}`);
      if (f.path) console.log(`      at ${f.path}`);
      console.log('');
    }
    console.log('Bring these under custody (Absorb), or acknowledge them as known ambient access.');
    // Nonzero so CI / scripts can gate on a clean environment.
    process.exitCode = 1;
  }

  // ── Network check (§4.6) — advisory, never changes the exit code. ──
  console.log('');
  const net = await checkNetwork();
  if (net.restricted) {
    printSandboxGuidance();
  } else {
    const reachable = net.probes.filter((p) => p.reached).map((p) => p.label);
    console.log(reachable.length > 0
      ? `✓ Network reachable (${reachable.join(', ')}).`
      : '· Network check inconclusive (offline?) — nothing blocked outright.');
  }
}
