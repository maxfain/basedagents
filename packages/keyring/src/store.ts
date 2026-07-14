/**
 * VaultStore — file-backed persistence for the local-first vault.
 *
 * Layout (default ~/.basedagents/keyring, override with BASEDAGENTS_KEYRING_DIR):
 *   vault.json    — identities, credentials (ciphertext only), grants, requests
 *   events.jsonl  — append-only hash-chained AccessEvent log
 *   owner.json    — owner keypair (0600). The only private key the vault stores.
 *
 * Writes are atomic (tmp + rename) and serialized through a lock file so the
 * CLI, MCP server, and admin server can share one vault safely.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { VaultFile, AccessEvent } from './types.js';
import type { AgentKeypair } from './crypto.js';
import { publicKeyToAgentId, base58Encode, hexToBytes, bytesToHex, base58Decode } from './util.js';

export const GENESIS_HASH = '0'.repeat(64);

const LOCK_STALE_MS = 10_000;
const LOCK_RETRIES = 100;
const LOCK_RETRY_DELAY_MS = 50;

export function defaultVaultDir(): string {
  return process.env.BASEDAGENTS_KEYRING_DIR
    ?? path.join(os.homedir(), '.basedagents', 'keyring');
}

/** Owner keypair file — same shape the MCP server accepts for agent keypairs. */
export interface OwnerKeyFile {
  agent_id: string;
  public_key_b58: string;
  private_key_hex: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export class VaultStore {
  readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? defaultVaultDir();
  }

  get vaultPath(): string { return path.join(this.dir, 'vault.json'); }
  get eventsPath(): string { return path.join(this.dir, 'events.jsonl'); }
  get ownerKeyPath(): string { return path.join(this.dir, 'owner.json'); }
  private get lockPath(): string { return path.join(this.dir, '.lock'); }

  exists(): boolean {
    return fs.existsSync(this.vaultPath);
  }

  ensureDir(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  // ── Locking ──

  private async acquireLock(): Promise<void> {
    this.ensureDir();
    for (let attempt = 0; attempt < LOCK_RETRIES; attempt++) {
      try {
        const fd = fs.openSync(this.lockPath, 'wx', 0o600);
        fs.writeSync(fd, String(process.pid));
        fs.closeSync(fd);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        // Steal stale locks (crashed process)
        try {
          const age = Date.now() - fs.statSync(this.lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) {
            fs.unlinkSync(this.lockPath);
            continue;
          }
        } catch {
          continue; // lock vanished between check and stat — retry
        }
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
    throw new Error(`Could not acquire vault lock at ${this.lockPath} — another process is holding it`);
  }

  private releaseLock(): void {
    try { fs.unlinkSync(this.lockPath); } catch { /* already gone */ }
  }

  /** Run a read-modify-write section exclusively. */
  async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    await this.acquireLock();
    try {
      return await fn();
    } finally {
      this.releaseLock();
    }
  }

  // ── Vault file ──

  readVault(): VaultFile {
    if (!this.exists()) {
      throw new Error(`No keyring vault at ${this.dir} — run \`based init\` first`);
    }
    const raw = fs.readFileSync(this.vaultPath, 'utf-8');
    const vault = JSON.parse(raw) as VaultFile;
    if (vault.version !== 1) {
      throw new Error(`Unsupported vault version: ${String(vault.version)}`);
    }
    return vault;
  }

  writeVault(vault: VaultFile): void {
    this.ensureDir();
    this.atomicWrite(this.vaultPath, JSON.stringify(vault, null, 2) + '\n');
  }

  private atomicWrite(filePath: string, content: string): void {
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, { mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  // ── Event log ──

  appendEvent(event: AccessEvent): void {
    this.ensureDir();
    fs.appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', { mode: 0o600 });
  }

  readEvents(): AccessEvent[] {
    if (!fs.existsSync(this.eventsPath)) return [];
    const raw = fs.readFileSync(this.eventsPath, 'utf-8');
    const events: AccessEvent[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      events.push(JSON.parse(trimmed) as AccessEvent);
    }
    return events;
  }

  /** Chain head: last event's hash and sequence, or the genesis sentinel. */
  chainHead(): { sequence: number; entry_hash: string } {
    const events = this.readEvents();
    if (events.length === 0) return { sequence: 0, entry_hash: GENESIS_HASH };
    const last = events[events.length - 1];
    return { sequence: last.sequence, entry_hash: last.entry_hash };
  }

  // ── Owner keypair ──

  writeOwnerKey(keypair: AgentKeypair): OwnerKeyFile {
    this.ensureDir();
    const file: OwnerKeyFile = {
      agent_id: publicKeyToAgentId(keypair.publicKey),
      public_key_b58: base58Encode(keypair.publicKey),
      private_key_hex: bytesToHex(keypair.privateKey),
    };
    this.atomicWrite(this.ownerKeyPath, JSON.stringify(file, null, 2) + '\n');
    return file;
  }

  readOwnerKey(): AgentKeypair {
    if (!fs.existsSync(this.ownerKeyPath)) {
      throw new Error(`No owner key at ${this.ownerKeyPath} — run \`based init\` first`);
    }
    const raw = fs.readFileSync(this.ownerKeyPath, 'utf-8');
    return parseKeypairJson(raw);
  }
}

/**
 * Parse a keypair file. Accepts both formats in use across BasedAgents:
 *   { public_key_b58, private_key_hex, agent_id? }   (MCP / owner.json style)
 *   { publicKey: hex, privateKey: hex }               (SDK serializeKeypair style)
 */
export function parseKeypairJson(json: string): AgentKeypair {
  const parsed = JSON.parse(json) as Record<string, string>;
  if (parsed.private_key_hex && parsed.public_key_b58) {
    return {
      publicKey: base58Decode(parsed.public_key_b58),
      privateKey: hexToBytes(parsed.private_key_hex),
    };
  }
  if (parsed.privateKey && parsed.publicKey) {
    return {
      publicKey: hexToBytes(parsed.publicKey),
      privateKey: hexToBytes(parsed.privateKey),
    };
  }
  throw new Error(
    'Unrecognized keypair file — expected { public_key_b58, private_key_hex } or { publicKey, privateKey } (hex)'
  );
}

/** Load a keypair from a file path. */
export function loadKeypairFile(filePath: string): AgentKeypair {
  return parseKeypairJson(fs.readFileSync(filePath, 'utf-8'));
}
