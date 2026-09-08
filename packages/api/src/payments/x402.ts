/**
 * x402 v2 helpers for task bounties (spec §2 Step 3 / Step 5, §6, N1, N9, N12).
 *
 * Pure functions only — no DB, no fetch. Everything here is Workers-safe
 * (no Buffer / process / node: imports): bytes go through Uint8Array,
 * TextEncoder/TextDecoder, and a strict hand-rolled base64 codec.
 *
 * Money boundary: amounts are ATOMIC-UNIT STRINGS (USDC has 6 decimals) and
 * are compared with BigInt, never parsed as floats. `usdcToAtomic` /
 * `atomicToDisplay` exist for the edges (CLI/MCP/console) and for responses;
 * the API itself accepts only `BOUNTY_AMOUNT_RE`.
 */

import { z } from 'zod';
import type { Bindings } from '../types/index.js';

// ─── Constants (spec §2 "Constants") ───

/** `maxTimeoutSeconds` we advertise: the buyer signs `validBefore ≤ now + 3600`. */
export const MAX_TIMEOUT_SECONDS = 3600;
/** Reject an authorization whose `validBefore` is closer than this to now. */
export const MIN_VALID_BEFORE_SLACK = 120;
/** Clock-skew allowance on top of MAX_TIMEOUT_SECONDS for the upper bound. */
export const MAX_VALID_BEFORE_SKEW = 600;
/** settle.ts refuses to broadcast an authorization expiring within this many seconds. */
export const SETTLE_PRECHECK_SLACK = 30;
/** Largest PAYMENT-SIGNATURE header we will decode. */
export const HEADER_MAX_BYTES = 16384;

/** API `bounty.amount`: atomic units, no leading zero, ≤ 10 digits (N1). */
export const BOUNTY_AMOUNT_RE = /^[1-9][0-9]{0,9}$/;
/** 1,000 USDC in atomic units — the per-task ceiling (N1). */
export const MAX_BOUNTY_ATOMIC = 1_000_000_000n;
/** USDC decimals. */
const USDC_DECIMALS = 6n;
const ATOMIC_PER_USDC = 10n ** USDC_DECIMALS;

/** Public resource URL prefix used in `PaymentRequired.resource.url`. */
export const TASK_RESOURCE_BASE = 'https://api.basedagents.ai/v1/tasks';

// ─── Networks and assets (N12) ───

export const NETWORKS = ['eip155:8453', 'eip155:84532'] as const;
export type Network = (typeof NETWORKS)[number];

export function isNetwork(v: unknown): v is Network {
  return typeof v === 'string' && (NETWORKS as readonly string[]).includes(v);
}

export interface AssetInfo {
  asset: `0x${string}`;
  chainId: number;
  /** EIP-712 domain (name, version) of the USDC contract on that chain. */
  defaultExtra: { name: string; version: string };
}

export const ASSETS: Record<Network, AssetInfo> = {
  // USDC on Base mainnet. The domain name is NOT confirmed by any saved
  // Coinbase doc (spec §12 risk 1) — override with X402_EIP712_NAME/VERSION
  // if `/supported` or a staging dry run says otherwise.
  'eip155:8453': {
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453,
    defaultExtra: { name: 'USD Coin', version: '2' },
  },
  // USDC on Base Sepolia.
  'eip155:84532': {
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    chainId: 84532,
    defaultExtra: { name: 'USDC', version: '2' },
  },
};

export type X402Env = Pick<Bindings, 'X402_EIP712_NAME' | 'X402_EIP712_VERSION'>;

/**
 * Asset address + EIP-712 `extra` for a network. The env overrides apply to
 * mainnet (8453) only — Sepolia's domain is known and fixed.
 */
export function assetFor(
  network: Network,
  env?: X402Env | null,
): { asset: `0x${string}`; extra: { name: string; version: string } } {
  const info = ASSETS[network];
  if (!info) throw new Error(`unsupported network: ${String(network)}`);
  let { name, version } = info.defaultExtra;
  if (network === 'eip155:8453') {
    if (env?.X402_EIP712_NAME) name = env.X402_EIP712_NAME;
    if (env?.X402_EIP712_VERSION) version = env.X402_EIP712_VERSION;
  }
  return { asset: info.asset, extra: { name, version } };
}

// ─── Zod schemas (spec Step 5) ───

const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const addr = z.string().regex(ADDR_RE, 'expected a 0x-prefixed 20-byte hex address');
const atomicAmount = z.string().regex(/^[0-9]{1,30}$/, 'expected an atomic-unit integer string');
const unixSeconds = z.string().regex(/^[0-9]{1,12}$/, 'expected a unix timestamp in seconds');

export const PaymentRequirementsV2 = z.object({
  scheme: z.literal('exact'),
  network: z.enum(NETWORKS),
  asset: addr,
  amount: atomicAmount,
  payTo: addr,
  maxTimeoutSeconds: z.number().int().positive(),
  extra: z.object({ name: z.string(), version: z.string() }).passthrough(),
});
export type PaymentRequirementsV2 = z.infer<typeof PaymentRequirementsV2>;

export const ResourceInfo = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfo>;

export const ExactEvmAuthorization = z.object({
  from: addr,
  to: addr,
  value: atomicAmount,
  validAfter: unixSeconds,
  validBefore: unixSeconds,
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'expected a bytes32 hex nonce'),
});
export type ExactEvmAuthorization = z.infer<typeof ExactEvmAuthorization>;

export const PaymentPayloadV2 = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfo.optional(),
  accepted: PaymentRequirementsV2,
  payload: z.object({
    signature: z.string().regex(/^0x[0-9a-fA-F]{130,}$/, 'expected a hex EIP-712 signature'),
    authorization: ExactEvmAuthorization,
  }),
});
export type PaymentPayloadV2 = z.infer<typeof PaymentPayloadV2>;

/** The 402 body / PAYMENT-REQUIRED header (x402 v2 `PaymentRequired`). */
export interface PaymentRequired {
  x402Version: 2;
  error?: string;
  resource: { url: string; description: string; mimeType: string };
  accepts: PaymentRequirementsV2[];
}

// ─── Errors ───

/** A PAYMENT-SIGNATURE header we could not turn into a v2 payload → 400 payment_malformed. */
export class PaymentMalformed extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`payment_malformed: ${detail}`);
    this.name = 'PaymentMalformed';
    this.detail = detail;
  }
}

// ─── Base64 (strict, Workers-safe, no atob/btoa) ───

const B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < 64; i++) t[B64_STD.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // base64url
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

/** Standard base64 (with padding) or, with `urlSafe`, base64url without padding. */
export function bytesToBase64(bytes: Uint8Array, urlSafe = false): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += B64_STD[(n >> 18) & 63] + B64_STD[(n >> 12) & 63] + B64_STD[(n >> 6) & 63] + B64_STD[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = bytes[i] << 16;
    out += B64_STD[(n >> 18) & 63] + B64_STD[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += B64_STD[(n >> 18) & 63] + B64_STD[(n >> 12) & 63] + B64_STD[(n >> 6) & 63] + '=';
  }
  if (urlSafe) return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return out;
}

/**
 * Decode base64 OR base64url (padding optional). Throws on any character
 * outside the two alphabets, on interior padding, or on an impossible length.
 */
export function base64ToBytes(input: string): Uint8Array {
  const s = input.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/\-_]/.test(s)) throw new Error('invalid base64 character');
  if (s.length % 4 === 1) throw new Error('invalid base64 length');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < s.length; i++) {
    // Keep the accumulator bounded (only the low `bits` bits are live).
    acc = ((acc & 0xff) << 6) | B64_LOOKUP[s.charCodeAt(i)];
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

export function base64urlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes, true);
}

const utf8 = new TextEncoder();
const utf8Strict = new TextDecoder('utf-8', { fatal: true });

/** `base64(JSON.stringify(v))` — the encoding of PAYMENT-REQUIRED / PAYMENT-RESPONSE headers. */
export function encodeB64Json(v: unknown): string {
  return bytesToBase64(utf8.encode(JSON.stringify(v)));
}

// ─── Header decode (Step 5) ───

function zodDetail(err: z.ZodError): string {
  return err.issues
    .slice(0, 5)
    .map((i) => `${i.path.length ? i.path.join('.') : '$'}: ${i.message}`)
    .join('; ');
}

/**
 * Decode a PAYMENT-SIGNATURE header into a validated v2 payload.
 *
 * Accepts standard base64, base64url, or raw JSON (when the trimmed value
 * starts with `{`). Anything over HEADER_MAX_BYTES, undecodable, non-JSON,
 * x402 v1, or off-shape throws `PaymentMalformed` with a human `detail`.
 */
export function decodePaymentHeader(raw: string): PaymentPayloadV2 {
  if (typeof raw !== 'string') throw new PaymentMalformed('header is not a string');
  const rawBytes = utf8.encode(raw);
  if (rawBytes.byteLength > HEADER_MAX_BYTES) {
    throw new PaymentMalformed(`header exceeds ${HEADER_MAX_BYTES} bytes`);
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) throw new PaymentMalformed('header is empty');

  let text: string;
  if (trimmed.startsWith('{')) {
    text = trimmed;
  } else {
    let bytes: Uint8Array;
    try {
      bytes = base64ToBytes(trimmed);
    } catch {
      throw new PaymentMalformed('header is neither JSON nor base64');
    }
    try {
      text = utf8Strict.decode(bytes);
    } catch {
      throw new PaymentMalformed('decoded header is not valid UTF-8');
    }
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new PaymentMalformed('header is not valid JSON');
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new PaymentMalformed('payload must be a JSON object');
  }
  const version = (json as { x402Version?: unknown }).x402Version;
  if (version !== 2) {
    throw new PaymentMalformed(
      version === 1
        ? 'x402 v1 payloads are not supported; send an x402Version:2 payload'
        : `unsupported x402Version ${JSON.stringify(version ?? null)}; expected 2`,
    );
  }
  const parsed = PaymentPayloadV2.safeParse(json);
  if (!parsed.success) throw new PaymentMalformed(zodDetail(parsed.error));
  return parsed.data;
}

// ─── Requirements (Step 3) ───

export interface BountyTaskLike {
  task_id: string;
  bounty_amount: string | null | undefined;
  bounty_network: string | null | undefined;
}

/**
 * The `PaymentRequirements` we serve in the 402 and send to the facilitator.
 * ALWAYS rebuilt from the DB row + the deliverer's live wallet — never from
 * the buyer's `accepted` block.
 */
export function buildRequirements(
  task: BountyTaskLike,
  payTo: string,
  env?: X402Env | null,
): PaymentRequirementsV2 {
  if (!task.bounty_amount) throw new Error(`task ${task.task_id} has no bounty_amount`);
  if (!isNetwork(task.bounty_network)) {
    throw new Error(`task ${task.task_id} has unsupported bounty_network ${String(task.bounty_network)}`);
  }
  if (!ADDR_RE.test(payTo)) throw new Error(`payTo is not an EVM address: ${payTo}`);
  const { asset, extra } = assetFor(task.bounty_network, env);
  return PaymentRequirementsV2.parse({
    scheme: 'exact',
    network: task.bounty_network,
    asset,
    amount: task.bounty_amount,
    payTo,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra,
  });
}

/** The x402 v2 `PaymentRequired` envelope (402 body fields + PAYMENT-REQUIRED header). */
export function buildPaymentRequired(
  task: { task_id: string },
  requirements: PaymentRequirementsV2,
  error?: string,
): PaymentRequired {
  const out: PaymentRequired = {
    x402Version: 2,
    resource: {
      url: `${TASK_RESOURCE_BASE}/${task.task_id}/accept`,
      description: `BasedAgents task ${task.task_id} bounty`,
      mimeType: 'application/json',
    },
    accepts: [requirements],
  };
  if (error !== undefined) out.error = error;
  return out;
}

// ─── Local prechecks (Step 5, before spending a facilitator call) ───

export type PrecheckReason =
  | 'recipient_mismatch'
  | 'amount_mismatch'
  | 'requirements_mismatch'
  | 'not_yet_valid'
  | 'valid_before_out_of_range';

export type PrecheckResult =
  | { ok: true }
  | { ok: false; reason: PrecheckReason; expected?: string; got?: string };

function sameAddr(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Bind the signed authorization to OUR requirements. Each failure maps to
 * `402 payment_invalid {reason, expected, got}` in the route. Order matters
 * only for which reason a doubly-wrong payload reports first.
 */
export function localPrechecks(
  payload: PaymentPayloadV2,
  requirements: PaymentRequirementsV2,
  nowSec: number,
): PrecheckResult {
  const auth = payload.payload.authorization;
  const acc = payload.accepted;

  if (!sameAddr(auth.to, requirements.payTo)) {
    return { ok: false, reason: 'recipient_mismatch', expected: requirements.payTo, got: auth.to };
  }
  if (BigInt(auth.value) !== BigInt(requirements.amount)) {
    return { ok: false, reason: 'amount_mismatch', expected: requirements.amount, got: auth.value };
  }

  const mismatches: Array<[string, string, string]> = [];
  if (acc.network !== requirements.network) mismatches.push(['network', requirements.network, acc.network]);
  if (!sameAddr(acc.asset, requirements.asset)) mismatches.push(['asset', requirements.asset, acc.asset]);
  if (!sameAddr(acc.payTo, requirements.payTo)) mismatches.push(['payTo', requirements.payTo, acc.payTo]);
  if (acc.amount !== requirements.amount) mismatches.push(['amount', requirements.amount, acc.amount]);
  if (mismatches.length) {
    return {
      ok: false,
      reason: 'requirements_mismatch',
      expected: mismatches.map(([f, e]) => `${f}=${e}`).join(','),
      got: mismatches.map(([f, , g]) => `${f}=${g}`).join(','),
    };
  }

  const validAfter = Number(auth.validAfter);
  if (validAfter > nowSec) {
    return { ok: false, reason: 'not_yet_valid', expected: `validAfter<=${nowSec}`, got: auth.validAfter };
  }
  const validBefore = Number(auth.validBefore);
  const min = nowSec + MIN_VALID_BEFORE_SLACK;
  const max = nowSec + MAX_TIMEOUT_SECONDS + MAX_VALID_BEFORE_SKEW;
  if (validBefore < min || validBefore > max) {
    return { ok: false, reason: 'valid_before_out_of_range', expected: `${min}..${max}`, got: auth.validBefore };
  }
  return { ok: true };
}

// ─── Amount conversion (N1; copied verbatim into the SDK — no cross-package import) ───

const USDC_DECIMAL_RE = /^\d{1,7}(\.\d{1,6})?$/;

/**
 * `'5'` / `'5.00'` / `'0.5'` → atomic-unit string (`'5000000'`, `'500000'`).
 * Rejects anything but a plain decimal with ≤ 6 fraction digits, zero, and
 * amounts above MAX_BOUNTY_ATOMIC (1,000 USDC). Output always satisfies
 * BOUNTY_AMOUNT_RE.
 */
export function usdcToAtomic(decimal: string): string {
  if (typeof decimal !== 'string' || !USDC_DECIMAL_RE.test(decimal)) {
    throw new Error('amount must be a decimal USDC string with at most 6 decimals (e.g. "5.00")');
  }
  const [whole, frac = ''] = decimal.split('.');
  const atomic = BigInt(whole) * ATOMIC_PER_USDC + BigInt(frac.padEnd(6, '0'));
  if (atomic <= 0n) throw new Error('amount must be greater than zero');
  if (atomic > MAX_BOUNTY_ATOMIC) throw new Error('amount exceeds the 1000 USDC maximum');
  return atomic.toString();
}

/**
 * Atomic-unit string → human decimal with at least 2 fraction digits;
 * trailing zeros beyond the 2nd decimal are trimmed (`'5000000'` → `'5.00'`,
 * `'5120000'` → `'5.12'`, `'5123456'` → `'5.123456'`).
 */
export function atomicToDisplay(atomic: string): string {
  if (typeof atomic !== 'string' || !/^[0-9]{1,30}$/.test(atomic)) {
    throw new Error('atomic amount must be a non-negative integer string');
  }
  const n = BigInt(atomic);
  const whole = (n / ATOMIC_PER_USDC).toString();
  let frac = (n % ATOMIC_PER_USDC).toString().padStart(6, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole}.${frac}`;
}
