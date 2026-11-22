// Price history for the interactive chart on the ticker page. Each range pulls
// a longer window than it shows, so moving averages, RSI and MACD are already
// warmed up at the left edge of the chart. Intraday ranges include pre-market
// and after hours bars, tagged by session so the chart can shade them.
import { getJSON, cached, BROWSER_UA, yahooSymbol } from '../util.js';

const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };

// fetch: Yahoo range to download. show: how much of it the chart displays.
export const RANGES = {
  '1d': { fetch: '5d', interval: '5m', prePost: true, show: { days: 1 }, ttl: 60, ma: [20, 50] },
  '5d': { fetch: '1mo', interval: '15m', prePost: true, show: { days: 5 }, ttl: 120, ma: [20, 50] },
  '1mo': { fetch: '6mo', interval: '1h', prePost: false, show: { months: 1 }, ttl: 600, ma: [20, 50] },
  '3mo': { fetch: '2y', interval: '1d', prePost: false, show: { months: 3 }, ttl: 900, ma: [50, 200] },
  '6mo': { fetch: '2y', interval: '1d', prePost: false, show: { months: 6 }, ttl: 900, ma: [50, 200] },
  ytd: { fetch: '2y', interval: '1d', prePost: false, show: { ytd: true }, ttl: 900, ma: [50, 200] },
  '1y': { fetch: '2y', interval: '1d', prePost: false, show: { months: 12 }, ttl: 900, ma: [50, 200] },
  '5y': { fetch: '10y', interval: '1wk', prePost: false, show: { months: 60 }, ttl: 3600, ma: [10, 40] },
  max: { fetch: 'max', interval: '1mo', prePost: false, show: { all: true }, ttl: 3600 * 6, ma: [10, 40] },
};

// Bars of warm up kept before the first shown bar (enough for a 200 bar average).
const WARMUP = 220;

async function download(ticker, cfg) {
  const sym = encodeURIComponent(yahooSymbol(ticker));
  const qs = `range=${cfg.fetch}&interval=${cfg.interval}&includePrePost=${cfg.prePost}`;
  let d;
  try {
    d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?${qs}`, { headers: H });
  } catch {
    d = await getJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?${qs}`, { headers: H });
  }
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw new Error('No price data');
  return r;
}

// Regular session windows as [start, end] pairs in UTC seconds, from Yahoo's
// per day trading periods when present, else from the current period's time of day.
function regularWindows(meta) {
  const tp = meta.tradingPeriods;
  const reg = tp && !Array.isArray(tp) ? tp.regular : Array.isArray(tp) ? tp : null;
  const out = [];
  if (Array.isArray(reg)) for (const day of reg) for (const p of Array.isArray(day) ? day : [day]) if (p && p.start && p.end) out.push([p.start, p.end]);
  return out;
}

// Tags each bar 'pre', 'post' or null (regular session).
export function tagSessions(ts, meta) {
  const off = meta.gmtoffset || 0;
  const dayOf = (t) => Math.floor((t + off) / 86400);
  const byDay = new Map();
  for (const [s, e] of regularWindows(meta)) byDay.set(dayOf(s), [s, e]);
  const cur = meta.currentTradingPeriod && meta.currentTradingPeriod.regular;
  const tod = (t) => (((t + off) % 86400) + 86400) % 86400;
  return ts.map((t) => {
    const w = byDay.get(dayOf(t));
    if (w) return t < w[0] ? 'pre' : t >= w[1] ? 'post' : null;
    if (!cur) return null;
    return tod(t) < tod(cur.start) ? 'pre' : tod(t) >= tod(cur.end) ? 'post' : null;
  });
}

// Index of the first bar the chart shows for this range.
export function firstShown(bars, show, off) {
  if (!bars.length || show.all) return 0;
  const last = bars[bars.length - 1].t;
  const day = (t) => Math.floor((t + off) / 86400);
  if (show.days) {
    const days = [...new Set(bars.map((b) => day(b.t)))];
    const keep = new Set(days.slice(-show.days));
    const i = bars.findIndex((b) => keep.has(day(b.t)));
    return Math.max(0, i);
  }
  const d = new Date((last + off) * 1000);
  let cut;
  if (show.ytd) cut = Date.UTC(d.getUTCFullYear(), 0, 1) / 1000 - off;
  else {
    d.setUTCMonth(d.getUTCMonth() - show.months);
    cut = d.getTime() / 1000 - off;
  }
  const i = bars.findIndex((b) => b.t >= cut);
  return i < 0 ? 0 : i;
}

export function shapeHistory(r, range) {
  const cfg = RANGES[range];
  const meta = r.meta || {};
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const sess = cfg.prePost ? tagSessions(r.timestamp, meta) : [];
  let bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close && q.close[i];
    if (c == null || !isFinite(c)) continue;
    const b = { t: r.timestamp[i], o: q.open[i] ?? c, h: q.high[i] ?? c, l: q.low[i] ?? c, c, v: (q.volume && q.volume[i]) || 0 };
    if (sess[i]) b.s = sess[i];
    bars.push(b);
  }
  const off = meta.gmtoffset || 0;
  let start = firstShown(bars, cfg.show, off);
  const drop = Math.max(0, start - WARMUP);
  bars = bars.slice(drop);
  start -= drop;
  // Baseline for the one day view: the last regular session close before today.
  let prevClose = null;
  if (range === '1d') {
    for (let i = start - 1; i >= 0; i--) if (!bars[i].s) { prevClose = bars[i].c; break; }
    if (prevClose == null) prevClose = meta.previousClose ?? meta.chartPreviousClose ?? null;
  }
  return {
    range,
    interval: cfg.interval,
    intraday: /m$|h$/.test(cfg.interval),
    extended: cfg.prePost,
    ma: cfg.ma,
    gmtoffset: off,
    timezone: meta.exchangeTimezoneName || meta.timezone || null,
    currency: meta.currency || null,
    prevClose,
    start,
    bars,
  };
}

export async function priceHistory(env, ticker, range) {
  const cfg = RANGES[range];
  if (!cfg) throw new Error('Unknown range');
  // Ranges that share a download (3M, 6M, YTD, 1Y) share the cache entry too.
  const raw = await cached(env, `hist:v1:${ticker}:${cfg.fetch}:${cfg.interval}:${cfg.prePost ? 1 : 0}`, cfg.ttl, async () => {
    const r = await download(ticker, cfg);
    const q = r.indicators.quote[0];
    // Keep only what shapeHistory reads, so cache rows stay small.
    return {
      meta: {
        gmtoffset: r.meta.gmtoffset,
        exchangeTimezoneName: r.meta.exchangeTimezoneName,
        currency: r.meta.currency,
        previousClose: r.meta.previousClose,
        chartPreviousClose: r.meta.chartPreviousClose,
        currentTradingPeriod: r.meta.currentTradingPeriod,
        tradingPeriods: r.meta.tradingPeriods,
      },
      timestamp: r.timestamp,
      indicators: { quote: [{ open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume }] },
    };
  });
  return shapeHistory(raw, range);
}
