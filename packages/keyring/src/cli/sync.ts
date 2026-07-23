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
import { stripAnsi } from '../provisioner/engine.js';
import type { KillOutcome } from './grants.js';
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

/**
 * Console-facing reasons — plain words, no jargon, and NEVER raw automation
 * internals: ANSI codes stripped (Playwright colours its call logs and the
 * escapes survive the JSON trip as bare `[2m` markers — field-hit on a card),
 * first line only, bounded length.
 */
function consoleReason(err: unknown): string {
  const raw = stripAnsi(err instanceof Error ? err.message : String(err));
  return raw.split('\n')[0].slice(0, 300);
}

/** Console-facing reasons for provision failures — plain words, no jargon. */
function provisionFailureReason(err: unknown): string {
  const raw = consoleReason(err);
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
        const reason = consoleReason(err);
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
      const reason = consoleReason(err);
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

/** Runs the local kill for one console revocation; injected so tests never burn or sweep. */
export type KillRunner = (keyring: Keyring, agentRef: string, reason?: string) => Promise<KillOutcome>;

const defaultKillRunner: KillRunner = async (keyring, agentRef, reason) => {
  const { executeKill } = await import('./grants.js');
  return executeKill(keyring, agentRef, reason);
};

/**
 * The kill switch's local half (CONTROL_PLANE 0032): the console already
 * revoked the delegation — the agent can't ASK for anything — but this
 * machine still owes the part only it can do: revoke the vault grants, burn
 * minted provider-side keys, sweep for ambient residuals. Then confirm with
 * counts so the console stops saying "cut off at the account" and starts
 * telling the truth about this machine. Runs FIRST each round — kills beat
 * everything else. Field-hit: this half used to not exist while the confirm
 * dialog promised "your machine drops its access on the next sync".
 */
export async function processRevocations(
  keyring: Keyring,
  client: ControlClient,
  kill: KillRunner = defaultKillRunner,
): Promise<number> {
  let orders: Array<{ delegation_id: string; agent_id: string; label: string | null; revoked_at: string | null }>;
  try {
    orders = await client.getRevocations();
  } catch {
    return 0; // transient — next round retries
  }
  for (const order of orders) {
    const display = order.label ?? shortAgentId(order.agent_id);
    try {
      const out = await kill(keyring, order.agent_id, 'console kill switch');
      const burned = out.burns.filter((b) => b.result === 'burned' || b.result === 'already_gone').length;
      const burnFailures = out.burns.length - burned;
      console.log(
        `✓ Kill switch (from the console): ${display} — ${out.revokedGrantIds.length} grant(s) revoked, ` +
        `${burned} provider key(s) burned${burnFailures > 0 ? `, ${burnFailures} burn failure(s)` : ''}.`,
      );
      if (out.residuals.length > 0) {
        console.log(`  ⚠ ${out.residuals.length} ambient path(s) outside Keyring can still act as you — run \`based doctor\`:`);
        for (const r of out.residuals) console.log(`    • ${r.title} — ${r.remedy}`);
      }
      await client.confirmRevocation(order.delegation_id, {
        revoked_grants: out.revokedGrantIds.length,
        burned,
        burn_failures: burnFailures,
        residuals: out.residuals.length,
      });
    } catch (err) {
      const isUnknown = err instanceof KeyringError
        ? err.code === 'unknown_identity'
        : /unknown (identity|agent)/i.test(err instanceof Error ? err.message : String(err));
      if (isUnknown) {
        // The agent never lived on THIS machine — nothing local to drop.
        // Confirm honestly (zeros + note) so the order doesn't loop forever.
        console.log(`· Kill switch: ${display} is not set up on this computer — nothing to drop here.`);
        try {
          await client.confirmRevocation(order.delegation_id, {
            revoked_grants: 0, burned: 0, burn_failures: 0, residuals: 0,
            note: 'agent not on this machine',
          });
        } catch { /* reported next round */ }
      } else {
        // Kill or confirm failed — the order stays unconfirmed server-side, so
        // the next round re-runs the (idempotent) kill and re-confirms.
        console.log(`✗ Kill switch for ${display}: ${err instanceof Error ? err.message : String(err)} (will retry)`);
      }
    }
  }
  return orders.length;
}

/**
 * The facts the console needs to offer only actions this machine can perform.
 * Rotatable mirrors rotate.ts's guard chain EXACTLY — never the provisioning
 * token itself, a provider the rotate path speaks, a provider-side key id to
 * burn, and (Supabase) the project ref the id lives under. If the guard and
 * this predicate ever disagree, the console shows a button that lies.
 */
export function credentialFactsFrom(keyring: Keyring): Array<{ id: string; provider: string; rotatable: boolean }> {
  // The server caps a report at 200 rows; real vaults hold a handful.
  return keyring.credentialsView().slice(0, 200).map((c) => ({
    id: c.credential_id,
    provider: c.provider ?? '',
    rotatable:
      !c.provisioner &&
      (c.provider === 'vercel' || c.provider === 'supabase') &&
      !!c.provider_key_id &&
      (c.provider === 'vercel' || !!c.provider_team),
  }));
}

/**
 * The agent↔credential grants this machine actually holds, shaped for the
 * console mirror: one entry per (active grant → non-provisioner credential).
 * This is what makes a terminal `keyring connect` (or `grant`) show up in the
 * console — the console only ever saw console-initiated connections before
 * (field-hit: a `connect supabase --project` worked but /welcome kept
 * offering "Do it for me"). Metadata only; no secret leaves.
 */
export function mirrorEntriesFrom(keyring: Keyring): Array<{
  agent_id: string; provider: string; label: string; daemon_credential_id: string;
}> {
  const out: Array<{ agent_id: string; provider: string; label: string; daemon_credential_id: string }> = [];
  for (const c of keyring.credentialsView()) {
    if (c.provisioner) continue; // internal minting token — never an agent holding
    for (const h of c.holders) {
      if (h.status !== 'active') continue;
      out.push({
        agent_id: h.agent_id,
        provider: c.provider ?? '',
        label: c.label ?? c.provider ?? 'credential',
        daemon_credential_id: c.credential_id,
      });
    }
  }
  return out.slice(0, 200); // server caps the batch; real vaults hold a handful
}

/** Last successfully mirrored grant set (per process) — report only on change. */
let lastMirrored = '';

/** Mirror local grants to the console when they changed since the last success. */
export async function mirrorLocalGrants(keyring: Keyring, client: ControlClient): Promise<void> {
  const entries = mirrorEntriesFrom(keyring);
  const fingerprint = JSON.stringify(entries);
  if (fingerprint === lastMirrored) return;
  try {
    await client.mirrorConnections(entries);
    lastMirrored = fingerprint; // only a delivered mirror counts
  } catch {
    /* transient — the stale fingerprint forces a retry next round */
  }
}

/** Last successfully reported facts (per process) — report only on change. */
let lastReportedFacts = '';

/** Report facts when they changed since the last successful report this process. */
export async function reportCredentialFacts(keyring: Keyring, client: ControlClient): Promise<void> {
  const facts = credentialFactsFrom(keyring);
  const fingerprint = JSON.stringify(facts);
  if (fingerprint === lastReportedFacts) return;
  try {
    await client.reportCredentialFacts(facts);
    lastReportedFacts = fingerprint; // only a delivered report counts
  } catch {
    /* transient — the stale fingerprint forces a retry next round */
  }
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

/** Bare `--watch` polls at this interval — matches the console's own poll rate. */
export const DEFAULT_WATCH_SECONDS = 5;

/** `--watch 30` → 30; bare `--watch` → the default; absent → undefined (one-shot). */
export function watchSecondsFrom(flags: { values: Record<string, string>; switches: Set<string> }): number | undefined {
  if (flags.values['watch'] !== undefined) {
    const n = Number(flags.values['watch']);
    if (!Number.isFinite(n) || n < 1) {
      throw new CliError(`--watch takes a poll interval in seconds ≥ 1 (bare --watch uses ${DEFAULT_WATCH_SECONDS})`);
    }
    return n;
  }
  return flags.switches.has('watch') ? DEFAULT_WATCH_SECONDS : undefined;
}

export async function cmdSync(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['api'], optionalValue: ['watch'] });
  const keyring = Keyring.open(dir);
  const owner = keyring.ownerKeypair();
  const client = new ControlClient(owner, apiFrom(flags));

  const watchSeconds = watchSecondsFrom(flags);

  const runOnce = async (quiet: boolean): Promise<void> => {
    // Kills first — cutting an agent off beats storing anything new for it.
    await processRevocations(keyring, client);
    const touched = await processConnections(keyring, client);
    if (touched > 0 && !quiet) console.log('');
    // After connections (stores/rotations change the facts), before the wait:
    // the console learns which keys its per-key actions really work on, and
    // which grants this machine holds (so terminal connects show up too).
    await reportCredentialFacts(keyring, client);
    await mirrorLocalGrants(keyring, client);
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
