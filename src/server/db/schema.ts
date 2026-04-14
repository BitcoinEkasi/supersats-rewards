export const SQL_SCHEMA = `
CREATE TABLE IF NOT EXISTS admins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  balance_sats INTEGER NOT NULL DEFAULT 0,
  magic_token TEXT UNIQUE NOT NULL,
  ln_address_enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  k0 TEXT NOT NULL,
  k1 TEXT NOT NULL,
  k2 TEXT NOT NULL,
  k3 TEXT NOT NULL,
  k4 TEXT NOT NULL,
  uid TEXT,
  counter INTEGER NOT NULL DEFAULT -1,
  tx_max_sats INTEGER NOT NULL DEFAULT 1000,
  day_max_sats INTEGER NOT NULL DEFAULT 5000,
  day_spent_sats INTEGER NOT NULL DEFAULT 0,
  day_reset_at INTEGER NOT NULL DEFAULT 0,
  card_id TEXT,
  setup_token TEXT UNIQUE,
  programmed_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL CHECK(type IN ('spend','refill','card_fee')),
  amount_sats INTEGER NOT NULL,
  payment_hash TEXT,
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pending_withdrawals (
  k1_token TEXT PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id),
  max_sats INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_refills (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  payment_hash TEXT UNIQUE NOT NULL,
  amount_sats INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key_hash TEXT UNIQUE NOT NULL,
  description TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
`;
