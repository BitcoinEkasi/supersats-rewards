/**
 * Checks LN address refill crediting and reconciliation against a throwaway
 * SQLite DB with a stubbed Blink transaction feed. No network calls to Blink.
 *
 * Run: npm run test:refills
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { BlinkTx, BlinkTxPage } from '../services/blink.js';

const dir = mkdtempSync(path.join(tmpdir(), 'refills-test-'));
process.env.DB_PATH = path.join(dir, 'test.db');

// Import after DB_PATH is set so the module opens the temp database
const { db } = await import('../db/index.js');
const { creditRefill, reconcileRefills, backfillMissedRefills } = await import('../services/refills.js');
const { parsePaymentUpdate } = await import('../services/blink.js');

const now = Math.floor(Date.now() / 1000);

function addUser(username: string): number {
  return Number(
    db.prepare('INSERT INTO users (username, display_name, magic_token) VALUES (?, ?, ?)')
      .run(username, username, `token-${username}`).lastInsertRowid
  );
}
function addPending(userId: number, hash: string, sats: number) {
  db.prepare('INSERT INTO pending_refills (user_id, payment_hash, amount_sats, expires_at) VALUES (?, ?, ?, ?)')
    .run(userId, hash, sats, now + 3600);
}
const balance = (id: number) =>
  (db.prepare('SELECT balance_sats FROM users WHERE id = ?').get(id) as { balance_sats: number }).balance_sats;
const refillCount = (hash: string) =>
  (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE payment_hash = ? AND type = 'refill'").get(hash) as { n: number }).n;

function tx(hash: string, sats: number, status = 'SUCCESS', direction: BlinkTx['direction'] = 'RECEIVE',
  memo: string | null = null, createdAt = now): BlinkTx {
  return { id: hash, status, direction, memo, settlementAmount: sats, settlementFee: 0,
    createdAt, counterParty: 'Lightning', paymentHash: hash };
}
const feed = (txs: BlinkTx[]) => async (): Promise<BlinkTxPage> =>
  ({ transactions: txs, hasNextPage: false, endCursor: null });

try {
  const u = addUser('tsk00021');

  // Missed WebSocket event: reconciliation credits it once
  addPending(u, 'hash-missed', 500);
  const blink = feed([tx('unrelated', 999), tx('hash-missed', 500)]);
  assert.equal(await reconcileRefills(blink), 1);
  assert.equal(balance(u), 500);
  assert.equal(refillCount('hash-missed'), 1);
  assert.equal(await reconcileRefills(blink), 0, 'second run must not double-credit');
  assert.equal(balance(u), 500);

  // Live event already credited, then reconciliation sees the same payment
  addPending(u, 'hash-live', 200);
  assert.equal(await creditRefill('hash-live', 200), u);
  assert.equal(await creditRefill('hash-live', 200), null, 'repeat event is a no-op');
  assert.equal(await reconcileRefills(feed([tx('hash-live', 200)])), 0);
  assert.equal(balance(u), 700);

  // Unsettled or outgoing transactions are never credited
  addPending(u, 'hash-pending', 300);
  assert.equal(await reconcileRefills(feed([tx('hash-pending', 300, 'PENDING'), tx('hash-pending', 300, 'SUCCESS', 'SEND')])), 0);
  assert.equal(balance(u), 700);

  // Credits the settled amount from Blink, not the requested amount
  assert.equal(await reconcileRefills(feed([tx('hash-pending', 299)])), 1);
  assert.equal(balance(u), 999);

  // Live listener: Blink-to-Blink payments arrive as IntraLedgerUpdate
  const intraLedger = {
    __typename: 'IntraLedgerUpdate', txNotificationType: 'IntraLedgerReceipt',
    transaction: { status: 'SUCCESS', settlementAmount: 55, initiationVia: { paymentHash: 'hash-blink' } },
  };
  assert.deepEqual(parsePaymentUpdate(intraLedger), { paymentHash: 'hash-blink', sats: 55 });
  assert.deepEqual(
    parsePaymentUpdate({ __typename: 'LnUpdate', status: 'PAID', paymentHash: 'hash-ln', transaction: { settlementAmount: 10 } }),
    { paymentHash: 'hash-ln', sats: 10 }
  );
  assert.equal(parsePaymentUpdate({ ...intraLedger, txNotificationType: 'IntraLedgerPayment' }), null, 'outgoing ignored');
  assert.equal(parsePaymentUpdate({ ...intraLedger, transaction: { status: 'SUCCESS', settlementAmount: 55, initiationVia: {} } }), null,
    'internal transfer without an invoice ignored');
  assert.equal(parsePaymentUpdate({ __typename: 'Price' }), null);

  // Backfill: payments whose pending row is long gone, matched by invoice memo
  const v = addUser('tsk00022');
  const archived = addUser('tsk00099');
  db.prepare('UPDATE users SET archived_at = ? WHERE id = ?').run(now, archived);
  const memo = (user: string) => `Refill for ${user}@bolt.example`;
  const history = feed([
    tx('bf-1', 400, 'SUCCESS', 'RECEIVE', memo('tsk00022')),
    tx('bf-2', 410, 'SUCCESS', 'RECEIVE', memo('tsk00022')),
    tx('hash-missed', 500, 'SUCCESS', 'RECEIVE', memo('tsk00021')),        // credited earlier
    tx('bf-other-domain', 1, 'SUCCESS', 'RECEIVE', 'Refill for tsk00022@elsewhere'),
    tx('bf-not-refill', 7, 'SUCCESS', 'RECEIVE', 'Donation'),
    tx('bf-ghost', 9, 'SUCCESS', 'RECEIVE', memo('nobody')),
    tx('bf-archived', 9, 'SUCCESS', 'RECEIVE', memo('tsk00099')),
    tx('bf-old', 999, 'SUCCESS', 'RECEIVE', memo('tsk00022'), now - 90 * 86400),
  ]);
  const opts = { since: now - 30 * 86400, domain: 'bolt.example', fetchPage: history };

  const dry = await backfillMissedRefills({ ...opts, apply: false });
  assert.deepEqual(dry.map((i) => [i.paymentHash, i.action]), [
    ['bf-1', 'would credit'], ['bf-2', 'would credit'], ['hash-missed', 'already credited'],
    ['bf-ghost', 'skipped: unknown user'], ['bf-archived', 'skipped: archived user'],
  ]);
  assert.equal(balance(v), 0, 'dry run changes nothing');

  const applied = await backfillMissedRefills({ ...opts, apply: true });
  assert.equal(applied.filter((i) => i.action === 'credited').length, 2);
  assert.equal(balance(v), 810);
  assert.equal(balance(u), 999, 'already-credited payment untouched');
  assert.equal(balance(archived), 0);

  const rerun = await backfillMissedRefills({ ...opts, apply: true });
  assert.equal(rerun.filter((i) => i.action === 'credited').length, 0, 're-run credits nothing');
  assert.equal(balance(v), 810);

  console.log('test-refills: all checks passed');
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
