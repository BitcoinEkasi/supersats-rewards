import { db } from '../db/index.js';
import { getTransactions, type BlinkTxPage } from './blink.js';
import { getZarPerSat } from './zarPrice.js';

// How long a pending refill is kept after its invoice expires, so a payment
// whose WebSocket event was missed can still be found and credited.
export const REFILL_GRACE_SECS = 24 * 60 * 60;

const MAX_PAGES = 20;
const PAGE_SIZE = 100;

// ── creditRefill ──────────────────────────────────────────────────────────────

// Credits a paid LN address invoice to its user. Idempotent: the pending row is
// checked and deleted inside the same transaction, so a second call (WebSocket
// event + reconciliation) is a no-op. Returns the credited user id, or null.
export async function creditRefill(paymentHash: string, amountSats: number): Promise<number | null> {
  const zarPerSat = await getZarPerSat();

  return db.transaction(() => {
    const pending = db
      .prepare('SELECT user_id FROM pending_refills WHERE payment_hash = ?')
      .get(paymentHash) as { user_id: number } | undefined;
    if (!pending) return null;

    db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(
      amountSats,
      pending.user_id
    );
    db.prepare(
      'INSERT INTO transactions (user_id, type, amount_sats, payment_hash, description, zar_per_sat) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(pending.user_id, 'refill', amountSats, paymentHash, 'LN Address payment', zarPerSat);
    db.prepare('DELETE FROM pending_refills WHERE payment_hash = ?').run(paymentHash);
    return pending.user_id;
  })();
}

// ── reconcileRefills ──────────────────────────────────────────────────────────

// Catches LN address payments whose WebSocket event was missed (socket
// reconnecting, container restart). Pages back through Blink transactions far
// enough to cover the oldest pending refill and credits any settled match.
export async function reconcileRefills(
  fetchPage: (first: number, after?: string) => Promise<BlinkTxPage> = getTransactions
): Promise<number> {
  const pending = db
    .prepare('SELECT payment_hash, created_at FROM pending_refills')
    .all() as { payment_hash: string; created_at: number }[];
  if (pending.length === 0) return 0;

  const hashes = new Set(pending.map((p) => p.payment_hash));
  const oldest = Math.min(...pending.map((p) => p.created_at));

  let credited = 0;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES && hashes.size > 0; page++) {
    const { transactions, hasNextPage, endCursor } = await fetchPage(PAGE_SIZE, after);

    for (const tx of transactions) {
      if (
        tx.paymentHash &&
        hashes.has(tx.paymentHash) &&
        tx.direction === 'RECEIVE' &&
        tx.status === 'SUCCESS' &&
        tx.settlementAmount > 0
      ) {
        hashes.delete(tx.paymentHash);
        const userId = await creditRefill(tx.paymentHash, Math.abs(tx.settlementAmount));
        if (userId !== null) {
          credited++;
          console.log(`[reconcile] Credited ${Math.abs(tx.settlementAmount)} sats to user #${userId} (missed event)`);
        }
      }
    }

    // Transactions come newest first; stop once we're older than every pending refill
    const last = transactions[transactions.length - 1];
    if (!hasNextPage || !endCursor || !last || last.createdAt < oldest - 60) break;
    after = endCursor;
  }
  return credited;
}

// ── backfillMissedRefills ─────────────────────────────────────────────────────

export interface BackfillItem {
  username: string;
  userId: number | null;
  sats: number;
  createdAt: number;
  paymentHash: string;
  action: 'credited' | 'would credit' | 'already credited' | 'skipped: unknown user' | 'skipped: archived user';
}

// Finds LN address payments that reached the Blink wallet but were never
// credited, including ones whose pending row is long gone. Matches on the
// invoice memo set in routes/lnurlp.ts ("Refill for <username>@<domain>") and
// skips any payment hash already recorded, so it is safe to re-run.
export async function backfillMissedRefills(opts: {
  since: number;
  apply: boolean;
  domain: string;
  fetchPage?: (first: number, after?: string) => Promise<BlinkTxPage>;
}): Promise<BackfillItem[]> {
  const fetchPage = opts.fetchPage ?? getTransactions;
  const memoPrefix = 'Refill for ';
  const memoSuffix = `@${opts.domain}`;
  const zarPerSat = opts.apply ? await getZarPerSat() : null;
  const items: BackfillItem[] = [];

  let after: string | undefined;
  for (let page = 0; ; page++) {
    const { transactions, hasNextPage, endCursor } = await fetchPage(PAGE_SIZE, after);

    for (const tx of transactions) {
      if (tx.createdAt < opts.since) continue;
      if (tx.direction !== 'RECEIVE' || tx.status !== 'SUCCESS' || !tx.paymentHash) continue;
      if (!tx.memo?.startsWith(memoPrefix) || !tx.memo.endsWith(memoSuffix)) continue;

      const username = tx.memo.slice(memoPrefix.length, -memoSuffix.length);
      const sats = Math.abs(tx.settlementAmount);
      const hash = tx.paymentHash;
      const user = db
        .prepare('SELECT id, archived_at FROM users WHERE username = ?')
        .get(username) as { id: number; archived_at: number | null } | undefined;
      const item: BackfillItem = { username, userId: user?.id ?? null, sats, createdAt: tx.createdAt, paymentHash: hash, action: 'would credit' };
      items.push(item);

      if (!user) { item.action = 'skipped: unknown user'; continue; }
      if (user.archived_at) { item.action = 'skipped: archived user'; continue; }
      if (db.prepare('SELECT 1 FROM transactions WHERE payment_hash = ?').get(hash)) {
        item.action = 'already credited';
        continue;
      }
      if (!opts.apply) continue;

      const credited = db.transaction(() => {
        // Re-check inside the transaction so a concurrent live credit can't double up
        if (db.prepare('SELECT 1 FROM transactions WHERE payment_hash = ?').get(hash)) return false;
        db.prepare('UPDATE users SET balance_sats = balance_sats + ? WHERE id = ?').run(sats, user.id);
        db.prepare(
          'INSERT INTO transactions (user_id, type, amount_sats, payment_hash, description, zar_per_sat) VALUES (?, ?, ?, ?, ?, ?)'
        ).run(user.id, 'refill', sats, hash, 'LN Address payment (backfilled)', zarPerSat);
        db.prepare('DELETE FROM pending_refills WHERE payment_hash = ?').run(hash);
        return true;
      })();
      item.action = credited ? 'credited' : 'already credited';
    }

    // Transactions come newest first; stop once we're past the start date
    const last = transactions[transactions.length - 1];
    if (!hasNextPage || !endCursor || !last || last.createdAt < opts.since) break;
    if (page > 200) throw new Error('backfill: too many pages, narrow --since');
    after = endCursor;
  }
  return items;
}
