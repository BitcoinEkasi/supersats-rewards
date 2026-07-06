// One-time backfill: pre-existing transactions/ln_payouts rows predate the
// "locked ZAR rate at transaction time" feature and have no rate recorded.
// Per instruction, old rows just get a single current-price snapshot applied
// uniformly — this is NOT meant to be historically accurate per row.
//
// Safe to re-run: only touches rows where zar_per_sat IS NULL.

import { db } from '../db/index.js';
import { getZarPerSat } from '../services/zarPrice.js';

const dbPath = process.env.DB_PATH ?? './bolt.db';

async function main() {
  console.log(`[backfill] DB path: ${dbPath}`);
  console.log('[backfill] Make sure this file (and its -shm/-wal siblings) is backed up before proceeding.');

  const rate = await getZarPerSat();
  if (rate === null) {
    console.error('[backfill] Could not fetch a ZAR price — aborting, no rows changed.');
    process.exit(1);
  }
  console.log(`[backfill] Using current rate: ${rate} ZAR/sat`);

  let txChanges = 0;
  let lnChanges = 0;
  db.transaction(() => {
    txChanges = db.prepare('UPDATE transactions SET zar_per_sat = ? WHERE zar_per_sat IS NULL').run(rate).changes;
    lnChanges = db.prepare('UPDATE ln_payouts SET zar_per_sat = ? WHERE zar_per_sat IS NULL').run(rate).changes;
  })();

  console.log(`[backfill] Updated ${txChanges} transactions row(s), ${lnChanges} ln_payouts row(s).`);

  const txRemaining = (db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE zar_per_sat IS NULL').get() as { n: number }).n;
  const lnRemaining = (db.prepare('SELECT COUNT(*) AS n FROM ln_payouts WHERE zar_per_sat IS NULL').get() as { n: number }).n;
  console.log(`[backfill] Remaining NULL rows — transactions: ${txRemaining}, ln_payouts: ${lnRemaining}`);
}

main();
