/**
 * based grant / revoke / kill / requests / approve / deny — the binding
 * layer between credentials and agent identities.
 */

import { Keyring } from '../keyring.js';
import type { GrantConstraints } from '../types.js';
import { runSweep } from '../sweep.js';
import {
  CliError, parseFlags, parsePositiveInt, parseExpires,
  printTable, formatTime, agentDisplay, describeConstraints, printRevocationNotes,
} from './shared.js';

const CONSTRAINT_FLAGS = ['expires', 'max-ttl', 'max-uses', 'project'];

function constraintsFromFlags(
  values: Record<string, string>,
  switches?: Set<string>,
): GrantConstraints {
  const constraints: GrantConstraints = {};
  if (values['expires'] !== undefined) constraints.expires_at = parseExpires(values['expires']);
  if (values['max-ttl'] !== undefined) constraints.max_lease_ttl_seconds = parsePositiveInt(values['max-ttl'], '--max-ttl');
  if (values['max-uses'] !== undefined) constraints.max_uses = parsePositiveInt(values['max-uses'], '--max-uses');
  if (values['project'] !== undefined) constraints.project = values['project'];
  // Custody Fix 1: opt this grant into raw value release via keyring_lease.
  // Off by default — the agent should use keyring_run/keyring_render instead.
  if (switches?.has('unsafe-value-release')) constraints.unsafe_value_release = true;
  return constraints;
}

export async function cmdGrant(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: CONSTRAINT_FLAGS, switch: ['unsafe-value-release'] });
  const [credRef, agentRef] = flags.positional;
  if (!credRef || !agentRef) {
    throw new CliError('Usage: based grant <cred> <agent> [--expires <dur|iso>] [--max-ttl <seconds>] [--max-uses <n>] [--project <tag>] [--unsafe-value-release]');
  }

  const kr = Keyring.open(dir);
  const constraints = constraintsFromFlags(flags.values, flags.switches);
  const grant = await kr.createGrant(kr.ownerKeypair(), credRef, agentRef, constraints);

  const vault = kr.vault();
  const label = vault.credentials[grant.credential_id]?.label ?? grant.credential_id;
  console.log(`✓ Grant created: ${grant.grant_id}`);
  console.log(`  "${label}" → ${agentDisplay(vault, grant.agent_id)} (${grant.agent_id})`);
  console.log(`  ${describeConstraints(constraints) || 'no constraints — leases use the 900s default TTL'}`);
}

export async function cmdRevoke(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['reason'] });
  const grantId = flags.positional[0];
  if (!grantId) throw new CliError('Usage: based revoke <grant_id> [--reason <r>]');

  const kr = Keyring.open(dir);
  const grant = await kr.revokeGrant(kr.ownerKeypair(), grantId, flags.values['reason']);

  const vault = kr.vault();
  const label = vault.credentials[grant.credential_id]?.label ?? grant.credential_id;
  console.log(`✓ Grant ${grant.grant_id} revoked — "${label}" for ${agentDisplay(vault, grant.agent_id)}`);
  printRevocationNotes();
}

/** Everything one local kill did — the CLI prints it, the daemon reports it. */
export interface KillOutcome {
  agentId: string;
  revokedGrantIds: string[];
  burns: Array<{ label: string; result: string }>;
  residuals: Array<{ title: string; remedy: string }>;
}

/**
 * The whole local kill — grant revocation, provider-side burns (Provisioner
 * §6: a revoked grant blocks Keyring leases but the token still works at the
 * PROVIDER until burned), and the ambient-residuals sweep (Custody Fix 2:
 * honest only if it reports what revocation does NOT reach). ONE
 * implementation shared by `based kill` and the daemon's console revocation
 * orders, so the button and the command can never drift.
 */
export async function executeKill(kr: Keyring, agentRef: string, reason?: string): Promise<KillOutcome> {
  const result = await kr.killSwitch(kr.ownerKeypair(), agentRef, reason);
  const vault = kr.vault();

  const revokedCredIds = result.revoked_grant_ids
    .map((gid) => vault.grants[gid]?.credential_id)
    .filter((c): c is string => Boolean(c));
  let burns: Array<{ label: string; result: string }> = [];
  if (revokedCredIds.length > 0) {
    const { burnVercelTokensForAgent } = await import('../provisioner/connect.js');
    const { burnSupabaseKeysForAgent } = await import('../provisioner/connect-supabase.js');
    const ids = [...new Set(revokedCredIds)];
    burns = [
      ...(await burnVercelTokensForAgent({ kr, owner: kr.ownerKeypair() }, ids)),
      ...(await burnSupabaseKeysForAgent({ kr, owner: kr.ownerKeypair() }, ids)),
    ];
  }

  const { findings } = runSweep();
  return {
    agentId: result.agent_id,
    revokedGrantIds: result.revoked_grant_ids,
    burns,
    residuals: findings.map((f) => ({ title: f.title, remedy: f.remedy })),
  };
}

export async function cmdKill(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['reason'] });
  const agentRef = flags.positional[0];
  if (!agentRef) throw new CliError('Usage: based kill <agent> [--reason <r>]');

  const kr = Keyring.open(dir);
  const out = await executeKill(kr, agentRef, flags.values['reason']);

  const vault = kr.vault();
  const display = agentDisplay(vault, out.agentId);
  if (out.revokedGrantIds.length === 0) {
    console.log(`Kill switch: ${display} held no active grants — nothing to revoke (event logged).`);
  } else {
    console.log(`Kill switch: revoked ${out.revokedGrantIds.length} grant(s) for ${display} (${out.agentId}):`);
    for (const grantId of out.revokedGrantIds) {
      console.log(`    ${grantId}`);
    }
    printRevocationNotes();
  }

  if (out.burns.length > 0) {
    console.log('');
    console.log('Provider-side burn:');
    for (const b of out.burns) {
      const mark = b.result === 'burned' || b.result === 'already_gone' ? '✓' : '⚠';
      console.log(`    ${mark} ${b.label}: ${b.result}`);
    }
  }

  // Green only when residuals = 0.
  console.log('');
  if (out.residuals.length === 0) {
    console.log(`✓ Cut off. No ambient access found outside Keyring.`);
    return;
  }
  console.log(`⚠ NOT fully cut off — this agent's environment can still act as you via:`);
  for (const f of out.residuals) {
    console.log(`    • ${f.title} — ${f.remedy}`);
  }
  console.log('');
  console.log("Run `based doctor` for detail. Neutralise these and it's truly cut off.");
}

export async function cmdRequests(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { switch: ['all'] });
  const all = flags.switches.has('all');
  const kr = Keyring.open(dir);
  const vault = kr.vault();
  const requests = kr.requestsView(all ? undefined : 'pending');

  if (requests.length === 0) {
    console.log(all ? 'No grant requests.' : 'No pending grant requests.');
    return;
  }

  const rows: string[][] = [['', 'REQUEST', 'AGENT', 'PROVIDER', 'SCOPE', 'STATUS', 'CREATED', 'NOTE']];
  for (const request of requests) {
    rows.push([
      request.status === 'pending' ? '●' : request.status === 'approved' ? '✓' : '✗',
      request.request_id,
      agentDisplay(vault, request.agent_id),
      request.provider,
      request.scope ?? '-',
      request.status,
      formatTime(request.created_at),
      request.note ?? '-',
    ]);
  }
  printTable(rows);
  if (requests.some(r => r.status === 'pending')) {
    console.log('');
    console.log('Approve with `based approve <request_id> --credential <cred>`, deny with `based deny <request_id>`.');
  }
}

export async function cmdApprove(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['credential', ...CONSTRAINT_FLAGS], switch: ['unsafe-value-release'] });
  const requestId = flags.positional[0];
  const credentialRef = flags.values['credential'];
  if (!requestId || !credentialRef) {
    throw new CliError('Usage: based approve <request_id> --credential <cred> [--expires <dur|iso>] [--max-ttl <seconds>] [--max-uses <n>] [--project <tag>]');
  }

  const kr = Keyring.open(dir);
  const { request, grant } = await kr.approveRequest(
    kr.ownerKeypair(), requestId, credentialRef, constraintsFromFlags(flags.values, flags.switches)
  );

  const vault = kr.vault();
  const label = vault.credentials[grant.credential_id]?.label ?? grant.credential_id;
  console.log(`✓ Request ${request.request_id} approved`);
  console.log(`  Grant ${grant.grant_id}: "${label}" → ${agentDisplay(vault, grant.agent_id)}`);
  const described = describeConstraints(grant.constraints);
  if (described) console.log(`  ${described}`);
}

export async function cmdDeny(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['reason'] });
  const requestId = flags.positional[0];
  if (!requestId) throw new CliError('Usage: based deny <request_id> [--reason <r>]');

  const kr = Keyring.open(dir);
  const request = await kr.denyRequest(kr.ownerKeypair(), requestId, flags.values['reason']);

  const vault = kr.vault();
  console.log(
    `✗ Request ${request.request_id} denied — ${request.provider} for ` +
    `${agentDisplay(vault, request.agent_id)}${request.deny_reason ? ` (${request.deny_reason})` : ''}`
  );
}
