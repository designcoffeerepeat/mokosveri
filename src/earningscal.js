// Earnings calendar for the Market events page: a month grid of the most
// important companies reporting each trading day, and a day view with every
// company's timing, EPS estimate, analyst count, last year's result and, for
// the biggest names, Yahoo's revenue and EPS consensus ranges.
//
// Data: Nasdaq's daily earnings calendar (one fetch per trading day, shared
// cache slot with the events page) and Yahoo quoteSummary for the day view.
import { getJSON, settle, pool, cleanTicker } from './util.js';
import { quoteSummaryModules, raw } from './sources/yahoo.js';
import { NQ, budgeted, cacheGet, dayTtl, parseEarnRows, addDays, dow, todayET, HOLIDAYS, HALF_DAYS, MEGACAPS } from './events.js';

// Nasdaq fetches allowed per month request. A month has at most 23 trading
// days, so one cold visit loads the whole month (Workers Free allows 50).
export const MONTH_BUDGET = 23;
// Companies shown in each day cell of the month grid.
export const TOP_PER_DAY = 8;
// Companies in the day view that also get Yahoo consensus ranges.
export const YAHOO_PER_DAY = 8;
// Months reachable from the current one (back, ahead).
export const MONTH_RANGE = [-3, 3];

export const monthOf = (s) => s.slice(0, 7);
export function shiftMonth(m, n) {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}
export function monthDiff(a, b) {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (ya - yb) * 12 + (ma - mb);
}
// Weekdays of a month, YYYY-MM-DD.
export function weekdaysOf(m) {
  const out = [];
  for (let d = `${m}-01`; monthOf(d) === m; d = addDays(d, 1)) if (dow(d) > 0 && dow(d) < 6) out.push(d);
  return out;
}

// Importance: market value first, with the market moving megacaps and the
// reader's watchlist pulled to the front.
export function rankRows(rows, watch = new Set()) {
  const score = (r) => (r.cap || 0) + (MEGACAPS.includes(r.ticker) ? 1e15 : 0) + (watch.has(r.ticker) ? 2e15 : 0);
  return [...rows].sort((a, b) => score(b) - score(a) || a.ticker.localeCompare(b.ticker));
}

const WHEN = { 'Before the open': 'bmo', 'After the close': 'amc' };
const slim = (r, watch) => ({
  t: r.ticker,
  n: r.name || null,
  cap: r.cap || null,
  when: WHEN[r.when] || null,
  est: r.expected || null,
  act: r.actual || null,
  sur: r.surprise || null,
  watch: watch.has(r.ticker) || undefined,
});

const nasdaqDay = (env, budget, day, today) =>
  budgeted(env, budget, `ev:earn:${day}`, dayTtl(day, today), 1, async () => parseEarnRows(await getJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${day}`, { headers: NQ }, 8000)));

const closedNote = (day) => (HOLIDAYS[day] ? `Market closed: ${HOLIDAYS[day]}` : null);

export async function earningsMonth(env, opts = {}) {
  const today = opts.today || todayET();
  const cur = monthOf(today);
  let month = /^\d{4}-\d\d$/.test(opts.month || '') ? opts.month : cur;
  const off = monthDiff(month, cur);
  if (off < MONTH_RANGE[0] || off > MONTH_RANGE[1]) month = cur;
  const watch = new Set(opts.watch || []);
  const budget = { left: opts.budget ?? MONTH_BUDGET, skipped: 0 };
  const days = {};
  const failed = [];
  // Nearest days first, so a short budget fills the part of the month people look at.
  const order = weekdaysOf(month).sort((a, b) => Math.abs(Date.parse(a) - Date.parse(today)) - Math.abs(Date.parse(b) - Date.parse(today)));
  await pool(order, 4, async (day) => {
    if (HOLIDAYS[day]) {
      days[day] = { closed: closedNote(day), count: 0, top: [] };
      return;
    }
    const r = await settle(nasdaqDay(env, budget, day, today));
    if (!r.ok) {
      failed.push(day);
      return;
    }
    if (r.value === undefined) return; // over budget: loads on the next visit
    const rows = rankRows(r.value || [], watch);
    days[day] = {
      count: rows.length,
      bmo: rows.filter((x) => x.when === 'Before the open').length,
      amc: rows.filter((x) => x.when === 'After the close').length,
      half: HALF_DAYS[day] || undefined,
      top: rows.slice(0, TOP_PER_DAY).map((x) => slim(x, watch)),
    };
  });
  const pending = weekdaysOf(month).filter((d) => !days[d] && !failed.includes(d));
  return {
    month,
    today,
    prev: monthDiff(shiftMonth(month, -1), cur) >= MONTH_RANGE[0] ? shiftMonth(month, -1) : null,
    next: monthDiff(shiftMonth(month, 1), cur) <= MONTH_RANGE[1] ? shiftMonth(month, 1) : null,
    days,
    pending,
    failed,
    partial: pending.length > 0 || failed.length > 0,
    asOf: new Date().toISOString(),
    source: { name: 'Nasdaq earnings calendar', url: 'https://www.nasdaq.com/market-activity/earnings' },
  };
}

// Yahoo's consensus for the quarter being reported. earningsTrend "0q" is the
// current quarter, which is the one reported on an upcoming date.
export function yahooConsensus(q) {
  if (!q) return null;
  const tr = ((q.earningsTrend && q.earningsTrend.trend) || []).find((x) => x.period === '0q');
  const ce = (q.calendarEvents && q.calendarEvents.earnings) || {};
  const ee = (tr && tr.earningsEstimate) || {};
  const re = (tr && tr.revenueEstimate) || {};
  const hist = ((q.earningsHistory && q.earningsHistory.history) || [])
    .map((h) => ({ q: raw(h.quarter) ? new Date(raw(h.quarter) * 1000).toISOString().slice(0, 7) : null, act: raw(h.epsActual), est: raw(h.epsEstimate), sur: raw(h.surprisePercent) }))
    .filter((h) => h.act != null && h.est != null)
    .slice(-4);
  const out = {
    quarterEnd: tr && tr.endDate ? String(tr.endDate) : null,
    eps: { avg: raw(ee.avg) ?? raw(ce.earningsAverage), low: raw(ee.low) ?? raw(ce.earningsLow), high: raw(ee.high) ?? raw(ce.earningsHigh), yearAgo: raw(ee.yearAgoEps), growth: raw(ee.growth), analysts: raw(ee.numberOfAnalysts) },
    rev: { avg: raw(re.avg) ?? raw(ce.revenueAverage), low: raw(re.low) ?? raw(ce.revenueLow), high: raw(re.high) ?? raw(ce.revenueHigh), yearAgo: raw(re.yearAgoRevenue), growth: raw(re.growth), analysts: raw(re.numberOfAnalysts) },
    history: hist,
  };
  return out.eps.avg == null && out.rev.avg == null && !hist.length ? null : out;
}

export async function earningsDay(env, opts = {}) {
  const today = opts.today || todayET();
  const date = opts.date;
  if (!/^\d{4}-\d\d-\d\d$/.test(date || '')) throw new Error('Pick a date as YYYY-MM-DD');
  const off = monthDiff(monthOf(date), monthOf(today));
  if (off < MONTH_RANGE[0] || off > MONTH_RANGE[1]) throw new Error('That date is outside the calendar range');
  const watch = new Set(opts.watch || []);
  if (HOLIDAYS[date]) return { date, today, closed: closedNote(date), rows: [], consensus: {} };
  const r = await settle(nasdaqDay(env, { left: 1, skipped: 0 }, date, today));
  if (!r.ok) throw new Error(`Nasdaq earnings calendar: ${r.error}`);
  const rows = rankRows(r.value || [], watch).map((x) => ({
    ...slim(x, watch),
    q: x.quarter || null,
    ests: x.ests ?? null,
    ly: x.lastYearEps || null,
    lyDate: x.lastYearDate || null,
  }));
  // Revenue and EPS ranges only mean the quarter being reported for today and
  // later; after the report Yahoo has already rolled on to the next quarter.
  const consensus = {};
  if (date >= today) {
    const yb = { left: opts.yahooBudget ?? YAHOO_PER_DAY };
    await pool(rows.slice(0, YAHOO_PER_DAY), 4, async (row) => {
      let q = await cacheGet(env, `qsm:earn:${row.t}`);
      if (!q) {
        if (yb.left < 1) return;
        yb.left--;
        const y = await settle(quoteSummaryModules(env, row.t, 'earningsHistory,earningsTrend,calendarEvents,price', 'earn', 3 * 3600));
        if (!y.ok) return;
        q = y.value;
      }
      const c = yahooConsensus(q);
      if (c) consensus[row.t] = c;
    });
  }
  return {
    date,
    today,
    half: HALF_DAYS[date] || null,
    count: rows.length,
    rows,
    consensus,
    asOf: new Date().toISOString(),
    source: { name: 'Nasdaq earnings calendar', url: `https://www.nasdaq.com/market-activity/earnings` },
  };
}

export const parseWatch = (s) => String(s || '').split(',').map((x) => cleanTicker(x)).filter(Boolean).slice(0, 25);
