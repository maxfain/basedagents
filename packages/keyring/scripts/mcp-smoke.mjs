#!/usr/bin/env node
/**
 * Smoke-test the BUILT MCP server (dist + vendored SDK bundle) over real stdio:
 * initialize → initialized → tools/list, then assert every keyring tool is
 * present. This is what proves the esbuild bundle actually runs — typecheck and
 * unit tests exercise src against the devDependency SDK, not the vendored dist.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EXPECTED = [
  'keyring_list',
  'keyring_lease',
  'keyring_run',
  'keyring_render',
  'keyring_request',
  'invite_owner',
  'keyring_whoami',
];

const vaultDir = mkdtempSync(path.join(tmpdir(), 'keyring-mcp-smoke-'));
const child = spawn(process.execPath, [path.join(pkgDir, 'bin', 'keyring-mcp.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    BASEDAGENTS_KEYRING_DIR: vaultDir,
    BASEDAGENTS_KEYPAIR_PATH: '',
    BASEDAGENTS_PRIVATE_KEY_HEX: '',
    BASEDAGENTS_PUBLIC_KEY_B58: '',
  },
});

let stderr = '';
child.stderr.on('data', (d) => { stderr += d; });

const fail = (msg) => {
  console.error(`MCP smoke FAILED: ${msg}`);
  if (stderr.trim()) console.error(`server stderr:\n${stderr}`);
  child.kill();
  rmSync(vaultDir, { recursive: true, force: true });
  process.exit(1);
};

const timer = setTimeout(() => fail('no tools/list response within 15s'), 15_000);

const send = (msg) => child.stdin.write(JSON.stringify(msg) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'keyring-smoke', version: '0.0.0' },
  },
});

let buffer = '';
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`non-JSON line on stdout: ${line.slice(0, 200)}`);
      return;
    }
    if (msg.id === 1) {
      if (!msg.result?.serverInfo?.name) fail(`bad initialize result: ${line.slice(0, 200)}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    } else if (msg.id === 2) {
      clearTimeout(timer);
      const names = (msg.result?.tools ?? []).map((t) => t.name);
      const missing = EXPECTED.filter((n) => !names.includes(n));
      if (missing.length) fail(`tools missing from tools/list: ${missing.join(', ')} (got: ${names.join(', ')})`);
      console.log(`MCP smoke OK — ${names.length} tools over stdio: ${names.join(', ')}`);
      child.kill();
      rmSync(vaultDir, { recursive: true, force: true });
      process.exit(0);
    }
  }
});

child.on('exit', (code, signal) => {
  if (signal !== 'SIGTERM') fail(`server exited early (code ${code})`);
});
