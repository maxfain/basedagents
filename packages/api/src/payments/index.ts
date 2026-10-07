/**
 * Payment provider factory — the fail-closed switch (spec N6).
 *
 * The provider routes by network: CDP settles Base and Polygon; Arc (arc.ts) settles
 * buyers' deposits through Circle (CIRCLE_API_KEY) and the escrow wallet's own payouts
 * and refunds through its relay (ESCROW_WALLET_PRIVATE_KEY, ARC_RPC_URL).
 *
 * `paymentProviderFor(env)` returns a `Facilitator` ONLY when every piece is
 * present and well-formed:
 *   - TASK_PAYMENTS_ENABLED === '1'        (var; absent by default)
 *   - CDP_API_KEY_ID                       (secret)
 *   - CDP_API_KEY_SECRET is an Ed25519 key (secret; base64 of 64 bytes)
 *   - PAYMENT_ENCRYPTION_KEY is 64 hex     (secret; AES-256-GCM for stored headers)
 *   - X402_FACILITATOR_URL, if set, is an http(s) URL
 * Otherwise it returns null and the callers fail closed: 503 on bounty
 * create / paid accept, cron settle pass skipped. Each DISTINCT null reason is
 * logged once per isolate (a misconfigured key is visible without spamming, and
 * fixing one secret surfaces the next problem instead of going quiet).
 *
 * Tests inject a fake through `setPaymentProviderForTests` (null = "disabled").
 */

import type { Bindings } from '../types/index.js';
import { ARC_NETWORK } from '../types/index.js';
import { CdpFacilitator, DEFAULT_FACILITATOR_URL, type Facilitator } from './cdp-facilitator.js';
import { parseEd25519Secret } from './cdp-jwt.js';
import { arcFacilitatorFor, NetworkRouter } from './arc.js';

export type { Facilitator, VerifyOutcome, SettleOutcome, UnavailableCause } from './cdp-facilitator.js';

/** Reported to CDP in Correlation-Context; bump with notable payment-path changes. */
export const PAYMENTS_SOURCE_VERSION = '0.6.0';

export type PaymentsEnv = Pick<
  Bindings,
  'TASK_PAYMENTS_ENABLED' | 'CDP_API_KEY_ID' | 'CDP_API_KEY_SECRET' | 'PAYMENT_ENCRYPTION_KEY' | 'X402_FACILITATOR_URL'
  | 'CIRCLE_API_KEY' | 'CIRCLE_FACILITATOR_URL' | 'ESCROW_WALLET_PRIVATE_KEY' | 'ARC_RPC_URL'
>;

const HEX_KEY_RE = /^[0-9a-fA-F]{64}$/;

/** `undefined` = derive from env; `null` = forced disabled; otherwise the injected fake. */
let testOverride: Facilitator | null | undefined = undefined;
/** The last disabled reason logged by this isolate: one line per distinct reason. */
let lastLoggedReason: string | null = null;
/** Single-entry memo so a hot Worker does not re-derive the Ed25519 public key per request. */
let memo: { fingerprint: string; provider: Facilitator } | null = null;

/**
 * Why payments are disabled for this env, or null when fully configured.
 * Also backs `GET /v1/status.payments` and the enable checklist.
 */
export function paymentsDisabledReason(env: PaymentsEnv | undefined | null): string | null {
  if (!env) return 'no env bindings';
  if (env.TASK_PAYMENTS_ENABLED !== '1') return "TASK_PAYMENTS_ENABLED is not '1'";
  if (!env.CDP_API_KEY_ID) return 'CDP_API_KEY_ID is not set';
  if (!env.CDP_API_KEY_SECRET) return 'CDP_API_KEY_SECRET is not set';
  try {
    parseEd25519Secret(env.CDP_API_KEY_SECRET);
  } catch (err) {
    return `CDP_API_KEY_SECRET is not an Ed25519 key (${(err as Error).message})`;
  }
  if (!env.PAYMENT_ENCRYPTION_KEY || !HEX_KEY_RE.test(env.PAYMENT_ENCRYPTION_KEY)) {
    return 'PAYMENT_ENCRYPTION_KEY is not 64 hex characters';
  }
  if (env.X402_FACILITATOR_URL !== undefined && env.X402_FACILITATOR_URL !== '') {
    try {
      const u = new URL(env.X402_FACILITATOR_URL);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return 'X402_FACILITATOR_URL is not an http(s) URL';
    } catch {
      return 'X402_FACILITATOR_URL is not a valid URL';
    }
  }
  return null;
}

export function paymentProviderFor(env: PaymentsEnv | undefined | null): Facilitator | null {
  if (testOverride !== undefined) return testOverride;

  const reason = paymentsDisabledReason(env);
  if (reason !== null) {
    if (reason !== lastLoggedReason) {
      lastLoggedReason = reason;
      // The flag being off is the expected prod default (informational); the
      // flag being on with a broken key is a misconfiguration worth an error.
      if (env?.TASK_PAYMENTS_ENABLED === '1') console.error(`[payments] disabled: ${reason}`);
      else console.log(`[payments] disabled: ${reason}`);
    }
    return null;
  }

  const keyId = env!.CDP_API_KEY_ID!;
  const secret = env!.CDP_API_KEY_SECRET!;
  const baseUrl = env!.X402_FACILITATOR_URL || DEFAULT_FACILITATOR_URL;
  const fingerprint = JSON.stringify([
    keyId, secret, baseUrl, env!.CIRCLE_API_KEY ?? '', env!.CIRCLE_FACILITATOR_URL ?? '', env!.ESCROW_WALLET_PRIVATE_KEY ?? '', env!.ARC_RPC_URL ?? '',
  ]);
  if (memo && memo.fingerprint === fingerprint) return memo.provider;
  // CDP settles Base and Polygon; Arc goes to Circle (deposits) or the escrow wallet's own relay (payouts, refunds).
  const provider = new NetworkRouter(
    new CdpFacilitator({ keyId, secret, baseUrl, sourceVersion: PAYMENTS_SOURCE_VERSION }),
    { [ARC_NETWORK]: arcFacilitatorFor(env!) },
  );
  memo = { fingerprint, provider };
  return provider;
}

/**
 * Test hook. `undefined` restores env-derived behaviour (and resets the
 * one-line log flag + memo so each test starts clean); `null` forces
 * "payments disabled"; any object is returned verbatim by the factory.
 */
export function setPaymentProviderForTests(p: Facilitator | null | undefined): void {
  testOverride = p;
  lastLoggedReason = null;
  memo = null;
}
