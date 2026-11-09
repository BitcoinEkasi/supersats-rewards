import { db } from '../db/index.js';

// Limits on payments received via participants' Lightning addresses (LNURL-pay).
// Set by admins on the dashboard; card spending limits are separate.

export const MIN_RECEIVE_SATS = 1;
export const MAX_RECEIVE_SATS_CEILING = 10_000_000; // 0.1 BTC — typo guard for the admin setting
export const MAX_RATE_PER_MIN_CEILING = 600;

export interface ReceiveSettings {
  maxSats: number;
  ratePerMin: number;
}

export function getReceiveSettings(): ReceiveSettings {
  const row = db
    .prepare('SELECT ln_receive_max_sats, ln_invoice_rate_per_min FROM system_settings WHERE id = 1')
    .get() as { ln_receive_max_sats: number; ln_invoice_rate_per_min: number };
  return { maxSats: row.ln_receive_max_sats, ratePerMin: row.ln_invoice_rate_per_min };
}

// Returns an LNURL error reason, or null if the amount (in msats) is allowed.
export function validateAmount(amountMsats: number, maxSats: number): string | null {
  if (!Number.isInteger(amountMsats) || amountMsats < MIN_RECEIVE_SATS * 1000 || amountMsats > maxSats * 1000) {
    return `Amount must be between ${MIN_RECEIVE_SATS.toLocaleString('en-US')} and ${maxSats.toLocaleString('en-US')} sats`;
  }
  return null;
}
