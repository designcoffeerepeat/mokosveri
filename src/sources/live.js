// Live quotes for the watchlist and pinned strip. One batched Yahoo quote call
// for every ticker that is not in the 15 second cache, with a per-ticker
// intraday chart fallback when the batch endpoint refuses us.
import { fetchWithTimeout, getJSON, BROWSER_UA, settle, yahooSymbol } from '../util.js';
import { getCrumb } from './yahoo.js';

const TTL = 15e3;
const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };
const FIELDS = 'regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketPreviousClose,regularMarketTime,marketState,shortName';
const MAX_FALLBACK = 12;

async function batchQuote(env, tickers) {
  const bySym = new Map(tickers.map((t) => [yahooSymbol(t), t]));
  const syms = [...bySym.keys()].map(encodeURIComponent).join(',');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { crumb, cookie } = await getCrumb(env, attempt > 0);
    const r = await fetchWithTimeout(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=${FIELDS}&crumb=${encodeURIComponent(crumb)}`, { headers: { ...H, Cookie: cookie } }, 6000);
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status}`);
    const d = await r.json();
    const out = new Map();
    for (const q of (d.quoteResponse && d.quoteResponse.result) || []) {
      const t = bySym.get(q.symbol);
      if (!t || q.regularMarketPrice == null) continue;
      out.set(t, {
        price: q.regularMarketPrice,
        change: q.regularMarketChange ?? null,
        change1d: q.regularMarketChangePercent ?? null,
        prevClose: q.regularMarketPreviousClose ?? null,
        time: q.regularMarketTime ? q.regularMarketTime * 1000 : null,
        marketState: q.marketState || null,
        name: q.shortName || null,
      });
    }
    return out;
  }
  throw new Error('Yahoo quote unauthorized');
}

async function chartQuote(t) {
  const d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(t))}?range=1d&interval=5m`, { headers: H }, 6000);
  const m = d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta;
  if (!m || m.regularMarketPrice == null) throw new Error('No quote');
  const prev = m.chartPreviousClose ?? m.previousClose ?? null;
  const tp = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const now = Date.now() / 1000;
  return {
    price: m.regularMarketPrice,
    change: prev ? m.regularMarketPrice - prev : null,
    change1d: prev ? (m.regularMarketPrice / prev - 1) * 100 : null,
    prevClose: prev,
    time: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
    marketState: tp ? (now >= tp.start && now < tp.end ? 'REGULAR' : 'CLOSED') : null,
    name: m.shortName || m.longName || null,
  };
}

// Returns Map ticker -> quote. Missing tickers simply are not in the map.
export async function liveQuotes(env, tickers) {
  const out = new Map();
  if (!tickers.length) return out;
  const now = Date.now();
  const keys = tickers.map((t) => `lq:${t}`);
  try {
    const r = await env.DB.prepare(`SELECT k, v FROM cache WHERE exp > ? AND k IN (${keys.map(() => '?').join(',')})`).bind(now, ...keys).all();
    for (const row of r.results || []) out.set(row.k.slice(3), JSON.parse(row.v));
  } catch {}
  const miss = tickers.filter((t) => !out.has(t));
  if (!miss.length) return out;

  let got = new Map();
  const b = await settle(batchQuote(env, miss));
  if (b.ok) got = b.value;
  const still = miss.filter((t) => !got.has(t)).slice(0, MAX_FALLBACK);
  const fb = await Promise.all(still.map((t) => settle(chartQuote(t))));
  still.forEach((t, i) => fb[i].ok && got.set(t, fb[i].value));

  const writes = [];
  for (const [t, q] of got) {
    out.set(t, q);
    writes.push(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(`lq:${t}`, JSON.stringify(q), now + TTL));
  }
  if (writes.length) await settle(env.DB.batch(writes));
  return out;
}

// How often clients should poll, from the market state of what they hold.
export function refreshSeconds(quotes) {
  const states = [...quotes.values()].map((q) => q.marketState);
  if (states.includes('REGULAR')) return 15;
  if (states.some((s) => s === 'PRE' || s === 'POST' || s === 'PREPRE' || s === 'POSTPOST')) return 30;
  return 120;
}

export function marketLabel(quotes) {
  const states = [...quotes.values()].map((q) => q.marketState);
  if (states.includes('REGULAR')) return 'open';
  if (states.includes('PRE') || states.includes('PREPRE')) return 'pre-market';
  if (states.includes('POST') || states.includes('POSTPOST')) return 'after hours';
  return states.length ? 'closed' : null;
}
