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

import * as fs from 'node:fs';
import { Keyring, KeyringError } from '../keyring.js';
import { openSealedBox, sealToPublicKey } from '../crypto.js';
import { base58Decode } from '../util.js';
import { loadKeypairFile } from '../store.js';
import { buildPassportBlob, buildShelfSnapshot } from '../cloud/passport.js';
import { parseFlags, CliError, shortAgentId } from './shared.js';
import { confirm } from './prompt.js';
import { ControlClient, DEFAULT_KEYRING_API } from './control-client.js';
import { validateProviderToken, presetEnvVar } from './providers.js';
import type { EngineHooks } from '../provisioner/types.js';

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
 * Connections stored locally but whose server-side resolve call has not yet
 * succeeded (transient control-plane error). Keyed by connection id → the
 * credential id already created for it. On the next round we retry ONLY the
 * resolve — never re-store — so a resolve blip can't create a duplicate
 * credential/grant and can't mark an already-stored token as failed. Module
 * scope so it persists across watch-loop rounds within a process.
 */
const pendingResolves = new Map<string, string>();

/**
 * Engine hooks for a provision run nobody is watching from a terminal: the
 * human consented by clicking Connect in the console and is (presumably) near
 * the machine, so login just waits for them at the visible browser window and
 * anything that would need hands-on help stops cleanly instead of hanging.
 */
function daemonEngineHooks(): EngineHooks {
  return {
    async consent(plan) {
      console.log('  You asked for this from the console. Here is what runs:');
      for (const line of plan) console.log(`  • ${line}`);
      return true;
    },
    async login(hint) {
      console.log(`  ${hint} (waiting for you at the browser window…)`);
      await new Promise<void>((r) => setTimeout(r, 10_000));
      return 'continue'; // the engine re-probes; its bounded rounds cap the total wait
    },
    async checkpoint(_stepId, message) {
      console.log(`  ⚠ ${message} — no one is at this terminal to help, stopping.`);
      return 'abort';
    },
    info(message) {
      console.log(`  ${message}`);
    },
  };
}

/** Runs the Provisioner for one agent; injected so tests never need a browser. */
export type ProvisionRunner = (keyring: Keyring, agentId: string, provider: string) => Promise<{ credentialId: string }>;

/** Rotates one minted credential in place; injected so tests never need a provider. */
export type RotateRunner = (keyring: Keyring, credentialId: string) => Promise<void>;

const defaultRotateRunner: RotateRunner = async (keyring, credentialId) => {
  const { rotateProviderCredential } = await import('../provisioner/rotate.js');
  await rotateProviderCredential(
    { kr: keyring, owner: keyring.ownerKeypair(), info: (m) => console.log(`  ${m}`) },
    credentialId,
  );
};

/** Providers the daemon can provision on this machine (the console's "Do it for me"). */
export const PROVISIONABLE = ['vercel', 'supabase'];

const defaultProvisionRunner: ProvisionRunner = async (keyring, agentId, provider) => {
  const deps = {
    kr: keyring,
    owner: keyring.ownerKeypair(),
    hooks: daemonEngineHooks(),
    launchDriver: async () => {
      const { PlaywrightDriver } = await import('../provisioner/driver-playwright.js');
      return PlaywrightDriver.launch();
    },
    // Assisted paste needs a human at THIS terminal — there isn't one.
    pasteFallback: async () => null,
  };
  const opts = { agentRef: agentId, agentName: keyring.vault().identities[agentId]?.name };
  if (provider === 'supabase') {
    // No --project in a daemon run: the sole project auto-picks; multi-project
    // accounts fail with the roster, which the console shows as the reason.
    const { connectSupabase } = await import('../provisioner/connect-supabase.js');
    const result = await connectSupabase(deps, opts);
    return { credentialId: result.credential.credential_id };
  }
  const { connectVercel } = await import('../provisioner/connect.js');
  const result = await connectVercel(deps, opts);
  return { credentialId: result.credential.credential_id };
};

/** Console-facing reasons for provision failures — plain words, no jargon. */
function provisionFailureReason(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/unknown identity|unknown agent/i.test(raw)) {
    return 'That agent is not set up on this computer — run the setup command here first.';
  }
  return raw;
}

/**
 * Connect cards (onboarding Move 3): pull browser-sealed provider tokens,
 * open them with the vault owner key (LOCALLY — the plaintext exists only
 * here), validate against the provider where possible, store the credential
 * and create the grant for the connected agent, then confirm back so the
 * card in the browser flips to ✓. Shared by `based sync` and the tail of
 * `based init` (which keeps storing while the browser page is still open).
 *
 * Exactly-once, two lines of defense:
 *   - `claimConnection` atomically moves the row pending → processing, so two
 *     daemons racing the same card cannot both store it (only the winner
 *     proceeds; the loser skips).
 *   - `pendingResolves` retries a stored-but-unresolved connection's resolve
 *     without re-storing, so a transient resolve failure never duplicates or
 *     falsely fails.
 * Returns the number of connections it touched.
 */
export async function processConnections(
  keyring: Keyring,
  client: ControlClient,
  provision: ProvisionRunner = defaultProvisionRunner,
  rotate: RotateRunner = defaultRotateRunner,
): Promise<number> {
  const owner = keyring.ownerKeypair();

  // First, drain any store-succeeded-but-resolve-failed connections.
  for (const [id, credentialId] of [...pendingResolves]) {
    try {
      await client.resolveConnection(id, { daemonCredentialId: credentialId });
      pendingResolves.delete(id);
    } catch { /* still unreachable — keep for the next round */ }
  }

  const connections = await client.getConnections();
  for (const conn of connections) {
    const display = conn.label ?? conn.provider;
    if (pendingResolves.has(conn.id)) continue; // already stored; only the resolve is owed

    // Claim first — the loser of a cross-process race skips entirely.
    let claimed: boolean;
    try {
      claimed = await client.claimConnection(conn.id);
    } catch (err) {
      console.log(`· ${display}: ${(err as Error).message} (will retry)`);
      continue;
    }
    if (!claimed) continue;

    // Console-initiated automatic setup: mint the token HERE via the
    // Provisioner (visible browser once per machine, API-only after) instead
    // of opening a sealed paste. Same exactly-once dance as the sealed path.
    // Console-initiated rotation: replace one minted key in place. Exactly-once
    // rides the same claim; a failed rotate resolves with the plain-words
    // reason (which for pasted/legacy keys names the manual path).
    if (conn.kind === 'rotate') {
      try {
        if (!conn.daemon_credential_id) throw new Error('rotate row carries no credential id');
        console.log(`▶ ${display}: rotating the key for ${shortAgentId(conn.agent_id)}…`);
        await rotate(keyring, conn.daemon_credential_id);
        await client.resolveConnection(conn.id, { daemonCredentialId: conn.daemon_credential_id });
        console.log(`✓ ${display}: key rotated — the old one is gone at the provider.`);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        console.log(`✗ ${display}: ${reason}`);
        try {
          await client.resolveConnection(conn.id, { error: reason });
        } catch { /* reported next round */ }
      }
      continue;
    }

    if (conn.kind === 'provision') {
      try {
        if (!PROVISIONABLE.includes(conn.provider)) {
          throw new Error(`automatic setup for "${conn.provider}" is not available yet — paste a token on the card instead`);
        }
        console.log(`▶ ${display}: automatic setup for ${shortAgentId(conn.agent_id)} — a browser window may open here (first time only)…`);
        const { credentialId } = await provision(keyring, conn.agent_id, conn.provider);
        pendingResolves.set(conn.id, credentialId);
        await client.resolveConnection(conn.id, { daemonCredentialId: credentialId });
        pendingResolves.delete(conn.id);
        console.log(`✓ ${display} connected → ${shortAgentId(conn.agent_id)}`);
      } catch (err) {
        if (!pendingResolves.has(conn.id)) {
          const reason = provisionFailureReason(err);
          console.log(`✗ ${display}: ${reason}`);
          try {
            await client.resolveConnection(conn.id, { error: reason });
          } catch { /* reported next round */ }
        } else {
          console.log(`· ${display}: minted locally; confirming with the server (will retry)`);
        }
      }
      continue;
    }

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
      // Local store succeeded. From here a resolve failure must NOT re-store —
      // remember the credential id and retry the resolve alone next round.
      pendingResolves.set(conn.id, credential.credential_id);
      await client.resolveConnection(conn.id, { daemonCredentialId: credential.credential_id });
      pendingResolves.delete(conn.id);
      console.log(`✓ ${display} connected → ${shortAgentId(conn.agent_id)} (${check.detail})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      // Only report a failure if nothing was stored (validation/open error). If
      // the store already happened, pendingResolves holds it for a resolve-only
      // retry — do not overwrite a real credential with a 'failed' card.
      if (!pendingResolves.has(conn.id)) {
        console.log(`✗ ${display}: ${reason}`);
        try {
          await client.resolveConnection(conn.id, { error: reason });
        } catch { /* reported next round */ }
      } else {
        console.log(`· ${display}: stored locally; confirming with the server (will retry)`);
      }
    }
  }
  return connections.length;
}

/**
 * Serve pending passport requests (SANDBOX_SPEC §4b): seal {owner keypair,
 * agent keypair, name} to the browser's ephemeral key and post the ciphertext.
 * Values are never printed — the human finishes in the browser.
 */
export async function processPassportHandoffs(keyring: Keyring, client: ControlClient): Promise<number> {
  let handoffs: Array<{ id: string; browser_public_key: string }>;
  try {
    handoffs = await client.getPassportHandoffs();
  } catch {
    return 0; // transient — next round retries
  }
  if (handoffs.length === 0) return 0;
  const vault = keyring.vault();
  const withKeys = Object.values(vault.identities).filter(
    (i) => i.keypair_path && fs.existsSync(i.keypair_path),
  );
  if (withKeys.length !== 1) {
    console.log(`· ${handoffs.length} passport request(s) waiting, but ${withKeys.length} local agent key(s) here — run this where exactly one agent lives.`);
    return 0;
  }
  const identity = withKeys[0];
  const agentKp = loadKeypairFile(identity.keypair_path as string);
  const blob = buildPassportBlob(keyring.ownerKeypair(), agentKp, identity.name ?? identity.agent_id);
  let sent = 0;
  for (const h of handoffs) {
    try {
      const sealed = sealToPublicKey(base58Decode(h.browser_public_key), new TextEncoder().encode(blob));
      await client.fulfillPassportHandoff(h.id, sealed);
      sent++;
      console.log('✓ Sent a sealed passport to your browser — finish there. (Nothing was shown here.)');
    } catch (err) {
      console.log(`· passport request: ${(err as Error).message} (will retry)`);
    }
  }
  return sent;
}

/** Refresh the control-plane shelf (ciphertext only; server refuses until a passport exists). */
export async function depositShelf(keyring: Keyring, client: ControlClient): Promise<void> {
  try {
    const res = await client.putShelfSnapshot(buildShelfSnapshot(keyring.vault()));
    if (res.enabled) console.log('· Cloud copy refreshed (locked boxes only — nothing readable).');
  } catch {
    /* transient — refreshed on the next round that changes something */
  }
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
    const touched = await processConnections(keyring, client);
    if (touched > 0 && !quiet) console.log('');
    await processPassportHandoffs(keyring, client);
    const approvals = await client.getApprovals();
    if (approvals.length === 0) {
      if (touched > 0) await depositShelf(keyring, client);
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
    if (touched > 0 || applied > 0) await depositShelf(keyring, client);
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
