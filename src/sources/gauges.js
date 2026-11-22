// Broad market sentiment gauges from free public endpoints. Each function
// returns raw readings only; scoring lives in src/market.js.
import { getJSON, getText, BROWSER_UA, num } from '../util.js';
import { chart } from './yahoo.js';

const BH = { 'User-Agent': BROWSER_UA, Accept: 'application/json, text/plain, */*' };

// CNN Fear and Greed index (0 to 100) and its put/call sub gauge.
export async function fearGreed() {
  const d = await getJSON('https://production.dataviz.cnn.io/index/fearandgreed/graphdata', {
    headers: { ...BH, Referer: 'https://www.cnn.com/', Origin: 'https://www.cnn.com' },
  });
  const fg = d.fear_and_greed || {};
  const score = num(fg.score);
  if (score == null) throw new Error('Fear and Greed score missing');
  const pc = d.put_call_options || {};
  const pcData = Array.isArray(pc.data) ? pc.data : [];
  const last = pcData.length ? num(pcData[pcData.length - 1].y) : null;
  return {
    score,
    rating: fg.rating || '',
    weekAgo: num(fg.previous_1_week),
    monthAgo: num(fg.previous_1_month),
    asOf: fg.timestamp || null,
    putCall: last,
    putCallRating: pc.rating || '',
  };
}

// AAII weekly investor sentiment survey. The site sometimes blocks bots, in
// which case this throws and the component shows as unavailable.
export function parseAaii(html) {
  const re = /<td[^>]*>\s*([A-Z][a-z]{2,9}\.? \d{1,2})[^<]*<\/td>\s*<td[^>]*>\s*([\d.]+)%\s*<\/td>\s*<td[^>]*>\s*([\d.]+)%\s*<\/td>\s*<td[^>]*>\s*([\d.]+)%/;
  const m = html.match(re);
  if (!m) return null;
  return { week: m[1], bullish: num(m[2]), neutral: num(m[3]), bearish: num(m[4]) };
}
export async function aaii() {
  const html = await getText('https://www.aaii.com/sentimentsurvey/sent_results', { headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html' } });
  const r = parseAaii(html);
  if (!r) throw new Error('AAII table not found (page may be blocking automated requests)');
  return r;
}

const closes = (c) => c.bars.map((b) => b.c);
const sma = (a, n) => (a.length >= n ? a.slice(-n).reduce((s, x) => s + x, 0) / n : null);

// VIX level and term structure (VIX vs 3 month VIX).
export async function volatility(env) {
  const [v, v3] = await Promise.all([chart(env, 'VIX', '6mo'), chart(env, '^VIX3M', '6mo').catch(() => null)]);
  const vc = closes(v);
  const vix = vc[vc.length - 1];
  const vix3m = v3 ? closes(v3).at(-1) : null;
  return { vix, vix3m, ratio: vix3m ? vix / vix3m : null, avg50: sma(vc, 50), series: vc.slice(-60) };
}

// S&P 500 trend: distance from 200 day average and one month return.
export async function spTrend(env) {
  const c = closes(await chart(env, 'SPX', '1y'));
  const last = c[c.length - 1];
  const ma200 = sma(c, 200);
  const m1 = c.length > 21 ? c[c.length - 22] : null;
  return {
    last,
    ma200,
    dist200: ma200 ? (last / ma200 - 1) * 100 : null,
    ret1m: m1 ? (last / m1 - 1) * 100 : null,
    series: c.slice(-120),
  };
}

// 10 year minus 3 month Treasury yield. Inverted curves have preceded recessions.
export async function yieldCurve(env) {
  const [t10, t3m] = await Promise.all([chart(env, 'TNX', '1mo'), chart(env, 'IRX', '1mo')]);
  const a = closes(t10).at(-1);
  const b = closes(t3m).at(-1);
  return { y10: a, y3m: b, spread: a - b };
}

// Polymarket: open markets on recession and other macro questions.
const MACRO = /recession|s&p 500|s&p500|\bspx\b|fed (rate )?cut|rate cut|interest rate|inflation|\bcpi\b|stock market|nasdaq|bear market|gdp/i;
const parseArr = (s) => {
  try {
    return Array.isArray(s) ? s : JSON.parse(s || '[]');
  } catch {
    return [];
  }
};
export function pickPolymarket(markets) {
  const out = [];
  for (const m of markets || []) {
    if (!m || !m.question || !MACRO.test(m.question)) continue;
    const outcomes = parseArr(m.outcomes);
    const prices = parseArr(m.outcomePrices).map(Number);
    const yi = outcomes.findIndex((o) => /^yes$/i.test(o));
    if (yi < 0 || !Number.isFinite(prices[yi])) continue;
    out.push({
      source: 'Polymarket',
      question: m.question,
      prob: prices[yi],
      volume: num(m.volumeNum ?? m.volume) || 0,
      ends: m.endDate || m.endDateIso || null,
      url: m.slug ? `https://polymarket.com/market/${m.slug}` : 'https://polymarket.com',
      recession: /recession/i.test(m.question) && !/(not|avoid)/i.test(m.question),
    });
  }
  return out.sort((a, b) => b.volume - a.volume);
}
export async function polymarket() {
  const d = await getJSON('https://gamma-api.polymarket.com/markets?closed=false&active=true&limit=500&order=volume24hr&ascending=false', { headers: BH });
  return pickPolymarket(Array.isArray(d) ? d : d.data || d.markets || []);
}

// Kalshi: the NBER recession series. Prices are in cents (or dollars on newer fields).
export function pickKalshi(d) {
  const out = [];
  for (const m of (d && d.markets) || []) {
    let p = num(m.last_price_dollars);
    if (p == null && num(m.last_price) != null) p = num(m.last_price) / 100;
    const bid = num(m.yes_bid_dollars) ?? (num(m.yes_bid) != null ? num(m.yes_bid) / 100 : null);
    const ask = num(m.yes_ask_dollars) ?? (num(m.yes_ask) != null ? num(m.yes_ask) / 100 : null);
    if ((p == null || p === 0) && bid != null && ask != null && ask > 0) p = (bid + ask) / 2;
    if (p == null) continue;
    out.push({
      source: 'Kalshi',
      question: m.title || m.ticker,
      prob: p,
      volume: num(m.volume) || 0,
      ends: m.close_time || null,
      url: `https://kalshi.com/markets/${String(m.event_ticker || m.ticker || '').toLowerCase()}`,
      recession: true,
    });
  }
  return out.sort((a, b) => b.volume - a.volume);
}
export async function kalshi(env) {
  const series = (env.KALSHI_RECESSION_SERIES || 'KXRECSSNBER').split(',').map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const s of series) {
    const d = await getJSON(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${encodeURIComponent(s)}&status=open&limit=20`, { headers: BH });
    out.push(...pickKalshi(d));
  }
  if (!out.length) throw new Error('No open Kalshi recession markets');
  return out;
}

// Corporate insiders across the market, from the Form 4 rows this site already
// ingests: distinct people buying vs selling in the open market (plan sales excluded).
export async function insiderBreadth(env, days = 30) {
  if (!env.DB) throw new Error('No database');
  const since = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
  const r = await env.DB.prepare(
    "SELECT SUM(CASE WHEN code='P' THEN 1 ELSE 0 END) AS buys, SUM(CASE WHEN code='S' AND plan_10b5=0 THEN 1 ELSE 0 END) AS sells FROM (SELECT DISTINCT owner_cik, issuer_cik, code, plan_10b5 FROM insider_tx WHERE filed_date >= ? AND code IN ('P','S'))"
  )
    .bind(since)
    .first();
  const buys = Number((r && r.buys) || 0);
  const sells = Number((r && r.sells) || 0);
  if (buys + sells < 20) throw new Error('Not enough insider filings ingested yet');
  return { buys, sells, ratio: buys / (buys + sells), days };
}
