// Long-term crypto models for the ticker page: a power law fit (log price vs
// log days since the coin's genesis) and a rainbow chart (nine color bands
// between a support line and a line through past cycle tops). Both are refit
// on every request from the full daily price history, so the bands always use
// the latest data. Educational only: these are curve fits to past prices, not
// forecasts.
import { getJSON, cached, BROWSER_UA, yahooSymbol } from '../util.js';
import { chart } from './yahoo.js';

const DAY_MS = 86400e3;

// Major coins with a long enough history to fit. genesis: first block or
// mainnet launch, the day the power law counts from. cm: Coin Metrics id.
export const COINS = {
  BTC: { name: 'Bitcoin', cm: 'btc', genesis: '2009-01-03' },
  ETH: { name: 'Ethereum', cm: 'eth', genesis: '2015-07-30' },
  SOL: { name: 'Solana', cm: 'sol', genesis: '2020-03-16' },
  XRP: { name: 'XRP', cm: 'xrp', genesis: '2012-06-02' },
  BNB: { name: 'BNB', cm: 'bnb', genesis: '2017-07-25' },
  DOGE: { name: 'Dogecoin', cm: 'doge', genesis: '2013-12-06' },
  ADA: { name: 'Cardano', cm: 'ada', genesis: '2017-09-29' },
  LTC: { name: 'Litecoin', cm: 'ltc', genesis: '2011-10-07' },
};

// BTC-USD -> BTC when the coin is one we model, else null.
export function cryptoBase(ticker) {
  const m = String(ticker || '').toUpperCase().match(/^([A-Z]+)-USD$/);
  return m && COINS[m[1]] ? m[1] : null;
}

// Rainbow bands, cheapest first.
export const BANDS = [
  { name: 'Deep value', color: '#2b59c3' },
  { name: 'Very cheap', color: '#3d9be9' },
  { name: 'Cheap', color: '#2fb380' },
  { name: 'Below trend', color: '#8bd34c' },
  { name: 'Near trend', color: '#f2d43d' },
  { name: 'Above trend', color: '#f5a83a' },
  { name: 'Hot', color: '#f07b2f' },
  { name: 'Overheated', color: '#e0452f' },
  { name: 'Bubble territory', color: '#b3202f' },
];

// ---------- math ----------
export function ols(xs, ys) {
  const n = xs.length;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const b = sxx ? sxy / sxx : 0;
  return { a: my - b * mx, b, r2: sxx && syy ? (sxy * sxy) / (sxx * syy) : 0 };
}

const quantile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];

// Indexes of cycle tops: the highest close within a year either side. A top
// needs at least `settle` days after it so a running rally does not count.
export function cycleTops(prices, win = 365, settle = 120) {
  const out = [];
  for (let i = 0; i < prices.length - settle; i++) {
    let top = true;
    for (let j = Math.max(0, i - win), hi = Math.min(prices.length - 1, i + win); j <= hi && top; j++) if (prices[j] > prices[i]) top = false;
    if (top) out.push(i);
  }
  return out;
}

// points: [{ t: ms UTC, p: price }] daily, oldest first. genesis: 'YYYY-MM-DD'.
// Returns the fitted lines (as log10 price = a + b * log10 days) and where the
// last point sits against them.
export function fitModels(points, genesis) {
  const g = Date.parse(genesis);
  const pts = points.filter((x) => x.p > 0 && (x.t - g) / DAY_MS >= 1);
  if (pts.length < 365) return null;
  const days = pts.map((x) => (x.t - g) / DAY_MS);
  const xs = days.map((d) => Math.log10(d));
  const ys = pts.map((x) => Math.log10(x.p));

  // Fair value: least squares through every daily close.
  const fair = ols(xs, ys);
  const resid = ys.map((y, i) => y - (fair.a + fair.b * xs[i]));
  const sorted = [...resid].sort((a, b) => a - b);
  const lo = quantile(sorted, 0.01);
  const hi = quantile(sorted, 0.99);
  // Support: the fair line shifted down so only 1% of days closed below it.
  const support = { a: fair.a + lo, b: fair.b };

  // Resistance: a fit through past cycle tops, which rise more slowly than the
  // trend (diminishing returns). Without three tops, or if that line is not
  // rising, fall back to the band only 1% of days closed above.
  const tops = cycleTops(pts.map((x) => x.p));
  let resistance = { a: fair.a + hi, b: fair.b, from: 'band' };
  if (tops.length >= 3) {
    const f = ols(tops.map((i) => xs[i]), tops.map((i) => ys[i]));
    if (f.b > 0) resistance = { a: f.a, b: f.b, from: 'tops', tops: tops.length };
  }

  const last = pts.length - 1;
  const lastResid = resid[last];
  const below = resid.filter((r) => r <= lastResid).length / resid.length;
  return {
    start: new Date(pts[0].t).toISOString().slice(0, 10),
    years: (pts[last].t - pts[0].t) / DAY_MS / 365.25,
    fair: { a: fair.a, b: fair.b, r2: fair.r2 },
    support,
    resistance,
    // Rainbow edges never get closer than this many log10 units above the trend.
    minTopGap: 0.15,
    residual: lastResid,
    pctBelow: below,
  };
}

const at = (line, d) => 10 ** (line.a + line.b * Math.log10(d));

// Band edges at day d: support at the bottom, the tops line at the top (held
// at least minTopGap above fair value), nine equal slices in log space.
export function bandEdges(m, d) {
  const lo = Math.log10(at(m.support, d));
  const top = Math.max(Math.log10(at(m.resistance, d)), Math.log10(at(m.fair, d)) + m.minTopGap);
  return Array.from({ length: BANDS.length + 1 }, (_, i) => 10 ** (lo + ((top - lo) * i) / BANDS.length));
}

export function bandIndex(m, d, price) {
  const e = bandEdges(m, d);
  const f = (Math.log10(price) - Math.log10(e[0])) / (Math.log10(e[BANDS.length]) - Math.log10(e[0]));
  return Math.max(0, Math.min(BANDS.length - 1, Math.floor(f * BANDS.length)));
}

export function fitQuality(m, base) {
  if (!m || m.fair.b <= 0 || m.years < 3 || m.fair.r2 < 0.6) return 'poor';
  if (base === 'BTC' || m.fair.r2 >= 0.93) return 'strong';
  return m.fair.r2 >= 0.85 ? 'moderate' : 'loose';
}

const money = (v) => {
  if (!isFinite(v)) return 'n/a';
  const d = v >= 100 ? 0 : v >= 1 ? 2 : 4;
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
};

// Plain-language read of where today's price sits.
export function readModels(base, name, m, price, day) {
  const fair = at(m.fair, day);
  const mult = price / fair;
  const q = fitQuality(m, base);
  const out = [];
  if (q === 'poor') {
    out.push(`The power law does not fit ${name}'s price history well (R² ${m.fair.r2.toFixed(2)} over ${m.years.toFixed(1)} years), so the lines below are shown for reference only and are not worth reading as fair value.`);
    return out;
  }
  const pct = Math.round(Math.abs(mult - 1) * 100);
  out.push(`${name} is at ${money(price)}, ${pct < 3 ? 'right on' : `about ${pct}% ${mult < 1 ? 'below' : 'above'}`} its power law fair value of ${money(fair)} (${mult.toFixed(2)}x).`);
  const share = mult < 1 ? m.pctBelow : 1 - m.pctBelow;
  const sharePct = Math.max(1, Math.round(share * 100));
  if (share < 0.5) out.push(`Since ${m.start.slice(0, 4)} it has closed this ${mult < 1 ? 'low' : 'high'} relative to the trend on only about ${sharePct}% of days.`);
  out.push(`Support (the level only about 1% of days closed below) is near ${money(at(m.support, day))}, and ${m.resistance.from === 'tops' ? 'the line through past cycle tops' : 'the upper band (only about 1% of days closed above it)'} is near ${money(Math.max(at(m.resistance, day), fair * 10 ** m.minTopGap))}.`);
  const bi = bandIndex(m, day, price);
  out.push(`On the rainbow it sits in band ${bi + 1} of ${BANDS.length}, "${BANDS[bi].name}".`);
  if (mult < 0.6) out.push('In the past, prices this far under the trend came during bear markets that later recovered, but the model cannot say whether or when that repeats, and a trend that held for years can break.');
  else if (mult > 2) out.push('In the past, prices this far over the trend came near cycle peaks that were followed by deep drawdowns.');
  else out.push('That is inside the normal range around the trend.');
  if (base !== 'BTC') out.push(`The power law was found in Bitcoin's price history. ${name} has a shorter, choppier history (fit R² ${m.fair.r2.toFixed(2)} over ${m.years.toFixed(1)} years), so treat these lines as rough and expect them to move as new prices come in.`);
  return out;
}

// One point per week for the chart, plus the latest day.
export function weekly(points, genesis) {
  const g = Date.parse(genesis);
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i % 7 && i !== points.length - 1) continue;
    out.push([Math.round(((points[i].t - g) / DAY_MS) * 10) / 10, +points[i].p.toPrecision(5)]);
  }
  return out;
}

// ---------- data ----------
async function coinMetrics(cm) {
  const url = `https://community-api.coinmetrics.io/v4/timeseries/asset-metrics?assets=${cm}&metrics=PriceUSD&frequency=1d&page_size=10000&paging_from=start`;
  const d = await getJSON(url, { headers: { Accept: 'application/json' } }, 15000);
  const pts = (d.data || []).map((r) => ({ t: Date.parse(r.time), p: +r.PriceUSD })).filter((x) => isFinite(x.t) && x.p > 0);
  if (pts.length < 365) throw new Error('Not enough price history');
  return { source: 'Coin Metrics', pts };
}

async function yahooMax(ticker) {
  const sym = encodeURIComponent(yahooSymbol(ticker));
  const d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=max&interval=1d`, { headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' } }, 15000);
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw new Error('No price data');
  const c = r.indicators.quote[0].close;
  const pts = r.timestamp.map((t, i) => ({ t: Math.floor(t / 86400) * DAY_MS, p: c[i] })).filter((x) => x.p > 0);
  return { source: 'Yahoo Finance', pts };
}

export async function cryptoLong(env, ticker) {
  const base = cryptoBase(ticker);
  if (!base) return { error: 'Long-term models cover BTC, ETH, SOL, XRP, BNB, DOGE, ADA and LTC (as BTC-USD and so on).', status: 404 };
  const coin = COINS[base];
  // Full daily history, refreshed every 6 hours. Coin Metrics goes back to
  // 2010 for Bitcoin; Yahoo (from 2014) is the fallback.
  const hist = await cached(env, `cryptolong:v1:${base}`, 6 * 3600, async () => {
    try {
      return await coinMetrics(coin.cm);
    } catch {
      return yahooMax(ticker);
    }
  });
  const pts = hist.pts.slice();
  // Today's live price from the same cached Yahoo call the page header uses.
  try {
    const live = await chart(env, ticker, '1y');
    const b = live.bars[live.bars.length - 1];
    const t = b.t * 1000;
    const last = pts[pts.length - 1];
    if (b && b.c > 0 && t > last.t) pts.push({ t, p: b.c });
  } catch {}
  const m = fitModels(pts, coin.genesis);
  if (!m) return { error: 'Not enough price history to fit the models yet.', status: 422 };
  const now = pts[pts.length - 1];
  const day = (now.t - Date.parse(coin.genesis)) / DAY_MS;
  const bi = bandIndex(m, day, now.p);
  return {
    ticker,
    base,
    name: coin.name,
    genesis: coin.genesis,
    source: hist.source,
    asOf: new Date(now.t).toISOString(),
    price: now.p,
    day,
    quality: fitQuality(m, base),
    model: m,
    fairNow: at(m.fair, day),
    supportNow: at(m.support, day),
    resistanceNow: Math.max(at(m.resistance, day), at(m.fair, day) * 10 ** m.minTopGap),
    band: { index: bi, name: BANDS[bi].name },
    bands: BANDS,
    read: readModels(base, coin.name, m, now.p, day),
    series: weekly(pts, coin.genesis),
  };
}
