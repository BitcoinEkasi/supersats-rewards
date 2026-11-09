/**
 * Checks the 'debit' transactions migration against a DB with the production
 * (pre-debit) schema, then admin debits. Uses a throwaway SQLite DB.
 *
 * Run: npm test
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import Database from 'better-sqlite3';

const dir = mkdtempSync(path.join(tmpdir(), 'debit-test-'));
const dbPath = path.join(dir, 'test.db');
process.env.DB_PATH = dbPath;

try {
  // Production's transactions table: card_fee CHECK, zar_per_sat added later by ALTER
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, display_name TEXT NOT NULL,
      balance_sats INTEGER NOT NULL DEFAULT 0, magic_token TEXT UNIQUE NOT NULL,
      ln_address_enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK(type IN ('spend','refill','card_fee')),
      amount_sats INTEGER NOT NULL,
      payment_hash TEXT,
      description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    ALTER TABLE transactions ADD COLUMN zar_per_sat REAL;
    INSERT INTO users (username, display_name, balance_sats, magic_token) VALUES ('tsk00021', 'Test', 1000, 't1');
    INSERT INTO transactions (user_id, type, amount_sats, payment_hash, description, created_at, zar_per_sat)
      VALUES (1, 'refill', 1000, 'h1', 'Monthly reward', 1700000000, 0.0123),
             (1, 'card_fee', 5, NULL, 'Fee', 1700000001, NULL),
             (1, 'spend', 7, 'h3', 'BoltCard payment', 1700000002, 0.02);
    DELETE FROM transactions WHERE id = 3;  -- AUTOINCREMENT high-water mark is now above max(id)
  `);
  old.close();

  // Opening the DB runs the migrations
  const { db } = await import('../db/index.js');
  const { debitUser, DebitError } = await import('../services/debit.js');

  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'transactions'`).get() as { sql: string }).sql;
  assert.match(sql, /'card_fee','debit'/, 'CHECK now allows debit');
  assert.match(sql, /zar_per_sat/, 'zar_per_sat column kept');
  assert.deepEqual(
    db.prepare('SELECT id, type, amount_sats, payment_hash, description, created_at, zar_per_sat FROM transactions ORDER BY id').all(),
    [
      { id: 1, type: 'refill', amount_sats: 1000, payment_hash: 'h1', description: 'Monthly reward', created_at: 1700000000, zar_per_sat: 0.0123 },
      { id: 2, type: 'card_fee', amount_sats: 5, payment_hash: null, description: 'Fee', created_at: 1700000001, zar_per_sat: null },
    ],
    'existing rows copied exactly'
  );

  const balance = () => (db.prepare('SELECT balance_sats FROM users WHERE id = 1').get() as { balance_sats: number }).balance_sats;

  // Debit succeeds and is recorded
  assert.equal(await debitUser(1, 300, '  Repayment: wetsuit advance '), 700);
  assert.equal(balance(), 700);
  const row = db.prepare("SELECT id, amount_sats, description FROM transactions WHERE type = 'debit'").get() as any;
  assert.equal(row.amount_sats, 300);
  assert.equal(row.description, 'Repayment: wetsuit advance');
  assert.equal(row.id, 4, 'id not reused after the deleted row');
  const ev = db.prepare("SELECT description FROM card_events WHERE event = 'debited'").get() as any;
  assert.equal(ev.description, '300 sats — Repayment: wetsuit advance');

  // Rejections change nothing
  await assert.rejects(debitUser(1, 701, 'too much'), DebitError);
  await assert.rejects(debitUser(1, 10, '   '), DebitError);
  await assert.rejects(debitUser(1, 0, 'zero'), DebitError);
  await assert.rejects(debitUser(1, 1.5, 'fraction'), DebitError);
  await assert.rejects(debitUser(99, 1, 'nobody'), DebitError);
  assert.equal(balance(), 700);

  // Whole balance can be debited, never below zero
  assert.equal(await debitUser(1, 700, 'Correction'), 0);
  await assert.rejects(debitUser(1, 1, 'empty'), DebitError);

  db.close();

  // Re-opening an already-migrated DB is a no-op
  const again = new Database(dbPath);
  assert.equal((again.prepare("SELECT COUNT(*) AS n FROM transactions WHERE type = 'debit'").get() as { n: number }).n, 2);
  again.close();

  console.log('test-debit: all checks passed');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
