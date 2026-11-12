/**
 * Checks payout batch expiry reporting and the expired-batch cancel endpoint
 * against a throwaway SQLite DB. No network calls to Blink.
 *
 * Run: npx tsx src/server/scripts/test-payout-expiry.ts
 */
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

const dir = mkdtempSync(path.join(tmpdir(), 'payout-expiry-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

const { db } = await import('../db/index.js');
const { default: express } = await import('express');
const { default: apiRoutes } = await import('../routes/api.js');
const { INVOICE_EXPIRY_MINS } = await import('../services/blink.js');

const API_KEY = 'test-key';
db.prepare('INSERT INTO api_keys (key_hash, description) VALUES (?, ?)')
  .run(createHash('sha256').update(API_KEY).digest('hex'), 'test');

const app = express();
app.use(express.json());
app.use('/api/v1', apiRoutes);
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
const call = (p: string, method = 'GET') =>
  fetch(`${base}${p}`, { method, headers: { 'X-API-Key': API_KEY } });
const body = async (res: Response): Promise<any> => res.json();

const now = Math.floor(Date.now() / 1000);
const expirySecs = INVOICE_EXPIRY_MINS * 60;
function addBatch(hash: string, createdAt: number, status = 'pending', source = 'invoice'): number {
  return Number(db.prepare(
    'INSERT INTO payout_batches (payment_hash, payment_request, total_sats, memo, status, created_at, source) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(hash, 'lnbc1test', 1000, 'test', status, createdAt, source).lastInsertRowid);
}

try {
  const fresh = addBatch('h-fresh', now - 60);
  const old = addBatch('h-old', now - expirySecs - 60);
  const paidOld = addBatch('h-paid', now - expirySecs - 60, 'paid');
  const direct = addBatch('h-direct', now - expirySecs - 60, 'paid', 'direct');

  // GET reports expiry
  let r = await body(await call(`/payout/batch/${fresh}`));
  assert.equal(r.expired, false);
  assert.equal(r.expires_at, now - 60 + expirySecs);
  assert.equal(r.created_at, undefined, 'internal columns not leaked');
  r = await body(await call(`/payout/batch/${old}`));
  assert.equal(r.expired, true);
  r = await body(await call(`/payout/batch/${paidOld}`));
  assert.equal(r.expired, false, 'paid batches are never expired');
  r = await body(await call(`/payout/batch/${direct}`));
  assert.equal(r.expires_at, null);

  // Cancel refuses a still-valid invoice and non-pending batches
  assert.equal((await call(`/payout/batch/${fresh}/cancel`, 'POST')).status, 409);
  assert.equal((await call(`/payout/batch/${paidOld}/cancel`, 'POST')).status, 409);
  assert.equal((await call(`/payout/batch/999/cancel`, 'POST')).status, 404);

  // Cancel succeeds on an expired pending batch, idempotently
  let res = await call(`/payout/batch/${old}/cancel`, 'POST');
  assert.equal(res.status, 200);
  assert.equal((await body(res)).status, 'cancelled');
  res = await call(`/payout/batch/${old}/cancel`, 'POST');
  assert.equal(res.status, 200);
  r = await body(await call(`/payout/batch/${old}`));
  assert.equal(r.status, 'cancelled');
  assert.equal(r.expired, false);

  // A cancelled batch is no longer matched by the payment handler's lookup
  const match = db.prepare("SELECT * FROM payout_batches WHERE payment_hash = ? AND status = 'pending'").get('h-old');
  assert.equal(match, undefined);

  console.log('test-payout-expiry: all checks passed');
} finally {
  server.close();
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
