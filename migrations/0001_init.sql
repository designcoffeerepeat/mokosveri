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
