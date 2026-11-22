CREATE TABLE IF NOT EXISTS insider_tx (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  accession TEXT NOT NULL,
  ticker TEXT,
  issuer TEXT,
  issuer_cik TEXT,
  owner TEXT,
  owner_cik TEXT,
  title TEXT,
  is_director INTEGER DEFAULT 0,
  is_officer INTEGER DEFAULT 0,
  is_ten_pct INTEGER DEFAULT 0,
  code TEXT,
  ad TEXT,
  tx_date TEXT,
  filed_date TEXT,
  shares REAL,
  price REAL,
  value REAL,
  owned_after REAL,
  plan_10b5 INTEGER DEFAULT 0,
  UNIQUE(accession, owner_cik, tx_date, code, shares, price)
);
CREATE INDEX IF NOT EXISTS idx_insider_ticker ON insider_tx(ticker, tx_date);
CREATE INDEX IF NOT EXISTS idx_insider_code_date ON insider_tx(code, filed_date);
CREATE TABLE IF NOT EXISTS processed (
  accession TEXT PRIMARY KEY,
  filed_date TEXT,
  status TEXT
);
CREATE TABLE IF NOT EXISTS tickers (
  ticker TEXT PRIMARY KEY,
  cik TEXT NOT NULL,
  name TEXT
);
CREATE TABLE IF NOT EXISTS kvstate (
  k TEXT PRIMARY KEY,
  v TEXT
);
CREATE TABLE IF NOT EXISTS cache (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL,
  exp INTEGER NOT NULL
);
-- User accounts (invite only, capped at 20 in code), sessions, invites,
-- rate limiting and per-user watchlists.
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  pins TEXT,
  created_at INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  note TEXT,
  created_by INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  used_by INTEGER,
  used_at INTEGER
);
CREATE TABLE IF NOT EXISTS rate_limits (
  k TEXT PRIMARY KEY,
  n INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS watchlist (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, ticker)
);
CREATE TABLE IF NOT EXISTS watchlists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_watchlists_user ON watchlists(user_id, position);
CREATE TABLE IF NOT EXISTS watchlist_items (
  list_id INTEGER NOT NULL REFERENCES watchlists(id) ON DELETE CASCADE,
  ticker TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  added_price REAL,
  PRIMARY KEY (list_id, ticker)
);
