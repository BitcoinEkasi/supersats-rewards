import Database from 'better-sqlite3';
import { SQL_SCHEMA } from './schema.js';

const dbPath = process.env.DB_PATH ?? './bolt.db';
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SQL_SCHEMA);

// Migrations for existing databases
const userColumns = (db.prepare(`PRAGMA table_info(users)`).all() as { name: string }[]).map(c => c.name);
if (!userColumns.includes('ln_payout_address')) {
  db.exec('ALTER TABLE users ADD COLUMN ln_payout_address TEXT');
}
if (!userColumns.includes('division')) {
  db.exec('ALTER TABLE users ADD COLUMN division TEXT');
}
if (!userColumns.includes('tsk_level')) {
  db.exec('ALTER TABLE users ADD COLUMN tsk_level TEXT');
}
if (!userColumns.includes('jc_level')) {
  db.exec('ALTER TABLE users ADD COLUMN jc_level INTEGER');
}
if (!userColumns.includes('tsk_group')) {
  db.exec('ALTER TABLE users ADD COLUMN tsk_group TEXT');
}
if (!userColumns.includes('ac')) {
  db.exec('ALTER TABLE users ADD COLUMN ac INTEGER NOT NULL DEFAULT 0');
}

const cardColumns = (db.prepare(`PRAGMA table_info(cards)`).all() as { name: string }[]).map(c => c.name);
if (!cardColumns.includes('card_id')) {
  db.exec('ALTER TABLE cards ADD COLUMN card_id TEXT');
}
if (!cardColumns.includes('wipe_token')) {
  db.exec('ALTER TABLE cards ADD COLUMN wipe_token TEXT');
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_wipe_token ON cards(wipe_token)');
}
if (!cardColumns.includes('wiped_at')) {
  db.exec('ALTER TABLE cards ADD COLUMN wiped_at INTEGER');
}
if (!cardColumns.includes('previous_card_id')) {
  db.exec('ALTER TABLE cards ADD COLUMN previous_card_id TEXT');
}
if (!cardColumns.includes('replaced_at')) {
  db.exec('ALTER TABLE cards ADD COLUMN replaced_at INTEGER');
}

// Card event history table
db.exec(`
  CREATE TABLE IF NOT EXISTS card_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    event TEXT NOT NULL,
    description TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Payout batch tables (month-end reward distribution)
db.exec(`
  CREATE TABLE IF NOT EXISTS payout_batches (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    payment_hash TEXT UNIQUE NOT NULL,
    payment_request TEXT NOT NULL,
    total_sats INTEGER NOT NULL,
    memo TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    paid_at INTEGER
  )
`);
db.exec(`
  CREATE TABLE IF NOT EXISTS payout_batch_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    amount_sats INTEGER NOT NULL,
    description TEXT
  )
`);

// Migrations for payout_batches
const batchCols = (db.prepare(`PRAGMA table_info(payout_batches)`).all() as { name: string }[]).map(c => c.name);
if (!batchCols.includes('source')) {
  db.exec("ALTER TABLE payout_batches ADD COLUMN source TEXT NOT NULL DEFAULT 'invoice'");
}
if (!batchCols.includes('invoice_sats')) {
  db.exec('ALTER TABLE payout_batches ADD COLUMN invoice_sats INTEGER');
}

// Migrations for payout_batch_items
const batchItemCols = (db.prepare(`PRAGMA table_info(payout_batch_items)`).all() as { name: string }[]).map(c => c.name);
if (!batchItemCols.includes('payout_type')) {
  db.exec("ALTER TABLE payout_batch_items ADD COLUMN payout_type TEXT NOT NULL DEFAULT 'internal'");
}
if (!batchItemCols.includes('ln_address')) {
  db.exec('ALTER TABLE payout_batch_items ADD COLUMN ln_address TEXT');
}

// Migration: add 'card_fee' to transactions type CHECK constraint
// SQLite can't ALTER a CHECK constraint, so recreate the table
const txTypeCheck = (db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='transactions'`).get() as any)?.sql ?? '';
if (!txTypeCheck.includes('card_fee')) {
  db.transaction(() => {
    db.exec(`CREATE TABLE transactions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL CHECK(type IN ('spend','refill','card_fee')),
      amount_sats INTEGER NOT NULL,
      payment_hash TEXT,
      description TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    )`);
    db.exec(`INSERT INTO transactions_new SELECT id, user_id, type, amount_sats, payment_hash, description, created_at FROM transactions`);
    db.exec(`DROP TABLE transactions`);
    db.exec(`ALTER TABLE transactions_new RENAME TO transactions`);
  })();
}

// Migration: add zar_per_sat (ZAR/sat rate locked in at transaction time)
const txColumns = (db.prepare(`PRAGMA table_info(transactions)`).all() as { name: string }[]).map(c => c.name);
if (!txColumns.includes('zar_per_sat')) {
  db.exec('ALTER TABLE transactions ADD COLUMN zar_per_sat REAL');
}

// LN address payout log
db.exec(`
  CREATE TABLE IF NOT EXISTS ln_payouts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    amount_sats INTEGER NOT NULL,
    ln_address TEXT NOT NULL,
    payment_hash TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    description TEXT,
    zar_per_sat REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

// Bulk spending-limit update log — one row per bulk action, not per card
db.exec(`
  CREATE TABLE IF NOT EXISTS bulk_limit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_max_sats INTEGER,
    day_max_sats INTEGER,
    affected_count INTEGER NOT NULL,
    zar_per_sat REAL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);

const lnPayoutColumns = (db.prepare(`PRAGMA table_info(ln_payouts)`).all() as { name: string }[]).map(c => c.name);
if (!lnPayoutColumns.includes('zar_per_sat')) {
  db.exec('ALTER TABLE ln_payouts ADD COLUMN zar_per_sat REAL');
}

// Global emergency stop — single-row config table. Defaults to enabled (1)
// so nothing changes for anyone unless an admin deliberately flips it.
db.exec(`
  CREATE TABLE IF NOT EXISTS system_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    cards_enabled INTEGER NOT NULL DEFAULT 1
  )
`);
db.exec('INSERT OR IGNORE INTO system_settings (id, cards_enabled) VALUES (1, 1)');

const settingsColumns = (db.prepare(`PRAGMA table_info(system_settings)`).all() as { name: string }[]).map(c => c.name);
if (!settingsColumns.includes('velocity_max_taps')) {
  db.exec('ALTER TABLE system_settings ADD COLUMN velocity_max_taps INTEGER NOT NULL DEFAULT 3');
}
if (!settingsColumns.includes('velocity_window_secs')) {
  db.exec('ALTER TABLE system_settings ADD COLUMN velocity_window_secs INTEGER NOT NULL DEFAULT 300');
}

// Tap log for the velocity-limit security rule — one row per CMAC-verified tap
db.exec(`
  CREATE TABLE IF NOT EXISTS card_taps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    card_id INTEGER NOT NULL REFERENCES cards(id),
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_card_taps_card_id_created_at ON card_taps(card_id, created_at)');
