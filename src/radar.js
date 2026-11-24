// Under the radar picks (/api/radar): small and mid caps where insiders,
// members of Congress or a quietly growing crowd are buying in, but the price
// has not moved yet. Every name gets a breakout score from 0 to 99, a one line
// thesis, a breakout trigger, a target and the level where the setup fails.
//
// Pipeline (kept inside the Workers subrequest budget):
//   1. Candidates from open market insider buys, congressional buys, Reddit
//      names whose mentions are climbing from a low base, and StockTwits.
//   2. One batched Yahoo quote call to drop large caps, ETFs, illiquid names
//      and penny stocks, and to size insider buys against market cap.
//   3. Price history for the best ~22, technicals, and the "already ran"
//      filter (up 20% or more over 1 or 3 months is out).
//   4. Headlines for the top few, then the final ranking.
import { settle, pool, cleanTicker, clamp, daysBetween, fetchWithTimeout, BROWSER_UA, yahooSymbol } from './util.js';
import { chart, getCrumb, news } from './sources/yahoo.js';
import { apeWisdom, stocktwitsTrending, headlineSentiment } from './sources/social.js';
import { congressRecent } from './sources/congress.js';
import { mergedInsiderBuys } from './buzz.js';
import { computeTechnicals, sma } from './analysis/technicals.js';

export const RADAR_KEY = 'radar:v1';
export const RADAR_FRESH_MS = 45 * 60e3;
export const RADAR_STALE_MS = 12 * 3600e3;

export const LIMITS = {
  minCap: 30e6, // below this the data is too thin to trust
  maxCap: 15e9, // above this a name is not under the radar
  minPrice: 1,
  minDollarVol: 250e3, // average daily dollar volume
  maxRun: 20, // percent; up this much over 1 or 3 months means it already ran
  maxRun5d: 15,
  crowdedRank: 15, // Reddit top 15 is the opposite of under the radar
  charts: 20,
  newsFor: 6,
};

const SKIP = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'USD', 'CEO', 'DD', 'YOLO', 'ATH', 'IPO', 'ETF', 'AI', 'GDP', 'FOMC', 'IT', 'ALL', 'ON', 'FOR', 'ARE', 'NOW', 'BIG', 'OPEN']);
const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };

export const fmtMoney = (v) => {
  if (v == null || !Number.isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};

// ---------- 1. candidates ----------

// Merge every source into one map of ticker -> raw signals.
export function gatherCandidates({ insiders = [], congress = [], ape = [], st = [] }) {
  const map = new Map();
  const get = (t) => {
    t = cleanTicker(t);
    if (!t || SKIP.has(t) || t.startsWith('^') || /[^A-Z.\-]/.test(t)) return null;
    if (!map.has(t)) map.set(t, { ticker: t, name: '', insider: null, congress: { buys: [], sells: [] }, ape: null, st: false });
    return map.get(t);
  };
  for (const r of insiders) {
    const c = get(r.ticker);
    if (!c) continue;
    c.insider = r;
    if (!c.name && r.issuer) c.name = r.issuer;
  }
  for (const r of congress) {
    if (r.type !== 'buy' && r.type !== 'sell') continue;
    const c = r.type === 'buy' ? get(r.ticker) : map.get(cleanTicker(r.ticker));
    if (!c) continue;
    (r.type === 'buy' ? c.congress.buys : c.congress.sells).push(r);
  }
  // Reddit: skip the crowded top, keep names whose mentions are rising from a low base.
  const apeBy = new Map(ape.map((r) => [r.ticker, r]));
  for (const r of ape) {
    if (r.rank > LIMITS.crowdedRank && r.mentions >= 4 && r.mentions >= 1.6 * Math.max(r.mentions24hAgo, 1)) {
      const c = get(r.ticker);
      if (c && !c.name) c.name = r.name || '';
    }
  }
  const stSet = new Set(st.map((r) => r.ticker));
  for (const r of st) {
    const c = get(r.ticker);
    if (c && !c.name) c.name = r.name || '';
  }
  // Tag the social side for every candidate, wherever it came from.
  for (const c of map.values()) {
    c.ape = apeBy.get(c.ticker) || null;
    c.st = stSet.has(c.ticker);
  }
  return map;
}

// ---------- 2. quote screen ----------

const QUOTE_FIELDS = 'regularMarketPrice,marketCap,averageDailyVolume3Month,averageDailyVolume10Day,fiftyDayAverage,twoHundredDayAverage,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,quoteType,fullExchangeName,sharesOutstanding';

export async function quoteBatch(env, tickers) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 50) chunks.push(tickers.slice(i, i + 50));
  for (const c of chunks) {
    const bySym = new Map(c.map((t) => [yahooSymbol(t), t]));
    const syms = [...bySym.keys()].map(encodeURIComponent).join(',');
    let done = false;
    for (let attempt = 0; attempt < 2 && !done; attempt++) {
      const { crumb, cookie } = await getCrumb(env, attempt > 0);
      const r = await fetchWithTimeout(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=${QUOTE_FIELDS}&crumb=${encodeURIComponent(crumb)}`, { headers: { ...H, Cookie: cookie } }, 8000);
      if (r.status === 401 || r.status === 403) continue;
      if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status}`);
      const d = await r.json();
      for (const q of (d.quoteResponse && d.quoteResponse.result) || []) {
        const t = bySym.get(q.symbol);
        if (t) out.set(t, q);
      }
      done = true;
    }
    if (!done) throw new Error('Yahoo quote unauthorized');
  }
  return out;
}

// Why a quote rules a name out, or null when it passes.
export function screenOut(q) {
  if (!q) return null; // no quote: let the chart decide
  if (q.quoteType && q.quoteType !== 'EQUITY') return 'not a stock';
  const px = q.regularMarketPrice;
  if (px != null && px < LIMITS.minPrice) return 'under $1';
  if (q.marketCap != null && q.marketCap > LIMITS.maxCap) return 'large cap';
  if (q.marketCap != null && q.marketCap < LIMITS.minCap) return 'too small';
  const dv = (q.averageDailyVolume3Month || 0) * (px || 0);
  if (px != null && q.averageDailyVolume3Month != null && dv < LIMITS.minDollarVol) return 'too thinly traded';
  return null;
}

// ---------- scoring pieces (each returns points and plain language reasons) ----------

const isCSuiteText = (s) => /CEO|Chief Exec|CFO|Chief Fin|Pres|Chair|COO/i.test(s || '');

export function insiderPoints(ins, cap) {
  if (!ins) return { pts: 0, why: [] };
  const buyers = ins.buyers || 1;
  const val = ins.total_value || 0;
  let pts = 10 + (buyers >= 4 ? 12 : buyers === 3 ? 10 : buyers === 2 ? 5 : 0);
  const cs = (ins.csuite || 0) > 0 || isCSuiteText(ins.owners) ? 1 : 0;
  if (cs) pts += 6;
  let pctCap = null;
  if (cap && val) {
    pctCap = (val / cap) * 100;
    // 0.01% of the company earns nothing extra, 1% or more earns the full 7.
    pts += 7 * clamp(Math.log10(Math.max(pctCap, 1e-6) / 0.01) / 2, 0, 1);
  } else pts += 3.5 * clamp(Math.log10(Math.max(val, 1) / 1e5), 0, 2) / 2;
  const fresh = ins.last_date && daysBetween(ins.last_date) <= 10;
  if (fresh) pts += 3;
  const who = cs ? (buyers > 1 ? ', including a top executive' : ' (a top executive)') : '';
  const why = [`${buyers} insider${buyers > 1 ? 's' : ''} bought ${fmtMoney(val)} on the open market${who}${pctCap != null && pctCap >= 0.05 ? `, about ${pctCap >= 1 ? pctCap.toFixed(1) : pctCap.toFixed(2)}% of the company` : ''}`];
  if (buyers >= 3) why.push('Cluster buy: 3 or more insiders in the same month');
  return { pts: Math.min(pts, 35), why, pctCap, cluster: buyers >= 3, csuite: !!cs };
}

export function congressPoints(cg) {
  const buys = cg ? cg.buys : [];
  const sells = cg ? cg.sells : [];
  if (!buys.length && !sells.length) return { pts: 0, why: [] };
  const members = [...new Set(buys.map((b) => b.member).filter(Boolean))];
  let pts = Math.min(buys.length * 5, 12) + (buys.some((b) => (b.amountMin || 0) >= 50000) ? 3 : 0) - sells.length * 4;
  const why = [];
  if (buys.length) why.push(`${buys.length} congressional purchase${buys.length > 1 ? 's' : ''}${members.length ? ` (${members.slice(0, 2).join(', ')})` : ''}`);
  if (sells.length) why.push(`${sells.length} congressional sale${sells.length > 1 ? 's' : ''}`);
  return { pts: clamp(pts, -8, 15), why, buyers: members.length || buys.length };
}

export function socialPoints(ape, st) {
  let pts = 0;
  const why = [];
  if (ape && ape.mentions >= 3) {
    const growth = (ape.mentions + 1) / (Math.max(ape.mentions24hAgo, 0) + 1);
    if (growth >= 1.5) {
      pts += Math.min(8, 3 * Math.log2(growth));
      why.push(`Reddit mentions up ${growth >= 10 ? `${Math.round(growth)}x` : `${Math.round((growth - 1) * 100)}%`} in 24 hours (${ape.mentions} now, rank #${ape.rank})`);
    } else if (ape.rank <= 60) {
      pts += 2;
      why.push(`Steady Reddit chatter (rank #${ape.rank})`);
    }
    if (ape.rank24hAgo && ape.rank24hAgo - ape.rank >= 25) pts += 2;
  }
  if (st) {
    pts += 5;
    why.push('Trending on StockTwits');
  }
  return { pts: Math.min(pts, 15), why };
}

// Breakout geometry from daily bars: the base the stock is sitting in.
export function baseInfo(bars) {
  if (!bars || bars.length < 60) return null;
  const last = bars[bars.length - 1].c;
  const prior = bars.slice(-61, -1); // the 60 sessions before today
  const pivot = Math.max(...prior.map((b) => b.h));
  const floor = Math.min(...prior.map((b) => b.l));
  const near = bars.slice(-21, -1); // the last 20 sessions before today
  const pivot20 = Math.max(...near.map((b) => b.h));
  const floor20 = Math.min(...near.map((b) => b.l));
  const r20 = bars.slice(-20);
  const range20 = (Math.max(...r20.map((b) => b.h)) - Math.min(...r20.map((b) => b.l))) / last;
  const rets = [];
  const c = bars.map((b) => b.c);
  for (let i = 1; i < c.length; i++) rets.push(Math.log(c[i] / c[i - 1]));
  const sd = (a) => {
    if (a.length < 5) return null;
    const m = a.reduce((x, y) => x + y, 0) / a.length;
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / a.length);
  };
  const v20 = sd(rets.slice(-20));
  const v100 = sd(rets.slice(-120, -20));
  const sma50Prev = c.length >= 60 ? sma(c.slice(0, -10), 50) : null;
  const sma50Now = sma(c, 50);
  return {
    pivot,
    floor,
    pivot20,
    floor20,
    toPivot: (pivot / last - 1) * 100, // % still to go to the 60 day high (negative = already above)
    range20: range20 * 100,
    squeeze: v20 && v100 ? v20 / v100 : null,
    sma50Rising: sma50Prev && sma50Now ? sma50Now > sma50Prev : null,
  };
}

export function setupPoints(t, base) {
  if (!t) return { pts: 0, why: [] };
  let pts = 0;
  const why = [];
  if (base) {
    if (base.toPivot <= 0 && base.toPivot > -4) {
      pts += 7;
      why.push(`Pushing through its 60 day high of ${base.pivot.toFixed(2)} right now`);
    } else if (base.toPivot > 0 && base.toPivot <= 8) {
      pts += 9;
      why.push(`Sitting ${base.toPivot.toFixed(1)}% under its 60 day high (${base.pivot.toFixed(2)}), the breakout line`);
    } else if (base.toPivot > 8 && base.toPivot <= 15) pts += 4;
    if (base.range20 < 8) {
      pts += 7;
      why.push(`Coiled: the last 20 sessions traded in a tight ${base.range20.toFixed(1)}% range`);
    } else if (base.range20 < 13) pts += 4;
    if (base.squeeze != null && base.squeeze < 0.75) {
      pts += 4;
      why.push('Volatility has squeezed to well below its usual level, which tends to come before a big move');
    }
    if (base.sma50Rising) pts += 2;
  }
  if (t.sma50 && t.price > t.sma50) pts += 3;
  if (t.sma200 && t.price > t.sma200) pts += 2;
  if (t.goldenCross) pts += 1;
  if (t.obvTrend > 0.15 && Math.abs(t.ret1m || 0) < 10) {
    pts += 5;
    why.push('Quiet accumulation: buying volume is outpacing selling while the price stays flat');
  } else if (t.obvTrend > 0.15) pts += 2;
  if (t.relVolume5 != null && t.relVolume5 > 1.3) {
    pts += 3;
    why.push(`Volume picking up: the last 5 days averaged ${t.relVolume5.toFixed(1)}x normal`);
  }
  if (t.rsi14 != null) {
    if (t.rsi14 >= 45 && t.rsi14 <= 65) pts += 3;
    else if (t.rsi14 > 72) pts -= 5;
    else if (t.rsi14 < 32) {
      pts += 1;
      why.push(`Oversold (RSI ${t.rsi14.toFixed(0)}), set up for a snapback`);
    }
  }
  if (t.macdCross === 'bullish') {
    pts += 4;
    why.push('Fresh bullish MACD crossover');
  } else if (t.macdHist > 0) pts += 1;
  if (t.relStrength3m != null && t.relStrength3m > 0) pts += 2;
  if (t.sma200 && t.price < t.sma200 && t.fromHigh != null && t.fromHigh < -40) {
    pts -= 6;
    why.push(`Still ${Math.abs(t.fromHigh).toFixed(0)}% under its 52 week high and below the 200 day average`);
  }
  return { pts: clamp(pts, -10, 35), why };
}

export function radarPoints(q, ape) {
  let pts = 0;
  const cap = q && q.marketCap;
  if (cap != null) pts += cap < 2e9 ? 6 : cap < 6e9 ? 3 : 0;
  const mentions = ape ? ape.mentions : 0;
  pts += mentions < 25 ? 4 : mentions < 75 ? 2 : 0;
  return Math.min(pts, 10);
}

// Already ran: up 20%+ over 1 or 3 months, or 15%+ in a week.
export function alreadyRan(t) {
  if (!t) return null;
  if (t.ret1m != null && t.ret1m >= LIMITS.maxRun) return `up ${t.ret1m.toFixed(0)}% in a month`;
  if (t.ret3m != null && t.ret3m >= LIMITS.maxRun) return `up ${t.ret3m.toFixed(0)}% in 3 months`;
  if (t.ret5d != null && t.ret5d >= LIMITS.maxRun5d) return `up ${t.ret5d.toFixed(0)}% this week`;
  return null;
}

// Trigger, target and the line where the idea is wrong.
export function levels(t, base) {
  if (!t || !base) return null;
  const price = t.price;
  // A base more than 15% overhead is too far to call; use the nearer 20 day range.
  const far = base.toPivot > 15;
  const top = far ? base.pivot20 : base.pivot;
  const bottom = far ? base.floor20 : base.floor;
  const breaking = price >= top;
  const trigger = breaking ? price : top;
  const height = Math.max(top - bottom, price * 0.08);
  const target = Math.min(trigger + height, trigger * 1.35);
  const support = [bottom, t.sma50].filter((x) => x && x < price).sort((a, b) => b - a)[0] || bottom;
  return {
    trigger: +trigger.toFixed(2),
    target: +target.toFixed(2),
    upside: +((target / price - 1) * 100).toFixed(1),
    fails: +support.toFixed(2),
    breaking,
  };
}

export const conviction = (s) => (s >= 62 ? 'High' : s >= 46 ? 'Medium' : 'Speculative');

// One sentence best guess built from the strongest evidence.
export function thesis(p) {
  const bits = [];
  if (p.parts.insider.pts >= 15) bits.push(p.parts.insider.cluster ? 'a cluster of insiders is buying' : p.parts.insider.csuite ? 'management is buying its own stock' : 'insiders are buying');
  else if (p.parts.insider.pts > 0) bits.push('an insider bought shares');
  if (p.parts.congress.pts >= 5) bits.push(p.parts.congress.buyers > 1 ? 'members of Congress are buying' : 'a member of Congress is buying');
  if (p.parts.social.pts >= 5) bits.push('chatter is starting to build');
  const lead = bits.length ? bits.slice(0, 2).join(' and ') : 'the chart is quietly setting up';
  const ret3 = p.ret3m != null ? `${p.ret3m >= 0 ? 'up only' : 'down'} ${Math.abs(p.ret3m).toFixed(0)}% over 3 months` : 'barely moving';
  let tail;
  if (p.levels && p.levels.breaking) tail = `it is breaking above its recent range now, with room to about ${p.levels.target} (+${p.levels.upside}%)`;
  else if (p.levels) tail = `a close above ${p.levels.trigger} would confirm the breakout and opens a run to about ${p.levels.target} (+${p.levels.upside}%)`;
  else tail = 'a push through recent highs would confirm it';
  const cap = p.marketCap ? `${fmtMoney(p.marketCap)} ${p.marketCap < 300e6 ? 'micro cap' : p.marketCap < 2e9 ? 'small cap' : p.marketCap < 10e9 ? 'mid cap' : 'company'}` : 'stock';
  const s = `${lead.charAt(0).toUpperCase()}${lead.slice(1)} in a ${cap} that is ${ret3}; ${tail}.`;
  return s;
}

// Score one candidate once its quote, chart and news are known.
export function scorePick(c, q, tech, base, tone = null) {
  const cap = q ? q.marketCap : null;
  const parts = {
    insider: insiderPoints(c.insider, cap),
    congress: congressPoints(c.congress),
    social: socialPoints(c.ape, c.st),
    setup: setupPoints(tech, base),
  };
  const radar = radarPoints(q, c.ape);
  let newsPts = 0;
  const newsWhy = [];
  if (tone && tone.count) {
    newsPts = clamp(tone.score * 6, -5, 5);
    if (tone.top) newsWhy.push(`Latest headline: "${tone.top}"`);
  }
  const raw = parts.insider.pts + parts.congress.pts + parts.social.pts + parts.setup.pts + radar + newsPts;
  // Flow (insiders, Congress, the crowd) is the edge; a chart alone scores lower.
  const flow = parts.insider.pts + Math.max(parts.congress.pts, 0) + parts.social.pts;
  const score = Math.round(clamp(raw * (flow > 0 ? 1 : 0.75), 0, 99));
  const lv = levels(tech, base);
  const p = {
    ticker: c.ticker,
    name: (q && (q.longName || q.shortName)) || c.name || '',
    exchange: (q && q.fullExchangeName) || '',
    marketCap: cap,
    price: tech ? +tech.price.toFixed(2) : null,
    change1d: tech ? tech.change1d : null,
    ret1m: tech ? tech.ret1m : null,
    ret3m: tech ? tech.ret3m : null,
    fromHigh: tech ? tech.fromHigh : null,
    rsi: tech ? tech.rsi14 : null,
    relVolume5: tech ? tech.relVolume5 : null,
    score,
    parts: { ...parts, radar: { pts: radar }, news: { pts: newsPts, why: newsWhy } },
    levels: lv,
  };
  p.conviction = conviction(score);
  p.thesis = thesis(p);
  p.tags = [
    parts.insider.pts > 0 && (parts.insider.cluster ? 'Insider cluster' : 'Insider buying'),
    parts.congress.pts > 0 && 'Congress buying',
    parts.social.pts > 0 && 'Rising buzz',
    base && base.range20 < 8 && 'Tight coil',
    base && base.squeeze != null && base.squeeze < 0.75 && 'Volatility squeeze',
    tech && tech.obvTrend > 0.15 && Math.abs(tech.ret1m || 0) < 10 && 'Quiet accumulation',
    lv && lv.breaking && 'Breaking out',
  ].filter(Boolean);
  p.why = [...parts.insider.why, ...parts.congress.why, ...parts.social.why, ...parts.setup.why, ...newsWhy];
  return p;
}

// Cheap ranking before any charts are fetched.
export function prescore(c, q) {
  const cap = q ? q.marketCap : null;
  let s = insiderPoints(c.insider, cap).pts + congressPoints(c.congress).pts + socialPoints(c.ape, c.st).pts + radarPoints(q, c.ape);
  if (q && q.fiftyDayAverage && q.regularMarketPrice) {
    const vs50 = (q.regularMarketPrice / q.fiftyDayAverage - 1) * 100;
    if (vs50 > 18) s -= 15; // probably already ran
    else if (vs50 > -5 && vs50 < 10) s += 4; // basing near the average
  }
  if (q && q.fiftyTwoWeekHigh && q.regularMarketPrice) {
    const fh = (q.regularMarketPrice / q.fiftyTwoWeekHigh - 1) * 100;
    if (fh > -15) s += 3;
  }
  return s;
}

function newsTone(items, ticker) {
  const recent = (items || []).filter((n) => !n.time || daysBetween(n.time) <= 10).filter((n) => !n.tickers || !n.tickers.length || n.tickers.includes(ticker));
  if (!recent.length) return { count: 0, score: 0, top: null };
  const h = headlineSentiment(recent);
  const best = h.items.find((x) => x.tone > 0) || h.items[0];
  return { count: recent.length, score: h.score, top: best ? best.title : null, link: best ? best.link : null };
}

// ---------- the whole page ----------
export async function buildRadar(env) {
  const [ape, st, ins, cong, spy] = await Promise.all([
    settle(apeWisdom(env)),
    settle(stocktwitsTrending(env)),
    settle(mergedInsiderBuys(env, 30)),
    settle(congressRecent(env)),
    settle(chart(env, 'SPY', '1y')),
  ]);
  const cands = gatherCandidates({
    insiders: ins.ok ? ins.value.list : [],
    congress: cong.ok ? cong.value : [],
    ape: ape.ok ? ape.value : [],
    st: st.ok ? st.value : [],
  });

  // Insider and Congress names first: they carry the strongest evidence.
  const all = [...cands.values()].sort((a, b) => prescore(b, null) - prescore(a, null)).slice(0, 150);
  const qr = await settle(quoteBatch(env, all.map((c) => c.ticker)));
  const quotes = qr.ok ? qr.value : new Map();

  const screened = [];
  const ruledOut = {};
  for (const c of all) {
    const q = quotes.get(c.ticker) || null;
    const why = screenOut(q);
    if (why) ruledOut[why] = (ruledOut[why] || 0) + 1;
    else screened.push({ c, q, pre: prescore(c, q) });
  }
  screened.sort((a, b) => b.pre - a.pre);
  const shortlist = screened.slice(0, LIMITS.charts);

  const spyBars = spy.ok ? spy.value.bars : null;
  const ran = [];
  const rows = await pool(shortlist, 6, async ({ c, q }) => {
    const px = await chart(env, c.ticker, '1y');
    if (/ETF|FUND/i.test(px.meta.instrumentType || '')) return null;
    const tech = computeTechnicals(px.bars, spyBars);
    if (!tech) return null;
    const r = alreadyRan(tech);
    if (r) {
      ran.push({ ticker: c.ticker, name: (q && (q.shortName || q.longName)) || c.name || px.meta.name || '', why: r, ret1m: tech.ret1m, ret3m: tech.ret3m });
      return null;
    }
    const base = baseInfo(px.bars);
    return { c, q: q || { longName: px.meta.name }, tech, base, spark: px.bars.slice(-90).map((b) => +b.c.toFixed(2)) };
  });
  const live = rows.filter((r) => r && !r.error);

  let picks = live.map((r) => ({ ...scorePick(r.c, r.q, r.tech, r.base), spark: r.spark, _r: r }));
  picks.sort((a, b) => b.score - a.score);

  // Headlines for the leaders, then a final re-rank.
  const top = picks.slice(0, LIMITS.newsFor);
  await pool(top, 4, async (p) => {
    const n = await settle(news(env, p.ticker));
    if (!n.ok) return;
    const tone = newsTone(n.value, p.ticker);
    const again = scorePick(p._r.c, p._r.q, p._r.tech, p._r.base, tone);
    Object.assign(p, again, { headline: tone.top ? { title: tone.top, link: tone.link } : null });
  });
  picks.sort((a, b) => b.score - a.score);
  picks = picks.map(({ _r, ...p }) => p);

  return {
    asOf: new Date().toISOString(),
    picks: picks.slice(0, 12),
    bench: picks.slice(12, 22),
    alreadyRan: ran.sort((a, b) => Math.max(b.ret1m || 0, b.ret3m || 0) - Math.max(a.ret1m || 0, a.ret3m || 0)).slice(0, 12),
    stats: { candidates: cands.size, screened: screened.length, charted: shortlist.length, ruledOut },
    rules: { maxCap: LIMITS.maxCap, maxRun: LIMITS.maxRun, minPrice: LIMITS.minPrice },
    status: {
      insiders: ins.ok ? 'ok' : ins.error,
      congress: cong.ok ? 'ok' : cong.error,
      reddit: ape.ok ? 'ok' : ape.error,
      stocktwits: st.ok ? 'ok' : st.error,
      quotes: qr.ok ? 'ok' : qr.error,
    },
  };
}

// Served from the D1 cache: fresh for 45 minutes, then shown while a new
// board builds in the background, for up to 12 hours.
export async function radarPage(env, waitUntil) {
  const now = Date.now();
  let hit = null;
  try {
    hit = await env.DB.prepare('SELECT v, exp FROM cache WHERE k = ?').bind(RADAR_KEY).first();
  } catch {}
  const save = async () => {
    const d = await buildRadar(env);
    if (d.picks.length) {
      try {
        await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(RADAR_KEY, JSON.stringify(d), Date.now() + RADAR_STALE_MS).run();
      } catch {}
    }
    return d;
  };
  if (hit) {
    const d = JSON.parse(hit.v);
    const age = now - new Date(d.asOf).getTime();
    if (age < RADAR_FRESH_MS) return d;
    if (hit.exp > now) {
      // One rebuild at a time: mark it started so other visitors just read.
      if (!d.rebuildAt || now - d.rebuildAt > 5 * 60e3) {
        try {
          await env.DB.prepare('UPDATE cache SET v = ? WHERE k = ?').bind(JSON.stringify({ ...d, rebuildAt: now }), RADAR_KEY).run();
        } catch {}
        if (waitUntil) waitUntil(save().catch(() => {}));
      }
      const { rebuildAt, ...rest } = d;
      return { ...rest, refreshing: true };
    }
  }
  return save();
}
