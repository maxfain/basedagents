/**
 * based init / export / verify-log — vault lifecycle and the signed access log.
 */

import * as fs from 'node:fs';
import { Keyring } from '../keyring.js';
import { CliError, parseFlags } from './shared.js';

export async function cmdExport(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['out'] });
  const kr = Keyring.open(dir);
  const exported = await kr.exportLog(kr.ownerKeypair());
  const json = JSON.stringify(exported, null, 2);
  const out = flags.values['out'];
  if (out) {
    fs.writeFileSync(out, json + '\n');
    console.log(`✓ Signed log export → ${out} (${exported.events.length} event(s), head #${exported.head?.sequence ?? 0})`);
  } else {
    console.log(json);
  }
}

export async function cmdVerifyLog(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args);
  if (flags.positional.length > 0) throw new CliError('Usage: based verify-log');
  const kr = Keyring.open(dir);
  const result = await kr.verifyLog();
  if (result.ok) {
    console.log(`✓ Access log verified — ${result.events_checked} event(s), hash chain intact, all signatures valid`);
    if (result.head) {
      console.log(`  head: #${result.head.sequence} ${result.head.entry_hash.slice(0, 16)}…`);
    }
    return;
  }
  console.error(`✗ Access log verification FAILED — ${result.errors.length} error(s) in ${result.events_checked} event(s):`);
  for (const error of result.errors) {
    console.error(`  #${error.sequence}${error.event_id ? ` ${error.event_id}` : ''}: ${error.error}`);
  }
  process.exitCode = 1;
}
