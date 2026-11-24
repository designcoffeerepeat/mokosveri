// Valuation, earnings and trading figures for watchlist columns: one batched
// Yahoo quote call for every ticker not in the 30 minute D1 cache.
import { fetchWithTimeout, BROWSER_UA, settle, yahooSymbol } from '../util.js';
import { getCrumb } from './yahoo.js';

const TTL = 30 * 60e3;
const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };
const FIELDS = [
  'regularMarketPrice,marketCap,trailingPE,forwardPE,priceToBook,averageAnalystRating',
  'epsTrailingTwelveMonths,epsForward,earningsTimestamp,earningsTimestampStart,earningsTimestampEnd,isEarningsDateEstimate',
  'dividendRate,dividendYield,trailingAnnualDividendYield,exDividendDate',
  'regularMarketVolume,averageDailyVolume3Month,fiftyTwoWeekHigh,fiftyTwoWeekLow',
].join(',');

const num = (v) => (typeof v === 'number' && isFinite(v) ? v : v && typeof v === 'object' && typeof v.raw === 'number' ? v.raw : null);
const pos = (v) => (num(v) != null && num(v) > 0 ? num(v) : null);

// Next earnings date (ms) from the Yahoo timestamps: the earliest one that is
// today or later. Yahoo keeps the last report in earningsTimestamp until the
// next date is set, so a past-only answer means "not announced".
export function nextEarnings(q, now = Date.now()) {
  const from = now - 18 * 3600e3; // keep today's report visible all day
  const ts = [q.earningsTimestamp, q.earningsTimestampStart, q.earningsTimestampEnd].map(num).filter((t) => t && t * 1000 >= from);
  if (!ts.length) return null;
  return { at: Math.min(...ts) * 1000, estimate: !!q.isEarningsDateEstimate };
}

// Dividend yield in percent. Yahoo's dividendYield is already a percent,
// trailingAnnualDividendYield is a fraction.
export function dividendYieldPct(q) {
  const price = pos(q.regularMarketPrice);
  if (pos(q.dividendRate) && price) return (q.dividendRate / price) * 100;
  if (pos(q.dividendYield) != null) return num(q.dividendYield);
  if (pos(q.trailingAnnualDividendYield) != null) return num(q.trailingAnnualDividendYield) * 100;
  return null;
}

// "2.1 - Buy" -> { score: 2.1, label: 'Buy' }
export function parseRating(s) {
  const m = typeof s === 'string' && s.match(/^\s*([\d.]+)\s*-\s*(.+?)\s*$/);
  return m && isFinite(+m[1]) ? { score: +m[1], label: m[2] } : null;
}

// The fields a watchlist row needs from one Yahoo quote.
export function statsFrom(q, now = Date.now()) {
  const earn = nextEarnings(q, now);
  const rating = parseRating(q.averageAnalystRating);
  const vol = num(q.regularMarketVolume);
  const avg = pos(q.averageDailyVolume3Month);
  const exDiv = num(q.exDividendDate);
  return {
    mcap: pos(q.marketCap),
    pe: pos(q.trailingPE),
    fwdPe: pos(q.forwardPE),
    pb: pos(q.priceToBook),
    rating: rating ? rating.score : null,
    ratingLabel: rating ? rating.label : null,
    earnings: earn ? earn.at : null,
    earningsEst: earn ? earn.estimate : false,
    eps: num(q.epsTrailingTwelveMonths),
    fwdEps: num(q.epsForward),
    divYield: dividendYieldPct(q),
    exDiv: exDiv ? exDiv * 1000 : null,
    volume: vol,
    avgVolume: avg,
    relVolume: vol != null && avg ? vol / avg : null,
    hi52: pos(q.fiftyTwoWeekHigh),
    lo52: pos(q.fiftyTwoWeekLow),
  };
}

async function batch(env, tickers) {
  const bySym = new Map(tickers.map((t) => [yahooSymbol(t), t]));
  const syms = [...bySym.keys()].map(encodeURIComponent).join(',');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { crumb, cookie } = await getCrumb(env, attempt > 0);
    const r = await fetchWithTimeout(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=${FIELDS}&crumb=${encodeURIComponent(crumb)}`, { headers: { ...H, Cookie: cookie } }, 7000);
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status}`);
    const d = await r.json();
    const out = new Map();
    for (const q of (d.quoteResponse && d.quoteResponse.result) || []) {
      const t = bySym.get(q.symbol);
      if (t) out.set(t, statsFrom(q));
    }
    return out;
  }
  throw new Error('Yahoo quote unauthorized');
}

// Returns Map ticker -> stats. Tickers Yahoo does not know are cached as {}
// so they are not asked for again on every load.
export async function quoteStats(env, tickers) {
  const out = new Map();
  if (!tickers.length) return out;
  const now = Date.now();
  const keys = tickers.map((t) => `qstat:${t}`);
  try {
    const r = await env.DB.prepare(`SELECT k, v FROM cache WHERE exp > ? AND k IN (${keys.map(() => '?').join(',')})`).bind(now, ...keys).all();
    for (const row of r.results || []) out.set(row.k.slice(6), JSON.parse(row.v));
  } catch {}
  const miss = tickers.filter((t) => !out.has(t));
  if (!miss.length) return out;
  const b = await settle(batch(env, miss));
  if (!b.ok) return out;
  const writes = [];
  for (const t of miss) {
    const s = b.value.get(t) || {};
    out.set(t, s);
    writes.push(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(`qstat:${t}`, JSON.stringify(s), now + TTL));
  }
  if (writes.length) await settle(env.DB.batch(writes));
  return out;
}
