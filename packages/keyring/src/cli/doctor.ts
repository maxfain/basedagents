/**
 * based doctor — run the ambient-access sweep (Custody Fix 2) and report every
 * way the agent can already act as you WITHOUT going through Keyring. Exits
 * nonzero when any ungoverned path exists, so it is usable as a CI gate.
 *
 * Vault-independent: it inspects the project's .env files, logged-in provider
 * CLIs, token-shaped env vars, and ~/.netrc — never secret values.
 */

import { runSweep } from '../sweep.js';

export async function cmdDoctor(_args: string[], _dir: string | undefined): Promise<void> {
  const { findings, scanned } = runSweep();

  console.log('based doctor — ambient access sweep');
  console.log(`  project: ${scanned.cwd}`);
  console.log(`  home:    ${scanned.home}`);
  console.log('');

  if (findings.length === 0) {
    console.log('✓ No ungoverned credentials found — everything your agent can act through goes via Keyring.');
    return;
  }

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
