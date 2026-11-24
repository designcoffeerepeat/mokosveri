// Watchlist column choices and the figures behind them. Run: node test/wlcolumns.mjs
import assert from 'node:assert/strict';
import { COLUMNS, DEFAULT_COLUMNS, MAX_COLUMNS, cleanColumns, columnNeeds } from '../public/wlcols.js';
import { statsFrom, nextEarnings, dividendYieldPct, parseRating } from '../src/sources/quotestats.js';
import { betaFrom, ytdReturn, mergeStats } from '../src/watchlist.js';

// Catalog: unique keys, defaults are real columns, every group is used.
assert.equal(new Set(COLUMNS.map((c) => c.key)).size, COLUMNS.length);
for (const k of DEFAULT_COLUMNS) assert.ok(COLUMNS.some((c) => c.key === k), k);
for (const k of ['pe', 'mcap', 'earnings']) assert.ok(DEFAULT_COLUMNS.includes(k), `default has ${k}`);

// Saved choices are cleaned: unknown keys dropped, duplicates removed, order kept.
assert.deepEqual(cleanColumns(null), DEFAULT_COLUMNS);
assert.deepEqual(cleanColumns('not json'), DEFAULT_COLUMNS);
assert.deepEqual(cleanColumns('["pe","bogus","pe","price"]'), ['pe', 'price']);
assert.deepEqual(cleanColumns(['beta', 1, '<b>', 'mcap']), ['beta', 'mcap']);
assert.deepEqual(cleanColumns([]), []);
assert.equal(cleanColumns(COLUMNS.map((c) => c.key)).length, MAX_COLUMNS);
assert.equal(columnNeeds(['price', 'pe'], 'stats'), true);
assert.equal(columnNeeds(['price', 'ret1m', 'hi52'], 'stats'), false);
assert.equal(columnNeeds(['beta'], 'spy'), true);

// Next earnings: earliest date from today on, past only means not announced.
const now = Date.parse('2026-11-24T15:00:00Z');
const sec = (iso) => Date.parse(iso) / 1000;
assert.deepEqual(nextEarnings({ earningsTimestamp: sec('2026-10-30T20:00:00Z'), earningsTimestampStart: sec('2027-01-28T21:00:00Z'), earningsTimestampEnd: sec('2027-02-02T21:00:00Z'), isEarningsDateEstimate: true }, now), { at: Date.parse('2027-01-28T21:00:00Z'), estimate: true });
assert.equal(nextEarnings({ earningsTimestamp: sec('2026-10-30T20:00:00Z') }, now), null);
assert.equal(nextEarnings({ earningsTimestamp: sec('2026-11-24T12:00:00Z') }, now).at, Date.parse('2026-11-24T12:00:00Z'));

// Dividend yield in percent from each Yahoo shape.
assert.equal(dividendYieldPct({ regularMarketPrice: 200, dividendRate: 4 }), 2);
assert.equal(dividendYieldPct({ dividendYield: 0.44 }), 0.44);
assert.equal(Math.round(dividendYieldPct({ trailingAnnualDividendYield: 0.031 }) * 100) / 100, 3.1);
assert.equal(dividendYieldPct({ regularMarketPrice: 50 }), null);

assert.deepEqual(parseRating('2.1 - Buy'), { score: 2.1, label: 'Buy' });
assert.deepEqual(parseRating('1.4 - Strong Buy'), { score: 1.4, label: 'Strong Buy' });
assert.equal(parseRating(''), null);
assert.equal(parseRating(undefined), null);

const s = statsFrom(
  { regularMarketPrice: 100, marketCap: 2.5e12, trailingPE: 31.2, forwardPE: 27.4, priceToBook: 45, averageAnalystRating: '2.0 - Buy', epsTrailingTwelveMonths: 6.4, epsForward: 7.1, earningsTimestampStart: sec('2027-01-28T21:00:00Z'), isEarningsDateEstimate: false, dividendRate: 1, exDividendDate: sec('2026-11-10T00:00:00Z'), regularMarketVolume: 60e6, averageDailyVolume3Month: 40e6, fiftyTwoWeekHigh: 120, fiftyTwoWeekLow: 80, trailingPE_bad: 'x' },
  now
);
assert.equal(s.mcap, 2.5e12);
assert.equal(s.pe, 31.2);
assert.equal(s.fwdPe, 27.4);
assert.equal(s.rating, 2);
assert.equal(s.ratingLabel, 'Buy');
assert.equal(s.earnings, Date.parse('2027-01-28T21:00:00Z'));
assert.equal(s.earningsEst, false);
assert.equal(s.divYield, 1);
assert.equal(s.exDiv, Date.parse('2026-11-10T00:00:00Z'));
assert.equal(s.relVolume, 1.5);
assert.equal(s.hi52, 120);
// Negative P/E (losses) shows blank, not a negative multiple. Negative EPS stays.
const loss = statsFrom({ trailingPE: -12, epsTrailingTwelveMonths: -1.2 }, now);
assert.equal(loss.pe, null);
assert.equal(loss.eps, -1.2);

// Beta: a stock that moves exactly twice the index has beta 2.
const day0 = sec('2025-11-24T14:30:00Z');
const spy = [];
const stock = [];
let a = 100;
let b = 50;
for (let i = 0; i < 260; i++) {
  const r = Math.sin(i * 1.7) * 0.01;
  a *= 1 + r;
  b *= 1 + 2 * r;
  spy.push({ t: day0 + i * 86400, c: a });
  stock.push({ t: day0 + i * 86400, c: b });
}
assert.ok(Math.abs(betaFrom(stock, spy) - 2) < 1e-9);
assert.equal(betaFrom(stock.slice(0, 10), spy), null);
// Days missing from the stock are skipped, not misaligned.
assert.ok(Math.abs(betaFrom(stock.filter((_, i) => i % 7), spy) - 2) < 0.2);

// YTD from the last close of last year.
const ybars = [
  { t: sec('2025-12-30T14:30:00Z'), c: 90 },
  { t: sec('2025-12-31T14:30:00Z'), c: 100 },
  { t: sec('2026-01-02T14:30:00Z'), c: 101 },
  { t: sec('2026-11-23T14:30:00Z'), c: 125 },
];
assert.equal(ytdReturn(ybars, now), 25);
assert.equal(ytdReturn(ybars.slice(2), now), null);

// Yahoo's 52 week range replaces the chart one; other chart values are kept.
assert.deepEqual(mergeStats({ hi52: 118, pe: null, ret1m: 3 }, { hi52: 120, pe: 30, ret1m: 9 }), { hi52: 120, pe: 30, ret1m: 3 });

console.log('wlcolumns ok');
