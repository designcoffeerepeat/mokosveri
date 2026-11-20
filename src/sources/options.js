// Option chains from Yahoo Finance (same cookie + crumb pair as quoteSummary).
// Falls back to price only (from the chart endpoint) so the calculator still
// works with manual premiums when the chain is unavailable.
import { fetchWithTimeout, cached, settle, BROWSER_UA } from '../util.js';
import { chart } from './yahoo.js';

const YAHOO_HEADERS = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };

// Same KV key and shape as the crumb helper in yahoo.js, so they share it.
async function getCrumb(env, force = false) {
  const key = 'yahoo:crumb';
  if (!force && env.CACHE) {
    const c = await env.CACHE.get(key, 'json');
    if (c && c.crumb) return c;
  }
  const r1 = await fetchWithTimeout('https://fc.yahoo.com/', { headers: { 'User-Agent': BROWSER_UA }, redirect: 'manual' });
  const list = typeof r1.headers.getSetCookie === 'function' ? r1.headers.getSetCookie() : (r1.headers.get('set-cookie') || '').split(/,(?=\s*[A-Za-z0-9_]+=)/);
  const cookie = list.map((c) => c.split(';')[0].trim()).filter(Boolean).join('; ');
  const r2 = await fetchWithTimeout('https://query2.finance.yahoo.com/v1/test/getcrumb', { headers: { 'User-Agent': BROWSER_UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.length > 40 || /</.test(crumb)) throw new Error('Yahoo crumb unavailable');
  const val = { crumb, cookie };
  if (env.CACHE) await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: 60 * 60 * 6 });
  return val;
}

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);

function slimContract(c) {
  return {
    strike: num(c.strike),
    bid: num(c.bid),
    ask: num(c.ask),
    last: num(c.lastPrice),
    iv: num(c.impliedVolatility),
    oi: num(c.openInterest),
    vol: num(c.volume),
  };
}

export function parseChain(d) {
  const r = d && d.optionChain && d.optionChain.result && d.optionChain.result[0];
  if (!r) throw new Error('Option chain empty');
  const q = r.quote || {};
  const o = (r.options && r.options[0]) || {};
  return {
    symbol: r.underlyingSymbol || q.symbol,
    name: q.longName || q.shortName || '',
    price: num(q.regularMarketPrice),
    dividendYield: num(q.trailingAnnualDividendYield),
    expirations: r.expirationDates || [],
    expiration: o.expirationDate || (r.expirationDates || [])[0] || null,
    calls: (o.calls || []).map(slimContract).filter((c) => c.strike != null),
    puts: (o.puts || []).map(slimContract).filter((c) => c.strike != null),
  };
}

async function fetchChain(env, ticker, date) {
  const sym = encodeURIComponent(ticker.replace('.', '-'));
  for (let attempt = 0; attempt < 2; attempt++) {
    const { crumb, cookie } = await getCrumb(env, attempt > 0);
    const qs = `crumb=${encodeURIComponent(crumb)}${date ? `&date=${date}` : ''}`;
    const r = await fetchWithTimeout(`https://query2.finance.yahoo.com/v7/finance/options/${sym}?${qs}`, { headers: { ...YAHOO_HEADERS, Cookie: cookie } });
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) throw new Error(`Yahoo options HTTP ${r.status}`);
    return parseChain(await r.json());
  }
  throw new Error('Yahoo options unauthorized');
}

export async function optionChain(env, ticker, date = null) {
  const d = date && /^\d{9,11}$/.test(String(date)) ? String(date) : '';
  const res = await settle(cached(env, `opt:v1:${ticker}:${d || 'next'}`, 300, () => fetchChain(env, ticker, d)));
  if (res.ok && res.value.price != null) return { ...res.value, chain: true };
  // Price only fallback
  const c = await settle(chart(env, ticker, '5d'));
  if (!c.ok) throw new Error('Could not find a price for that ticker.');
  return {
    symbol: ticker,
    name: c.value.meta.name || '',
    price: c.value.meta.price ?? c.value.bars[c.value.bars.length - 1].c,
    dividendYield: null,
    expirations: [],
    expiration: null,
    calls: [],
    puts: [],
    chain: false,
    chainError: res.ok ? 'No option chain' : res.error,
  };
}
