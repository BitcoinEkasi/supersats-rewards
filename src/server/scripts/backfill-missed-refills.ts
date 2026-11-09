// Credits LN address payments that reached the Blink wallet but never reached
// the participant's balance (e.g. payers on Blink, whose payments arrived as
// IntraLedgerUpdate events the listener used to ignore).
//
// Dry run by default; pass --apply to credit. Safe to re-run: payments already
// recorded (by payment hash) are skipped.
//
// Usage: backfill-missed-refills --since 2026-10-01 [--apply]

import { backfillMissedRefills } from '../services/refills.js';

const dbPath = process.env.DB_PATH ?? './bolt.db';

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const sinceArg = args[args.indexOf('--since') + 1];
  const since = args.includes('--since') ? Date.parse(sinceArg) / 1000 : NaN;
  if (!Number.isFinite(since)) {
    console.error('Usage: backfill-missed-refills --since YYYY-MM-DD [--apply]');
    process.exit(1);
  }
  const domain = process.env.DOMAIN;
  if (!domain) {
    console.error('[backfill] DOMAIN is not set — aborting.');
    process.exit(1);
  }

  console.log(`[backfill] DB path: ${dbPath}`);
  console.log(`[backfill] ${apply ? 'APPLYING' : 'Dry run'} — LN address payments since ${sinceArg}`);
  if (apply) console.log('[backfill] Make sure the DB (and its -shm/-wal siblings) is backed up first.');

  const items = await backfillMissedRefills({ since, apply, domain });
  for (const i of items) {
    const when = new Date(i.createdAt * 1000).toISOString().replace('T', ' ').slice(0, 16);
    console.log(`  ${when}  ${i.username.padEnd(12)} ${String(i.sats).padStart(7)} sats  ${i.action}  ${i.paymentHash.slice(0, 12)}…`);
  }
  const count = (a: string) => items.filter((i) => i.action === a).length;
  console.log(
    `[backfill] ${items.length} LN address payments found: ${count('already credited')} already credited, ` +
    `${apply ? `${count('credited')} credited now` : `${count('would credit')} would be credited (re-run with --apply)`}, ` +
    `${items.length - count('already credited') - count('credited') - count('would credit')} skipped`
  );
}

main().catch((err) => {
  console.error('[backfill] failed:', err);
  process.exit(1);
});
