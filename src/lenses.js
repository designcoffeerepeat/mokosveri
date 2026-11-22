// AI lenses for the ticker page: six analysis frameworks (thesis stress test,
// margin trends, earnings quality, chart vs fundamentals, macro stress test,
// moat check). Each lens gathers real data for the ticker, fills the framework
// prompt with it, and asks Workers AI for a short structured read (verdict,
// three or four points, what to watch). The data is returned alongside so the
// page can show the numbers the read is based on.
import { cached, settle, cleanTicker } from './util.js';
import { chart, quoteSummary, raw } from './sources/yahoo.js';
import { latestNews } from './sources/news.js';
import { computeTechnicals } from './analysis/technicals.js';
import { cleanCopy } from './analysis/summary.js';
import { secQuarterly, valuationOf, valuation, peers, earnings, earningsRelease } from './sources/fundamentals.js';

export const LENS_IDS = ['devil', 'margins', 'earnings', 'convergence', 'macro', 'moat'];

export const MACRO_EVENTS = {
  rates_high: 'sustained high interest rates',
  rate_cuts: 'falling interest rates as the Fed cuts',
  oil_up: 'rising oil prices',
  recession: 'a US recession',
  inflation: 're-accelerating inflation',
  dollar_up: 'a strong US dollar',
  tariffs: 'new tariffs and trade restrictions',
};

// ---------- formatting for prompts ----------
const f = (v, d = 1) => (v == null || !isFinite(v) ? null : Number(v).toFixed(d));
const pc = (v, d = 1, sign = false) => (v == null || !isFinite(v) ? null : `${sign && v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const x = (v, d = 1) => (v == null || !isFinite(v) ? null : `${Number(v).toFixed(d)}x`);
const usd = (v) => {
  if (v == null || !isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v)}`;
};
const lines = (pairs) => pairs.filter(([, v]) => v != null && v !== '').map(([k, v]) => `${k}: ${v}`).join('\n');

function valuationLines(v) {
  if (!v) return 'Valuation data unavailable.';
  return lines([
    ['Market cap', usd(v.marketCap)],
    ['P/E (trailing)', x(v.pe)],
    ['P/E (forward)', x(v.forwardPe)],
    ['Price to sales', x(v.ps)],
    ['EV/EBITDA', x(v.evEbitda)],
    ['Free cash flow yield', pc(v.fcfYield)],
    ['Debt to equity', x(v.debtToEquity, 2)],
    ['Gross margin (ttm)', pc(v.grossMargin)],
    ['Operating margin (ttm)', pc(v.opMargin)],
    ['Revenue growth (yoy, latest quarter)', pc(v.revGrowth)],
    ['Return on equity', pc(v.roe)],
    ['Current ratio', f(v.currentRatio, 2)],
    ['Cash', usd(v.totalCash)],
    ['Total debt', usd(v.totalDebt)],
    ['Beta', f(v.beta, 2)],
  ]);
}

function quarterLines(sec) {
  if (!sec || !sec.rows || !sec.rows.length) return 'Quarterly SEC figures unavailable.';
  const head = 'Quarter end | Revenue | Rev growth yoy | Gross margin | Operating margin';
  const body = sec.rows.map((r) => [r.end, usd(r.revenue), pc(r.revGrowth) || 'n/a', pc(r.grossMargin) || 'n/a', pc(r.opMargin) || 'n/a'].join(' | '));
  const flags = (sec.flags || []).map((t) => `${t.metric}: ${t.dir} (${f(t.before)}% to ${f(t.now)}%)`);
  return [head, ...body, ...(flags.length ? ['Computed trend flags:', ...flags] : [])].join('\n');
}

function techLines(t) {
  if (!t) return 'Price data unavailable.';
  const vs = (a) => (a ? pc((t.price / a - 1) * 100) : null);
  return lines([
    ['Price', f(t.price, 2)],
    ['vs 50 day average', vs(t.sma50)],
    ['vs 200 day average', vs(t.sma200)],
    ['50 day vs 200 day', t.goldenCross == null ? null : t.goldenCross ? '50d above 200d (golden cross state)' : '50d below 200d (death cross state)'],
    ['RSI 14', f(t.rsi14, 0)],
    ['MACD histogram', t.macdHist == null ? null : `${f(t.macdHist, 3)}${t.macdCross ? `, fresh ${t.macdCross} cross` : ''}`],
    ['On balance volume, 20 day trend', t.obvTrend == null ? null : t.obvTrend > 0.15 ? 'accumulation' : t.obvTrend < -0.15 ? 'distribution' : 'flat'],
    ['5 day volume vs 50 day average', x(t.relVolume5, 2)],
    ['Return 1 month', pc(t.ret1m)],
    ['Return 3 months', pc(t.ret3m)],
    ['Return 1 year', pc(t.ret1y)],
    ['From 52 week high', pc(t.fromHigh)],
  ]);
}

const peerLines = (list) => (list && list.length ? list.map((p) => `${p.ticker} (${p.name}): P/E ${x(p.pe) || 'n/a'}, P/S ${x(p.ps) || 'n/a'}, EV/EBITDA ${x(p.evEbitda) || 'n/a'}, gross margin ${pc(p.grossMargin) || 'n/a'}, op margin ${pc(p.opMargin) || 'n/a'}, rev growth ${pc(p.revGrowth) || 'n/a'}`).join('\n') : 'Peer data unavailable.');

// ---------- deterministic reads ----------

// Scores the chart and the fundamentals separately and says whether they agree.
export function convergenceRead(t, v) {
  const tech = [];
  const fund = [];
  if (t) {
    if (t.sma50) tech.push({ label: 'Price vs 50 day', value: pc((t.price / t.sma50 - 1) * 100, 1, true), s: t.price > t.sma50 ? 1 : -1 });
    if (t.sma200) tech.push({ label: 'Price vs 200 day', value: pc((t.price / t.sma200 - 1) * 100, 1, true), s: t.price > t.sma200 ? 1 : -1 });
    if (t.goldenCross != null) tech.push({ label: '50 day vs 200 day', value: t.goldenCross ? 'Above' : 'Below', s: t.goldenCross ? 1 : -1 });
    if (t.rsi14 != null) tech.push({ label: 'RSI 14', value: f(t.rsi14, 0), s: t.rsi14 > 70 ? 0 : t.rsi14 >= 50 ? 1 : t.rsi14 < 30 ? 0 : -1, note: t.rsi14 > 70 ? 'overbought' : t.rsi14 < 30 ? 'oversold' : null });
    if (t.macdHist != null) tech.push({ label: 'MACD', value: t.macdHist > 0 ? 'Above signal' : 'Below signal', s: t.macdHist > 0 ? 1 : -1, note: t.macdCross ? `fresh ${t.macdCross} cross` : null });
  }
  if (v) {
    if (v.fcfYield != null) fund.push({ label: 'FCF yield', value: pc(v.fcfYield), s: v.fcfYield >= 5 ? 1 : v.fcfYield < 2 ? -1 : 0 });
    if (v.debtToEquity != null) fund.push({ label: 'Debt to equity', value: x(v.debtToEquity, 2), s: v.debtToEquity < 0.5 ? 1 : v.debtToEquity > 1.5 ? -1 : 0 });
    if (v.pe != null || v.forwardPe != null) {
      const pe = v.pe ?? v.forwardPe;
      fund.push({ label: 'P/E', value: pe > 0 ? x(pe) : 'Negative earnings', s: pe <= 0 ? -1 : pe < 15 ? 1 : pe > 35 ? -1 : 0 });
    } else if (v.marketCap) fund.push({ label: 'P/E', value: 'No earnings', s: -1 });
    if (v.revGrowth != null) fund.push({ label: 'Revenue growth', value: pc(v.revGrowth), s: v.revGrowth >= 10 ? 1 : v.revGrowth < 0 ? -1 : 0 });
  }
  const sum = (a) => a.reduce((s, y) => s + y.s, 0);
  const ts = sum(tech);
  const fs = sum(fund);
  const techStance = ts >= 2 ? 'bullish' : ts <= -2 ? 'bearish' : 'neutral';
  const fundStance = fs >= 2 ? 'attractive' : fs <= -2 ? 'stretched' : 'fair';
  let alignment = 'Mixed';
  if (techStance === 'bullish' && fundStance === 'attractive') alignment = 'Congruent, bullish';
  else if (techStance === 'bearish' && fundStance === 'stretched') alignment = 'Congruent, bearish';
  else if (techStance === 'bullish' && fundStance === 'stretched') alignment = 'Diverging, momentum ahead of value';
  else if (techStance === 'bearish' && fundStance === 'attractive') alignment = 'Diverging, value without momentum';
  return { tech, fund, techScore: ts, fundScore: fs, techStance, fundStance, alignment };
}

function marginStability(rows) {
  const g = (rows || []).map((r) => r.grossMargin).filter((v) => v != null);
  const o = (rows || []).map((r) => r.opMargin).filter((v) => v != null);
  const avg = (a) => (a.length ? a.reduce((s, y) => s + y, 0) / a.length : null);
  return {
    quarters: (rows || []).length,
    grossAvg: avg(g),
    grossMin: g.length ? Math.min(...g) : null,
    grossMax: g.length ? Math.max(...g) : null,
    opAvg: avg(o),
    opMin: o.length ? Math.min(...o) : null,
    opMax: o.length ? Math.max(...o) : null,
  };
}

// ---------- params ----------

export function lensParams(lens, q, ticker) {
  if (lens === 'devil') return { side: q.get('side') === 'bearish' ? 'bearish' : 'bullish' };
  if (lens === 'macro') {
    const event = MACRO_EVENTS[q.get('event')] ? q.get('event') : 'rates_high';
    const vs = cleanTicker(q.get('vs') || '');
    return { event, vs: vs && vs !== ticker ? vs : null };
  }
  return {};
}

// ---------- the six lenses ----------

const SYSTEM =
  'You are a buy side equity analyst writing for an experienced trader. Ground every point in the numbers provided and cite them. When a point relies on general public knowledge about the company rather than the data given, say "from public knowledge" in that point. Be specific and concrete, no filler, no greetings, no disclaimers, no advice to buy or sell. Never use dashes of any kind as punctuation. Reply with one JSON object only.';

const SHAPE = '{"verdict": string, "tone": "positive" | "negative" | "mixed" | "neutral", "rating": string, "headline": string, "points": [{"tag": string, "title": string, "detail": string}], "watch": [string]}';

const SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string' },
    tone: { type: 'string', enum: ['positive', 'negative', 'mixed', 'neutral'] },
    rating: { type: 'string' },
    headline: { type: 'string' },
    points: {
      type: 'array',
      items: { type: 'object', properties: { tag: { type: 'string' }, title: { type: 'string' }, detail: { type: 'string' } }, required: ['title', 'detail'] },
    },
    watch: { type: 'array', items: { type: 'string' } },
  },
  required: ['verdict', 'tone', 'headline', 'points'],
};

async function gather(env, t, need) {
  const jobs = {
    qs: () => quoteSummary(env, t),
    tech: async () => {
      const c = await chart(env, t, '1y');
      return computeTechnicals(c.bars);
    },
    sec: () => secQuarterly(env, t),
    peers: () => peers(env, t, 3),
    earn: () => earnings(env, t),
    release: () => earningsRelease(env, t),
    news: async () => (await latestNews(env, t, '')).items || [],
  };
  const keys = need.filter((k) => jobs[k]);
  const res = await Promise.all(keys.map((k) => settle(jobs[k]())));
  const out = {};
  keys.forEach((k, i) => (out[k] = res[i].ok ? res[i].value : null));
  return out;
}

function profileOf(qs, t) {
  const ap = (qs && (qs.assetProfile || qs.summaryProfile)) || {};
  const pr = (qs && qs.price) || {};
  return {
    name: pr.longName || pr.shortName || t,
    sector: ap.sector || null,
    industry: ap.industry || null,
    description: ap.longBusinessSummary ? String(ap.longBusinessSummary).slice(0, 1200) : null,
    type: (qs && qs.quoteType && qs.quoteType.quoteType) || null,
  };
}

const profileLines = (p) => lines([['Company', p.name], ['Sector', p.sector], ['Industry', p.industry], ['Business', p.description]]);

// Each lens returns { data, prompt (the framework question), user (full model input), guide }.
const BUILD = {
  async devil(env, t, params) {
    const g = await gather(env, t, ['qs', 'tech', 'sec', 'news']);
    const p = profileOf(g.qs, t);
    const v = valuationOf(g.qs, t);
    const fd = (g.qs && g.qs.financialData) || {};
    const target = raw(fd.targetMeanPrice);
    const prompt = `Act as a fundamental equity analyst and play devil's advocate on ${t}. I am currently ${params.side} on this stock. Give me the three strongest arguments against my position, focusing on structural business risks, macroeconomic headwinds, and deteriorating fundamental metrics rather than intraday price action. What specific conditions would need to materialize for my thesis to be completely wrong?`;
    const news = (g.news || []).slice(0, 8).map((n) => `- ${n.title}`).join('\n');
    const facts = [profileLines(p), valuationLines(v), quarterLines(g.sec), techLines(g.tech), target ? `Analyst mean target: $${f(target, 2)}` : '', news ? `Recent headlines:\n${news}` : ''].filter(Boolean).join('\n\n');
    const guide = `points: exactly 3 arguments against a ${params.side} position. tag each with one of "Structural", "Macro", "Fundamentals". title is a short claim, detail is 2 or 3 sentences with the evidence. watch: 3 specific, measurable conditions that would prove the ${params.side} thesis completely wrong. rating: how strong the counter case is, one of "strong", "moderate", "weak". verdict: 2 to 4 words, e.g. "Strong counter case". tone: the stock outlook implied by the counter case (negative if arguing against a bullish view, positive if arguing against a bearish view).`;
    return {
      data: { side: params.side, profile: p, valuation: v, flags: (g.sec && g.sec.flags) || [], tech: techBrief(g.tech), target },
      prompt,
      facts,
      guide,
    };
  },

  async margins(env, t) {
    const g = await gather(env, t, ['qs', 'sec', 'peers']);
    const p = profileOf(g.qs, t);
    const v = valuationOf(g.qs, t);
    const prompt = `Analyze ${t}'s revenue growth, gross margins, and operating margins over the last 12 quarters. Flag any acceleration or deterioration in these metrics and explain the underlying drivers behind the shifts. Finally, compare its current valuation multiples (P/E, Price-to-Sales, and EV/EBITDA) against its top three closest publicly traded competitors.`;
    const facts = [profileLines(p), `Quarterly figures from SEC filings:\n${quarterLines(g.sec)}`, `${t} valuation:\n${valuationLines(v)}`, `Closest competitors:\n${peerLines(g.peers)}`].join('\n\n');
    const guide = 'points: 3 or 4 findings. tag each with one of "Revenue", "Gross margin", "Operating margin", "Valuation". Cover each flagged acceleration or deterioration with its likely driver (say "likely" when inferring), and include one "Valuation" point comparing the multiples to the competitors by name. watch: 2 or 3 things to check in the next quarterly report. rating: overall fundamental momentum, one of "improving", "stable", "deteriorating". verdict: 2 to 4 words, e.g. "Margins expanding". tone: positive, negative, mixed or neutral for the fundamentals.';
    return {
      data: { profile: p, quarters: (g.sec && g.sec.rows) || [], flags: (g.sec && g.sec.flags) || [], valuation: v, peers: g.peers || [] },
      prompt,
      facts,
      guide,
    };
  },

  async earnings(env, t) {
    const g = await gather(env, t, ['qs', 'earn', 'release', 'sec']);
    const p = profileOf(g.qs, t);
    const e = g.earn || { history: [], trend: [] };
    const rel = g.release && g.release.found ? g.release : null;
    const prompt = `Break down ${p.name}'s latest earnings report. Look past the headline EPS and revenue numbers to assess the quality of earnings: were gains driven by organic core business growth or one-time items? Highlight any significant changes in forward guidance and identify three potential red flags or areas of concern found in management's commentary.`;
    const hist = e.history.map((h) => `${h.quarter}: EPS ${f(h.actual, 2)} vs estimate ${f(h.estimate, 2)} (surprise ${pc(h.surprisePct) || 'n/a'})`).join('\n');
    const trend = e.trend.map((r) => `${r.period}${r.end ? ` (${r.end})` : ''}: EPS estimate ${f(r.eps, 2)}${r.change30 != null ? `, ${pc(r.change30)} in 30 days` : ''}${r.change90 != null ? `, ${pc(r.change90)} in 90 days` : ''}${r.up30 != null ? `, revisions ${r.up30} up / ${r.down30 || 0} down` : ''}${r.revenue ? `, revenue estimate ${usd(r.revenue)}` : ''}`).join('\n');
    const facts = [
      profileLines(p),
      hist ? `EPS history:\n${hist}` : 'EPS history unavailable.',
      trend ? `Analyst estimates and revisions (a proxy for how guidance landed):\n${trend}` : '',
      `Recent quarters from SEC filings:\n${quarterLines(g.sec && { rows: g.sec.rows.slice(-5), flags: [] })}`,
      rel ? `Latest earnings press release (SEC 8-K, filed ${rel.filed}), excerpt:\n${rel.text.slice(0, 7000)}` : 'The earnings press release text is unavailable; rely on the numbers above.',
    ].filter(Boolean).join('\n\n');
    const guide = 'points: 3 findings on earnings quality. tag each with one of "Organic", "One time", "Guidance", "Margins", "Cash flow". Quote specific figures from the release when possible. watch: exactly 3 red flags or areas of concern from management commentary or the numbers. rating: quality of earnings, one of "high", "mixed", "low". verdict: 2 to 4 words, e.g. "Mostly organic beat". tone: positive, negative, mixed or neutral.';
    return {
      data: { profile: p, history: e.history, trend: e.trend, release: rel ? { filed: rel.filed, url: rel.url } : null },
      prompt,
      facts,
      guide,
    };
  },

  async convergence(env, t) {
    const g = await gather(env, t, ['qs', 'tech']);
    const p = profileOf(g.qs, t);
    const v = valuationOf(g.qs, t);
    const read = convergenceRead(g.tech, v);
    const prompt = `Evaluate ${t} by analyzing its current technical setup (including RSI, MACD, and price relative to its 50-day and 200-day moving averages) alongside its core fundamentals (Free Cash Flow yield, debt-to-equity, and P/E ratio). Explain whether the technical indicators and fundamental valuation are signaling a congruent trend or if they are diverging, and explain what that divergence suggests about institutional sentiment.`;
    const facts = [
      profileLines(p),
      `Technical setup:\n${techLines(g.tech)}`,
      `Fundamentals:\n${valuationLines(v)}`,
      lines([['Institutional ownership', pc(v && v.instOwn)], ['Short interest, % of float', pc(v && v.shortFloat)]]),
      `Rules based read: chart ${read.techStance} (${read.techScore}), fundamentals ${read.fundStance} (${read.fundScore}), ${read.alignment}.`,
    ].filter(Boolean).join('\n\n');
    const guide = 'points: 3 points. tag the first "Technical", the second "Fundamental", the third "Institutions". The third explains what the agreement or divergence suggests about institutional sentiment, using volume, accumulation or distribution, institutional ownership and short interest. watch: 2 or 3 price levels or data points that would confirm or break the current setup. rating: one of "congruent", "diverging", "mixed". verdict: 2 to 4 words, e.g. "Momentum ahead of value". tone: positive, negative, mixed or neutral.';
    return {
      data: { profile: p, valuation: v, read, tech: techBrief(g.tech) },
      prompt,
      facts,
      guide,
    };
  },

  async macro(env, t, params) {
    const g = await gather(env, t, ['qs', 'peers']);
    const p = profileOf(g.qs, t);
    const v = valuationOf(g.qs, t);
    const vsT = params.vs || (g.peers && g.peers[0] && g.peers[0].ticker) || null;
    let vsQs = null;
    if (vsT) {
      const r = await settle(quoteSummary(env, vsT));
      vsQs = r.ok ? r.value : null;
    }
    const vp = vsQs ? profileOf(vsQs, vsT) : null;
    const vv = vsQs ? valuationOf(vsQs, vsT) : vsT ? await valuation(env, vsT) : null;
    const ev = MACRO_EVENTS[params.event];
    const prompt = `Explain the historical impact of ${ev} on the ${p.industry || p.sector || "company's"} industry. Compare ${t} and ${vsT || 'its closest competitor'} within this sector. Based on their balance sheet leverage, pricing power, and geographic revenue mix, which company is structurally better positioned to navigate this specific macroeconomic environment?`;
    const facts = [`${t}:\n${profileLines(p)}\n${valuationLines(v)}`, vsT ? `${vsT}:\n${vp ? profileLines(vp) : ''}\n${valuationLines(vv)}` : 'No comparison company available.', 'Geographic revenue mix is not in the data; use public knowledge and say so.'].join('\n\n');
    const guide = `points: 4 points. First a "History" point on how ${ev} has historically hit this industry. Then one point each tagged "Leverage", "Pricing power" and "Geography" comparing ${t} and ${vsT || 'the competitor'} with numbers. watch: 2 or 3 data releases or company metrics to monitor. rating: the ticker symbol of the better positioned company${vsT ? `, either "${t}" or "${vsT}"` : ''}. verdict: 2 to 5 words naming the winner, e.g. "${t} better positioned". tone: the outlook for ${t} in this environment.`;
    return {
      data: { event: params.event, eventLabel: ev, a: { profile: p, valuation: v }, b: vsT ? { ticker: vsT, profile: vp, valuation: vv } : null, peers: (g.peers || []).map((x) => x.ticker) },
      prompt,
      facts,
      guide,
      params: { ...params, vs: vsT },
    };
  },

  async moat(env, t) {
    const g = await gather(env, t, ['qs', 'sec', 'peers']);
    const p = profileOf(g.qs, t);
    const v = valuationOf(g.qs, t);
    const st = marginStability(g.sec && g.sec.rows);
    const prompt = `Apply a competitive moat framework to ${t}. Categorize its primary moat (network effects, switching costs, intangible brand value, or cost advantage/scale). Rate the durability of this moat over the next 5 to 10 years as strong, moderate, or weak, and cite specific evidence. What emerging technological, competitive, or regulatory threats are most likely to erode this advantage?`;
    const facts = [
      profileLines(p),
      valuationLines(v),
      st.quarters ? `Margin stability over ${st.quarters} quarters: gross margin ${f(st.grossMin)}% to ${f(st.grossMax)}% (avg ${f(st.grossAvg)}%), operating margin ${f(st.opMin)}% to ${f(st.opMax)}% (avg ${f(st.opAvg)}%).` : '',
      `Closest competitors:\n${peerLines(g.peers)}`,
    ].filter(Boolean).join('\n\n');
    const guide = 'points: 3 or 4 points. The first is tagged "Moat" and names the primary moat type (one of "Network effects", "Switching costs", "Brand", "Cost advantage") in its title. The rest are tagged "Evidence" and cite specific evidence from the numbers or public knowledge. watch: exactly 3 emerging threats (technological, competitive or regulatory) most likely to erode the moat. rating: moat durability over 5 to 10 years, one of "strong", "moderate", "weak". verdict: 2 to 4 words, e.g. "Strong switching costs". tone: positive, negative, mixed or neutral.';
    return {
      data: { profile: p, valuation: v, stability: st, peers: g.peers || [] },
      prompt,
      facts,
      guide,
    };
  },
};

function techBrief(t) {
  if (!t) return null;
  return { price: t.price, sma50: t.sma50, sma200: t.sma200, rsi14: t.rsi14, macdHist: t.macdHist, macdCross: t.macdCross, obvTrend: t.obvTrend, relVolume5: t.relVolume5, ret1m: t.ret1m, ret3m: t.ret3m, ret1y: t.ret1y, fromHigh: t.fromHigh };
}

// ---------- AI ----------

// Pulls the JSON object out of a model reply (it may come back as an object,
// as a string, or wrapped in prose or a code fence).
export function parseAiJson(r) {
  const v = r && (r.response ?? r.result ?? r);
  if (v && typeof v === 'object' && !Array.isArray(v) && (v.verdict || v.points)) return v;
  const s = typeof v === 'string' ? v : '';
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

const clip = (s, n) => {
  const c = cleanCopy(s);
  return c.length > n ? `${c.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : c;
};

// Validates and tidies a model reply. Returns null when it is not usable.
export function sanitizeLens(o) {
  if (!o || typeof o !== 'object') return null;
  const points = (Array.isArray(o.points) ? o.points : [])
    .filter((p) => p && typeof p === 'object' && p.title && p.detail)
    .slice(0, 4)
    .map((p) => ({ tag: clip(p.tag || '', 24), title: clip(p.title, 110), detail: clip(p.detail, 600) }));
  if (points.length < 2 || !o.headline) return null;
  const tone = ['positive', 'negative', 'mixed', 'neutral'].includes(String(o.tone).toLowerCase()) ? String(o.tone).toLowerCase() : 'neutral';
  return {
    verdict: clip(o.verdict || '', 48),
    tone,
    rating: clip(o.rating || '', 16),
    headline: clip(o.headline, 320),
    points,
    watch: (Array.isArray(o.watch) ? o.watch : []).filter((w) => typeof w === 'string' && w.trim()).slice(0, 4).map((w) => clip(w, 260)),
  };
}

export const LENS_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

async function askModel(env, model, messages, json) {
  const opts = { messages, max_tokens: 1100, temperature: 0.2 };
  if (json) opts.response_format = { type: 'json_schema', json_schema: SCHEMA };
  return sanitizeLens(parseAiJson(await env.AI.run(model, opts)));
}

export async function lensAI(env, built) {
  if (!env.AI) return { ai: null, aiError: 'AI is not configured on this site.' };
  const messages = [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: `${built.prompt}\n\nData:\n${built.facts}\n\nHow to answer: ${built.guide}\nheadline: one sentence with the overall read.\nReply with JSON only, in this shape: ${SHAPE}` },
  ];
  const main = env.LENS_MODEL || LENS_MODEL;
  const tries = [[main, true], [main, false]];
  if (env.AI_MODEL && env.AI_MODEL !== main) tries.push([env.AI_MODEL, false]);
  let last = null;
  for (const [model, json] of tries) {
    const r = await settle(askModel(env, model, messages, json));
    if (r.ok && r.value) return { ai: r.value, model };
    last = r.ok ? 'The AI reply could not be read.' : r.error;
  }
  return { ai: null, aiError: `The AI read is unavailable right now (${String(last).slice(0, 120)}).` };
}

// ---------- entry ----------

export const LENS_TTL = 12 * 3600;

export const lensKey = (t, lens, params) => `lens:v1:${t}:${lens}:${Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => `${k}=${v}`).join('&')}`;

export async function readLensCache(env, key) {
  try {
    const row = await env.DB.prepare('SELECT v, exp FROM cache WHERE k = ?').bind(key).first();
    if (row && row.exp > Date.now()) return JSON.parse(row.v);
  } catch {}
  return null;
}

export async function buildLens(env, t, lens, params) {
  const built = await BUILD[lens](env, t, params);
  const p = built.params || params;
  const { ai, aiError, model } = await lensAI(env, built);
  return {
    ticker: t,
    lens,
    params: p,
    asOf: new Date().toISOString(),
    prompt: built.prompt,
    data: built.data,
    ai,
    aiError: aiError || null,
    model: model || null,
  };
}

export async function handleLens(request, env, ctx, url, t, lens, rateLimit) {
  const params = lensParams(lens, url.searchParams, t);
  const fresh = url.searchParams.get('fresh') === '1';
  const key = lensKey(t, lens, params);
  if (!fresh) {
    const hit = await readLensCache(env, key);
    if (hit) return { body: { ...hit, cached: true } };
  }
  const ip = request.headers.get('cf-connecting-ip') || 'local';
  const day = new Date().toISOString().slice(0, 10);
  if (rateLimit && env.DB) {
    if (!(await rateLimit(env, `lens:${ip}`, 20, 3600))) return { status: 429, body: { error: 'You have run a lot of AI lenses this hour. Try again a bit later.' } };
    if (!(await rateLimit(env, `lens:all:${day}`, 300, 86400))) return { status: 429, body: { error: 'The site has used its AI budget for today. Saved reads still work; new ones are back tomorrow.' } };
  }
  const out = await buildLens(env, t, lens, params);
  if (out.ai && env.DB) {
    const save = env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(key, JSON.stringify(out), Date.now() + LENS_TTL * 1000).run();
    ctx.waitUntil(save);
    // The macro lens resolves a default comparison company; save under that
    // key too so picking the same company later is instant.
    const k2 = lensKey(t, lens, out.params);
    if (k2 !== key) ctx.waitUntil(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(k2, JSON.stringify(out), Date.now() + LENS_TTL * 1000).run());
  }
  return { body: out };
}
