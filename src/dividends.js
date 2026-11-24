// Dividend aristocrats page (/api/dividends): every S&P 500 Dividend Aristocrat
// with live yield, price returns and an approximate total return, plus what the
// r/dividends community is talking about. Membership and streaks are typed in
// below because S&P publishes them only in PDFs; update them after each January
// review. Prices, yields and returns are live from Yahoo, cached for 3 hours.
import { fetchWithTimeout, getJSON, BROWSER_UA, cached, settle, yahooSymbol, pool } from './util.js';
import { getCrumb, fetchChart } from './sources/yahoo.js';

const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };

// Membership checked Nov 24, 2026: 69 companies, no changes at S&P's January
// 2026 review (last changes Feb 2025: ERIE, ES and FDS added). `years` is
// consecutive years of dividend increases as of Oct 2026.
export const LIST_CHECKED = '2026-11-24';
export const ARISTOCRATS = [
  ['AOS', 'A. O. Smith', 'Industrials', 35],
  ['ABT', 'Abbott Laboratories', 'Health Care', 54],
  ['ABBV', 'AbbVie', 'Health Care', 54],
  ['AFL', 'Aflac', 'Financials', 44],
  ['APD', 'Air Products', 'Materials', 44],
  ['ALB', 'Albemarle', 'Materials', 32],
  ['AMCR', 'Amcor', 'Materials', 42],
  ['ADM', 'Archer-Daniels-Midland', 'Consumer Staples', 53],
  ['ATO', 'Atmos Energy', 'Utilities', 42],
  ['ADP', 'Automatic Data Processing', 'Industrials', 51],
  ['BDX', 'Becton Dickinson', 'Health Care', 54],
  ['BRO', 'Brown & Brown', 'Financials', 33],
  ['BF.B', 'Brown-Forman', 'Consumer Staples', 42],
  ['CAH', 'Cardinal Health', 'Health Care', 40],
  ['CAT', 'Caterpillar', 'Industrials', 33],
  ['CHRW', 'C.H. Robinson', 'Industrials', 27],
  ['CVX', 'Chevron', 'Energy', 39],
  ['CB', 'Chubb', 'Financials', 33],
  ['CHD', 'Church & Dwight', 'Consumer Staples', 30],
  ['CINF', 'Cincinnati Financial', 'Financials', 66],
  ['CTAS', 'Cintas', 'Industrials', 43],
  ['CLX', 'Clorox', 'Consumer Staples', 49],
  ['KO', 'Coca-Cola', 'Consumer Staples', 64],
  ['CL', 'Colgate-Palmolive', 'Consumer Staples', 63],
  ['ED', 'Consolidated Edison', 'Utilities', 52],
  ['DOV', 'Dover', 'Industrials', 71],
  ['ECL', 'Ecolab', 'Materials', 34],
  ['EMR', 'Emerson Electric', 'Industrials', 70],
  ['ERIE', 'Erie Indemnity', 'Financials', 36],
  ['ES', 'Eversource Energy', 'Utilities', 28],
  ['ESS', 'Essex Property Trust', 'Real Estate', 32],
  ['EXPD', 'Expeditors International', 'Industrials', 32],
  ['XOM', 'Exxon Mobil', 'Energy', 43],
  ['FDS', 'FactSet', 'Financials', 27],
  ['FAST', 'Fastenal', 'Industrials', 27],
  ['FRT', 'Federal Realty', 'Real Estate', 59],
  ['BEN', 'Franklin Resources', 'Financials', 46],
  ['GD', 'General Dynamics', 'Industrials', 29],
  ['GPC', 'Genuine Parts', 'Consumer Discretionary', 70],
  ['HRL', 'Hormel Foods', 'Consumer Staples', 60],
  ['ITW', 'Illinois Tool Works', 'Industrials', 63],
  ['IBM', 'IBM', 'Information Technology', 31],
  ['SJM', 'J.M. Smucker', 'Consumer Staples', 25],
  ['JNJ', 'Johnson & Johnson', 'Health Care', 64],
  ['KVUE', 'Kenvue', 'Consumer Staples', 64],
  ['KMB', 'Kimberly-Clark', 'Consumer Staples', 54],
  ['LIN', 'Linde', 'Materials', 33],
  ['LOW', "Lowe's", 'Consumer Discretionary', 63],
  ['MKC', 'McCormick', 'Consumer Staples', 40],
  ['MCD', "McDonald's", 'Consumer Discretionary', 50],
  ['MDT', 'Medtronic', 'Health Care', 49],
  ['NEE', 'NextEra Energy', 'Utilities', 32],
  ['NDSN', 'Nordson', 'Industrials', 63],
  ['NUE', 'Nucor', 'Materials', 53],
  ['PNR', 'Pentair', 'Industrials', 50],
  ['PEP', 'PepsiCo', 'Consumer Staples', 54],
  ['PPG', 'PPG Industries', 'Materials', 55],
  ['PG', 'Procter & Gamble', 'Consumer Staples', 70],
  ['O', 'Realty Income', 'Real Estate', 32],
  ['ROP', 'Roper Technologies', 'Industrials', 33],
  ['SPGI', 'S&P Global', 'Financials', 53],
  ['SHW', 'Sherwin-Williams', 'Materials', 48],
  ['SWK', 'Stanley Black & Decker', 'Industrials', 59],
  ['SYY', 'Sysco', 'Consumer Staples', 56],
  ['TROW', 'T. Rowe Price', 'Financials', 40],
  ['TGT', 'Target', 'Consumer Discretionary', 55],
  ['GWW', 'W.W. Grainger', 'Industrials', 55],
  ['WMT', 'Walmart', 'Consumer Staples', 53],
  ['WST', 'West Pharmaceutical', 'Health Care', 34],
].map(([t, name, sector, years]) => ({ t, name, sector, years }));

// Yields last checked by hand (Oct 23, 2026 close). Shown only when Yahoo has
// no live figure for a ticker, and marked as such.
export const YIELD_FALLBACK = {
  AOS: 2.47, ABT: 2.43, ABBV: 2.42, AFL: 2.02, APD: 2.36, ALB: 1.75, AMCR: 5.64, ADM: 2.6, ATO: 2.32, ADP: 2.24, BDX: 2.11, BRO: 0.99,
  'BF.B': 3.14, CAH: 0.83, CAT: 0.95, CHRW: 1.79, CVX: 3.05, CB: 1.15, CHD: 1.17, CINF: 2.13, CTAS: 0.93, CLX: 5.79, KO: 2.29, CL: 2.25,
  ED: 3.07, DOV: 1.05, ECL: 1.01, EMR: 1.37, ERIE: 2.31, ES: 4.67, ESS: 3.72, EXPD: 0.83, XOM: 2.25, FDS: 1.4, FAST: 2.0, FRT: 4.27,
  BEN: 4.25, GD: 1.82, GPC: 3.45, HRL: 5.56, ITW: 2.5, IBM: 2.67, SJM: 3.45, JNJ: 2.03, KVUE: 4.29, KMB: 4.65, LIN: 1.26, LOW: 2.52,
  MKC: 3.99, MCD: 3.11, MDT: 3.02, NEE: 3.04, NDSN: 1.18, NUE: 0.87, PNR: 1.95, PEP: 4.36, PPG: 2.68, PG: 2.7, O: 5.73, ROP: 0.83,
  SPGI: 0.86, SHW: 0.95, SWK: 3.39, SYY: 2.7, TROW: 4.99, TGT: 3.04, GWW: 0.74, WMT: 0.83, WST: 0.27,
};

// Dividend ETFs shown beside the aristocrats. Expense ratios are the funds'
// published figures (percent a year); check them on the issuer's page.
export const ETFS = [
  ['SCHD', 'Schwab US Dividend Equity', 'Dividend growth', 0.06],
  ['VIG', 'Vanguard Dividend Appreciation', 'Dividend growth', 0.05],
  ['DGRO', 'iShares Core Dividend Growth', 'Dividend growth', 0.08],
  ['NOBL', 'ProShares S&P 500 Dividend Aristocrats', 'Aristocrats', 0.35],
  ['SDY', 'SPDR S&P Dividend', 'Aristocrats', 0.35],
  ['REGL', 'ProShares S&P MidCap 400 Dividend Aristocrats', 'Aristocrats', 0.4],
  ['VYM', 'Vanguard High Dividend Yield', 'High yield', 0.06],
  ['HDV', 'iShares Core High Dividend', 'High yield', 0.08],
  ['DVY', 'iShares Select Dividend', 'High yield', 0.38],
  ['SPYD', 'SPDR Portfolio S&P 500 High Dividend', 'High yield', 0.07],
  ['FDVV', 'Fidelity High Dividend', 'High yield', 0.15],
  ['SCHY', 'Schwab International Dividend Equity', 'International', 0.08],
  ['JEPI', 'JPMorgan Equity Premium Income', 'Covered call income', 0.35],
  ['JEPQ', 'JPMorgan Nasdaq Equity Premium Income', 'Covered call income', 0.35],
  ['DIVO', 'Amplify CWP Enhanced Dividend Income', 'Covered call income', 0.56],
].map(([t, name, sector, er]) => ({ t, name, sector, er, etf: true, years: null }));

// Third party research notes shown on the page, with their dates.
export const RESEARCH = {
  morningstar: {
    title: 'Morningstar: 10 best Dividend Aristocrats to buy for 2026',
    asOf: '2026-01-23',
    url: 'https://www.morningstar.com/stocks/10-best-dividend-aristocrats-buy-now',
    note: 'Aristocrats with a narrow or wide moat trading below Morningstar fair value. Price to fair value in brackets (below 1 means undervalued in their model).',
    picks: [
      ['CLX', 0.7, 'Wide moat'], ['AMCR', 0.74, 'Narrow moat'], ['BF.B', 0.75, 'Wide moat'], ['BDX', 0.75, 'Narrow moat'], ['WST', 0.76, 'Wide moat'],
      ['KMB', 0.77, 'Narrow moat'], ['FDS', 0.8, 'Narrow moat'], ['APD', 0.86, 'Wide moat'], ['ADP', 0.87, 'Wide moat'], ['PEP', 0.87, 'Wide moat'],
    ],
  },
  leaders: {
    title: 'Best performing aristocrats in 2026 so far',
    asOf: '2026-06-12',
    url: 'https://www.dividendhike.com/p/best-performing-dividend-aristocrats-2026',
    note: 'Total return from Jan 1 to Jun 12, 2026. Most of the leaders yield under 2%, which is why the live table below matters more for income.',
    rows: [['NUE', 63.8], ['CAT', 59.6], ['ADM', 41.6], ['TGT', 41.0], ['BEN', 36.4], ['GWW', 30.9], ['LIN', 23.6]],
  },
  longRun: 'Over the 10 years to Sep 30, 2026 the aristocrats index returned about 9.9% a year against about 15.3% for the S&P 500 (AllInvestView), so the group trades some growth for steadier, rising income.',
};

// What r/dividends keeps coming back to, summarized by Mokosveri from the
// subreddit's long running discussions. These are paraphrased themes, not
// quotes, and they are not recommendations.
export const COMMUNITY = {
  reviewed: '2026-11',
  themes: [
    {
      title: 'Dividend growth beats chasing yield',
      body: 'The most repeated advice: a 2% to 4% yield that grows every year usually beats a 7% yield that stalls or gets cut. A yield far above a company\'s own history is treated as a warning sign until earnings and the payout ratio say otherwise.',
      tickers: [],
    },
    {
      title: 'SCHD as the core, aristocrats around it',
      body: 'Many posters hold SCHD (or VIG, DGRO) as the base and add a handful of individual aristocrats on top. NOBL, the aristocrats ETF, is often criticized for its equal weighting, higher fee and lagging the S&P 500.',
      tickers: [],
    },
    {
      title: 'Realty Income, the monthly payer',
      body: 'O is one of the most discussed names: monthly dividends and a 30 plus year streak. The pushback is slow per share growth and sensitivity to interest rates, so it is usually framed as an income anchor, not a growth stock.',
      tickers: ['O'],
    },
    {
      title: 'Beaten down staples: bargain or value trap',
      body: 'PepsiCo, Target, Clorox, Kimberly-Clark, Hormel, Kenvue and Smucker show up in "is this a buy?" threads because falling prices pushed their yields well above normal. Bulls point to long streaks and brands; skeptics point to weak volumes, GLP-1 drug worries and thin dividend raises.',
      tickers: ['PEP', 'TGT', 'CLX', 'KMB', 'HRL', 'KVUE', 'SJM'],
    },
    {
      title: 'Sleep well at night holdings',
      body: 'Johnson & Johnson, Coca-Cola, Procter & Gamble and AbbVie are the names people say they would hold through any market. Expect lower yields than the beaten down staples but fewer surprises.',
      tickers: ['JNJ', 'KO', 'PG', 'ABBV'],
    },
    {
      title: 'Energy and utilities for income',
      body: 'Exxon and Chevron get credit for keeping raises going through oil crashes, and utilities like Con Edison, Eversource and NextEra are used for steady income. The common caution is that both groups are sensitive to commodity prices and rates.',
      tickers: ['XOM', 'CVX', 'ED', 'ES', 'NEE'],
    },
  ],
};

// Plain words and short tickers that would match normal English; these only
// count as mentions with a $ in front or by company name.
const AMBIGUOUS = new Set(['O', 'ED', 'ES', 'GD', 'CL', 'CB', 'LOW', 'CAT', 'BEN', 'KO', 'PG', 'ALL', 'TGT', 'LIN', 'ADP', 'MCD', 'ECL']);
const ALIASES = {
  O: ['Realty Income'], PEP: ['PepsiCo', 'Pepsi'], KO: ['Coca-Cola', 'Coca Cola', 'Coke'], JNJ: ['Johnson & Johnson', 'J&J'], PG: ['Procter', 'P&G'],
  ABBV: ['AbbVie', 'Abbvie'], TGT: [], CLX: ['Clorox'], KMB: ['Kimberly-Clark', 'Kimberly Clark'], HRL: ['Hormel'], KVUE: ['Kenvue'], SJM: ['Smucker'],
  XOM: ['Exxon'], CVX: ['Chevron'], ED: ['Con Ed', 'ConEd', 'Consolidated Edison'], ES: ['Eversource'], NEE: ['NextEra'], MCD: ["McDonald's", 'McDonalds'],
  LOW: ["Lowe's", 'Lowes'], CAT: ['Caterpillar'], WMT: ['Walmart'], IBM: [], MDT: ['Medtronic'], TROW: ['T. Rowe', 'T Rowe'], BEN: ['Franklin Resources'],
  AMCR: ['Amcor'], GPC: ['Genuine Parts'], SWK: ['Stanley Black'], FRT: ['Federal Realty'], ESS: ['Essex Property'], MKC: ['McCormick'], CL: ['Colgate'],
  CB: ['Chubb'], GD: ['General Dynamics'], LIN: ['Linde'], ADP: ['Automatic Data'], ECL: ['Ecolab'], SYY: ['Sysco'], ADM: ['Archer Daniels', 'Archer-Daniels'],
};
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Which aristocrats a post's text mentions (a Set of tickers).
export function mentionsIn(text) {
  const out = new Set();
  const s = String(text || '');
  for (const a of ARISTOCRATS) {
    const t = a.t;
    const pats = [`\\$${reEsc(t)}\\b`];
    if (!AMBIGUOUS.has(t) && t.length >= 3) pats.push(`\\b${reEsc(t)}\\b`);
    for (const al of ALIASES[t] || []) pats.push(`\\b${reEsc(al)}\\b`);
    if (new RegExp(pats.join('|')).test(s)) out.add(t);
  }
  return out;
}

// Counts mentions across Reddit listing children and keeps the top posts that
// name an aristocrat. Duplicate posts (same id in two listings) count once.
export function tallyReddit(listings) {
  const seen = new Set();
  const counts = new Map();
  const posts = [];
  for (const l of listings) {
    for (const c of (l && l.data && l.data.children) || []) {
      const p = c.data || {};
      if (!p.id || seen.has(p.id)) continue;
      seen.add(p.id);
      const hits = mentionsIn(`${p.title || ''}\n${p.selftext || ''}`);
      if (!hits.size) continue;
      for (const t of hits) {
        const cur = counts.get(t) || { t, posts: 0, score: 0 };
        cur.posts++;
        cur.score += Math.max(0, p.score || 0);
        counts.set(t, cur);
      }
      posts.push({
        title: String(p.title || '').slice(0, 200),
        url: p.permalink ? `https://www.reddit.com${p.permalink}` : null,
        score: p.score || 0,
        comments: p.num_comments || 0,
        created: p.created_utc ? p.created_utc * 1000 : null,
        tickers: [...hits],
      });
    }
  }
  return {
    scanned: seen.size,
    tickers: [...counts.values()].sort((a, b) => b.posts - a.posts || b.score - a.score).slice(0, 15),
    posts: posts.sort((a, b) => b.score - a.score).slice(0, 10),
  };
}

const REDDIT_URLS = [
  'https://www.reddit.com/r/dividends/search.json?q=aristocrat&restrict_sr=1&sort=top&t=year&limit=100',
  'https://www.reddit.com/r/dividends/top.json?t=month&limit=100',
];

async function redditListing(url) {
  try {
    return await getJSON(url, { headers: { 'User-Agent': 'web:mokosveri-research:v1 (dividend page)', Accept: 'application/json' } }, 7000);
  } catch (e) {
    // Reddit sometimes refuses one host and not the other.
    return getJSON(url.replace('www.reddit.com', 'old.reddit.com'), { headers: { 'User-Agent': 'web:mokosveri-research:v1 (dividend page)', Accept: 'application/json' } }, 7000);
  }
}

export async function redditBuzz(env) {
  return cached(env, 'div:reddit:v1', 6 * 3600, async () => {
    const got = await Promise.all(REDDIT_URLS.map((u) => settle(redditListing(u))));
    const ok = got.filter((g) => g.ok).map((g) => g.value);
    if (!ok.length) throw new Error(got[0].error || 'Reddit unavailable');
    return { asOf: new Date().toISOString(), ...tallyReddit(ok) };
  });
}

// ---------- prices, yields and returns ----------

const QUOTE_FIELDS = 'regularMarketPrice,regularMarketChangePercent,shortName,trailingAnnualDividendYield,trailingAnnualDividendRate,dividendYield,dividendRate,exDividendDate,dividendDate,trailingPE,marketCap';

async function quotes(env, tickers) {
  const bySym = new Map(tickers.map((t) => [yahooSymbol(t), t]));
  const syms = [...bySym.keys()].map(encodeURIComponent).join(',');
  for (let attempt = 0; attempt < 2; attempt++) {
    const { crumb, cookie } = await getCrumb(env, attempt > 0);
    const r = await fetchWithTimeout(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${syms}&fields=${QUOTE_FIELDS}&crumb=${encodeURIComponent(crumb)}`, { headers: { ...H, Cookie: cookie } }, 8000);
    if (r.status === 401 || r.status === 403) continue;
    if (!r.ok) throw new Error(`Yahoo quote HTTP ${r.status}`);
    const d = await r.json();
    const out = new Map();
    for (const q of (d.quoteResponse && d.quoteResponse.result) || []) {
      const t = bySym.get(q.symbol);
      if (t) out.set(t, q);
    }
    return out;
  }
  throw new Error('Yahoo quote unauthorized');
}

// Spark returns closes for up to 20 symbols per call. Yahoo has served two
// shapes over time; both are read here. Returns Map ticker -> [{t, c}].
export function parseSpark(d, bySym) {
  const out = new Map();
  const put = (sym, ts, closes) => {
    const t = bySym.get(sym);
    if (!t || !ts || !closes) return;
    const pts = [];
    for (let i = 0; i < ts.length; i++) if (closes[i] != null) pts.push({ t: ts[i] * 1000, c: closes[i] });
    if (pts.length) out.set(t, pts);
  };
  if (d && d.spark && Array.isArray(d.spark.result)) {
    for (const r of d.spark.result) {
      const x = r.response && r.response[0];
      if (x) put(r.symbol, x.timestamp, x.indicators && x.indicators.quote && x.indicators.quote[0] && x.indicators.quote[0].close);
    }
  } else if (d && typeof d === 'object') {
    for (const [sym, x] of Object.entries(d)) if (x && x.timestamp) put(sym, x.timestamp, x.close);
  }
  return out;
}

async function histories(env, tickers) {
  const out = new Map();
  const chunks = [];
  for (let i = 0; i < tickers.length; i += 20) chunks.push(tickers.slice(i, i + 20));
  await Promise.all(
    chunks.map(async (c) => {
      const bySym = new Map(c.map((t) => [yahooSymbol(t), t]));
      const syms = [...bySym.keys()].map(encodeURIComponent).join(',');
      const r = await settle(getJSON(`https://query1.finance.yahoo.com/v8/finance/spark?symbols=${syms}&range=5y&interval=1wk`, { headers: H }, 9000));
      if (r.ok) for (const [t, pts] of parseSpark(r.value, bySym)) out.set(t, pts);
    })
  );
  // Per ticker chart fallback for anything spark missed, kept small so the
  // request stays inside the Workers subrequest limit.
  const miss = tickers.filter((t) => !out.has(t)).slice(0, 20);
  await pool(miss, 6, async (t) => {
    const r = await settle(fetchChart(t, '5y', '1wk'));
    if (r.ok) out.set(t, r.value.bars.map((b) => ({ t: b.t * 1000, c: b.c })));
  });
  return out;
}

// Close on or just before time `ms`.
function closeAt(pts, ms) {
  let best = null;
  for (const p of pts) {
    if (p.t <= ms) best = p;
    else break;
  }
  return best;
}

// Price returns in percent: YTD, 1y, 3y and 5y (the last two annualized).
export function priceReturns(pts, price, now = Date.now()) {
  if (!pts || pts.length < 2) return {};
  const last = price ?? pts[pts.length - 1].c;
  const yr = new Date(now).getUTCFullYear();
  const pct = (a) => (a && a.c ? (last / a.c - 1) * 100 : null);
  const ann = (a, years) => (a && a.c && pts[0].t <= now - (years - 0.1) * 365.25 * 864e5 ? ((last / a.c) ** (1 / years) - 1) * 100 : null);
  return {
    ytd: pct(closeAt(pts, Date.UTC(yr, 0, 1) - 1)),
    r1y: pct(closeAt(pts, now - 365.25 * 864e5)),
    r3y: ann(closeAt(pts, now - 3 * 365.25 * 864e5), 3),
    r5y: ann(closeAt(pts, now - 5 * 365.25 * 864e5), 5),
  };
}

const r2 = (x) => (typeof x !== 'number' || !isFinite(x) ? null : Math.round(x * 100) / 100);
// Yahoo sometimes sends {} or strings where numbers belong.
const n = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const pos = (v) => (n(v) != null && v > 0 ? v : null);
const day = (v) => {
  const d = typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : null;
  return d && !isNaN(d) ? d.toISOString().slice(0, 10) : null;
};

// One table row from the static entry, a Yahoo quote and price history.
// `dist` is the fund's cash distributions ({t: epoch seconds, amount}); for
// ETFs the trailing 12 months of those is the yield people quote.
export function rowFor(a, q, pts, now = Date.now(), dist = null) {
  q = q || {};
  const price = pos(q.regularMarketPrice) ?? (pts && pts.length ? pts[pts.length - 1].c : null);
  const cut = now / 1000 - 365 * 86400;
  const ttm = (dist || []).filter((d) => d && n(d.t) != null && d.t >= cut && pos(d.amount)).reduce((s, d) => s + d.amount, 0) || null;
  let yld = null;
  let yieldSrc = 'live';
  const trailingQ = pos(q.trailingAnnualDividendYield) != null ? q.trailingAnnualDividendYield * 100 : null;
  if (a.etf && ttm && price) yld = (ttm / price) * 100;
  else if (pos(q.dividendRate) && price) yld = (q.dividendRate / price) * 100;
  else if (pos(q.dividendYield) != null) yld = q.dividendYield;
  else if (trailingQ != null) yld = trailingQ;
  else if (ttm && price) yld = (ttm / price) * 100;
  if (yld == null && YIELD_FALLBACK[a.t] != null) {
    yld = YIELD_FALLBACK[a.t];
    yieldSrc = 'Oct 23';
  }
  const rt = priceReturns(pts, price, now);
  const trailing = ttm && price ? (ttm / price) * 100 : trailingQ;
  // Approximate total returns: price return plus the trailing yield per year.
  const inc = trailing ?? yld ?? 0;
  const row = {
    t: a.t,
    name: a.name,
    sector: a.sector,
    years: a.years,
    etf: !!a.etf,
    er: a.er ?? null,
    price: r2(price),
    change1d: r2(q.regularMarketChangePercent),
    yield: r2(yld),
    yieldSrc,
    rate: r2(pos(q.dividendRate) ?? pos(q.trailingAnnualDividendRate) ?? ttm),
    pe: r2(q.trailingPE),
    cap: n(q.marketCap),
    exDiv: day(q.exDividendDate) || (dist && dist.length ? day(dist[dist.length - 1].t) : null),
    ytd: r2(rt.ytd),
    r1y: r2(rt.r1y),
    r3y: r2(rt.r3y),
    r5y: r2(rt.r5y),
    tr1y: rt.r1y == null ? null : r2(rt.r1y + inc),
    tr5y: rt.r5y == null ? null : r2(rt.r5y + inc),
    spark: pts ? pts.slice(-52).map((p) => r2(p.c)) : [],
  };
  row.flags = flagsFor(row);
  return row;
}

// Plain warnings the page shows next to a row.
export function flagsFor(r) {
  const f = [];
  if (r.sector === 'Covered call income') f.push({ k: 'cc', text: 'Covered call fund: payouts include option premium, so upside is capped and the payout does not grow like a dividend.' });
  if (r.yield != null && r.yield >= 5 && r.r1y != null && r.r1y <= -15) f.push({ k: 'trap', text: 'Yield is high mostly because the price fell. Check that earnings still cover the dividend.' });
  else if (r.yield != null && r.yield >= 4.5) f.push({ k: 'high', text: 'Well above the group average. Often a sign the market doubts future growth.' });
  if (r.years != null && r.years >= 50) f.push({ k: 'king', text: 'Dividend King: 50 or more years of raises.' });
  return f;
}

// ETF history comes from the chart endpoint, one call each, because it also
// returns the fund's distributions (Yahoo's quote yield is often missing or
// zero for ETFs).
async function etfHistories(env) {
  const out = new Map();
  await pool(ETFS, 6, async (e) => {
    const r = await settle(fetchChart(e.t, '5y', '1wk'));
    if (r.ok) out.set(e.t, { pts: r.value.bars.map((b) => ({ t: b.t * 1000, c: b.c })), dist: r.value.dividends });
  });
  return out;
}

export async function buildDividends(env) {
  return cached(env, 'div:aristocrats:v2', 3 * 3600, async () => {
    const tickers = ARISTOCRATS.map((a) => a.t);
    const [q, h, eh] = await Promise.all([settle(quotes(env, [...tickers, ...ETFS.map((e) => e.t)])), settle(histories(env, tickers)), settle(etfHistories(env))]);
    const qm = q.ok ? q.value : new Map();
    const hm = h.ok ? h.value : new Map();
    const em = eh.ok ? eh.value : new Map();
    if (!qm.size && !hm.size) throw new Error(q.error || h.error || 'No market data');
    const now = Date.now();
    const rows = ARISTOCRATS.map((a) => rowFor(a, qm.get(a.t), hm.get(a.t), now));
    const etfs = ETFS.map((e) => rowFor(e, qm.get(e.t), em.get(e.t) && em.get(e.t).pts, now, em.get(e.t) && em.get(e.t).dist));
    const ylds = rows.map((r) => r.yield).filter((x) => x != null);
    return {
      asOf: new Date(now).toISOString(),
      listChecked: LIST_CHECKED,
      count: rows.length,
      avgYield: ylds.length ? r2(ylds.reduce((s, x) => s + x, 0) / ylds.length) : null,
      quotesOk: q.ok,
      historyCount: hm.size,
      rows,
      etfs,
    };
  });
}

export async function dividendsPage(env) {
  const [d, rd] = await Promise.all([buildDividends(env), settle(redditBuzz(env))]);
  return {
    ...d,
    research: RESEARCH,
    community: COMMUNITY,
    reddit: rd.ok ? { ok: true, ...rd.value } : { ok: false, error: rd.error },
  };
}
