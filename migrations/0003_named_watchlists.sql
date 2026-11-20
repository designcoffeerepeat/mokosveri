-- Multiple named watchlists per user. Each user's existing list moves into a
-- list called "My watchlist". The old watchlist table is left in place
-- (unused) so the site keeps working in the moments between this migration
-- and the deploy.
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
  PRIMARY KEY (list_id, ticker)
);
INSERT INTO watchlists (user_id, name, position, created_at)
  SELECT DISTINCT w.user_id, 'My watchlist', 0, CAST(strftime('%s', 'now') AS INTEGER) * 1000
  FROM watchlist w
  WHERE NOT EXISTS (SELECT 1 FROM watchlists l WHERE l.user_id = w.user_id);
INSERT OR IGNORE INTO watchlist_items (list_id, ticker, position, added_at)
  SELECT l.id, w.ticker, w.position, w.added_at
  FROM watchlist w JOIN watchlists l ON l.user_id = w.user_id AND l.name = 'My watchlist';
