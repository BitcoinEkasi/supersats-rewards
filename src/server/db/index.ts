import Database from 'better-sqlite3';
import { SQL_SCHEMA } from './schema.js';

const dbPath = process.env.DB_PATH ?? './bolt.db';
export const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SQL_SCHEMA);

// Migrations for existing databases
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
