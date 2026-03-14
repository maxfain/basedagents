/**
 * Payment provider interface — abstract over CDP x402, Bankr, etc.
 * BasedAgents is non-custodial: we store signed payment authorizations, not funds.
 */

export interface VerifyResult {
  valid: boolean;
  /** When the authorization expires (ISO 8601) */
  expires_at?: string;
  /** Error message if invalid */
  error?: string;
  /** Raw response from the facilitator */
  raw?: unknown;
}

export interface SettleResult {
  success: boolean;
  /** On-chain transaction hash */
  tx_hash?: string;
  /** Error message if failed */
  error?: string;
  /** Raw response from the facilitator */
  raw?: unknown;
}

export interface PaymentProvider {
  /** Provider identifier (e.g. "cdp", "bankr") */
  readonly name: string;

  /**
   * Verify a payment signature is valid and the sender has sufficient funds.
   * Does NOT settle — just confirms the authorization is valid.
   */
  verify(paymentSignature: string): Promise<VerifyResult>;

  /**
   * Settle a previously verified payment — triggers on-chain USDC transfer.
   * Should only be called after the task creator verifies the deliverable.
   */
  settle(paymentSignature: string): Promise<SettleResult>;
}
