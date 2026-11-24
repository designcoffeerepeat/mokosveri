// Watchlist column catalog, shared by the browser table (public/wltable.js)
// and the Worker (src/watchlist.js), which validates saved choices and only
// fetches the data the chosen columns need. Pure data, no DOM.
//
// need: 'stats' = one batched Yahoo quote call for valuation and trading
// figures, 'spy' = the S&P 500 price history (for beta). Anything else comes
// from the 1 year chart the table already loads. asc: the first click on the
// header sorts soonest first instead of largest first.

export const COLUMN_GROUPS = ['Price and performance', 'Valuation', 'Earnings and dividends', 'Trading', 'Technicals', 'Your list'];

export const COLUMNS = [
  { key: 'name', label: 'Name', group: 'Price and performance', num: false, help: 'Company or fund name' },
  { key: 'price', label: 'Price', group: 'Price and performance', num: true, help: 'Last price, with pre-market or after hours trading underneath' },
  { key: 'change1d', label: 'Today', group: 'Price and performance', num: true, help: 'Change today, in percent' },
  { key: 'ret5d', label: '5D', group: 'Price and performance', num: true, help: 'Change over the last 5 trading days' },
  { key: 'ret1m', label: '1M', group: 'Price and performance', num: true, help: 'Change over the last month' },
  { key: 'ret3m', label: '3M', group: 'Price and performance', num: true, help: 'Change over the last 3 months' },
  { key: 'ytd', label: 'YTD', group: 'Price and performance', num: true, help: 'Change since the last close of last year' },
  { key: 'ret1y', label: '1Y', group: 'Price and performance', num: true, help: 'Change over the last year' },
  { key: 'spark', label: '30 days', group: 'Price and performance', num: false, sortable: false, help: 'Small chart of the last 30 closes' },

  { key: 'mcap', label: 'Mkt cap', group: 'Valuation', num: true, need: 'stats', help: 'Market capitalization' },
  { key: 'pe', label: 'P/E', group: 'Valuation', num: true, need: 'stats', help: 'Price to trailing 12 month earnings' },
  { key: 'fwdPe', label: 'Fwd P/E', group: 'Valuation', num: true, need: 'stats', help: 'Price to expected earnings over the next year' },
  { key: 'pb', label: 'P/B', group: 'Valuation', num: true, need: 'stats', help: 'Price to book value' },
  { key: 'rating', label: 'Analysts', group: 'Valuation', num: true, need: 'stats', help: 'Average analyst rating, 1 is strong buy and 5 is sell' },

  { key: 'earnings', label: 'Earnings', group: 'Earnings and dividends', num: true, asc: true, need: 'stats', help: 'Next earnings date. Marked ~ when the company has not confirmed it yet' },
  { key: 'eps', label: 'EPS', group: 'Earnings and dividends', num: true, need: 'stats', help: 'Earnings per share, trailing 12 months' },
  { key: 'fwdEps', label: 'Fwd EPS', group: 'Earnings and dividends', num: true, need: 'stats', help: 'Expected earnings per share over the next year' },
  { key: 'divYield', label: 'Div yield', group: 'Earnings and dividends', num: true, need: 'stats', help: 'Dividend yield' },
  { key: 'exDiv', label: 'Ex-div', group: 'Earnings and dividends', num: true, asc: true, need: 'stats', help: 'Ex-dividend date. Buy before it to get the next payment' },

  { key: 'volume', label: 'Volume', group: 'Trading', num: true, need: 'stats', help: 'Shares traded today' },
  { key: 'avgVolume', label: 'Avg vol', group: 'Trading', num: true, need: 'stats', help: 'Average shares traded per day over 3 months' },
  { key: 'relVolume', label: 'Rel vol', group: 'Trading', num: true, need: 'stats', help: 'Volume today against the 3 month average' },
  { key: 'hi52', label: '52W high', group: 'Trading', num: true, help: '52 week high' },
  { key: 'lo52', label: '52W low', group: 'Trading', num: true, help: '52 week low' },
  { key: 'fromHigh', label: 'Off high', group: 'Trading', num: true, help: 'Distance below the 52 week high' },
  { key: 'beta', label: 'Beta', group: 'Trading', num: true, need: 'spy', help: 'How much the stock moves with the S&P 500 over the last year. 1 moves with the market, 2 moves twice as much' },

  { key: 'rsi', label: 'RSI', group: 'Technicals', num: true, help: '14 day RSI. Over 70 is often called overbought, under 30 oversold' },
  { key: 'vs50', label: 'vs 50D', group: 'Technicals', num: true, help: 'Price against the 50 day average' },
  { key: 'vs200', label: 'vs 200D', group: 'Technicals', num: true, help: 'Price against the 200 day average' },
  { key: 'score', label: 'Score', group: 'Technicals', num: true, help: 'Mokosveri score. Marked ~ when it is a quick estimate' },

  { key: 'addedAt', label: 'Added', group: 'Your list', num: true, help: 'Date you added it' },
  { key: 'sinceAdded', label: 'Since added', group: 'Your list', num: true, help: 'Change since you added it' },
];

export const COLUMN_KEYS = new Set(COLUMNS.map((c) => c.key));
export const DEFAULT_COLUMNS = ['name', 'price', 'change1d', 'ret1m', 'ret1y', 'mcap', 'pe', 'earnings', 'score', 'addedAt', 'spark'];
export const MAX_COLUMNS = 16;

// A saved choice (array or JSON text) cleaned to known keys, or the defaults.
export function cleanColumns(raw) {
  let a = raw;
  if (typeof a === 'string') {
    try {
      a = JSON.parse(a);
    } catch {
      a = null;
    }
  }
  if (!Array.isArray(a)) return DEFAULT_COLUMNS.slice();
  return [...new Set(a.filter((k) => typeof k === 'string' && COLUMN_KEYS.has(k)))].slice(0, MAX_COLUMNS);
}

export const columnNeeds = (cols, need) => cols.some((k) => (COLUMNS.find((c) => c.key === k) || {}).need === need);
