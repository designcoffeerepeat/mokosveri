// Offline test for pre-market and after hours quotes. Run: node test/extended.mjs
import assert from 'node:assert/strict';
import { pickExtended, liveQuotes } from '../src/sources/live.js';

const close = 1_700_000_000; // regular session close, seconds

// Regular session: never an extended figure.
assert.equal(pickExtended({ marketState: 'REGULAR', regularMarketPrice: 100, regularMarketTime: close, postMarketPrice: 101, postMarketTime: close + 60 }), null);

// After hours.
let x = pickExtended({ marketState: 'POST', regularMarketPrice: 100, regularMarketTime: close, postMarketPrice: 102, postMarketTime: close + 600, postMarketChangePercent: 2 });
assert.deepEqual(x, { session: 'post', price: 102, change: 2, changePct: 2, time: (close + 600) * 1000 });

// Pre-market wins over last night's after hours, and the change is computed when missing.
x = pickExtended({ marketState: 'PRE', regularMarketPrice: 100, regularMarketTime: close, postMarketPrice: 102, postMarketTime: close + 600, preMarketPrice: 95, preMarketTime: close + 50000 });
assert.equal(x.session, 'pre');
assert.equal(x.price, 95);
assert.ok(Math.abs(x.changePct + 5) < 1e-9);

// Weekend (CLOSED) still shows the last after hours trade.
assert.equal(pickExtended({ marketState: 'CLOSED', regularMarketPrice: 100, regularMarketTime: close, postMarketPrice: 99, postMarketTime: close + 900 }).session, 'post');

// Stale after hours from before the latest close is ignored.
assert.equal(pickExtended({ marketState: 'POST', regularMarketPrice: 100, regularMarketTime: close, postMarketPrice: 99, postMarketTime: close - 86400 }), null);

// End to end: batch endpoint refuses us, chart fallback reads the last after hours bar.
const db = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  batch: async () => [],
};
const off = -18000; // New York, EST
const day = Math.floor((close + off) / 86400) * 86400 - off; // midnight local, in UTC seconds
const reg = { start: day + 9.5 * 3600, end: day + 16 * 3600 };
const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('fc.yahoo.com')) return new Response('', { status: 404 });
  if (u.includes('getcrumb')) return new Response('abc', { status: 200 });
  if (u.includes('/v7/finance/quote')) return J({}, 500);
  if (u.includes('/v8/finance/chart/')) {
    assert.ok(u.includes('includePrePost=true'));
    return J({
      chart: {
        result: [
          {
            meta: { regularMarketPrice: 50, chartPreviousClose: 49, regularMarketTime: reg.end, gmtoffset: off, currentTradingPeriod: { pre: { start: day + 4 * 3600 + 86400 * 3, end: reg.start + 86400 * 3 }, regular: { start: reg.start + 86400 * 3, end: reg.end + 86400 * 3 }, post: { start: reg.end + 86400 * 3, end: day + 20 * 3600 + 86400 * 3 } } },
            timestamp: [reg.end - 300, reg.end + 1800, reg.end + 3600],
            indicators: { quote: [{ close: [50, 51, null] }] },
          },
        ],
      },
    });
  }
  throw new Error('unexpected ' + u);
};
const out = await liveQuotes({ DB: db }, ['ACME']);
const q = out.get('ACME');
assert.equal(q.price, 50);
assert.equal(q.marketState, 'CLOSED');
assert.equal(q.ext.session, 'post');
assert.equal(q.ext.price, 51);
assert.ok(Math.abs(q.ext.changePct - 2) < 1e-9);

console.log('extended hours: ok');
