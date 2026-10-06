/**
 * Wallet-signed task actions: how a wallet-only poster (routes/x402-tasks.ts) proves it
 * is the wallet that paid for a task, without an agent key or the manage token.
 *
 * The wallet signs (EIP-191 personal_sign) this exact text:
 *
 *   BasedAgents task action
 *   Task: task_…
 *   Action: accept
 *   Wallet: 0x…
 *   Network: eip155:8453
 *   Issued: 2026-10-06T19:06:13Z
 *   Nonce: 53dca6690f12cf6b
 *
 *   Signing accepts the delivered work and releases this task's escrowed bounty to the agent that delivered it. Nothing leaves your wallet.
 *
 * The last line says what the action does with the escrowed bounty
 * (ACTION_FOOTERS): accept releases it, cancel refunds it, the others leave it
 * where it is. Lines end in "\n" exactly. The message names one task and one action, is accepted for
 * ACTION_MAX_AGE_MS after `Issued` (with clock skew), and its nonce is spent once
 * (wallet_action_nonces, checked by the route). The signature check is the payout-wallet
 * bind's (wallets/bind.ts): a plain key, or a smart wallet deployed or not.
 */
import { verifyWalletSignature, BIND_MAX_AGE_MS, BIND_MAX_SKEW_MS } from './bind.js';

export const ACTION_TITLE = 'BasedAgents task action';
export const ACTION_MAX_AGE_MS = BIND_MAX_AGE_MS;
export const TASK_ACTIONS = ['accept', 'revision', 'dispute', 'cancel', 'read'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

/** The message's last line: what signing does, including to the bounty the registry holds for the task. */
export const ACTION_FOOTERS: Readonly<Record<TaskAction, string>> = {
  accept: "Signing accepts the delivered work and releases this task's escrowed bounty to the agent that delivered it. Nothing leaves your wallet.",
  cancel: "Signing cancels this task and refunds its escrowed bounty to the wallet that paid it. Nothing leaves your wallet.",
  revision: 'Signing sends the delivered work back for changes. The bounty stays in escrow, and nothing leaves your wallet.',
  dispute: 'Signing disputes the delivered work. The bounty stays in escrow, and nothing leaves your wallet.',
  read: 'Signing shows you this task and its delivered work. It moves no funds.',
};

export interface ActionFields {
  taskId: string;
  action: TaskAction;
  wallet: string;
  network: string;
  issuedAt: string;
  nonce: string;
}

const TASK_ID_RE = /^task_[A-Za-z0-9]{6,64}$/;
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const NETWORK_RE = /^eip155:[0-9]{1,10}$/;
const ISSUED_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const NONCE_RE = /^[0-9a-f]{16}$/;

export function buildActionMessage(f: ActionFields): string {
  return [
    ACTION_TITLE,
    `Task: ${f.taskId}`,
    `Action: ${f.action}`,
    `Wallet: ${f.wallet}`,
    `Network: ${f.network}`,
    `Issued: ${f.issuedAt}`,
    `Nonce: ${f.nonce}`,
    '',
    ACTION_FOOTERS[f.action],
  ].join('\n');
}

/** A fresh message for the 401 `sign_this` (Issued = now, a random nonce). */
export function freshActionMessage(taskId: string, action: TaskAction, wallet: string, network: string, now: Date = new Date()): string {
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
  const issuedAt = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  return buildActionMessage({ taskId, action, wallet, network, issuedAt, nonce });
}

/** Parse the exact format, or null. Anything else (CRLF, extra lines, another footer) is refused. */
export function parseActionMessage(message: string): ActionFields | null {
  const lines = message.split('\n');
  // The footer must be the one for the named action; the round-trip below checks it.
  if (lines.length !== 9 || lines[0] !== ACTION_TITLE || lines[7] !== '') return null;
  const value = (line: string, key: string): string | null => (line.startsWith(`${key}: `) ? line.slice(key.length + 2) : null);
  const taskId = value(lines[1], 'Task');
  const action = value(lines[2], 'Action');
  const wallet = value(lines[3], 'Wallet');
  const network = value(lines[4], 'Network');
  const issuedAt = value(lines[5], 'Issued');
  const nonce = value(lines[6], 'Nonce');
  if (!taskId || !TASK_ID_RE.test(taskId)) return null;
  if (!action || !(TASK_ACTIONS as readonly string[]).includes(action)) return null;
  if (!wallet || !ADDR_RE.test(wallet)) return null;
  if (!network || !NETWORK_RE.test(network)) return null;
  if (!issuedAt || !ISSUED_RE.test(issuedAt) || Number.isNaN(Date.parse(issuedAt))) return null;
  if (!nonce || !NONCE_RE.test(nonce)) return null;
  // Round-trip: refuses anything the parser tolerated but the canonical form differs from.
  const fields: ActionFields = { taskId, action: action as TaskAction, wallet, network, issuedAt, nonce };
  return buildActionMessage(fields) === message ? fields : null;
}

export type ActionProofResult =
  | { ok: true; fields: ActionFields; signerKind: 'eoa' | 'erc1271' }
  | { ok: false; reason: 'malformed_message' | 'task_mismatch' | 'action_mismatch' | 'wallet_mismatch' | 'network_mismatch' | 'issued_in_future' | 'expired' | 'bad_signature' | 'rpc_unavailable'; detail: string };

/** Check a wallet-signed action for `taskId` / `action`, signed by `wallet` on `network`. The nonce is the caller's to spend. */
export async function verifyActionProof(
  env: unknown,
  args: { taskId: string; action: TaskAction; wallet: string; network: string; message: string; signature: string; now?: Date },
): Promise<ActionProofResult> {
  const fields = parseActionMessage(args.message);
  if (!fields) return { ok: false, reason: 'malformed_message', detail: 'The message is not a BasedAgents task action in the exact format (sign the sign_this text you were given, unchanged).' };
  if (fields.taskId !== args.taskId) return { ok: false, reason: 'task_mismatch', detail: `The message names ${fields.taskId}, not ${args.taskId}.` };
  if (fields.action !== args.action) return { ok: false, reason: 'action_mismatch', detail: `The message is for "${fields.action}", not "${args.action}".` };
  if (fields.wallet.toLowerCase() !== args.wallet.toLowerCase()) return { ok: false, reason: 'wallet_mismatch', detail: `The message names wallet ${fields.wallet}; this task was paid by ${args.wallet}.` };
  if (fields.network !== args.network) return { ok: false, reason: 'network_mismatch', detail: `The message names network ${fields.network}, not ${args.network}.` };
  const now = (args.now ?? new Date()).getTime();
  const issued = Date.parse(fields.issuedAt);
  if (issued > now + BIND_MAX_SKEW_MS) return { ok: false, reason: 'issued_in_future', detail: 'The message is dated in the future; check your clock.' };
  if (now - issued > ACTION_MAX_AGE_MS) return { ok: false, reason: 'expired', detail: `The message was issued more than ${ACTION_MAX_AGE_MS / 60000} minutes ago; sign a fresh one.` };
  const sig = await verifyWalletSignature(env, { address: args.wallet, network: args.network, message: args.message, signature: args.signature });
  return sig.ok ? { ok: true, fields, signerKind: sig.signerKind } : sig;
}
