// Offline test for the dividend income calculators: projection math, the
// combined mix, and the per ticker yield and growth lookup. Run: node test/divcalc.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { project, portfolio, byYield, optionsHtml, resultHtml, clampGrowth, isCoveredCall, isTbill, isFlat, groupFunds, catOf, CATS, PAGE } from '../public/divcalc.js';
import { ETFS, INCOME_FUNDS, incomeFunds } from '../src/dividends.js';
import { dividendStats, dividendCalc } from '../src/dividends.js';

for (const f of ['public/divcalc.js', 'public/dividends.css', 'src/dividends.js']) assert.ok(!readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('—'), `${f} has no em dash`);

const close = (a, b, eps = 0.01) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

// --- flat: $10,000 at 4% for 10 years, no growth, no DRIP
let p = project({ amount: 10000, yieldPct: 4, years: 10 });
close(p.first, 400);
close(p.last, 400);
close(p.total, 4000);
close(p.endValue, 10000);
assert.equal(p.rows.length, 10);

// --- dividend growth 5%, price growth same: year n income = 400 * 1.05^(n-1)
p = project({ amount: 10000, yieldPct: 4, years: 3, growthPct: 5 });
close(p.rows[1].income, 420);
close(p.rows[2].income, 441);
close(p.total, 1261);
close(p.endValue, 10000 * 1.05 ** 3);

// --- DRIP with flat price compounds at the yield
p = project({ amount: 10000, yieldPct: 4, years: 10, drip: true });
close(p.endValue, 10000 * 1.04 ** 10, 0.5);
close(p.rows[1].income, 416);
assert.ok(p.total > 4000);
// DRIP with price rising as fast as the dividend: value grows by yield + growth
p = project({ amount: 1000, yieldPct: 3, years: 2, growthPct: 6, drip: true });
close(p.rows[0].income, 30);
assert.ok(p.endValue > 1000 * 1.06 ** 2);

// --- separate price growth
p = project({ amount: 1000, yieldPct: 5, years: 2, growthPct: 0, priceGrowthPct: -10 });
close(p.endValue, 810);
close(p.total, 100);

// --- odd inputs never throw
p = project({ amount: '$5,000', yieldPct: 2, years: 0 });
assert.equal(p.amount, 5000);
assert.equal(p.rows.length, 1);
p = project({ amount: 'abc', yieldPct: null, years: 5 });
assert.equal(p.total, 0);

// --- mix of holdings
const mix = portfolio(
  [
    { t: 'A', amount: 6000, yield: 5, growth: 0 },
    { t: 'B', amount: 4000, yield: 2.5, growth: 10 },
    { t: 'C', amount: 0, yield: 9, growth: 0 },
  ],
  { years: 2, drip: false }
);
assert.equal(mix.items.length, 2, 'zero amounts are left out');
close(mix.amount, 10000);
close(mix.yield, 4);
close(mix.first, 400);
close(mix.rows[1].income, 300 + 110);
close(mix.total, 810);
assert.equal(portfolio([], { years: 5, drip: true }).total, 0);

// --- picker
const rows = [{ t: 'X', name: 'Ex', yield: 2 }, { t: 'Y', name: 'Why', yield: 5 }, { t: 'Z', name: 'Zed', yield: null }, { t: 'W', name: 'Dub', yield: 5 }];
assert.deepEqual(byYield(rows).map((r) => r.t), ['W', 'Y', 'X'], 'highest yield first, no yield left out');
const many = Array.from({ length: 69 }, (_, i) => ({ t: 'T' + i, name: 'N' + i, yield: 10 - i / 10 }));
assert.equal((optionsHtml(byYield(many), PAGE, 'T3').match(/<option/g) || []).length, 20, 'first page is 20');
assert.ok(optionsHtml(byYield(many), PAGE, 'T3').includes('value="T3" selected'));
// Income ETFs follow the dividend stocks, grouped by type, all of them shown.
const allFunds = [...ETFS, ...INCOME_FUNDS];
assert.equal(new Set(allFunds.map((e) => e.t)).size, allFunds.length, 'no fund listed twice');
const fundRows = allFunds.map((e, i) => ({ ...e, yield: 1 + i / 3 }));
const groups = groupFunds(fundRows);
assert.deepEqual(groups.map(([l]) => l), CATS.map(([l]) => l), 'every category has funds, in order');
assert.ok(allFunds.every((e) => catOf(e) !== 'Other income ETFs'), 'every fund has a known category');
const withFunds = optionsHtml(byYield(many), PAGE, 'SCHD', groups);
assert.equal((withFunds.match(/<option/g) || []).length, 20 + allFunds.length);
assert.ok(withFunds.indexOf('Dividend growth ETFs') > withFunds.indexOf('T19'), 'ETF groups come after the stocks');
assert.ok(!/aristocrat/i.test(withFunds.replace(/ProShares[^<]*Aristocrats/g, '')), 'no group is called aristocrats');
for (const t of ['SCHD', 'VYM', 'DGRO', 'NOBL', 'JEPI', 'HDV', 'VIG', 'SPYD', 'SGOV', 'BIL', 'BND', 'PFF', 'QYLD']) assert.ok(withFunds.includes(`value="${t}"`), `${t} in the picker`);
assert.ok(isFlat(INCOME_FUNDS.find((e) => e.t === 'BND')) && isFlat(INCOME_FUNDS.find((e) => e.t === 'PFF')));
assert.ok(!isFlat(INCOME_FUNDS.find((e) => e.t === 'QYLD')));
assert.ok(withFunds.includes('value="SCHD" selected'));
assert.ok(isCoveredCall(ETFS.find((e) => e.t === 'JEPI')));
// SGOV sits in the Treasury bill group and is projected flat.
const sgov = INCOME_FUNDS.find((e) => e.t === 'SGOV');
assert.ok(sgov && isTbill(sgov) && isFlat(sgov));
assert.ok(!ETFS.some((e) => e.t === 'SGOV'), 'SGOV is not in the dividend ETF table');
assert.ok(isTbill(null, 'bil'), 'typed T-bill tickers are recognized');
assert.ok(!isTbill(ETFS.find((e) => e.t === 'SCHD')));
const withCash = optionsHtml(byYield(many), PAGE, 'SGOV', groupFunds([{ ...sgov, yield: 4.2 }]));
assert.ok(withCash.includes('Treasury bill and cash ETFs') && withCash.includes('value="SGOV" selected'));
const flat = project({ amount: 10000, yieldPct: 4.2, years: 5, growthPct: 0, priceGrowthPct: 0, drip: false });
close(flat.total, 2100);
close(flat.endValue, 10000);
assert.ok(!isCoveredCall(ETFS.find((e) => e.t === 'SCHD')));
assert.ok(resultHtml(project({ amount: 1000, yieldPct: 4, years: 5 }), { years: 5, drip: false }).includes('Total over 5 years'));
assert.equal(clampGrowth(40), 15);
assert.equal(clampGrowth(-30), -10);
assert.equal(clampGrowth(null), null);

// --- dividendStats: quarterly payer raising 7% a year
const now = Date.UTC(2026, 10, 24);
const divs = [];
for (let y = 2016; y <= 2026; y++)
  for (const m of [1, 4, 7, 10]) {
    const t = Date.UTC(y, m, 15);
    if (t < now) divs.push({ t: t / 1000, amount: 0.5 * 1.07 ** (y - 2016) });
  }
let s = dividendStats(divs, 50, null, now);
close(s.growth, 7, 0.05);
assert.equal(s.growthYears, 5);
assert.equal(s.payments, 4);
assert.equal(s.basis, 'trailing');
close(s.yield, ((divs.slice(-4).reduce((a, d) => a + d.amount, 0)) / 50) * 100, 0.01);
s = dividendStats(divs, 50, { dividendRate: 4 }, now);
assert.equal(s.yield, 8);
assert.equal(s.basis, 'forward');
s = dividendStats([], 20, null, now);
assert.equal(s.yield, 0, 'no dividends is 0%, not an error');
assert.equal(s.growth, null);
// Too little history for growth
s = dividendStats(divs.filter((d) => d.t * 1000 > Date.UTC(2023, 5, 1)), 50, null, now);
assert.equal(s.growth, null);

// --- full lookup with mocked Yahoo
globalThis.fetch = async (url) => {
  url = String(url);
  const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'set-cookie': 'A3=x; Path=/' } });
  if (url.startsWith('https://fc.yahoo.com')) return res('');
  if (url.includes('getcrumb')) return res('crumb123');
  if (url.includes('/v7/finance/quote')) return res({ quoteResponse: { result: [{ symbol: 'MO', regularMarketPrice: 60, dividendRate: 4.2, shortName: 'Altria Group' }] } });
  if (url.includes('/v8/finance/chart/')) {
    const ts = divs.map((d) => d.t);
    const ev = Object.fromEntries(divs.map((d) => [d.t, { date: d.t, amount: d.amount }]));
    return res({ chart: { result: [{ meta: { regularMarketPrice: 60, instrumentType: 'EQUITY', currency: 'USD', longName: 'Altria Group, Inc.' }, timestamp: ts, indicators: { quote: [{ open: ts.map(() => 60), high: ts.map(() => 60), low: ts.map(() => 60), close: ts.map(() => 60), volume: ts.map(() => 0) }] }, events: { dividends: ev } }] } });
  }
  return res({}, 404);
};
const mem = new Map();
const env = { CACHE: { async get(k, ty) { const v = mem.get(k); return v == null ? null : ty === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } } };
const d = await dividendCalc(env, 'MO');
assert.equal(d.t, 'MO');
assert.equal(d.name, 'Altria Group');
assert.equal(d.yield, 7);
assert.equal(d.aristocrat, false);
assert.ok(d.growth != null);
const ko = await dividendCalc(env, 'KO');
assert.equal(ko.aristocrat, true);
assert.equal(ko.raises, 64);

// Income fund list: one quote plus one chart call per fund, under the Workers limit.
let fcalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url) => ((fcalls += 1), realFetch(url));
const fl = await incomeFunds({ CACHE: { async get() { return null; }, async put() {} } });
assert.equal(fl.funds.length, INCOME_FUNDS.length);
assert.ok(fl.funds.every((f) => f.yield != null), 'every income fund has a yield');
assert.ok(fcalls < 45, `income funds stay under the subrequest limit (${fcalls})`);

console.log('divcalc: all checks passed');
