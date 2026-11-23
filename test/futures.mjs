// Offline test for the home page futures panel. Run: node test/futures.mjs
import assert from 'node:assert/strict';
import { futuresBoard, FUTURES } from '../src/sources/futures.js';

const db = {
  prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), run: async () => ({}) }) }),
  batch: async () => [],
};
let asked = '';
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('fc.yahoo.com')) return new Response('', { status: 404 });
  if (u.includes('getcrumb')) return new Response('abc', { status: 200 });
  if (u.includes('/v7/finance/quote')) {
    asked = decodeURIComponent(u.match(/symbols=([^&]+)/)[1]);
    // Every contract but natural gas comes back from the batch call.
    const result = FUTURES.filter((f) => f.symbol !== 'NG').map((f, i) => ({
      symbol: f.yahoo,
      regularMarketPrice: 100 + i,
      regularMarketChange: i % 2 ? -1 : 1,
      regularMarketChangePercent: i % 2 ? -1 : 1,
      regularMarketTime: 1_700_000_000,
      marketState: 'REGULAR',
    }));
    return new Response(JSON.stringify({ quoteResponse: { result } }), { status: 200 });
  }
  if (u.includes('/v8/finance/chart/NG%3DF')) {
    return new Response(JSON.stringify({ chart: { result: [{ meta: { regularMarketPrice: 3.1, chartPreviousClose: 3, regularMarketTime: 1_700_000_000 } }] } }), { status: 200 });
  }
  throw new Error('unexpected ' + u);
};

const b = await futuresBoard({ DB: db });
assert.equal(asked, FUTURES.map((f) => f.yahoo).join(','));
assert.equal(b.items.length, FUTURES.length);
assert.deepEqual(b.items.map((f) => f.symbol), ['ES', 'NQ', 'YM', 'RTY', 'CL', 'NG', 'GC', 'SI', 'ZN', 'BTC']);
const es = b.items[0];
assert.equal(es.price, 100);
assert.equal(es.change1d, 1);
assert.equal(es.group, 'Equity index');
const ng = b.items.find((f) => f.symbol === 'NG');
assert.equal(ng.price, 3.1);
assert.ok(Math.abs(ng.change1d - (3.1 / 3 - 1) * 100) < 1e-9);
assert.equal(b.market, 'open');
assert.equal(b.refreshSec, 15);

// Yahoo down entirely: the panel still gets every row, with empty prices.
globalThis.fetch = async () => new Response('', { status: 503 });
const down = await futuresBoard({ DB: db });
assert.equal(down.items.length, FUTURES.length);
assert.ok(down.items.every((f) => f.price == null));

console.log('futures: ok');
