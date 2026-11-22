// Offline test for the interactive chart: range shaping, session tagging and
// indicator math. Run: node test/chart.mjs
import assert from 'node:assert/strict';
import { shapeHistory, priceHistory, RANGES, tagSessions } from '../src/sources/history.js';
import { smaSeries, rsiSeries, macdSeries, niceTicks } from '../public/chart.js';
import { rsi } from '../src/analysis/technicals.js';

const off = -18000; // New York, EST
const DAY = 86400;
const mid = (d) => d * DAY - off; // local midnight of day number d, in UTC seconds

// Five trading days of 15 minute bars from 4:00 to 20:00, regular 9:30 to 16:00.
const days = [20400, 20401, 20402, 20403, 20406];
const ts = [];
for (const d of days) for (let m = 4 * 60; m < 20 * 60; m += 15) ts.push(mid(d) + m * 60);
const close = ts.map((_, i) => 100 + Math.sin(i / 9) * 3 + i * 0.01);
const raw = (meta) => ({
  meta: { gmtoffset: off, ...meta },
  timestamp: ts,
  indicators: { quote: [{ open: close, high: close.map((c) => c + 0.2), low: close.map((c) => c - 0.2), close, volume: close.map(() => 1000) }] },
});
const reg = (d) => ({ start: mid(d) + 9.5 * 3600, end: mid(d) + 16 * 3600 });

// Sessions from per day trading periods, including an early close on one day.
const periods = days.map((d) => [d === 20402 ? { start: reg(d).start, end: mid(d) + 13 * 3600 } : reg(d)]);
let tags = tagSessions(ts, { gmtoffset: off, tradingPeriods: { regular: periods } });
const at = (d, h) => ts.indexOf(mid(d) + h * 3600);
assert.equal(tags[at(20400, 4)], 'pre');
assert.equal(tags[at(20400, 9.5)], null);
assert.equal(tags[at(20400, 15.75)], null);
assert.equal(tags[at(20400, 16)], 'post');
assert.equal(tags[at(20402, 13)], 'post', 'early close day turns post at 1 PM');

// Fallback to the current trading period's time of day.
tags = tagSessions(ts, { gmtoffset: off, currentTradingPeriod: { regular: reg(20410) } });
assert.equal(tags[at(20401, 9.25)], 'pre');
assert.equal(tags[at(20401, 12)], null);
assert.equal(tags[at(20401, 19)], 'post');

// 1D shows only the last day and takes the previous regular close as baseline.
let h = shapeHistory(raw({ currentTradingPeriod: { regular: reg(20406) } }), '1d');
assert.equal(h.bars.length - h.start, 64);
assert.ok(h.bars.slice(h.start).every((b) => Math.floor((b.t + off) / DAY) === 20406));
const lastRegPrev = ts.indexOf(mid(20403) + 15.75 * 3600);
assert.equal(h.prevClose, close[lastRegPrev]);
assert.equal(h.extended, true);
assert.equal(h.intraday, true);
assert.ok(h.bars.some((b) => b.s === 'pre') && h.bars.some((b) => b.s === 'post'));

// 5D shows all five days.
h = shapeHistory(raw({ currentTradingPeriod: { regular: reg(20406) } }), '5d');
assert.equal(h.start, 0);
assert.equal(h.prevClose, null);

// Daily ranges: 2 years of daily bars, warm up is capped and windows are right.
const dts = [];
const dc = [];
for (let d = 20000, i = 0; d <= 20730; d++) {
  const wd = (d + 4) % 7; // 1970-01-01 was a Thursday
  if (wd === 0 || wd === 6) continue;
  dts.push(mid(d) + 9.5 * 3600);
  dc.push(50 + i++ * 0.1);
}
const draw = { meta: { gmtoffset: off }, timestamp: dts, indicators: { quote: [{ open: dc, high: dc, low: dc, close: dc, volume: dc.map(() => 5) }] } };
const lastLocal = new Date((dts[dts.length - 1] + off) * 1000);
for (const [range, months] of [['3mo', 3], ['6mo', 6], ['1y', 12]]) {
  h = shapeHistory(draw, range);
  const first = new Date((h.bars[h.start].t + off) * 1000);
  const span = (lastLocal - first) / (DAY * 1000);
  assert.ok(span <= months * 31 && span >= months * 28 - 4, `${range} spans ${span} days`);
  assert.ok(h.start <= 220, 'warm up capped');
  assert.deepEqual(h.ma, [50, 200]);
}
h = shapeHistory(draw, 'ytd');
assert.equal(new Date((h.bars[h.start].t + off) * 1000).getUTCFullYear(), lastLocal.getUTCFullYear());
assert.notEqual(new Date((h.bars[h.start - 1].t + off) * 1000).getUTCFullYear(), lastLocal.getUTCFullYear());
assert.equal(shapeHistory(draw, 'max').start, 0);

// Null closes are skipped, missing OHLC falls back to the close.
const holes = { meta: { gmtoffset: 0 }, timestamp: [1, 2, 3], indicators: { quote: [{ open: [null, 2, 3], high: [null, null, 3], low: [1, 2, 3], close: [1, null, 3], volume: [null, 5, 6] }] } };
h = shapeHistory(holes, 'max');
assert.deepEqual(h.bars, [{ t: 1, o: 1, h: 1, l: 1, c: 1, v: 0 }, { t: 3, o: 3, h: 3, l: 3, c: 3, v: 6 }]);

// Every range is wired with a Yahoo interval and the end to end fetch works.
assert.deepEqual(Object.keys(RANGES), ['1d', '5d', '1mo', '3mo', '6mo', 'ytd', '1y', '5y', 'max']);
const seen = [];
globalThis.fetch = async (url) => {
  seen.push(String(url));
  return new Response(JSON.stringify({ chart: { result: [{ ...draw, meta: { ...draw.meta, currency: 'USD' } }] } }), { status: 200 });
};
const kv = new Map();
const env = { CACHE: { get: async (k) => kv.get(k) ?? null, put: async (k, v) => kv.set(k, JSON.parse(v)) } };
const a = await priceHistory(env, 'AAPL', '6mo');
const b = await priceHistory(env, 'AAPL', '1y');
assert.equal(seen.length, 1, '6M and 1Y share one download');
assert.ok(seen[0].includes('range=2y&interval=1d&includePrePost=false'));
assert.equal(a.currency, 'USD');
assert.ok(b.bars.length - b.start > a.bars.length - a.start);
await assert.rejects(priceHistory(env, 'AAPL', '2w'));

// Indicator math.
assert.deepEqual(smaSeries([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
const walk = [];
for (let i = 0, p = 100, s = 7; i < 300; i++) walk.push((p += ((s = (s * 16807) % 2147483647) / 2147483647 - 0.5) * 2));
const r = rsiSeries(walk);
assert.equal(r[13], null);
assert.ok(r[14] != null);
assert.ok(Math.abs(r[299] - rsi(walk)) < 1e-9, 'RSI series matches the scoring model');
assert.ok(r.slice(14).every((v) => v >= 0 && v <= 100));
const m = macdSeries(walk);
assert.equal(m.macd[32], null);
assert.ok(m.macd[33] != null);
assert.ok(Math.abs(m.hist[200] - (m.macd[200] - m.signal[200])) < 1e-12);
assert.deepEqual(niceTicks(0, 100, 5), [0, 20, 40, 60, 80, 100]);
assert.deepEqual(niceTicks(101.3, 109.9, 4), [102.5, 105, 107.5]);

console.log('chart tests passed');
