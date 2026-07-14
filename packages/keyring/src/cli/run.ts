/**
 * based run — lease everything the acting agent holds, inject the secrets
 * as env vars, and spawn the command:
 *
 *   based run --agent ci-bot -- npm run deploy
 *
 * Secrets exist only in the child process environment for the lease TTL;
 * nothing is written to disk and values are never printed.
 */

import { spawn } from 'node:child_process';
import { Keyring } from '../keyring.js';
import { publicKeyToAgentId } from '../util.js';
import {
  CliError, parseFlags, parsePositiveInt, printTable, formatTime,
  agentDisplay, loadKeypairChecked,
} from './shared.js';

const USAGE = 'Usage: based run [--agent <ref>] [--keypair <file>] [--context <c>] [--ttl <seconds>] -- <command...>';

export async function cmdRun(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['agent', 'keypair', 'context', 'ttl'] });
  const command = flags.rest.length > 0 ? flags.rest : flags.positional;
  if (command.length === 0) throw new CliError(USAGE);

  const kr = Keyring.open(dir);
  const vault = kr.vault();

  // Acting keypair: --keypair > the identity's stored keypair_path > $BASEDAGENTS_KEYPAIR_PATH.
  let expectedAgentId: string | undefined;
  let keypairPath: string | undefined = flags.values['keypair'];
  if (flags.values['agent'] !== undefined) {
    expectedAgentId = kr.resolveAgent(vault, flags.values['agent']);
    keypairPath ??= vault.identities[expectedAgentId]?.keypair_path;
  }
  keypairPath ??= process.env.BASEDAGENTS_KEYPAIR_PATH;
  if (!keypairPath) {
    throw new CliError(
      'No keypair for the acting agent — pass --keypair <file>, store one on the identity ' +
      '(based identity add ... --keypair <path>), or set BASEDAGENTS_KEYPAIR_PATH'
    );
  }

  const keypair = loadKeypairChecked(keypairPath);
  const actingAgentId = publicKeyToAgentId(keypair.publicKey);
  if (expectedAgentId !== undefined && actingAgentId !== expectedAgentId) {
    throw new CliError(
      `Keypair mismatch: ${keypairPath} belongs to ${actingAgentId}, ` +
      `but --agent ${flags.values['agent']} resolves to ${expectedAgentId}`
    );
  }

  const ttlSeconds = flags.values['ttl'] !== undefined ? parsePositiveInt(flags.values['ttl'], '--ttl') : undefined;
  const context = flags.values['context'] ?? `based run: ${command.join(' ')}`;
  const { leases, denied } = await kr.leaseAll(keypair, { context, ttlSeconds });

  // ── Summary — labels and env var names only, NEVER values ──
  console.log(`based run — acting as ${agentDisplay(vault, actingAgentId)} (${actingAgentId})`);
  if (leases.length > 0) {
    console.log(`Leased ${leases.length} credential(s):`);
    printTable(leases.map(lease => [
      '✓',
      lease.credential.env_var ?? '(no env var)',
      lease.credential.label,
      `TTL ${lease.ttl_seconds}s`,
      `expires ${formatTime(lease.expires_at)}`,
    ]));
  }
  if (denied.length > 0) {
    console.log(`Denied ${denied.length}:`);
    printTable(denied.map(denial => ['✗', denial.label, denial.reason]));
  }
  if (leases.length === 0) {
    console.log('No credentials leased for this identity — running the command without injected secrets.');
  } else {
    console.log('Secrets are injected into the child process environment only — nothing is written to disk.');
  }

  // ── Env injection ──
  const env: NodeJS.ProcessEnv = { ...process.env };
  const injected = new Map<string, string>();
  for (const lease of leases) {
    const name = lease.credential.env_var;
    if (!name) {
      console.error(`⚠ "${lease.credential.label}" has no env var name — skipped`);
      continue;
    }
    const previous = injected.get(name);
    if (previous !== undefined) {
      console.error(`⚠ Env var collision on ${name}: "${previous}" and "${lease.credential.label}" — the latter wins`);
    }
    injected.set(name, lease.credential.label);
    env[name] = lease.value;
  }

  console.log(`Running: ${command.join(' ')}`);
  console.log('');

  const exitCode = await new Promise<number>(resolve => {
    const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env, shell: false });
    child.on('error', err => {
      console.error(`Error: could not start "${command[0]}": ${err.message}`);
      resolve(127);
    });
    child.on('close', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
  process.exitCode = exitCode;
}
