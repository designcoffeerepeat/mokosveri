// Offline test for the ETF dividend yield: chart dividend parsing and the
// yield picked for the headline number. Run: node test/dividend.mjs
import assert from 'node:assert/strict';
import { dividendInfo } from '../src/analyze.js';
import { fetchChart } from '../src/sources/yahoo.js';

const now = Math.floor(Date.now() / 1000);
const day = 86400;
const divs = [400, 300, 200, 100, 10].map((d, i) => ({ t: now - d * day, amount: 0.25 + i * 0.01 }));

// Summary yield wins (Yahoo gives ETFs summaryDetail.yield as a fraction).
let d = dividendInfo({ summaryDetail: { yield: { raw: 0.0362 }, trailingAnnualDividendYield: { raw: 0 }, exDividendDate: { raw: now - 12 * day } } }, divs, 30);
assert.equal(d.yieldPct, 3.62);
assert.equal(d.payments12m, 4);
assert.equal(d.annualRate, +(0.26 + 0.27 + 0.28 + 0.29).toFixed(4));
assert.equal(d.ttmYieldPct, +((1.1 / 30) * 100).toFixed(2));
assert.equal(d.lastAmount, 0.29);
assert.ok(d.exDate);

// No summary: trailing 12 months from the payouts.
d = dividendInfo({}, divs, 30);
assert.equal(d.yieldPct, d.ttmYieldPct);

// Zero values in the summary are ignored, not shown as 0%.
d = dividendInfo({ summaryDetail: { yield: { raw: 0 }, dividendYield: { raw: 0.015 } } }, [], 100);
assert.equal(d.yieldPct, 1.5);

// Nothing at all: no dividend block.
assert.equal(dividendInfo({}, [], 100), null);

// Chart parsing picks up the dividend events.
globalThis.fetch = async () =>
  new Response(JSON.stringify({ chart: { result: [{
    meta: { currency: 'USD', regularMarketPrice: 30 },
    timestamp: [now - 2 * day, now - day],
    indicators: { quote: [{ open: [29, 30], high: [30, 31], low: [28, 29], close: [29.5, 30], volume: [100, 200] }] },
    events: { dividends: { b: { date: now - day, amount: 0.3 }, a: { date: now - 90 * day, amount: 0.28 } } },
  }] } }), { status: 200 });
const c = await fetchChart('SCHD');
assert.equal(c.dividends.length, 2);
assert.equal(c.dividends[0].amount, 0.28);
assert.equal(c.bars.length, 2);

console.log('dividend tests passed');
