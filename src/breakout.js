// Breakout watch: six stocks where insiders, Congress and social chatter are
// lining up behind a stock whose chart has not moved yet. Every candidate comes
// from the same feeds as the buzz board; each one is priced, anything already up
// 20% or more over the last one to three months is dropped, and the rest are
// ranked by a 0 to 100 setup score:
//   insiders up to 35, chart setup up to 25, Congress up to 15, social up to 15,
//   news up to 10, plus a bonus when several of those agree, minus points for a
//   stock that is already stretched.
import { settle, pool, cleanTicker, clamp, daysBetween } from './util.js';
import { chart, news } from './sources/yahoo.js';
import { apeWisdom, stocktwitsTrending } from './sources/social.js';
import { congressRecent } from './sources/congress.js';
import { lexiconTone, catalystOf } from './sources/news.js';
import { computeTechnicals } from './analysis/technicals.js';
import { mergedInsiderBuys, SKIP } from './buzz.js';

export const PICKS = 6;
export const MAX_RUN_PCT = 20; // up this much over 1, 2 or 3 months means it already moved
const MAX_CHARTS = 30; // price histories per build (Workers Free allows 50 fetches per request)
const MAX_NEWS = 10; // finalists that get a headline check
const MIN_PRICE = 1;
const MIN_DOLLAR_VOL = 500e3; // average daily dollar volume

const money = (v) => {
  const a = Math.abs(v || 0);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v || 0)}`;
};
const pctMove = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

// Price facts the setup score needs beyond the standard technicals.
export function setupFacts(bars) {
  const c = bars.map((b) => b.c);
  const n = c.length;
  const last = c[n - 1];
  const back = (d) => (n > d ? pctMove(last, c[n - 1 - d]) : null);
  const last3m = c.slice(-63);
  const low3m = Math.min(...last3m);
  const high3m = Math.max(...bars.slice(-63).map((b) => b.h));
  // Bollinger band width now vs the last six months: a squeeze (bottom quarter)
  // means volatility has dried up, which tends to come right before a big move.
  const widths = [];
  for (let i = Math.max(20, n - 126); i <= n; i++) {
    const w = c.slice(i - 20, i);
    const m = w.reduce((a, b) => a + b, 0) / 20;
    const sd = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20);
    widths.push(m ? (4 * sd) / m : 0);
  }
  const now = widths[widths.length - 1];
  const squeezePct = widths.length > 20 ? (widths.filter((w) => w < now).length / widths.length) * 100 : null;
  return {
    ret1m: back(21),
    ret2m: back(42),
    ret3m: back(63),
    fromLow3m: pctMove(last, low3m),
    high3m,
    toHigh3m: pctMove(high3m, last),
    squeezePct,
  };
}

// The biggest run over the last one to three months, measured both point to
// point and off the 3 month low. Anything at or above MAX_RUN_PCT is out.
export function recentRun(f) {
  return Math.max(...[f.ret1m, f.ret2m, f.ret3m, f.fromLow3m].filter((x) => x != null), 0);
}

// ---------- the setup score ----------
// Each part returns { pts, why: [plain language reasons], tag }.
export function insiderPart(ins) {
  if (!ins || !ins.buyers) return null;
  let pts = 14 + 5 * Math.min(ins.buyers - 1, 3);
  if (ins.csuite) pts += 5;
  pts += 3 * clamp(Math.log10(Math.max(ins.total_value || 0, 1) / 1e5), 0, 2);
  const age = ins.last_date ? daysBetween(ins.last_date) : 30;
  if (age <= 7) pts += 2;
  pts = Math.min(35, pts);
  const who = ins.buyers >= 3 ? `Cluster buy: ${ins.buyers} insiders` : ins.buyers === 2 ? '2 insiders' : 'An insider';
  const why = [`${who} bought ${money(ins.total_value)} on the open market${ins.csuite ? ', including the C-suite' : ''}${age <= 30 ? ` (latest ${age === 0 ? 'today' : `${age} day${age === 1 ? '' : 's'} ago`})` : ''}`];
  if (ins.plan_buys) why.push(`${ins.plan_buys} of these purchases ${ins.plan_buys === 1 ? 'was' : 'were'} made under a 10b5-1 plan`);
  return { pts, why, tag: ins.buyers >= 3 ? 'Insider cluster' : 'Insider buying' };
}

export function congressPart(trades) {
  if (!trades || !trades.length) return null;
  const buys = trades.filter((t) => t.type === 'buy');
  const sells = trades.filter((t) => t.type === 'sell');
  const members = [...new Set(buys.map((b) => b.member).filter(Boolean))];
  let pts = 0;
  for (const b of buys) pts += 6 + (b.amountMin >= 50000 ? 3 : 0);
  for (const s of sells) pts -= 5 + (s.amountMin >= 50000 ? 2 : 0);
  pts = clamp(pts, -10, 15);
  if (!buys.length) return { pts, why: [`${sells.length} member${sells.length > 1 ? 's' : ''} of Congress sold recently`], tag: null };
  return {
    pts,
    why: [`Congress buying: ${members.slice(0, 2).join(' and ')}${members.length > 2 ? ` and ${members.length - 2} more` : ''} disclosed ${buys.length} purchase${buys.length > 1 ? 's' : ''}${sells.length ? ` (${sells.length} sale${sells.length > 1 ? 's' : ''})` : ''}`],
    tag: pts > 0 ? 'Congress buying' : null,
  };
}

export function socialPart(ape, trending, tech) {
  if (!ape && !trending) return null;
  let pts = 0;
  const why = [];
  let tag = null;
  if (ape) {
    const growth = ape.mentions24hAgo ? ape.mentions / ape.mentions24hAgo : ape.mentions >= 10 ? 3 : 1;
    const climb = ape.rank24hAgo ? ape.rank24hAgo - ape.rank : 0;
    if (growth >= 1.5 && ape.mentions >= 8) {
      pts += Math.min(10, 4 + 3 * Math.log2(growth));
      why.push(`Reddit chatter up ${Math.round((growth - 1) * 100)}% in a day (${ape.mentions} mentions, rank #${ape.rank})`);
      tag = 'Reddit rising';
    } else if (climb >= 10) {
      pts += 5;
      why.push(`Climbing the Reddit board: #${ape.rank24hAgo} to #${ape.rank}`);
      tag = 'Reddit rising';
    } else if (ape.mentions >= 5) {
      pts += 2;
      why.push(`Steady Reddit interest (${ape.mentions} mentions, rank #${ape.rank})`);
    }
    // Already the most hyped name on an overbought chart: the crowd is in.
    if (ape.rank <= 10 && tech && tech.rsi14 > 70) {
      pts -= 6;
      why.push('Crowded: top 10 on Reddit with an overbought chart');
    }
  }
  if (trending) {
    pts += 5;
    why.push('Trending on StockTwits');
    tag = tag || 'StockTwits trending';
  }
  return { pts: clamp(pts, -6, 15), why, tag };
}

export function chartPart(t, f) {
  let pts = 0;
  const why = [];
  let tag = null;
  if (t.sma50 && t.price > t.sma50) pts += 4;
  if (t.sma200 && t.price > t.sma200) pts += 3;
  if (t.sma50 && t.sma200 && t.price < t.sma50 && t.price < t.sma200) pts -= 4;
  if (f.squeezePct != null && f.squeezePct <= 25) {
    pts += 5;
    why.push('Price range squeezed to one of its tightest of the last 6 months, often the calm before a big move');
    tag = 'Squeeze';
  }
  if (t.obvTrend > 0.15 && Math.abs(f.ret1m || 0) < 8) {
    pts += 5;
    why.push('Quiet accumulation: buying volume is building while the price stays flat');
    tag = tag || 'Accumulation';
  }
  if (f.toHigh3m != null && f.toHigh3m > 1 && f.toHigh3m <= 12) {
    pts += 4;
    why.push(`Sitting ${f.toHigh3m.toFixed(1)}% under its 3 month high, the level to clear`);
  }
  if (t.macdCross === 'bullish') {
    pts += 3;
    why.push('Fresh bullish MACD crossover');
  } else if (t.macdHist > 0) pts += 1;
  if (t.rsi14 != null && t.rsi14 >= 45 && t.rsi14 <= 65) pts += 2;
  if (t.relVolume5 != null && t.relVolume5 >= 1.3 && (t.ret5d || 0) < 6) {
    pts += 2;
    why.push(`Volume running ${t.relVolume5.toFixed(1)}x normal this week without a price jump`);
  }
  // Already stretched in the short term.
  if (t.rsi14 > 72) pts -= 5;
  if ((t.ret5d || 0) > 10) pts -= 5;
  return { pts: clamp(pts, -10, 25), why, tag };
}

export function newsPart(items) {
  if (!items || !items.length) return null;
  const now = Date.now();
  let num = 0;
  let den = 0;
  const cats = new Set();
  let best = null;
  for (const n of items) {
    const age = n.time ? Math.max(0, (now - new Date(n.time).getTime()) / 864e5) : 5;
    if (age > 10) continue;
    const tone = lexiconTone(n.title);
    const w = Math.exp(-age / 4);
    num += tone * w;
    den += w;
    const c = catalystOf(n.title || '');
    if (c && age <= 7) cats.add(c);
    if (tone > 0 && !best) best = n;
  }
  if (!den) return null;
  const tone = num / den;
  const pts = clamp(Math.round(tone * 12), -8, 10);
  const why = [];
  if (pts > 0 && best) why.push(`Positive headline: "${String(best.title).slice(0, 110)}"`);
  else if (pts < 0) why.push('Recent headlines lean negative');
  return { pts, why, tag: pts >= 4 ? 'Good news flow' : null, catalysts: [...cats].slice(0, 3) };
}

export function setupScore(parts) {
  const ps = parts.filter(Boolean);
  let s = ps.reduce((a, p) => a + p.pts, 0);
  // Independent groups pointing the same way are worth more than one loud one.
  const agree = ps.filter((p) => p.pts >= 5).length;
  if (agree >= 3) s += 10;
  else if (agree === 2) s += 5;
  return Math.round(clamp(s, 0, 100));
}

export const setupLabel = (s) => (s >= 60 ? 'Strong setup' : s >= 40 ? 'Building' : 'Early');

// ---------- the build ----------
// Candidates: insider buys first (they are the strongest of these signals),
// then Congress purchases, then names whose social chatter is accelerating.
export function pickCandidates({ insiders = [], congress = [], ape = [], trending = [] }, max = MAX_CHARTS) {
  const why = new Map();
  const add = (t, src) => {
    t = cleanTicker(t);
    if (!t || SKIP.has(t) || /-USD$/.test(t)) return;
    if (!why.has(t)) why.set(t, new Set());
    why.get(t).add(src);
  };
  insiders.slice(0, 22).forEach((r) => add(r.ticker, 'insider'));
  const net = new Map();
  for (const x of congress) net.set(x.ticker, (net.get(x.ticker) || 0) + (x.type === 'buy' ? 1 : x.type === 'sell' ? -1 : 0));
  [...net.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([t]) => add(t, 'congress'));
  ape
    .filter((r) => r.mentions >= 8 && (r.mentions >= 1.5 * Math.max(r.mentions24hAgo, 1) || (r.rank24hAgo && r.rank24hAgo - r.rank >= 10)))
    .slice(0, 10)
    .forEach((r) => add(r.ticker, 'social'));
  trending.slice(0, 8).forEach((r) => add(r.ticker, 'social'));
  // Tickers backed by more than one kind of signal go first.
  return [...why.entries()].map(([t, s], i) => ({ t, n: s.size, i })).sort((a, b) => b.n - a.n || a.i - b.i).slice(0, max).map((x) => x.t);
}

export async function buildBreakout(env) {
  const days = parseInt(env.INSIDER_DAYS || '30', 10);
  const [ape, st, ins, cong, spy] = await Promise.all([
    settle(apeWisdom(env)),
    settle(stocktwitsTrending(env)),
    settle(mergedInsiderBuys(env, days)),
    settle(congressRecent(env)),
    settle(chart(env, 'SPY', '1y')),
  ]);
  const apeList = ape.ok ? ape.value : [];
  const stList = st.ok ? st.value : [];
  const insList = ins.ok ? ins.value.list : [];
  const congList = cong.ok ? cong.value : [];
  const apeMap = new Map(apeList.map((r) => [r.ticker, r]));
  const stSet = new Set(stList.map((r) => r.ticker));
  const insMap = new Map(insList.map((r) => [r.ticker, r]));

  const tickers = pickCandidates({ insiders: insList, congress: congList, ape: apeList, trending: stList });
  const skipped = { ran: 0, etf: 0, thin: 0, data: 0 };
  const rows = await pool(tickers, 6, async (t) => {
    const px = await chart(env, t, '1y');
    if (/ETF|FUND|INDEX|CRYPTO/i.test(px.meta.instrumentType || '')) return void skipped.etf++;
    const tech = computeTechnicals(px.bars, spy.ok ? spy.value.bars : null);
    if (!tech || px.bars.length < 70) return void skipped.data++;
    if (tech.price < MIN_PRICE || (tech.avgVolume20 || 0) * tech.price < MIN_DOLLAR_VOL) return void skipped.thin++;
    const f = setupFacts(px.bars);
    const run = recentRun(f);
    if (run >= MAX_RUN_PCT) return void skipped.ran++;
    const insAgg = insMap.get(t);
    const ct = congList.filter((x) => x.ticker === t);
    const parts = {
      insider: insiderPart(insAgg),
      congress: congressPart(ct),
      social: socialPart(apeMap.get(t), stSet.has(t), tech),
      chart: chartPart(tech, f),
    };
    return {
      ticker: t,
      name: (insAgg && insAgg.issuer) || (apeMap.get(t) && apeMap.get(t).name) || px.meta.name || '',
      price: tech.price,
      change1d: tech.change1d,
      ret1m: f.ret1m,
      ret3m: f.ret3m,
      run,
      high3m: f.high3m,
      toHigh3m: f.toHigh3m,
      rsi: tech.rsi14,
      parts,
      spark: px.bars.slice(-63).map((b) => +b.c.toFixed(2)),
    };
  });
  let live = rows.filter((r) => r && !r.error);
  for (const r of live) r.score = setupScore(Object.values(r.parts));
  live.sort((a, b) => b.score - a.score);

  // Headlines for the leading names; good or bad news can reorder them.
  const top = live.slice(0, MAX_NEWS);
  await pool(top, 5, async (r) => {
    const n = await news(env, r.ticker).catch(() => null);
    r.parts.news = newsPart(n);
    r.score = setupScore(Object.values(r.parts));
  });
  live = top.sort((a, b) => b.score - a.score);

  const picks = live
    .filter((r) => r.parts.insider || (r.parts.congress && r.parts.congress.pts > 0) || (r.parts.social && r.parts.social.pts > 0))
    .slice(0, PICKS)
    .map((r) => {
      const ps = Object.values(r.parts).filter(Boolean).sort((a, b) => b.pts - a.pts);
      return {
        ticker: r.ticker,
        name: r.name,
        price: r.price,
        change1d: r.change1d,
        ret1m: r.ret1m,
        ret3m: r.ret3m,
        run: r.run,
        trigger: r.high3m,
        toTrigger: r.toHigh3m,
        rsi: r.rsi,
        score: r.score,
        label: setupLabel(r.score),
        tags: [...new Set(ps.filter((p) => p.pts > 0).map((p) => p.tag).filter(Boolean))].slice(0, 3),
        reasons: ps.filter((p) => p.pts > 0).flatMap((p) => p.why).slice(0, 4),
        catalysts: (r.parts.news && r.parts.news.catalysts) || [],
        breakdown: Object.fromEntries(Object.entries(r.parts).map(([k, p]) => [k, p ? Math.round(p.pts) : 0])),
        spark: r.spark,
      };
    });

  return {
    updated: new Date().toISOString(),
    picks,
    rules: { maxRunPct: MAX_RUN_PCT, insiderDays: days },
    status: {
      candidates: tickers.length,
      scored: rows.filter((r) => r && !r.error).length,
      skipped,
      failed: rows.filter((r) => r && r.error).length,
      reddit: ape.ok ? 'ok' : ape.error,
      stocktwits: st.ok ? 'ok' : st.error,
      insiders: ins.ok ? 'ok' : ins.error,
      congress: cong.ok ? 'ok' : cong.error,
    },
  };
}
