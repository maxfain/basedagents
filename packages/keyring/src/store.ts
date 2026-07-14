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

/** Steal a lock whose pid is unknown after this long. */
const LOCK_STALE_MS = 15_000;
/** Steal a lock even if its pid looks alive after this long (guards against pid reuse). */
const LOCK_STALE_HARD_MS = 120_000;
const LOCK_RETRIES = 200;
const LOCK_RETRY_DELAY_MS = 50;

/** Persisted chain-head anchor — cross-checked by verifyLog to catch tail truncation. */
export interface HeadAnchor {
  count: number;
  sequence: number;
  entry_hash: string;
}

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
  get headAnchorPath(): string { return path.join(this.dir, 'head.json'); }
  private get lockPath(): string { return path.join(this.dir, '.lock'); }

  exists(): boolean {
    return fs.existsSync(this.vaultPath);
  }

  ownerKeyExists(): boolean {
    return fs.existsSync(this.ownerKeyPath);
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
        if (this.tryStealStaleLock()) continue;
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
    throw new Error(`Could not acquire vault lock at ${this.lockPath} — another process is holding it`);
  }

  /**
   * Decide whether the existing lock is stale and, if so, steal it atomically.
   * A lock is stale only when its owning pid is dead (crash) or its pid is
   * unknown and it is older than the soft threshold — never while a live
   * process legitimately holds it, unless it has been held implausibly long
   * (pid reuse). The steal itself is a single atomic rename so that two racing
   * processes cannot both proceed: only one rename can succeed.
   */
  private tryStealStaleLock(): boolean {
    let mtimeMs: number;
    let holderPid: number | null = null;
    try {
      const stat = fs.statSync(this.lockPath);
      mtimeMs = stat.mtimeMs;
      const raw = fs.readFileSync(this.lockPath, 'utf-8').trim();
      const parsed = Number.parseInt(raw, 10);
      holderPid = Number.isInteger(parsed) && parsed > 0 ? parsed : null;
    } catch {
      return true; // lock vanished between open and stat — retry immediately
    }

    const age = Date.now() - mtimeMs;
    const holderAlive = holderPid !== null && pidIsAlive(holderPid);
    const stale = holderPid === null
      ? age > LOCK_STALE_MS
      : (!holderAlive || age > LOCK_STALE_HARD_MS);
    if (!stale) return false;

    const stealPath = `${this.lockPath}.steal-${process.pid}-${mtimeMs}`;
    try {
      fs.renameSync(this.lockPath, stealPath); // atomic — only one racer wins
      fs.unlinkSync(stealPath);
    } catch {
      // Lost the steal race (someone else renamed/removed it first) — retry.
    }
    return true;
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
    // A previous crash may have left a torn (newline-less) final line; repair it
    // before appending so the log stays parseable.
    this.repairTornTail();
    fs.appendFileSync(this.eventsPath, JSON.stringify(event) + '\n', { mode: 0o600 });
    const prev = this.readHeadAnchor();
    this.writeHeadAnchor({
      count: (prev?.count ?? 0) + 1,
      sequence: event.sequence,
      entry_hash: event.entry_hash,
    });
  }

  /**
   * Read all events. Tolerates exactly one torn trailing line (an append
   * interrupted by a crash): a parse failure on the LAST line is dropped, while
   * a parse failure on any earlier line is corruption/tampering and throws.
   */
  readEvents(): AccessEvent[] {
    if (!fs.existsSync(this.eventsPath)) return [];
    const raw = fs.readFileSync(this.eventsPath, 'utf-8');
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    const events: AccessEvent[] = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]) as AccessEvent);
      } catch (err) {
        if (i === lines.length - 1) break; // torn trailing append — ignore
        throw new Error(`Corrupt event log at line ${i + 1}: ${(err as Error).message}`);
      }
    }
    return events;
  }

  private repairTornTail(): void {
    if (!fs.existsSync(this.eventsPath)) return;
    const raw = fs.readFileSync(this.eventsPath, 'utf-8');
    if (raw === '' || raw.endsWith('\n')) return; // clean (or empty)
    const lastNewline = raw.lastIndexOf('\n');
    const tail = raw.slice(lastNewline + 1).trim();
    if (!tail) return;
    try {
      JSON.parse(tail);
      // Parses but lacks a trailing newline — normalize.
      fs.appendFileSync(this.eventsPath, '\n', { mode: 0o600 });
    } catch {
      // Torn/partial line — truncate back to the last complete newline.
      fs.truncateSync(this.eventsPath, lastNewline + 1);
    }
  }

  /** Chain head: last event's hash and sequence, or the genesis sentinel. */
  chainHead(): { sequence: number; entry_hash: string } {
    const events = this.readEvents();
    if (events.length === 0) return { sequence: 0, entry_hash: GENESIS_HASH };
    const last = events[events.length - 1];
    return { sequence: last.sequence, entry_hash: last.entry_hash };
  }

  // ── Head anchor (truncation guard) ──

  readHeadAnchor(): HeadAnchor | null {
    if (!fs.existsSync(this.headAnchorPath)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.headAnchorPath, 'utf-8')) as HeadAnchor;
    } catch {
      return null;
    }
  }

  writeHeadAnchor(anchor: HeadAnchor): void {
    this.atomicWrite(this.headAnchorPath, JSON.stringify(anchor) + '\n');
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

/** Expand a leading `~` (or `~/`) to the user's home directory. */
export function expandHome(filePath: string): string {
  if (filePath === '~') return os.homedir();
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

/** Load a keypair from a file path (a leading `~` is expanded to $HOME). */
export function loadKeypairFile(filePath: string): AgentKeypair {
  return parseKeypairJson(fs.readFileSync(expandHome(filePath), 'utf-8'));
}

/** Whether a pid refers to a live process (best-effort; used for lock staleness). */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process (dead); EPERM = alive but not ours to signal.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
