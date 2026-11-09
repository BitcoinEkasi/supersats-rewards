/**
 * Checks Lightning-address receive limits: settings defaults, amount
 * validation, and the per-IP invoice rate limiter. Uses a throwaway SQLite DB.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

const dir = mkdtempSync(path.join(tmpdir(), 'receive-limits-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const { db } = await import('../db/index.js');
const { getReceiveSettings, validateAmount } = await import('../services/receiveLimits.js');
const { allowInvoiceRequest, sweepInvoiceRequests, invoiceRequestIpCount } = await import('../services/rateLimit.js');

try {
  // Defaults from the migration
  assert.deepEqual(getReceiveSettings(), { maxSats: 500_000, ratePerMin: 10 });

  // Amount validation follows the stored max
  assert.equal(validateAmount(1_000, 500_000), null, '1 sat allowed');
  assert.equal(validateAmount(500_000_000, 500_000), null, '500,000 sats allowed');
  assert.equal(validateAmount(500_001_000, 500_000), 'Amount must be between 1 and 500,000 sats');
  assert.notEqual(validateAmount(999, 500_000), null, 'below 1 sat rejected');
  assert.notEqual(validateAmount(NaN, 500_000), null, 'missing/garbage amount rejected');
  assert.notEqual(validateAmount(1_500.5, 500_000), null, 'fractional msats rejected');

  // A changed setting applies on the next read
  db.prepare('UPDATE system_settings SET ln_receive_max_sats = 20000, ln_invoice_rate_per_min = 3 WHERE id = 1').run();
  assert.deepEqual(getReceiveSettings(), { maxSats: 20_000, ratePerMin: 3 });
  assert.notEqual(validateAmount(20_001_000, getReceiveSettings().maxSats), null);

  // Rate limiter: 10 per minute per IP, sliding window
  const t0 = 1_000_000;
  // One request a second for 10 seconds
  for (let i = 0; i < 10; i++) assert.equal(allowInvoiceRequest('1.1.1.1', 10, t0 + i * 1000), true, `request ${i + 1} allowed`);
  assert.equal(allowInvoiceRequest('1.1.1.1', 10, t0 + 9_500), false, '11th blocked');
  assert.equal(allowInvoiceRequest('2.2.2.2', 10, t0 + 100), true, 'other IPs unaffected');
  assert.equal(allowInvoiceRequest('1.1.1.1', 10, t0 + 59_000), false, 'still blocked inside the window');
  assert.equal(allowInvoiceRequest('1.1.1.1', 10, t0 + 60_001), true, 'allowed once the oldest falls out');
  assert.equal(allowInvoiceRequest('1.1.1.1', 10, t0 + 60_002), false, 'only as many as have expired');

  // A lower limit applies immediately to an IP with history
  assert.equal(allowInvoiceRequest('2.2.2.2', 1, t0 + 200), false, 'lowered limit applies at once');

  // Sweep drops idle IPs only
  allowInvoiceRequest('3.3.3.3', 10, t0 + 200_000);
  sweepInvoiceRequests(t0 + 200_000);
  assert.equal(invoiceRequestIpCount(), 1, 'only the recently active IP remains');

  console.log('test-receive-limits: all checks passed');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
