/**
 * based identity add/rm, identities, agents — who the vault knows and
 * what each agent holds.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Keyring } from '../keyring.js';
import { publicKeyToAgentId } from '../util.js';
import { CliError, parseFlags, printTable, formatTime, shortAgentId, describeConstraints, loadKeypairChecked } from './shared.js';

export async function cmdIdentity(args: string[], dir: string | undefined): Promise<void> {
  const sub = args[0];
  if (sub === 'add') return identityAdd(args.slice(1), dir);
  if (sub === 'rm') return identityRemove(args.slice(1), dir);
  throw new CliError('Usage: based identity add <agent_id> [--name <n>] [--keypair <path>]  |  based identity rm <ref>');
}

async function identityAdd(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['name', 'keypair'] });
  const agentId = flags.positional[0];
  if (!agentId) throw new CliError('Usage: based identity add <agent_id> [--name <n>] [--keypair <path>]');

  const kr = Keyring.open(dir);

  let keypairPath: string | undefined;
  if (flags.values['keypair']) {
    keypairPath = path.resolve(flags.values['keypair']);
    if (fs.existsSync(keypairPath)) {
      const keypair = loadKeypairChecked(keypairPath);
      const keypairAgent = publicKeyToAgentId(keypair.publicKey);
      if (keypairAgent !== agentId) {
        throw new CliError(`Keypair ${keypairPath} belongs to ${keypairAgent}, not ${agentId}`);
      }
    } else {
      console.error(`⚠ Keypair file does not exist yet: ${keypairPath} (path stored anyway)`);
    }
  }

  const identity = await kr.addIdentity(kr.ownerKeypair(), agentId, {
    name: flags.values['name'],
    keypairPath,
  });

  console.log(`✓ Identity added${identity.name ? `: ${identity.name}` : ''}`);
  console.log(`  agent_id:  ${identity.agent_id}`);
  if (identity.keypair_path) console.log(`  keypair:   ${identity.keypair_path}`);
  console.log(`  Grant it a credential with: based grant <cred> ${identity.name ?? identity.agent_id}`);
}

async function identityRemove(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args);
  const ref = flags.positional[0];
  if (!ref) throw new CliError('Usage: based identity rm <ref>');

  const kr = Keyring.open(dir);
  const vault = kr.vault();
  const agentId = kr.resolveAgent(vault, ref);
  const name = vault.identities[agentId]?.name;
  await kr.removeIdentity(kr.ownerKeypair(), ref);
  console.log(`✓ Identity removed: ${name ?? agentId}`);
}

export async function cmdIdentities(args: string[], dir: string | undefined): Promise<void> {
  parseFlags(args);
  const kr = Keyring.open(dir);
  const vault = kr.vault();
  const identities = Object.values(vault.identities)
    .sort((a, b) => (a.name ?? a.agent_id).localeCompare(b.name ?? b.agent_id));

  const rows: string[][] = [['NAME', 'AGENT ID', 'ADDED', 'KEYPAIR']];
  rows.push(['(owner)', vault.owner.agent_id, formatTime(vault.created_at), kr.store.ownerKeyPath]);
  for (const identity of identities) {
    rows.push([
      identity.name ?? '-',
      identity.agent_id,
      formatTime(identity.added_at),
      identity.keypair_path ?? '-',
    ]);
  }
  printTable(rows);
  if (identities.length === 0) {
    console.log('');
    console.log('No agent identities yet. Add one with `based identity add <agent_id> --name <n>`.');
  }
}

export async function cmdAgents(args: string[], dir: string | undefined): Promise<void> {
  parseFlags(args);
  const kr = Keyring.open(dir);
  const agents = kr.agentsView();

  if (agents.length === 0) {
    console.log('No agent identities yet. Add one with `based identity add <agent_id> --name <n>`.');
    return;
  }

  for (const agent of agents) {
    console.log('');
    console.log(`${agent.name ?? shortAgentId(agent.agent_id)}  (${agent.agent_id})`);
    console.log(
      `  ${agent.active_grants} active / ${agent.revoked_grants} revoked grant(s)` +
      ` · ${agent.total_leases} lease(s) · last access ${formatTime(agent.last_access)}`
    );
    if (agent.grants.length > 0) {
      printTable(agent.grants.map(grant => [
        grant.status === 'active' ? '✓' : '✗',
        grant.credential_label,
        grant.grant_id,
        `${grant.use_count} use${grant.use_count === 1 ? '' : 's'}`,
        grant.status === 'revoked'
          ? `revoked${grant.revoke_reason ? `: ${grant.revoke_reason}` : ''}`
          : (describeConstraints(grant.constraints) || 'no constraints'),
      ]), '    ');
    }
  }
  console.log('');
}
