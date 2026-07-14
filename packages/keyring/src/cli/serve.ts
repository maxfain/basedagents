/**
 * based admin / mcp — long-running local servers over the same vault.
 *
 * Both modules are loaded with dynamic imports so the CLI's module graph
 * stays independent of the admin and MCP servers.
 */

import { Keyring } from '../keyring.js';
import { parseFlags, parsePositiveInt } from './shared.js';

export async function cmdAdmin(args: string[], dir: string | undefined): Promise<void> {
  const flags = parseFlags(args, { value: ['port'] });
  const port = flags.values['port'] !== undefined ? parsePositiveInt(flags.values['port'], '--port') : undefined;
  const keyring = Keyring.open(dir);

  const { startAdminServer } = await import('../admin/index.js');
  const server = await startAdminServer({ keyring, port });

  console.log(`Keyring admin UI running at ${server.url}`);
  console.log('Press Ctrl-C to stop.');

  await new Promise<void>(resolve => {
    const stop = (): void => {
      server.close();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('\nAdmin server stopped.');
}

export async function cmdMcp(args: string[], dir: string | undefined): Promise<void> {
  parseFlags(args);
  // The MCP server reads BASEDAGENTS_KEYRING_DIR — plumb --dir through it.
  if (dir) process.env.BASEDAGENTS_KEYRING_DIR = dir;
  // Self-starts on import (stdio transport keeps the process alive).
  await import('../mcp/index.js');
}
