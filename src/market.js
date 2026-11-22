// Market sentiment page: gathers gauges, prediction markets and 13F moves,
// then builds a transparent composite from -100 (very bearish) to +100 (very bullish).
import { clamp, settle, cached } from './util.js';
import { fearGreed, aaii, volatility, spTrend, yieldCurve, polymarket, kalshi, insiderBreadth } from './sources/gauges.js';
import { allInvestors } from './sources/thirteenf.js';

export const BANDS = [
  [60, 'Very bullish'],
  [20, 'Bullish'],
  [-20, 'Neutral'],
  [-60, 'Bearish'],
  [-101, 'Very bearish'],
];
export const labelFor = (s) => BANDS.find(([min]) => s >= min)[1];

const r1 = (x, d = 1) => (x == null || !Number.isFinite(x) ? null : Number(x.toFixed(d)));

// Each scorer turns raw readings into a score in [-1, 1] with a plain reading.
// Weights say how much each component counts; missing components drop out
// and the rest are re-weighted.
export const COMPONENTS = [
  {
    id: 'trend',
    name: 'S&P 500 trend',
    group: 'Price action',
    weight: 1.25,
    source: 'Yahoo Finance',
    how: 'Distance of the S&P 500 from its 200 day average. +8% or more scores fully bullish, -8% or less fully bearish.',
    score: (d) => clamp(d.dist200 / 8),
    value: (d) => `${d.dist200 >= 0 ? '+' : ''}${r1(d.dist200)}% vs 200 day avg, ${d.ret1m >= 0 ? '+' : ''}${r1(d.ret1m)}% in 1 month`,
  },
  {
    id: 'fearGreed',
    name: 'CNN Fear and Greed',
    group: 'Crowd mood',
    weight: 1,
    source: 'CNN Business',
    url: 'https://www.cnn.com/markets/fear-and-greed',
    how: 'Index from 0 (extreme fear) to 100 (extreme greed), rescaled so 50 is neutral.',
    score: (d) => clamp((d.score - 50) / 50),
    value: (d) => `${Math.round(d.score)} (${d.rating || 'n/a'})${d.weekAgo != null ? `, ${Math.round(d.weekAgo)} a week ago` : ''}`,
  },
  {
    id: 'putCall',
    name: 'Put/call ratio',
    group: 'Crowd mood',
    weight: 0.5,
    source: 'CNN Business (CBOE data)',
    url: 'https://www.cnn.com/markets/fear-and-greed',
    how: '5 day average of puts vs calls bought. Below 0.85 leans bullish, above leans bearish; 0.65 or 1.05 score fully.',
    errKey: 'fearGreed',
    pick: (all) => (all.fearGreed && all.fearGreed.putCall != null ? all.fearGreed : null),
    score: (d) => clamp((0.85 - d.putCall) / 0.2),
    value: (d) => `${d.putCall.toFixed(2)}${d.putCallRating ? ` (${d.putCallRating})` : ''}`,
  },
  {
    id: 'aaii',
    name: 'AAII investor survey',
    group: 'Crowd mood',
    weight: 0.75,
    source: 'AAII',
    url: 'https://www.aaii.com/sentimentsurvey',
    how: 'Weekly bullish minus bearish percentage of individual investors. A spread of +30 points scores fully bullish.',
    score: (d) => clamp((d.bullish - d.bearish) / 30),
    value: (d) => `${r1(d.bullish)}% bullish, ${r1(d.bearish)}% bearish (week of ${d.week})`,
  },
  {
    id: 'vix',
    name: 'VIX level',
    group: 'Volatility',
    weight: 1,
    source: 'Yahoo Finance (CBOE)',
    how: 'Expected S&P 500 volatility. 20 is neutral; 10 scores fully bullish and 30 fully bearish.',
    score: (d) => clamp((20 - d.vix) / 10),
    value: (d) => `${r1(d.vix)}${d.avg50 ? ` (50 day avg ${r1(d.avg50)})` : ''}`,
  },
  {
    id: 'vixTerm',
    name: 'VIX term structure',
    group: 'Volatility',
    weight: 0.75,
    source: 'Yahoo Finance (CBOE)',
    how: 'VIX divided by 3 month VIX. Under 0.95 means calm markets (bullish); above 1 means near term stress (bearish).',
    errKey: 'vix',
    pick: (all) => (all.vix && all.vix.ratio != null ? all.vix : null),
    score: (d) => clamp((0.95 - d.ratio) / 0.1),
    value: (d) => `${d.ratio.toFixed(2)} (VIX ${r1(d.vix)} vs VIX3M ${r1(d.vix3m)})`,
  },
  {
    id: 'curve',
    name: 'Yield curve',
    group: 'Macro',
    weight: 0.5,
    source: 'Yahoo Finance (Treasury yields)',
    how: '10 year minus 3 month Treasury yield. Inverted (negative) has often preceded recessions. +1 point scores fully bullish.',
    score: (d) => clamp(d.spread / 1),
    value: (d) => `${d.spread >= 0 ? '+' : ''}${d.spread.toFixed(2)} pts (10y ${d.y10.toFixed(2)}%, 3m ${d.y3m.toFixed(2)}%)`,
  },
  {
    id: 'recession',
    name: 'Recession odds',
    group: 'Forecasters',
    weight: 1,
    source: 'Polymarket and Kalshi',
    how: 'Average market implied chance of a US recession. 25% is neutral; 0% scores fully bullish and 50% fully bearish.',
    score: (d) => clamp((0.25 - d.prob) / 0.25),
    value: (d) => `${Math.round(d.prob * 100)}% implied (${d.markets.map((m) => m.source).join(' and ')})`,
  },
  {
    id: 'insiders',
    name: 'Corporate insiders',
    group: 'Smart money',
    weight: 0.75,
    source: 'SEC Form 4 (this site)',
    how: 'Share of insiders buying vs selling (planned sales excluded) over 30 days. 25% buyers is typical; 40% scores fully bullish, 10% fully bearish.',
    score: (d) => clamp((d.ratio - 0.25) / 0.15),
    value: (d) => `${d.buys} buyers vs ${d.sells} sellers (${Math.round(d.ratio * 100)}% buying)`,
  },
  {
    id: 'funds',
    name: 'Famous investors (13F)',
    group: 'Smart money',
    weight: 1,
    source: 'SEC Form 13F',
    how: 'Average stance of the investors below, from net buying and put vs call hedges in their latest quarterly filing. Stale filings count less.',
    score: (d) => clamp(d.stance),
    value: (d) => `${d.bullish} net buyers, ${d.bearish} net sellers or hedged, of ${d.count} with recent filings`,
  },
];

export function aggregateFunds(investors) {
  let w = 0;
  let s = 0;
  let bullish = 0;
  let bearish = 0;
  let count = 0;
  for (const i of investors) {
    if (!i.weight || i.stance == null) continue;
    w += i.weight;
    s += i.weight * i.stance;
    count++;
    if (i.stance > 0.1) bullish++;
    else if (i.stance < -0.1) bearish++;
  }
  if (!w) return null;
  return { stance: s / w, bullish, bearish, count };
}

export function recessionOdds(markets) {
  const rec = (markets || []).filter((m) => m.recession && m.prob >= 0 && m.prob <= 1);
  if (!rec.length) return null;
  // One market per source: the most traded.
  const bySrc = new Map();
  for (const m of rec) if (!bySrc.has(m.source) || m.volume > bySrc.get(m.source).volume) bySrc.set(m.source, m);
  const ms = [...bySrc.values()];
  return { prob: ms.reduce((s, m) => s + m.prob, 0) / ms.length, markets: ms };
}

// Pure: raw readings in, scored composite out.
export function composite(all, errors = {}) {
  const rows = [];
  let wsum = 0;
  for (const c of COMPONENTS) {
    const d = c.pick ? c.pick(all) : all[c.id];
    let score = null;
    let value = null;
    if (d) {
      try {
        score = c.score(d);
        value = c.value(d);
        if (!Number.isFinite(score)) score = null;
      } catch {
        score = null;
      }
    }
    const ok = score !== null;
    if (ok) wsum += c.weight;
    rows.push({ id: c.id, name: c.name, group: c.group, weight: c.weight, source: c.source, url: c.url || null, how: c.how, available: ok, score: ok ? r1(score * 100, 0) : null, value, error: ok ? null : errors[c.errKey || c.id] || 'No data' });
  }
  let total = 0;
  for (const r of rows) {
    if (!r.available) continue;
    r.share = r1((r.weight / wsum) * 100, 0);
    r.contribution = r1((r.weight / wsum) * r.score, 1);
    total += (r.weight / wsum) * r.score;
  }
  const used = rows.filter((r) => r.available).length;
  const score = used ? Math.round(total) : null;
  return {
    score,
    label: score == null ? 'Not enough data' : labelFor(score),
    used,
    of: rows.length,
    confidence: used >= 7 ? 'High' : used >= 4 ? 'Medium' : 'Low',
    components: rows,
  };
}

// Readings that hit extremes are worth flagging: crowds tend to be most
// bullish near tops and most bearish near bottoms.
export function extremes(all) {
  const out = [];
  if (all.fearGreed) {
    if (all.fearGreed.score <= 25) out.push('Fear and Greed shows extreme fear. Historically that has often been closer to a bottom than a top.');
    if (all.fearGreed.score >= 75) out.push('Fear and Greed shows extreme greed. Historically that has often been closer to a top than a bottom.');
  }
  if (all.aaii) {
    const s = all.aaii.bullish - all.aaii.bearish;
    if (s <= -20) out.push('AAII bears outnumber bulls by a wide margin, a reading contrarians treat as a possible buy signal.');
    if (s >= 25) out.push('AAII bulls outnumber bears by a wide margin, a reading contrarians treat as a warning.');
  }
  if (all.vix && all.vix.vix >= 30) out.push('VIX above 30 signals panic. Sharp rebounds often start from these levels, but so do further drops.');
  return out;
}

// Sources asked for that have no free, reliable feed. Shown so the page is honest about gaps.
export const NOT_AVAILABLE = [
  { name: 'Good Judgment superforecasts', reason: 'Published on a subscription dashboard with no free API.' },
  { name: 'Metaculus', reason: 'Its API now needs an account token, and it has few live market direction questions.' },
  { name: 'Bank and institutional outlooks', reason: 'Year ahead S&P targets from banks are in PDFs and press coverage, not a feed. Not scored.' },
];

const pad = (p) => settle(p);

export async function buildSentiment(env) {
  const gauges = await cached(env, 'mkt:gauges:v1', 900, async () => {
    const [fg, aa, vx, tr, yc, pm, ks, ins] = await Promise.all([fearGreed(), aaii(), volatility(env), spTrend(env), yieldCurve(env), polymarket(), kalshi(env), insiderBreadth(env)].map(pad));
    const v = (r) => (r.ok ? r.value : null);
    const errors = {};
    [['fearGreed', fg], ['aaii', aa], ['vix', vx], ['trend', tr], ['curve', yc], ['polymarket', pm], ['kalshi', ks], ['insiders', ins]].forEach(([k, r]) => {
      if (!r.ok) errors[k] = r.error;
    });
    return { fearGreed: v(fg), aaii: v(aa), vix: v(vx), trend: v(tr), curve: v(yc), markets: [...(v(pm) || []), ...(v(ks) || [])], errors, asOf: new Date().toISOString() };
  });
  const investors = await allInvestors(env, Number(env.F13_PER_REQUEST || 3));
  const all = { ...gauges, recession: recessionOdds(gauges.markets), funds: aggregateFunds(investors) };
  const errors = { ...gauges.errors };
  if (!all.recession) errors.recession = [errors.polymarket, errors.kalshi].filter(Boolean).join('; ') || 'No open recession markets found';
  if (!all.funds) errors.funds = 'No recent 13F filings loaded yet';
  const rating = composite(all, errors);
  return {
    asOf: gauges.asOf,
    rating,
    extremes: extremes(all),
    trendSeries: gauges.trend ? gauges.trend.series : null,
    vixSeries: gauges.vix ? gauges.vix.series : null,
    markets: gauges.markets.slice(0, 10),
    investors: investors.map((i) => ({
      id: i.id,
      person: i.person,
      fund: i.fund,
      style: i.style,
      period: i.period || null,
      filed: i.filed || null,
      url: i.url || `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${i.cik}&type=13F-HR`,
      stance: i.stance != null ? Math.round(i.stance * 100) : null,
      flowPct: i.flowPct != null ? r1(i.flowPct) : null,
      hedgePct: i.hedgePct != null ? r1(i.hedgePct) : null,
      totals: i.totals || null,
      moves: i.moves || [],
      top: i.top || [],
      weight: r1(i.weight, 2),
      pending: i.pending,
      error: i.error,
    })),
    notAvailable: NOT_AVAILABLE,
  };
}
