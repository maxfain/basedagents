/**
 * USDC amount conversion for the console edge. Bounties cross the wire as
 * ATOMIC-UNIT STRINGS (USDC has 6 decimals); a human types a decimal. These
 * mirror packages/api/src/payments/x402.ts verbatim (no cross-package import —
 * the console never bundles the worker) so the browser and the server agree on
 * exactly one integer.
 *
 * BigInt only — never parse an amount as a float.
 */

const USDC_DECIMALS = 6n;
const ATOMIC_PER_USDC = 10n ** USDC_DECIMALS;
/** 1,000 USDC in atomic units — the per-task ceiling (API N1). */
export const MAX_BOUNTY_ATOMIC = 1_000_000_000n;
const USDC_DECIMAL_RE = /^\d{1,7}(\.\d{1,6})?$/;

/**
 * `'5'` / `'5.00'` / `'0.10'` → atomic-unit string (`'5000000'`, `'100000'`).
 * Rejects anything but a plain decimal with ≤ 6 fraction digits, zero, and
 * amounts above 1,000 USDC. Throws with a human message the composer surfaces.
 */
export function usdcToAtomic(decimal: string): string {
  const v = decimal.trim();
  if (!USDC_DECIMAL_RE.test(v)) {
    throw new Error('Enter a USDC amount like 0.10 or 5 (up to 6 decimal places).');
  }
  const [whole, frac = ''] = v.split('.');
  const atomic = BigInt(whole) * ATOMIC_PER_USDC + BigInt(frac.padEnd(6, '0'));
  if (atomic <= 0n) throw new Error('The bounty must be more than zero.');
  if (atomic > MAX_BOUNTY_ATOMIC) throw new Error('The bounty cannot exceed 1,000 USDC.');
  return atomic.toString();
}

/**
 * Atomic-unit string → human decimal with at least 2 fraction digits; trailing
 * zeros beyond the 2nd decimal are trimmed (`'5000000'` → `'5.00'`,
 * `'100000'` → `'0.10'`, `'5123456'` → `'5.123456'`).
 */
export function atomicToDisplay(atomic: string): string {
  if (!/^[0-9]{1,30}$/.test(atomic)) throw new Error('atomic amount must be a non-negative integer string');
  const n = BigInt(atomic);
  const whole = (n / ATOMIC_PER_USDC).toString();
  let frac = (n % ATOMIC_PER_USDC).toString().padStart(6, '0');
  while (frac.length > 2 && frac.endsWith('0')) frac = frac.slice(0, -1);
  return `${whole}.${frac}`;
}
