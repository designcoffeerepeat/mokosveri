// Offline test for the full trades page: merging and grouping insider
// purchases, the multi page Congress fetch, and the page's filter and sort helpers.
// Run: node test/trades.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergePurchases, groupByCompany, buildTrades } from '../src/trades.js';
import { filterRows, sortRows, tableHtml, tabFromHash, COLS, DEFAULT_SORT, groupCongress, groupPeople, viewGroups, homeCongressHtml, personKey } from '../public/trades.js';

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
assert.equal(filterRows('purchases', merged, { ...base, csuite: true }).length, 2);
assert.equal(filterRows('insiders', groups, { ...base, q: 'doe' }).length, 1, 'search covers insider names');

// Congress grouped by member: the same person trading many times is one row.
const many = [
  ...Array.from({ length: 40 }, (_, i) => ({ member: 'Nancy Pelosi', chamber: 'House', party: 'Democrat', ticker: i % 3 ? 'NVDA' : 'AAPL', type: i % 4 ? 'buy' : 'sell', amount: '$1,001 - $15,000', amountMin: 1001, txDate: dAgo(20 + (i % 9)), filedDate: dAgo(2 + (i % 9)) })),
  { member: 'Tommy  Tuberville', chamber: 'Senate', party: 'Republican', ticker: 'XOM', type: 'buy', amount: '$15,001 - $50,000', amountMin: 15001, txDate: dAgo(5), filedDate: dAgo(1) },
  { member: 'tommy tuberville', chamber: 'Senate', party: 'Republican', ticker: 'CVX', type: 'sell', amount: '$15,001 - $50,000', amountMin: 15001, txDate: dAgo(6), filedDate: dAgo(3) },
];
const cg = groupCongress(many);
assert.equal(cg.length, 2, 'two members');
assert.equal(cg[0].member, 'Tommy  Tuberville', 'newest disclosure first');
assert.equal(cg[0].n, 2, 'spacing and case do not split a member');
const np = cg.find((g) => g.member === 'Nancy Pelosi');
assert.equal(np.n, 40);
assert.equal(np.buys + np.sells, 40);
assert.deepEqual(np.tickers, ['NVDA', 'AAPL'], 'most traded ticker first');
assert.equal(np.amountMin, 40040);
assert.ok(np.trades[0].filedDate >= np.trades[39].filedDate, 'member trades newest first');

const home = homeCongressHtml(many, 1);
assert.equal(home.count, 2);
assert.equal((home.html.match(/class="gp-row/g) || []).length, 2);
assert.equal((home.html.match(/xp-extra/g) || []).length, 1, 'rows past the first few start hidden');
assert.equal((home.html.match(/<tr class="click" data-t=/g) || []).length, 42, 'every trade is in an expandable row');
assert.ok(!home.html.includes('data-sort'), 'home table is not sortable');

// Insiders grouped by person, with the size filter on their total.
const ppl = groupPeople([...merged, { ...merged[0], owner: 'ROE, RICH', value: 50, ticker: 'ABC', company: 'Abc Corp' }]);
const roe = ppl.find((g) => g.owner.toLowerCase().startsWith('roe'));
assert.equal(roe.n, 2, 'same insider spelled differently is one row');
assert.deepEqual([...roe.tickers].sort(), ['ABC', 'XYZ']);
assert.equal(personKey('Smith, John A.'), 'smith john');
const d = { companies: groups, purchases: merged, congress: many };
assert.equal(viewGroups('purchases', d, { ...base, min: 1e6, sort: 'value' }).length, 1);
assert.equal(viewGroups('congress', d, { ...base, q: 'xom', sort: 'latest' })[0].n, 1, 'search narrows a member to matching trades');
const comp = viewGroups('insiders', d, { ...base, sort: 'buyers' });
assert.equal(comp.find((g) => g.ticker === 'ABC').trades.length, 2, 'company rows carry their purchases');
assert.equal(sortRows('congress', cg, 'n', false)[0].member, 'Nancy Pelosi');
assert.equal(sortRows('insiders', groups, 'ticker', true)[0].ticker, 'ABC');
for (const tab of Object.keys(COLS)) assert.ok(COLS[tab].some((c) => c[0] === DEFAULT_SORT[tab][0]), `${tab} default sort is a column`);

const html = tableHtml('congress', cg, { sort: 'latest', asc: false }, 1, { open: new Set([cg[0].key]) });
assert.equal((html.match(/class="gp-row/g) || []).length, 1, 'limit respected');
assert.ok(html.includes('aria-sort="descending"'));
assert.ok(html.includes('aria-expanded="true"'), 'open groups stay open');
assert.ok(tableHtml('purchases', [], {}).includes('No trades match'));
assert.ok(tableHtml('insiders', [{ ...groups[0], key: 'x', issuer: '<b>x</b>', trades: [] }], { sort: 'buyers' }).includes('&lt;b&gt;'), 'escapes text');

assert.equal(tabFromHash('#/trades/congress'), 'congress');
assert.equal(tabFromHash('#/trades'), 'insiders');
assert.equal(tabFromHash('#/trades/bogus'), 'insiders');

console.log('trades tests passed');
