/**
 * CDP x402 payment provider — uses the CDP facilitator REST API directly.
 *
 * Endpoints:
 *   POST https://api.cdp.coinbase.com/platform/v2/x402/verify
 *   POST https://api.cdp.coinbase.com/platform/v2/x402/settle
 *
 * The facilitator handles on-chain settlement (EIP-3009 TransferWithAuthorization).
 * Free tier: 1,000 transactions/month.
 */

import type { PaymentProvider, VerifyResult, SettleResult } from './provider.js';

const CDP_BASE_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

export class CdpPaymentProvider implements PaymentProvider {
  readonly name = 'cdp';

  constructor(private apiKey?: string) {}

  async verify(paymentSignature: string): Promise<VerifyResult> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${CDP_BASE_URL}/verify`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          x402_payment: paymentSignature,
        }),
      });

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        return {
          valid: false,
          error: (data.message as string) ?? `Verification failed: HTTP ${response.status}`,
          raw: data,
        };
      }

      return {
        valid: true,
        expires_at: (data.valid_before as string) ?? undefined,
        raw: data,
      };
    } catch (err) {
      return {
        valid: false,
        error: `CDP verify request failed: ${String(err)}`,
      };
    }
  }

  async settle(paymentSignature: string): Promise<SettleResult> {
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${CDP_BASE_URL}/settle`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          x402_payment: paymentSignature,
        }),
      });

      const data = await response.json() as Record<string, unknown>;

      if (!response.ok) {
        return {
          success: false,
          error: (data.message as string) ?? `Settlement failed: HTTP ${response.status}`,
          raw: data,
        };
      }

      return {
        success: true,
        tx_hash: (data.tx_hash as string) ?? (data.transaction_hash as string) ?? undefined,
        raw: data,
      };
    } catch (err) {
      return {
        success: false,
        error: `CDP settle request failed: ${String(err)}`,
      };
    }
  }
}
