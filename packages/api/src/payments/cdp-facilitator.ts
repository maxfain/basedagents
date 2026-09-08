/**
 * CDP x402 facilitator adapter (spec §6). ~40 lines of wire contract, pinned
 * by cdp-facilitator.test.ts.
 *
 *   POST {baseUrl}/verify   → VerifyOutcome
 *   POST {baseUrl}/settle   → SettleOutcome
 *   GET  {baseUrl}/supported → raw JSON (check script only)
 *
 * `verify` / `settle` NEVER throw: every failure mode is a classified outcome
 * so the route and settle.ts apply the OUTCOME TABLE without try/catch guesswork.
 * The classification distinguishes "the facilitator answered and said no"
 * (`invalid` / `rejected` — carries the CDP reason) from "we did not get an
 * answer" (`unavailable` — carries a `cause` for the retry schedule).
 *
 * Why not `@x402/core`'s HTTPFacilitatorClient: it throws on `success:false`,
 * losing `settlement_pending`'s `transaction`, and `@coinbase/cdp-sdk` is not
 * Workers-clean (D9).
 */

import { z } from 'zod';
import { cdpJwt } from './cdp-jwt.js';
import type { PaymentPayloadV2, PaymentRequirementsV2 } from './x402.js';

export const DEFAULT_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';
/** Per-request fetch timeout. The facilitator normally answers in < 5 s. */
export const FACILITATOR_TIMEOUT_MS = 15_000;
/** EVM transaction hash as returned in `transaction`. */
export const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

export type UnavailableCause = 'network' | 'server' | 'auth' | 'billing' | 'rate_limited' | 'malformed';

export type VerifyOutcome =
  | { kind: 'valid'; payer?: string }
  | { kind: 'invalid'; reason: string; message?: string; payer?: string; http: number }
  | { kind: 'unavailable'; cause: UnavailableCause; http?: number; detail: string };

export type SettleOutcome =
  | { kind: 'settled'; transaction: string; network?: string; payer?: string }
  /** `errorReason:'settlement_pending'` with a transaction: broadcast, not yet confirmed. */
  | { kind: 'pending'; transaction: string }
  | { kind: 'rejected'; reason: string; message?: string; transaction?: string; http: number }
  | { kind: 'unavailable'; cause: UnavailableCause; http?: number; detail: string };

export interface Facilitator {
  verify(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<VerifyOutcome>;
  settle(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<SettleOutcome>;
  /** `GET /supported`, parsed JSON. Throws on any failure — used only by scripts/x402-supported-check.mjs. */
  supported(): Promise<unknown>;
}

export interface CdpFacilitatorConfig {
  keyId: string;
  /** base64 64-byte Ed25519 secret. */
  secret: string;
  /** e.g. DEFAULT_FACILITATOR_URL or X402_FACILITATOR_URL. Trailing slashes are stripped. */
  baseUrl: string;
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Reported in Correlation-Context (package version). */
  sourceVersion: string;
}

// ─── Response schemas (nullish → undefined, like @x402/core) ───

const optStr = z.string().nullish().transform((v) => v ?? undefined);

const VerifyResponse = z
  .object({
    isValid: z.boolean(),
    invalidReason: optStr,
    invalidMessage: optStr,
    payer: optStr,
  })
  .passthrough();

const SettleResponse = z
  .object({
    success: z.boolean(),
    errorReason: optStr,
    errorMessage: optStr,
    payer: optStr,
    transaction: optStr,
    network: optStr,
  })
  .passthrough();

/** CDP's generic error envelope (401/402/429/5xx and some 400s). */
const CdpErrorEnvelope = z.object({ errorType: z.string(), errorMessage: z.string().optional() }).passthrough();

type Unavailable = { kind: 'unavailable'; cause: UnavailableCause; http?: number; detail: string };
type HttpBody = { kind: 'body'; http: number; json: unknown };

function excerpt(text: string, limit = 200): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (!compact) return '<empty response>';
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3)}...`;
}

function errorDetail(status: number, json: unknown, text: string): string {
  const env = CdpErrorEnvelope.safeParse(json);
  if (env.success) {
    return `HTTP ${status} ${env.data.errorType}${env.data.errorMessage ? `: ${env.data.errorMessage}` : ''}`;
  }
  return `HTTP ${status}: ${excerpt(text)}`;
}

export class CdpFacilitator implements Facilitator {
  private readonly keyId: string;
  private readonly secret: string;
  private readonly baseUrl: string;
  private readonly host: string;
  private readonly basePath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly correlationContext: string;

  constructor(cfg: CdpFacilitatorConfig) {
    this.keyId = cfg.keyId;
    this.secret = cfg.secret;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    const url = new URL(this.baseUrl); // throws on garbage — the factory validates first
    this.host = url.host;
    this.basePath = url.pathname.replace(/\/+$/, '');
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
    this.correlationContext = `sdkLanguage=typescript,source=basedagents-api,sourceVersion=${cfg.sourceVersion}`;
  }

  async verify(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<VerifyOutcome> {
    const res = await this.post('verify', payload, requirements);
    if (res.kind === 'unavailable') return res;
    const parsed = VerifyResponse.safeParse(res.json);
    if (!parsed.success) {
      // A 400 that is CDP's generic envelope (e.g. invalid_request) is a
      // request-level failure, not a verdict on the buyer's signature.
      return {
        kind: 'unavailable',
        cause: 'malformed',
        http: res.http,
        detail: `verify response off-shape: ${errorDetail(res.http, res.json, JSON.stringify(res.json))}`,
      };
    }
    const body = parsed.data;
    if (body.isValid) return body.payer ? { kind: 'valid', payer: body.payer } : { kind: 'valid' };
    const out: VerifyOutcome = { kind: 'invalid', reason: body.invalidReason ?? 'unknown', http: res.http };
    if (body.invalidMessage) out.message = body.invalidMessage;
    if (body.payer) out.payer = body.payer;
    return out;
  }

  async settle(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<SettleOutcome> {
    const res = await this.post('settle', payload, requirements);
    if (res.kind === 'unavailable') return res;
    const parsed = SettleResponse.safeParse(res.json);
    if (!parsed.success) {
      return {
        kind: 'unavailable',
        cause: 'malformed',
        http: res.http,
        detail: `settle response off-shape: ${errorDetail(res.http, res.json, JSON.stringify(res.json))}`,
      };
    }
    const body = parsed.data;
    const tx = body.transaction && TX_HASH_RE.test(body.transaction) ? body.transaction : undefined;

    if (body.success) {
      if (!tx) {
        return {
          kind: 'unavailable',
          cause: 'malformed',
          http: res.http,
          detail: `settle success without a valid transaction hash: ${excerpt(JSON.stringify(res.json))}`,
        };
      }
      const out: SettleOutcome = { kind: 'settled', transaction: tx };
      if (body.network) out.network = body.network;
      if (body.payer) out.payer = body.payer;
      return out;
    }

    if (body.errorReason === 'settlement_pending' && tx) {
      return { kind: 'pending', transaction: tx };
    }
    const out: SettleOutcome = { kind: 'rejected', reason: body.errorReason ?? 'unknown', http: res.http };
    if (body.errorMessage) out.message = body.errorMessage;
    if (tx) out.transaction = tx;
    return out;
  }

  async supported(): Promise<unknown> {
    const path = `${this.basePath}/supported`;
    const jwt = await cdpJwt({ keyId: this.keyId, secret: this.secret, method: 'GET', host: this.host, path });
    const res = await this.fetchImpl(`${this.baseUrl}/supported`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Correlation-Context': this.correlationContext,
      },
      signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`facilitator supported failed (${res.status}): ${excerpt(text)}`);
    return JSON.parse(text);
  }

  /**
   * One authenticated POST. Returns the parsed JSON body for 200/400 (the
   * two statuses whose body is a verdict) or a classified `unavailable`.
   */
  private async post(
    op: 'verify' | 'settle',
    paymentPayload: PaymentPayloadV2,
    paymentRequirements: PaymentRequirementsV2,
  ): Promise<HttpBody | Unavailable> {
    const path = `${this.basePath}/${op}`;
    let jwt: string;
    try {
      jwt = await cdpJwt({ keyId: this.keyId, secret: this.secret, method: 'POST', host: this.host, path });
    } catch (err) {
      return { kind: 'unavailable', cause: 'auth', detail: `cannot sign CDP JWT: ${String(err)}` };
    }

    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${op}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${jwt}`,
          'Correlation-Context': this.correlationContext,
        },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
        signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const detail =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? `facilitator ${op} timed out after ${FACILITATOR_TIMEOUT_MS}ms`
          : `facilitator ${op} fetch failed: ${e?.message ?? String(err)}`;
      return { kind: 'unavailable', cause: 'network', detail };
    }

    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      return {
        kind: 'unavailable',
        cause: 'network',
        http: res.status,
        detail: `facilitator ${op} body read failed: ${String(err)}`,
      };
    }
    let json: unknown = undefined;
    let jsonOk = false;
    try {
      json = JSON.parse(text);
      jsonOk = true;
    } catch {
      /* classified below */
    }

    const status = res.status;
    if (status === 402) return { kind: 'unavailable', cause: 'billing', http: status, detail: errorDetail(status, json, text) };
    if (status === 401 || status === 403) return { kind: 'unavailable', cause: 'auth', http: status, detail: errorDetail(status, json, text) };
    if (status === 429) return { kind: 'unavailable', cause: 'rate_limited', http: status, detail: errorDetail(status, json, text) };
    if (status >= 500) return { kind: 'unavailable', cause: 'server', http: status, detail: errorDetail(status, json, text) };
    if (status !== 200 && status !== 400) {
      return { kind: 'unavailable', cause: 'server', http: status, detail: `unexpected ${errorDetail(status, json, text)}` };
    }
    if (!jsonOk) {
      return { kind: 'unavailable', cause: 'malformed', http: status, detail: `facilitator ${op} returned non-JSON: ${excerpt(text)}` };
    }
    return { kind: 'body', http: status, json };
  }
}
