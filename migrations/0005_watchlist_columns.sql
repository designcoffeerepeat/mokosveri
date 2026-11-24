-- Columns chosen for each watchlist table, as a JSON array of column keys
-- (see public/wlcols.js). Empty means the default set.
ALTER TABLE watchlists ADD COLUMN columns TEXT;
