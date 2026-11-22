-- Price of each ticker when it was added to a watchlist, so the list can show
-- the gain or loss since then. Older rows start empty and are filled in from
-- the daily close on their add date the next time the list loads.
ALTER TABLE watchlist_items ADD COLUMN added_price REAL;
