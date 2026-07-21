/**
 * based add / update-secret / rm / credentials — credential lifecycle and
 * the reverse index (each credential and who holds it).
 */

import { Keyring } from '../keyring.js';
import { CliError, parseFlags, printTable, formatTime, agentDisplay, describeConstraints } from './shared.js';
import { acquireSecret, confirm } from './prompt.js';

export async function cmdAdd(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['provider', 'env', 'scope', 'rotation', 'provider-key-id', 'value'] });
  const label = flags.positional[0];
  if (!label) {
    throw new CliError('Usage: based add <label> [--provider <p>] [--env <VAR>] [--scope <s>] [--rotation <note>] [--provider-key-id <id>] [--value <secret>]');
  }
  if (flags.positional.length > 1) {
    throw new CliError(`Unexpected argument "${flags.positional[1]}" — quote labels with spaces: based add "Stripe key (prod)"`);
  }

  const kr = Keyring.open(dir);
  const owner = kr.ownerKeypair();
  const secret = await acquireSecret(flags.values['value'], `Secret for "${label}"`);
  const credential = await kr.addCredential(owner, {
    label,
    provider: flags.values['provider'],
    env_var: flags.values['env'],
    scope: flags.values['scope'],
    rotation_policy: flags.values['rotation'],
    provider_key_id: flags.values['provider-key-id'],
  }, secret);

  console.log(`✓ Credential added: ${credential.label}`);
  console.log(`  credential_id:  ${credential.credential_id}`);
  console.log(`  env var:        ${credential.env_var ?? '-'}`);
  console.log(`  Grant it with:  based grant ${credential.env_var ?? credential.credential_id} <agent>`);
}

export async function cmdUpdateSecret(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['value'] });
  const ref = flags.positional[0];
  if (!ref) throw new CliError('Usage: based update-secret <cred> [--value <secret>]');

  const kr = Keyring.open(dir);
  const owner = kr.ownerKeypair();
  const vault = kr.vault();
  const credential = kr.resolveCredential(vault, ref);
  const grantees = new Set(
    Object.values(vault.grants)
      .filter(g => g.credential_id === credential.credential_id && g.status === 'active')
      .map(g => g.agent_id)
  );

  const secret = await acquireSecret(flags.values['value'], `New secret for "${credential.label}"`);
  await kr.updateCredentialSecret(owner, credential.credential_id, secret);

  console.log(`✓ Secret replaced for "${credential.label}" (${credential.credential_id})`);
  console.log(
    grantees.size > 0
      ? `  Re-sealed to the owner and ${grantees.size} active grantee(s) — existing grants keep working with the new value.`
      : '  Re-sealed to the owner (no active grantees).'
  );
}

export async function cmdRemove(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { switch: ['yes'] });
  const ref = flags.positional[0];
  if (!ref) throw new CliError('Usage: based rm <cred> [--yes]');

  const kr = Keyring.open(dir);
  const vault = kr.vault();
  const credential = kr.resolveCredential(vault, ref);
  const grantCount = Object.values(vault.grants)
    .filter(g => g.credential_id === credential.credential_id).length;

  if (!flags.switches.has('yes')) {
    const ok = await confirm(`Remove "${credential.label}" (${credential.credential_id}) and its ${grantCount} grant(s)?`);
    if (!ok) {
      console.log('Aborted.');
      return;
    }
  }

  // Custody honesty: removing from the vault does not kill the token at the
  // provider. Burn it by id when we can (Vercel + provisioning token on hand).
  if (credential.provider === 'vercel' && credential.provider_key_id && !credential.provisioner) {
    try {
      const { VercelApi } = await import('../provisioner/vercel-api.js');
      const prov = kr.findProvisioner('vercel');
      if (prov) {
        const value = kr.provisionerValue(kr.ownerKeypair(), prov.credential_id);
        const status = await new VercelApi(value, undefined, prov.provider_team).deleteToken(credential.provider_key_id);
        console.log(`✓ Burned the token at Vercel (${status})`);
      } else {
        console.log('⚠ No provisioning token — delete it in the Vercel dashboard too.');
      }
    } catch (err) {
      console.log(`⚠ Could not burn at Vercel (${(err as Error).message}) — delete it in the dashboard too.`);
    }
  }

  await kr.removeCredential(kr.ownerKeypair(), credential.credential_id);
  console.log(`✓ Removed "${credential.label}" and ${grantCount} grant(s)`);
}

export async function cmdCredentials(args: string[], dir: string | undefined): Promise<void> {
  parseFlags(args);
  const kr = Keyring.open(dir);
  const vault = kr.vault();
  const credentials = kr.credentialsView();

  if (credentials.length === 0) {
    console.log('No credentials yet. Add one with `based add <label>`.');
    return;
  }

  for (const credential of credentials) {
    const meta = [
      credential.provider ? `provider ${credential.provider}` : '',
      credential.env_var ? `env ${credential.env_var}` : '',
      credential.scope ? `scope ${credential.scope}` : '',
      credential.rotation_policy ? `rotation ${credential.rotation_policy}` : '',
    ].filter(part => part !== '').join(' · ');

    console.log('');
    console.log(`${credential.label}  (${credential.credential_id})`);
    if (meta) console.log(`  ${meta}`);
    if (credential.holders.length === 0) {
      console.log('  holders: none');
      continue;
    }
    printTable(credential.holders.map(holder => [
      holder.status === 'active' ? '✓' : '✗',
      holder.name ?? agentDisplay(vault, holder.agent_id),
      holder.grant_id,
      holder.status,
      `${holder.use_count} use${holder.use_count === 1 ? '' : 's'}`,
      holder.last_leased ? `last leased ${formatTime(holder.last_leased)}` : 'never leased',
      describeConstraints(holder.constraints),
    ]));
  }
  console.log('');
}
