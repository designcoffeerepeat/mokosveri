// Offline test for the full trades page: merging and grouping insider
// purchases, the multi page Congress fetch, and the page's filter and sort helpers.
// Run: node test/trades.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergePurchases, groupByCompany, buildTrades } from '../src/trades.js';
import { filterRows, sortRows, tableHtml, tabFromHash, COLS, DEFAULT_SORT } from '../public/trades.js';

for (const f of ['src/trades.js', 'public/trades.js', 'public/trades.css', 'src/sources/congress.js', 'public/app.js']) assert.ok(!readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('—'), `${f} has no em dash`);

const dAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// SEC rows win; an OpenInsider row for the same filing is dropped, new ones are kept.
const sec = [
  { ticker: 'ABC', company: 'Abc Corp', owner: 'Smith John A', title: 'CEO', date: dAgo(3), filed: dAgo(2), qty: 1000, price: 50, value: 50000, deltaOwn: '+10%', source: 'SEC' },
  { ticker: 'ABC', company: 'Abc Corp', owner: 'Doe Jane', title: 'Director', date: dAgo(4), filed: dAgo(3), qty: 200, price: 50, value: 10000, deltaOwn: 'New', source: 'SEC' },
];
const oi = [
  { ticker: 'ABC', company: 'Abc Corp', owner: 'Smith John A', title: 'CEO', date: dAgo(3), filed: dAgo(2), qty: 1000, price: 50, value: 50500, type: 'P - Purchase' },
  { ticker: 'XYZ', company: 'Xyz Inc', owner: 'Roe Rich', title: 'CFO', date: dAgo(1), filed: dAgo(0), qty: 3000, price: 1000, value: 3000000, type: 'P - Purchase' },
  { ticker: 'XYZ', company: 'Xyz Inc', owner: 'Poe Pat', title: '10%', date: dAgo(1), filed: dAgo(0), qty: 10, price: 10, value: 100, type: 'P - Purchase' },
];
const merged = mergePurchases(sec, oi);
assert.equal(merged.length, 4, 'duplicate OpenInsider row dropped');
assert.equal(merged[0].ticker, 'XYZ', 'newest first');
assert.equal(merged.filter((r) => r.source === 'OpenInsider').length, 2);

const groups = groupByCompany(merged);
assert.equal(groups[0].ticker, 'XYZ', 'same insider count, more dollars ranks first');
assert.equal(groups[0].total_value, 3000100);
const abc = groups.find((g) => g.ticker === 'ABC');
assert.equal(abc.buyers, 2);
assert.equal(abc.csuite, 1);
assert.equal(abc.trades, 2);
assert.equal(groupByCompany([...merged, { ...sec[0], owner: 'Smith, John', value: 1 }]).find((g) => g.ticker === 'ABC').buyers, 2, 'same person spelled differently counts once');

// Full build with mocked feeds: 5 Capitol Trades pages, OpenInsider, and D1.
const ctPage = (p) => ({
  data: Array.from({ length: 3 }, (_, i) => ({
    politician: { firstName: 'Mem', lastName: `${p}${i}`, chamber: i % 2 ? 'senate' : 'house', party: i ? 'republican' : 'democrat' },
    issuer: { issuerTicker: i === 2 ? 'NVDA:US' : 'AAPL:US' },
    txType: i % 2 ? 'sell' : 'buy',
    value: 15000 * (i + 1),
    txDate: dAgo(10 + p),
    pubDate: dAgo(p),
  })),
});
const oiHtml = `<table class="tinytable"><thead><tr><th>X</th><th>Filing Date</th><th>Trade Date</th><th>Ticker</th><th>Company Name</th><th>Insider Name</th><th>Title</th><th>Trade Type</th><th>Price</th><th>Qty</th><th>Owned</th><th>ΔOwn</th><th>Value</th></tr></thead><tbody>
<tr><td></td><td>${dAgo(1)} 10:00:00</td><td>${dAgo(2)}</td><td>QQQX</td><td>Qq Co</td><td>Lee Ann</td><td>CEO</td><td>P - Purchase</td><td>$5.00</td><td>+2,000</td><td>10,000</td><td>+25%</td><td>+$10,000</td></tr></tbody></table>`;
let ctCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('capitoltrades')) {
    ctCalls++;
    const p = Number(new URL(u).searchParams.get('page'));
    return new Response(JSON.stringify(ctPage(p)), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  if (u.includes('openinsider')) return new Response(oiHtml, { status: 200 });
  return new Response('nope', { status: 404 });
};
const store = new Map();
const env = {
  DB: {
    prepare: (q) => ({
      bind: () => ({
        all: async () => ({ results: /insider_tx/.test(q) ? [{ accession: '0001', ticker: 'ABC', company: 'Abc Corp', owner: 'Smith John A', title: 'CEO', date: dAgo(3), filed: dAgo(2), qty: 1000, value: 50000, owned_after: 11000 }] : [] }),
        first: async () => store.get('x') || null,
        run: async () => ({}),
      }),
    }),
  },
};
const t = await buildTrades(env);
assert.equal(ctCalls, 5, 'five Capitol Trades pages fetched');
assert.equal(t.congress.length, 15, 'all pages merged');
assert.ok(t.congress.every((r) => r.ticker === 'AAPL' || r.ticker === 'NVDA'));
assert.ok(t.congress[0].filedDate >= t.congress[t.congress.length - 1].filedDate, 'newest disclosure first');
assert.equal(t.purchases.length, 2, 'SEC row plus the OpenInsider row');
assert.equal(t.purchases.find((r) => r.ticker === 'ABC').deltaOwn, '+10%');
assert.equal(t.purchases.find((r) => r.ticker === 'ABC').price, 50);
assert.equal(t.companies.length, 2);
assert.equal(t.status.congress, 'ok');

// Page helpers.
const base = { q: '', min: 0, csuite: false, cluster: false, type: 'all', chamber: 'all', party: 'all' };
assert.equal(filterRows('congress', t.congress, { ...base, type: 'sell' }).length, 5);
assert.equal(filterRows('congress', t.congress, { ...base, chamber: 'Senate' }).length, 5);
assert.equal(filterRows('congress', t.congress, { ...base, party: 'D' }).length, 5);
assert.equal(filterRows('congress', t.congress, { ...base, q: 'nvda' }).length, 5);
assert.equal(filterRows('congress', t.congress, { ...base, q: 'mem 31' }).length, 1, 'every word must match');
assert.equal(filterRows('purchases', merged, { ...base, min: 1e6 }).length, 1);
assert.equal(filterRows('purchases', merged, { ...base, csuite: true }).length, 2);
assert.equal(filterRows('insiders', groups, { ...base, q: 'doe' }).length, 1, 'search covers insider names');

const byAmt = sortRows('congress', t.congress, 'amountMin', false);
assert.equal(byAmt[0].amountMin, 45000);
assert.equal(sortRows('purchases', merged, 'value', true)[0].value, 100);
assert.equal(sortRows('insiders', groups, 'ticker', true)[0].ticker, 'ABC');
assert.equal(sortRows('insiders', groups, 'buyers', false)[0].buyers, 2);
for (const tab of Object.keys(COLS)) assert.ok(COLS[tab].some((c) => c[0] === DEFAULT_SORT[tab][0]), `${tab} default sort is a column`);

const html = tableHtml('congress', byAmt, { sort: 'amountMin', asc: false }, 4);
assert.equal((html.match(/<tr class="click"/g) || []).length, 4, 'limit respected');
assert.ok(html.includes('aria-sort="descending"'));
assert.ok(tableHtml('purchases', [], {}).includes('No trades match'));
assert.ok(tableHtml('insiders', [{ ...groups[0], issuer: '<b>x</b>' }], { sort: 'buyers' }).includes('&lt;b&gt;'), 'escapes text');

assert.equal(tabFromHash('#/trades/congress'), 'congress');
assert.equal(tabFromHash('#/trades'), 'insiders');
assert.equal(tabFromHash('#/trades/bogus'), 'insiders');

console.log('trades tests passed');
