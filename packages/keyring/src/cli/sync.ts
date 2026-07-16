/**
 * based link / based sync — the daemon side of the grant-approval loop.
 *
 *   based link   anchors the owner's console passkey(s) as the local authority
 *                root (CONTROL_PLANE.md §2 — trusted because the human confirms
 *                the fingerprints, not because they were fetched).
 *   based sync   pulls owner-approved grants from the control plane, verifies +
 *                applies each locally (re-sealing the secret), and reports the
 *                result back so the console shows `active` only on confirmation.
 */

import { Keyring, KeyringError } from '../keyring.js';
import { openSealedBox } from '../crypto.js';
import { parseFlags, CliError, shortAgentId } from './shared.js';
import { confirm } from './prompt.js';
import { ControlClient, DEFAULT_KEYRING_API } from './control-client.js';
import { validateProviderToken, presetEnvVar } from './providers.js';

function apiFrom(flags: { values: Record<string, string | undefined> }): string {
  return flags.values['api'] ?? DEFAULT_KEYRING_API;
}

export async function cmdLink(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['api'], switch: ['yes'] });
  const keyring = Keyring.open(dir);
  const owner = keyring.ownerKeypair();
  const client = new ControlClient(owner, apiFrom(flags));

  const { rp_id, origins, passkeys } = await client.getPasskeys();
  if (passkeys.length === 0) {
    console.log('No passkeys are registered for this owner yet.');
    console.log('Register one in the console (app.basedagents.ai), then run `based link` again.');
    return;
  }

  const already = new Set(keyring.anchoredPasskeys().map(p => p.credential_id));
  console.log(`Owner passkeys on file at ${apiFrom(flags)} (RP ${rp_id}):\n`);
  for (const p of passkeys) {
    const status = already.has(p.credential_id) ? ' [already anchored]' : '';
    console.log(`  ${p.nickname ?? '(unnamed)'}${status}`);
    console.log(`    credential:  ${p.credential_id}`);
    console.log(`    key:         ${p.public_key_hex.slice(0, 32)}…`);
    console.log(`    registered:  ${p.created_at.slice(0, 10)}`);
  }
  console.log('\nAnchoring makes these the authority the daemon trusts to approve grants.');
  console.log('Confirm the fingerprints match the passkey(s) you registered before continuing.');

  if (!flags.switches.has('yes')) {
    const ok = await confirm(`Anchor ${passkeys.length} passkey(s)?`);
    if (!ok) { console.log('Aborted. Nothing anchored.'); return; }
  }

  let anchored = 0;
  for (const p of passkeys) {
    await keyring.anchorOwnerPasskey(owner, {
      credentialId: p.credential_id,
      publicKeyHex: p.public_key_hex,
      rpId: rp_id,
      origins,
      nickname: p.nickname ?? undefined,
    });
    anchored++;
    console.log(`✓ anchored ${p.nickname ?? shortAgentId(p.credential_id)}`);
  }
  console.log(`\nDone — ${anchored} passkey(s) anchored. Run \`based sync\` to apply approved grants.`);
}

/**
 * Connect cards (onboarding Move 3): pull browser-sealed provider tokens,
 * open them with the vault owner key (LOCALLY — the plaintext exists only
 * here), validate against the provider where possible, store the credential
 * and create the grant for the connected agent, then confirm back so the
 * card in the browser flips to ✓. Shared by `based sync` and the tail of
 * `based init` (which keeps storing while the browser page is still open).
 * Returns the number of connections it resolved (either way).
 */
export async function processConnections(keyring: Keyring, client: ControlClient): Promise<number> {
  const owner = keyring.ownerKeypair();
  const connections = await client.getConnections();
  for (const conn of connections) {
    const display = conn.label ?? conn.provider;
    try {
      const secret = new TextDecoder().decode(openSealedBox(owner.privateKey, conn.sealed_secret));
      const check = await validateProviderToken(conn.provider, secret);
      if (!check.ok) {
        console.log(`✗ ${display}: ${check.detail}`);
        await client.resolveConnection(conn.id, { error: check.detail });
        continue;
      }
      const credential = await keyring.addCredential(owner, {
        label: conn.label ?? conn.provider,
        provider: conn.provider,
        env_var: conn.env_var ?? presetEnvVar(conn.provider),
      }, secret.trim());
      await keyring.createGrant(owner, credential.credential_id, conn.agent_id, {});
      await client.resolveConnection(conn.id, { daemonCredentialId: credential.credential_id });
      console.log(`✓ ${display} connected → ${shortAgentId(conn.agent_id)} (${check.detail})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.log(`✗ ${display}: ${reason}`);
      try {
        await client.resolveConnection(conn.id, { error: reason });
      } catch { /* reported next round */ }
    }
  }
  return connections.length;
}

export async function cmdSync(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['api', 'watch'] });
  const keyring = Keyring.open(dir);
  const owner = keyring.ownerKeypair();
  const client = new ControlClient(owner, apiFrom(flags));

  const watchSeconds = flags.values['watch'] !== undefined ? Number(flags.values['watch']) : undefined;
  if (watchSeconds !== undefined && (!Number.isFinite(watchSeconds) || watchSeconds < 1)) {
    throw new CliError('--watch requires a number of seconds ≥ 1');
  }

  const runOnce = async (quiet: boolean): Promise<void> => {
    if ((await processConnections(keyring, client)) > 0 && !quiet) console.log('');
    const approvals = await client.getApprovals();
    if (approvals.length === 0) {
      if (!quiet) console.log('No pending approvals.');
      return;
    }
    let applied = 0, rejected = 0;
    for (const a of approvals) {
      try {
        const grant = await keyring.applyApprovedGrant({
          nonce: a.nonce,
          credential_id: a.credential_id,
          agent_id: a.agent_id,
          constraints: a.constraints,
          assertion: a.assertion,
        });
        await client.confirmApproval(a.id, { daemonGrantId: grant.grant_id });
        applied++;
        console.log(`✓ applied grant ${grant.grant_id} → ${shortAgentId(a.agent_id)} (${a.credential_id})`);
      } catch (err) {
        // A rejected approval is reported back so the console never shows it active.
        const reason = err instanceof KeyringError || err instanceof Error ? err.message : String(err);
        rejected++;
        console.log(`✗ rejected approval ${a.id}: ${reason}`);
        try {
          await client.confirmApproval(a.id, { error: reason });
        } catch (reportErr) {
          console.log(`  (could not report the rejection: ${(reportErr as Error).message})`);
        }
      }
    }
    console.log(`Applied ${applied}, rejected ${rejected}.`);
  };

  if (watchSeconds === undefined) {
    await runOnce(false);
    return;
  }

  console.log(`Watching ${apiFrom(flags)} for approvals every ${watchSeconds}s. Press Ctrl-C to stop.`);
  let stop = false;
  process.once('SIGINT', () => { stop = true; });
  process.once('SIGTERM', () => { stop = true; });
  while (!stop) {
    try {
      await runOnce(true);
    } catch (err) {
      console.log(`sync error: ${(err as Error).message}`);
    }
    for (let i = 0; i < watchSeconds && !stop; i++) {
      await new Promise<void>(r => setTimeout(r, 1000));
    }
  }
  console.log('\nStopped.');
}
