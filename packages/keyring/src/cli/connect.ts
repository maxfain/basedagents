/**
 * based connect <provider> — the Provisioner front door (spec §3).
 *
 * Providers: vercel, supabase. Consent-first, window always visible,
 * checkpoint handoffs instead of crashes, assisted-paste as the floor. Where
 * it cannot run (no display — cloud sandboxes), it says exactly what to do
 * instead.
 */

import { Keyring } from '../keyring.js';
import { CliError, parseFlags } from './shared.js';
import { confirm, promptHidden } from './prompt.js';
import { connectVercel } from '../provisioner/connect.js';
import { connectSupabase } from '../provisioner/connect-supabase.js';
import type { EngineHooks } from '../provisioner/types.js';

const PROVIDERS = ['vercel', 'supabase'];

function cliHooks(): EngineHooks {
  return {
    async consent(plan) {
      console.log('');
      console.log('Here is exactly what will happen:');
      for (const line of plan) console.log(`  • ${line}`);
      console.log('');
      return confirm('Proceed?');
    },
    async login(hint) {
      console.log('');
      console.log(`  ${hint}`);
      return (await confirm('Continue (logged in)?')) ? 'continue' : 'abort';
    },
    async checkpoint(_stepId, message) {
      console.log('');
      console.log(`  ⚠ ${message}`);
      return (await confirm('Continue?')) ? 'continue' : 'abort';
    },
    info(message) {
      console.log(`  ${message}`);
    },
  };
}

export async function cmdConnect(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['agent', 'days', 'project'] });
  const provider = flags.positional[0];
  if (!provider || !PROVIDERS.includes(provider)) {
    throw new CliError(`Usage: based connect <${PROVIDERS.join('|')}> [--agent <ref>] [--days <n>] [--project <ref>]`);
  }
  if (flags.values['project'] && provider !== 'supabase') {
    throw new CliError('--project applies to supabase only (which project to mint the key for).');
  }

  if (!process.stdin.isTTY) {
    // §2: no headless provisioning, ever. Same message the driver uses, so a
    // sandboxed agent relays the right thing to its human.
    const { NO_DISPLAY_MESSAGE } = await import('../provisioner/driver-playwright.js');
    throw new CliError(NO_DISPLAY_MESSAGE);
  }

  const kr = Keyring.open(dir);
  const owner = kr.ownerKeypair();

  // Default the target agent when exactly one identity exists.
  const identities = Object.values(kr.vault().identities);
  let agentRef = flags.values['agent'];
  if (!agentRef) {
    if (identities.length === 1) agentRef = identities[0].agent_id;
    else if (identities.length === 0) throw new CliError('No agent identities yet — run `based init` first.');
    else throw new CliError(`Multiple agents in this vault — pick one with --agent <name|ag_…>.`);
  }
  // Fail HERE, with the roster, before any token is minted at the provider.
  try {
    kr.resolveAgent(kr.vault(), agentRef);
  } catch {
    const known = identities.map((i) => i.name ?? i.agent_id).join(', ') || '(none)';
    throw new CliError(
      `Unknown agent "${agentRef}". This vault knows: ${known}.\n` +
      'Tokens are minted FOR an agent that already exists here — agents register themselves via ' +
      '`npx basedagents keyring init` (or add one with `based identity add <ag_…> --name <n>`).'
    );
  }
  const agentName = identities.find((i) => i.agent_id === agentRef || i.name === agentRef)?.name ?? agentRef;

  const days = flags.values['days'] ? Number(flags.values['days']) : undefined;
  if (days !== undefined && (!Number.isFinite(days) || days <= 0 || days > 365)) {
    throw new CliError('--days must be between 1 and 365');
  }

  const deps = {
    kr,
    owner,
    hooks: cliHooks(),
    launchDriver: async () => {
      const { PlaywrightDriver } = await import('../provisioner/driver-playwright.js');
      return PlaywrightDriver.launch();
    },
    pasteFallback: async (message: string) => {
      console.log('');
      console.log(`  ${message}`);
      console.log('  (If NO token is visible — creation may have failed — just press Enter to cancel; nothing is saved, and re-running is safe.)');
      const v = await promptHidden('  Paste token, or Enter to cancel (input hidden): ');
      return v.trim() || null;
    },
  };

  const result = provider === 'supabase'
    ? await connectSupabase(deps, { agentRef, agentName, expiryDays: days, projectRef: flags.values['project'] })
    : await connectVercel(deps, { agentRef, agentName, expiryDays: days });

  console.log('');
  console.log('✓ Connected.');
  console.log(`  Key       ${result.tokenName}`);
  console.log(`  For       ${agentName} (${result.agentId})`);
  console.log(`  Reach     ${result.scope}`);
  console.log(`  Expires   ${result.expiresAt}${provider === 'supabase' ? ' (the grant — Supabase keys have no provider-side expiry; the kill switch burns by id)' : ''}`);
  console.log(`  Vaulted   ${result.credential.credential_id} · grant ${result.grantId}`);
  if (provider === 'supabase') {
    const s = result as Awaited<ReturnType<typeof connectSupabase>>;
    console.log(`  Project   ${s.projectRef} — set SUPABASE_URL=${s.projectUrl} beside the key (the URL is not a secret).`);
  }
  console.log(result.browserRan
    ? '  The browser ran once to set up provisioning — future connects are API-only, ~10 seconds.'
    : '  No browser needed — minted via the API with your provisioning token.');
}
