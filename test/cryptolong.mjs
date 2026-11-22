// Offline test for the long-term crypto models: power law fit, cycle tops,
// rainbow bands and the plain-language read. Run: node test/cryptolong.mjs
import assert from 'node:assert/strict';
import { cryptoBase, fitModels, cycleTops, bandEdges, bandIndex, fitQuality, readModels, weekly, BANDS, ols } from '../src/sources/cryptolong.js';
import { logTicks, axisMoney, money } from '../public/cryptolong.js';

assert.equal(cryptoBase('BTC-USD'), 'BTC');
assert.equal(cryptoBase('eth-usd'), 'ETH');
assert.equal(cryptoBase('BTC'), null, 'plain BTC is a Yahoo ETF symbol, not the coin');
assert.equal(cryptoBase('PEPE-USD'), null);

// OLS recovers a straight line.
const f = ols([1, 2, 3, 4], [3, 5, 7, 9]);
assert.ok(Math.abs(f.b - 2) < 1e-9 && Math.abs(f.a - 1) < 1e-9 && Math.abs(f.r2 - 1) < 1e-9);

// Synthetic Bitcoin-like history: power law trend (slope 5.8) with four year
// cycles whose swings shrink over time, sampled daily from day 560 to 6500.
const genesis = '2009-01-03';
const g = Date.parse(genesis);
const pts = [];
for (let d = 560; d <= 6500; d++) {
  const amp = 0.9 * Math.exp(-d / 5000);
  const cyc = amp * Math.sin((2 * Math.PI * (d - 560)) / 1460);
  pts.push({ t: g + d * 86400e3, p: 10 ** (-17 + 5.8 * Math.log10(d) + cyc) });
}
const m = fitModels(pts, genesis);
assert.ok(m, 'fits');
assert.ok(Math.abs(m.fair.b - 5.8) < 0.5, `slope near 5.8, got ${m.fair.b}`);
assert.ok(m.fair.r2 > 0.85, `r2 ${m.fair.r2}`);
assert.ok(m.support.a < m.fair.a, 'support under fair');
assert.equal(m.resistance.from, 'tops');
assert.ok(m.resistance.b < 5.8, 'tops rise slower than trend as cycles shrink');
assert.ok(m.pctBelow >= 0 && m.pctBelow <= 1);
assert.equal(fitQuality(m, 'BTC'), 'strong');

// Cycle tops land one per cycle.
const tops = cycleTops(pts.map((x) => x.p));
assert.ok(tops.length >= 3 && tops.length <= 5, `tops ${tops.length}`);

// Bands: ten increasing edges, today's band matches the price position.
const day = 6500;
const e = bandEdges(m, day);
assert.equal(e.length, BANDS.length + 1);
for (let i = 1; i < e.length; i++) assert.ok(e[i] > e[i - 1]);
assert.equal(bandIndex(m, day, e[0] / 2), 0, 'below support clamps to the bottom band');
assert.equal(bandIndex(m, day, e[9] * 2), 8, 'above the top clamps to the top band');
assert.equal(bandIndex(m, day, Math.sqrt(e[4] * e[5])), 4);
// The top edge never drops under the trend, even far in the future.
const far = bandEdges(m, 40000);
assert.ok(far[9] >= 10 ** (m.fair.a + m.fair.b * Math.log10(40000)) * 1.4);

// The read: below trend, mentions fair value and band, no em dashes.
const fair = 10 ** (m.fair.a + m.fair.b * Math.log10(day));
let read = readModels('BTC', 'Bitcoin', m, fair * 0.45, day);
assert.match(read[0], /below its power law fair value/);
assert.ok(read.some((s) => /band \d of 9/.test(s)));
assert.ok(read.some((s) => /bear markets/.test(s)));
assert.ok(!read.join(' ').includes(String.fromCharCode(8212)), 'no em dashes');
read = readModels('ETH', 'Ethereum', m, fair * 2.5, day);
assert.match(read[0], /above/);
assert.ok(read.some((s) => /found in Bitcoin's price history/.test(s)), 'non-BTC caveat');

// A coin going nowhere gets a poor fit and no fair value read.
const flat = [];
for (let d = 400; d <= 2000; d++) flat.push({ t: g + d * 86400e3, p: 1 + 0.5 * Math.sin(d / 50) });
const mf = fitModels(flat, genesis);
assert.equal(fitQuality(mf, 'XRP'), 'poor');
assert.match(readModels('XRP', 'XRP', mf, 1, 2000)[0], /does not fit/);

// Too little history.
assert.equal(fitModels(pts.slice(0, 100), genesis), null);

// Weekly downsample keeps the last day.
const w = weekly(pts, genesis);
assert.equal(w[w.length - 1][0], 6500);
assert.ok(w.length < pts.length / 6);

// Client formatting.
assert.deepEqual(logTicks(0.05, 200000), [0.1, 1, 10, 100, 1000, 10000, 100000]);
assert.deepEqual(logTicks(1e-6, 1e6), [1e-6, 1e-4, 0.01, 1, 100, 10000, 1e6]);
assert.deepEqual(logTicks(40, 300), [50, 100, 200]);
assert.equal(axisMoney(150000), '$150K');
assert.equal(axisMoney(0.01), '$0.01');
assert.equal(money(60123.4), '$60,123');

console.log('cryptolong: all tests passed');
