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

// Migrations for payout_batch_items
const batchItemCols = (db.prepare(`PRAGMA table_info(payout_batch_items)`).all() as { name: string }[]).map(c => c.name);
if (!batchItemCols.includes('payout_type')) {
  db.exec("ALTER TABLE payout_batch_items ADD COLUMN payout_type TEXT NOT NULL DEFAULT 'internal'");
}
if (!batchItemCols.includes('ln_address')) {
  db.exec('ALTER TABLE payout_batch_items ADD COLUMN ln_address TEXT');
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
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  )
`);
