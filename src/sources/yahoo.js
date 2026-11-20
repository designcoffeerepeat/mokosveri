// Yahoo Finance public endpoints: price history (no auth), quote summary (needs
// a cookie + crumb pair, cached), and news search.
import { getJSON, fetchWithTimeout, cached, BROWSER_UA, yahooSymbol, cleanTicker } from '../util.js';

const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };

export async function chart(env, ticker, range = '1y', interval = '1d') {
  return cached(env, `chart:${ticker}:${range}`, 600, () => fetchChart(ticker, range, interval));
}

// Uncached price history fetch (the watchlist batches its own cache reads).
export async function fetchChart(ticker, range = '1y', interval = '1d') {
  const sym = encodeURIComponent(yahooSymbol(ticker));
  let d;
  try {
    d = await getJSON(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`, { headers: H });
  } catch {
    d = await getJSON(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?range=${range}&interval=${interval}&includePrePost=false`, { headers: H });
  }
  const r = d.chart && d.chart.result && d.chart.result[0];
  if (!r || !r.timestamp) throw new Error('No price data');
  const q = r.indicators.quote[0];
  const bars = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    if (q.close[i] == null) continue;
    bars.push({ t: r.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  }
  const m = r.meta || {};
  return {
    bars,
    meta: {
      currency: m.currency,
      exchange: m.fullExchangeName || m.exchangeName,
      instrumentType: m.instrumentType,
      price: m.regularMarketPrice,
      prevClose: m.chartPreviousClose,
      name: m.longName || m.shortName,
    },
  };
}

export async function getCrumb(env, force = false) {
  const key = 'yahoo:crumb';
  if (!force && env.CACHE) {
    const c = await env.CACHE.get(key, 'json');
    if (c && c.crumb) return c;
  }
  const r1 = await fetchWithTimeout('https://fc.yahoo.com/', { headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual' });
  const list = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : (r1.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  const cookie = list
    .map((c) => c.split(';')[0].trim())
    .filter(Boolean)
    .join('; ');
  const r2 = await fetchWithTimeout('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': BROWSER_UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40 || /</.test(crumb)) throw new Error('Yahoo crumb unavailable');
  const val = { crumb, cookie };
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: 60 * 60 * 6 });
  return val;
}

const MODULES = [
  'price',
  'summaryDetail',
  'defaultKeyStatistics',
  'financialData',
  'recommendationTrend',
  'upgradeDowngradeHistory',
  'calendarEvents',
  'quoteType',
  'assetProfile',
  'summaryProfile',
  'fundProfile',
  'topHoldings',
].join(',');

export async function quoteSummary(env, ticker) {
  return cached(env, `qs:${ticker}`, 1800, async () => {
    const sym = encodeURIComponent(yahooSymbol(ticker));
    for (let attempt = 0; attempt < 2; attempt++) {
      const { crumb, cookie } = await getCrumb(env, attempt > 0);
      const r = await fetchWithTimeout(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${sym}?modules=${MODULES}&crumb=${encodeURIComponent(crumb)}`,
        { headers: { ...H, Cookie: cookie } }
      );
      if (r.status === 401 || r.status === 403) continue;
      if (!r.ok) throw new Error(`Yahoo summary HTTP ${r.status}`);
      const d = await r.json();
      const res = d.quoteSummary && d.quoteSummary.result && d.quoteSummary.result[0];
      if (!res) throw new Error('Yahoo summary empty');
      return res;
    }
    throw new Error('Yahoo summary unauthorized');
  });
}

export async function news(env, ticker) {
  return cached(env, `news:${ticker}`, 1200, async () => {
    const d = await getJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=1&newsCount=12&enableFuzzyQuery=false`, { headers: H });
    return (d.news || []).map((n) => ({
      title: n.title,
      publisher: n.publisher,
      link: n.link,
      time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
      tickers: n.relatedTickers || [],
    }));
  });
}

export async function searchSymbols(env, q) {
  return cached(env, `search2:${q.toLowerCase()}`, 3600, async () => {
    const d = await getJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0`, { headers: H });
    return (d.quotes || [])
      .filter((x) => x.symbol && ['EQUITY', 'ETF', 'INDEX'].includes(x.quoteType) && cleanTicker(x.symbol))
      .map((x) => ({ symbol: cleanTicker(x.symbol), name: x.shortname || x.longname || '', type: x.quoteType, exchange: x.exchDisp }));
  });
}

// Small helper: unwrap Yahoo {raw, fmt} values.
export const raw = (v) => (v && typeof v === 'object' && 'raw' in v ? v.raw : v ?? null);
