// Offline test for the earnings calendar: mocks the Nasdaq earnings calendar
// and Yahoo. Run: node test/earncal.mjs
import assert from 'node:assert/strict';
import { earningsMonth, earningsDay, weekdaysOf, shiftMonth, monthDiff, rankRows, yahooConsensus, MONTH_BUDGET } from '../src/earningscal.js';
import { monthWeeks, cellHtml, gridHtml, dayHtml, tableHtml, filterRows, epsTxt, epsNum, capTxt, pctTxt } from '../public/earncal.js';

// --- dates
assert.equal(weekdaysOf('2026-11').length, 21);
assert.equal(weekdaysOf('2026-11')[0], '2026-11-02');
assert.equal(shiftMonth('2026-12', 1), '2027-01');
assert.equal(shiftMonth('2026-01', -1), '2025-12');
assert.equal(monthDiff('2027-02', '2026-11'), 3);
const wk = monthWeeks('2026-11');
assert.equal(wk.length, 5);
assert.deepEqual(wk[0], ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
assert.deepEqual(monthWeeks('2026-10')[0], [null, null, null, '2026-10-01', '2026-10-02'], 'October 2026 starts on a Thursday');
assert.ok(MONTH_BUDGET >= 23, 'one visit can load a whole month');

// --- formatting
assert.equal(epsTxt('($0.12)'), '-$0.12');
assert.equal(epsNum('($0.12)'), -0.12);
assert.equal(epsTxt('$1.05'), '$1.05');
assert.equal(capTxt(3.9e12), '$3.9T');
assert.equal(capTxt(45.3e9), '$45.3B');
assert.equal(capTxt(820e6), '$820M');
assert.equal(pctTxt(5.234), '+5.2%');

// --- ranking: watchlist, then megacaps, then market value
const ranked = rankRows([
  { ticker: 'SMAL', cap: 2e9 },
  { ticker: 'BIG', cap: 500e9 },
  { ticker: 'NVDA', cap: 100e9 },
  { ticker: 'MINE', cap: 1e9 },
], new Set(['MINE']));
assert.deepEqual(ranked.map((r) => r.ticker), ['MINE', 'NVDA', 'BIG', 'SMAL']);

// --- mocked feeds
const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const row = (symbol, name, cap, time, eps = '$1.00', extra = {}) => ({ symbol, name, marketCap: `$${cap.toLocaleString('en-US')}`, time, epsForecast: eps, noOfEsts: '12', lastYearEPS: '$0.90', lastYearRptDt: '11/20/2025', fiscalQuarterEnding: 'Oct/2026', ...extra });
const EARN = {
  '2026-11-24': [
    row('DELL', 'Dell Technologies Inc.', 90e9, 'time-after-hours', '$2.47'),
    row('ADI', 'Analog Devices, Inc.', 110e9, 'time-pre-market', '$2.22', { eps: '$2.30', surprise: '3.6' }),
    row('ZZZ', 'Tiny Co', 50e6, 'time-not-supplied', '($0.05)'),
  ],
  '2026-11-25': [
    row('DE', 'Deere & Company', 130e9, 'time-pre-market', '$3.90'),
    ...Array.from({ length: 30 }, (_, i) => row(`S${String(i).padStart(2, '0')}`, `Small ${i}`, 1e9 - i * 1e6, 'time-after-hours')),
  ],
};
const calls = [];
let failDay = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  let m;
  if ((m = u.match(/calendar\/earnings\?date=(\d{4}-\d\d-\d\d)/))) {
    if (m[1] === failDay) return new Response('blocked', { status: 403 });
    return J({ data: { rows: EARN[m[1]] || [] } });
  }
  if (u.includes('fc.yahoo.com')) return new Response('', { status: 302, headers: { 'set-cookie': 'A3=x; Path=/' } });
  if (u.includes('getcrumb')) return new Response('crumb123', { status: 200 });
  if ((m = u.match(/quoteSummary\/([^?]+)/))) {
    const t = decodeURIComponent(m[1]);
    if (t !== 'DE') return J({ quoteSummary: { result: [{ calendarEvents: { earnings: {} } }] } });
    return J({
      quoteSummary: {
        result: [{
          earningsTrend: { trend: [{ period: '0q', endDate: '2026-10-31', earningsEstimate: { avg: { raw: 3.91 }, low: { raw: 3.5 }, high: { raw: 4.2 }, yearAgoEps: { raw: 4.55 }, growth: { raw: -0.14 }, numberOfAnalysts: { raw: 18 } }, revenueEstimate: { avg: { raw: 9.6e9 }, low: { raw: 9.1e9 }, high: { raw: 10.1e9 }, growth: { raw: -0.05 }, numberOfAnalysts: { raw: 16 } } }] },
          earningsHistory: { history: [1, 2, 3, 4].map((i) => ({ quarter: { raw: Date.parse(`2026-0${i * 2}-01`) / 1000 }, epsActual: { raw: 4 + i * 0.1 }, epsEstimate: { raw: i === 2 ? 5 : 4 }, surprisePercent: { raw: 0.1 } })) },
          calendarEvents: { earnings: {} },
          price: { shortName: 'Deere' },
        }],
      },
    });
  }
  return new Response('not mocked: ' + u, { status: 500 });
};
const mem = new Map();
const env = { CACHE: { async get(k, t) { const v = mem.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } } };
const today = '2026-11-24';

// A short budget loads the days nearest today first and reports the rest as pending.
const m1 = await earningsMonth(env, { today, month: '2026-11', budget: 3, watch: ['ZZZ'] });
assert.equal(m1.partial, true);
assert.ok(m1.days['2026-11-24'] && m1.days['2026-11-25'], 'nearest days load first');
assert.equal(m1.days['2026-11-26'].closed, 'Market closed: Thanksgiving Day', 'holidays cost nothing and say why');
assert.ok(m1.pending.includes('2026-11-02'));
const d24 = m1.days['2026-11-24'];
assert.equal(d24.count, 3);
assert.deepEqual(d24.top.map((x) => x.t), ['ZZZ', 'ADI', 'DELL'], 'watchlist first, then by market value');
assert.equal(d24.top[0].watch, true);
assert.equal(d24.top[1].when, 'bmo');
assert.equal(d24.top[2].when, 'amc');
assert.equal(m1.days['2026-11-25'].top.length, 8, 'cells carry only the top names');
assert.equal(m1.days['2026-11-25'].count, 31);
assert.equal(m1.days['2026-11-27'], undefined, 'over budget');

// The next visit fills in the rest from the default budget and reuses the cache.
const before = calls.length;
const m2 = await earningsMonth(env, { today, month: '2026-11' });
assert.equal(m2.partial, false);
assert.equal(m2.days['2026-11-27'].half, 'Day after Thanksgiving');
assert.equal(Object.keys(m2.days).length, 21);
assert.equal(calls.length - before, 21 - 1 - 3, 'cached days and the holiday are not fetched again');

// Navigation stays inside the range, and an out of range month falls back to this one.
assert.equal(m2.prev, '2026-10');
assert.equal(m2.next, '2026-12');
const far = await earningsMonth(env, { today, month: '2028-01', budget: 0 });
assert.equal(far.month, '2026-11');
const edge = await earningsMonth(env, { today, month: '2027-02', budget: 0 });
assert.equal(edge.next, null, 'three months ahead is the limit');

// A blocked day is reported as failed, not pending forever.
failDay = '2026-12-01';
const dec = await earningsMonth(env, { today, month: '2026-12', budget: 30 });
assert.ok(dec.failed.includes('2026-12-01'));
assert.ok(!dec.pending.includes('2026-12-01'));
assert.equal(dec.days['2026-12-25'].closed, 'Market closed: Christmas Day');

// --- day view
const day = await earningsDay(env, { today, date: '2026-11-25' });
assert.equal(day.count, 31);
assert.equal(day.rows[0].t, 'DE');
assert.equal(day.rows[0].ests, 12);
assert.equal(day.rows[0].ly, '$0.90');
assert.equal(day.rows[0].lyDate, '2025-11-20');
assert.equal(day.rows[0].q, 'Oct/2026');
const c = day.consensus.DE;
assert.ok(c, 'largest names get Yahoo consensus');
assert.equal(c.rev.avg, 9.6e9);
assert.equal(c.eps.low, 3.5);
assert.equal(c.eps.analysts, 18);
assert.equal(c.history.length, 4);
assert.equal(Object.keys(day.consensus).length, 1, 'companies without estimates are left out');
const past = await earningsDay(env, { today: '2026-11-25', date: '2026-11-24' });
assert.deepEqual(past.consensus, {}, 'no Yahoo ranges once the quarter has been reported');
assert.equal(past.rows.find((r) => r.t === 'ADI').act, '$2.30');
assert.equal(past.rows.find((r) => r.t === 'ADI').sur, '3.6');
const hol = await earningsDay(env, { today, date: '2026-11-26' });
assert.match(hol.closed, /Thanksgiving/);
await assert.rejects(earningsDay(env, { today, date: 'nope' }), /YYYY-MM-DD/);
await assert.rejects(earningsDay(env, { today, date: '2027-09-01' }), /outside/);
assert.equal(yahooConsensus({ calendarEvents: { earnings: {} } }), null);

// --- page rendering
const st = { today, sel: '2026-11-25', failed: [], watch: ['ZZZ'] };
const cell = cellHtml('2026-11-24', m2.days['2026-11-24'], st);
assert.match(cell, /data-day="2026-11-24"/);
assert.match(cell, /class="ec-tk amc"[^>]*>DELL/);
assert.match(cell, /ec-cell today/);
const busy = cellHtml('2026-11-25', m2.days['2026-11-25'], st);
assert.match(busy, /\+26 more/);
assert.match(busy, /aria-pressed="true"/);
assert.match(cellHtml('2026-11-26', m2.days['2026-11-26'], st), /Thanksgiving/);
assert.doesNotMatch(cellHtml('2026-11-26', m2.days['2026-11-26'], st), /<button/, 'closed days are not clickable');
assert.match(cellHtml('2026-11-30', undefined, st), /Loading/);
const grid = gridHtml(m2, st);
assert.equal((grid.match(/class="ec-cell/g) || []).length, 25, 'five full weeks of weekday slots');
const f = { when: 'all', q: '', all: false };
const dh = dayHtml(day, f);
assert.match(dh, /Wednesday, November 25/);
assert.match(dh, /Revenue estimate/);
assert.match(dh, /\$9\.6B/);
assert.match(dh, /Show all 31 companies/);
assert.equal(filterRows(day.rows, { when: 'bmo', q: '' }).length, 1);
assert.equal(filterRows(day.rows, { when: 'all', q: 'small 1' }).length, 11);
assert.match(tableHtml(past, f), /Surprise/);
assert.match(tableHtml(past, f), /\+3\.6%/);
assert.doesNotMatch(tableHtml(day, f), /Surprise/, 'upcoming days have no reported columns');
assert.match(dayHtml(hol, f), /Thanksgiving/);
for (const s of [dh, grid, tableHtml(past, f)]) assert.ok(!s.includes('—'), 'no em dashes in page text');

console.log('earnings calendar tests passed');
