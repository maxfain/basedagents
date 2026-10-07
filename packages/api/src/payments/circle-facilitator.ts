/**
 * Circle Facilitator Service adapter: settles Arc DEPOSITS (a buyer's EIP-3009
 * transfer into the escrow wallet). Same contract as the CDP adapter: `verify` /
 * `settle` never throw, and every failure is a classified outcome for settle.ts.
 *
 *   POST {baseUrl}/verify    → VerifyOutcome
 *   POST {baseUrl}/settle    → SettleOutcome
 *   GET  {baseUrl}/supported → raw JSON
 *
 * Auth is `Authorization: Bearer <CIRCLE_API_KEY>`. Settling with the key binds the
 * payment's `payTo` to that Circle account, which is right for the escrow wallet
 * and wrong for anyone else's: payouts and refunds on Arc (whose `payTo` is an
 * agent's or a buyer's wallet) never come here; the escrow wallet sends those
 * itself (arc.ts).
 *
 * Where Circle differs from CDP:
 *   - `settlement_pending` carries an empty `transaction` (the payment id is in
 *     `extensions['settlement-status']`). It maps to `pending` without a hash; the
 *     retry re-sends the identical authorization, which Circle resolves to the same
 *     payment.
 *   - Every settle carries a `payment-identifier` derived from the authorization
 *     nonce, so retries converge on one payment (idempotency per seller account).
 *   - Errors come as `{code, message, errors: [{reason}]}`.
 */
import { z } from 'zod';
import type { Facilitator, SettleOutcome, UnavailableCause, VerifyOutcome } from './cdp-facilitator.js';
import { FACILITATOR_TIMEOUT_MS, TX_HASH_RE } from './cdp-facilitator.js';
import type { PaymentPayloadV2, PaymentRequirementsV2 } from './x402.js';

export const DEFAULT_CIRCLE_FACILITATOR_URL = 'https://api.circle.com/v1/facilitator/x402';

export interface CircleFacilitatorConfig {
  apiKey: string;
  /** e.g. DEFAULT_CIRCLE_FACILITATOR_URL or CIRCLE_FACILITATOR_URL. Trailing slashes are stripped. */
  baseUrl: string;
  /** Injected by tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

const optStr = z.string().nullish().transform((v) => v ?? undefined);

const VerifyResponse = z.object({ isValid: z.boolean(), invalidReason: optStr, payer: optStr }).passthrough();

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

const CircleError = z
  .object({ code: z.number().optional(), message: z.string().optional(), errors: z.array(z.object({ reason: z.string() }).passthrough()).optional() })
  .passthrough();

type Unavailable = { kind: 'unavailable'; cause: UnavailableCause; http?: number; detail: string };
type HttpBody = { kind: 'body'; http: number; json: unknown };

function excerpt(text: string, limit = 200): string {
  const compact = text.trim().replace(/\s+/g, ' ');
  if (!compact) return '<empty response>';
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 3)}...`;
}

function errorDetail(status: number, json: unknown, text: string): string {
  const env = CircleError.safeParse(json);
  if (env.success && (env.data.message || env.data.errors?.length)) {
    const reasons = env.data.errors?.map((e) => e.reason).join(',');
    return `HTTP ${status}${reasons ? ` ${reasons}` : ''}${env.data.message ? `: ${env.data.message}` : ''}`;
  }
  return `HTTP ${status}: ${excerpt(text)}`;
}

/**
 * `payment-identifier` for an authorization: Circle's idempotency key. The nonce is
 * unique per authorization, so one signed transfer is one Circle payment.
 */
export function circlePaymentId(payload: PaymentPayloadV2): string {
  return `ba_${payload.payload.authorization.nonce.slice(2).toLowerCase()}`;
}

export class CircleFacilitator implements Facilitator {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: CircleFacilitatorConfig) {
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    new URL(this.baseUrl); // throws on garbage: the factory validates first
    this.fetchImpl = cfg.fetchImpl ?? ((input, init) => fetch(input, init));
  }

  async verify(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<VerifyOutcome> {
    const res = await this.post('verify', payload, requirements);
    if (res.kind === 'unavailable') return res;
    const parsed = VerifyResponse.safeParse(res.json);
    if (!parsed.success) {
      return { kind: 'unavailable', cause: 'malformed', http: res.http, detail: `verify response off-shape: ${errorDetail(res.http, res.json, JSON.stringify(res.json))}` };
    }
    const body = parsed.data;
    if (body.isValid) return body.payer ? { kind: 'valid', payer: body.payer } : { kind: 'valid' };
    const out: VerifyOutcome = { kind: 'invalid', reason: body.invalidReason ?? 'unknown', http: res.http };
    if (body.payer) out.payer = body.payer;
    return out;
  }

  async settle(payload: PaymentPayloadV2, requirements: PaymentRequirementsV2): Promise<SettleOutcome> {
    const withId: PaymentPayloadV2 = {
      ...payload,
      extensions: { ...payload.extensions, 'payment-identifier': { info: { required: true, id: circlePaymentId(payload) } } },
    };
    const res = await this.post('settle', withId, requirements);
    if (res.kind === 'unavailable') return res;
    const parsed = SettleResponse.safeParse(res.json);
    if (!parsed.success) {
      return { kind: 'unavailable', cause: 'malformed', http: res.http, detail: `settle response off-shape: ${errorDetail(res.http, res.json, JSON.stringify(res.json))}` };
    }
    const body = parsed.data;
    const tx = body.transaction && TX_HASH_RE.test(body.transaction) ? body.transaction : undefined;
    if (body.success) {
      if (!tx) return { kind: 'unavailable', cause: 'malformed', http: res.http, detail: `settle success without a valid transaction hash: ${excerpt(JSON.stringify(res.json))}` };
      const out: SettleOutcome = { kind: 'settled', transaction: tx };
      if (body.network) out.network = body.network;
      if (body.payer) out.payer = body.payer;
      return out;
    }
    // Pending is not failure: settlement continues, and the retry resolves it.
    if (body.errorReason === 'settlement_pending') return tx ? { kind: 'pending', transaction: tx } : { kind: 'pending' };
    const out: SettleOutcome = { kind: 'rejected', reason: body.errorReason ?? 'unknown', http: res.http };
    if (body.errorMessage) out.message = body.errorMessage;
    if (tx) out.transaction = tx;
    return out;
  }

  async supported(): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}/supported`, { method: 'GET', signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Circle facilitator supported failed (${res.status}): ${excerpt(text)}`);
    return JSON.parse(text);
  }

  /** One authenticated POST: the parsed body for 200/400, or a classified `unavailable`. */
  private async post(
    op: 'verify' | 'settle',
    paymentPayload: PaymentPayloadV2,
    paymentRequirements: PaymentRequirementsV2,
  ): Promise<HttpBody | Unavailable> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements }),
        signal: AbortSignal.timeout(FACILITATOR_TIMEOUT_MS),
      });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const detail = e?.name === 'TimeoutError' || e?.name === 'AbortError'
        ? `Circle facilitator ${op} timed out after ${FACILITATOR_TIMEOUT_MS}ms`
        : `Circle facilitator ${op} fetch failed: ${e?.message ?? String(err)}`;
      return { kind: 'unavailable', cause: 'network', detail };
    }
    let text = '';
    try {
      text = await res.text();
    } catch (err) {
      return { kind: 'unavailable', cause: 'network', http: res.status, detail: `Circle facilitator ${op} body read failed: ${String(err)}` };
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
    // 403: the trial allowance (registration_required) or an amount under Circle's minimum.
    if (status === 401 || status === 403) return { kind: 'unavailable', cause: 'auth', http: status, detail: errorDetail(status, json, text) };
    if (status === 429) return { kind: 'unavailable', cause: 'rate_limited', http: status, detail: errorDetail(status, json, text) };
    if (status === 415) return { kind: 'unavailable', cause: 'malformed', http: status, detail: errorDetail(status, json, text) };
    // 409 is an idempotency conflict: no verdict on this payment, so retry and never re-sign.
    if (status >= 500 || status === 409) return { kind: 'unavailable', cause: 'server', http: status, detail: errorDetail(status, json, text) };
    if (status !== 200 && status !== 400) return { kind: 'unavailable', cause: 'server', http: status, detail: `unexpected ${errorDetail(status, json, text)}` };
    if (!jsonOk) return { kind: 'unavailable', cause: 'malformed', http: status, detail: `Circle facilitator ${op} returned non-JSON: ${excerpt(text)}` };
    return { kind: 'body', http: status, json };
  }
}
