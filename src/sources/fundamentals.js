// Fundamentals for the AI lenses: quarterly revenue and margins from SEC XBRL
// filings, valuation multiples from Yahoo, the closest peers, earnings history
// and estimate revisions, and the text of the latest earnings press release.
import { getJSON, getText, cached, settle, pool } from '../util.js';
import { secHeaders, cikForTicker } from './sec.js';
import { quoteSummaryModules, similarSymbols, raw } from './yahoo.js';

const DAY = 864e5;
const days = (a, b) => (new Date(b) - new Date(a)) / DAY;

// ---------- quarterly series from XBRL facts ----------

// Turns the USD facts of one XBRL concept into discrete quarters. Companies
// report Q1 to Q3 as three month figures but Q4 only inside the annual total,
// so Q4 is derived as the year minus the three quarters inside it.
export function quartersFromFacts(facts, n = 16) {
  const q = new Map();
  const yr = new Map();
  for (const f of facts || []) {
    if (!f || !f.start || !f.end || f.val == null || !isFinite(f.val)) continue;
    const d = days(f.start, f.end);
    const slot = d >= 75 && d <= 105 ? q : d >= 340 && d <= 380 ? yr : null;
    if (!slot) continue;
    const prev = slot.get(f.end);
    if (!prev || String(f.filed || '') >= String(prev.filed || '')) slot.set(f.end, f);
  }
  const out = new Map([...q.values()].map((f) => [f.end, { end: f.end, val: f.val }]));
  for (const y of yr.values()) {
    if (out.has(y.end)) continue;
    const inside = [...q.values()].filter((f) => days(y.start, f.start) >= -5 && days(f.end, y.end) >= 60);
    if (inside.length !== 3) continue;
    out.set(y.end, { end: y.end, val: y.val - inside.reduce((s, f) => s + f.val, 0), derived: true });
  }
  return [...out.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-n);
}

// Merges series from tags a company used over the years (Revenues before
// 2018, the ASC 606 tag after). Earlier tags in the list win on overlap.
export function mergeSeries(list, n = 16) {
  const m = new Map();
  for (const s of list) for (const x of s || []) if (!m.has(x.end)) m.set(x.end, x);
  return [...m.values()].sort((a, b) => a.end.localeCompare(b.end)).slice(-n);
}

const REV_TAGS = ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'];
const TAGS = [...REV_TAGS, 'GrossProfit', 'CostOfRevenue', 'CostOfGoodsAndServicesSold', 'OperatingIncomeLoss', 'NetIncomeLoss'];

async function concept(env, cik, tag) {
  try {
    const d = await getJSON(`https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/us-gaap/${tag}.json`, { headers: secHeaders(env) }, 12000);
    return quartersFromFacts(d.units && d.units.USD);
  } catch {
    return null; // 404 when the company never used this tag
  }
}

// Builds per-quarter rows: revenue, year over year growth, gross and
// operating margin. The last `n` quarters are returned, oldest first.
export function buildQuarterRows(s, n = 12) {
  const rev = s.revenue || [];
  const at = (arr, end) => (arr || []).find((x) => x.end === end);
  const yearBefore = (end) => rev.find((x) => {
    const d = days(x.end, end);
    return d >= 350 && d <= 380;
  });
  const rows = rev.map((r) => {
    const g = at(s.gross, r.end);
    const cost = at(s.cost, r.end);
    const op = at(s.opInc, r.end);
    const ni = at(s.net, r.end);
    const prior = yearBefore(r.end);
    const gp = g ? g.val : cost ? r.val - cost.val : null;
    return {
      end: r.end,
      revenue: r.val,
      revGrowth: prior && prior.val > 0 ? (r.val / prior.val - 1) * 100 : null,
      grossMargin: gp != null && r.val > 0 ? (gp / r.val) * 100 : null,
      opMargin: op && r.val > 0 ? (op.val / r.val) * 100 : null,
      netMargin: ni && r.val > 0 ? (ni.val / r.val) * 100 : null,
      derived: !!r.derived,
    };
  });
  return rows.slice(-n);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

// Plain flags for acceleration or deterioration. Growth compares the last two
// quarters with the two before. Margins compare the last two quarters with
// the same two quarters a year earlier, so seasonality cancels out.
export function trendFlags(rows) {
  const out = [];
  const vals = (k) => rows.map((r) => r[k]);
  const g = vals('revGrowth').filter((v) => v != null);
  if (g.length >= 4) {
    const now = mean(g.slice(-2));
    const before = mean(g.slice(-4, -2));
    const d = now - before;
    out.push({ metric: 'Revenue growth', now, before, change: d, dir: d >= 3 ? 'accelerating' : d <= -3 ? 'decelerating' : 'steady', unit: 'pp' });
  }
  for (const [k, label] of [['grossMargin', 'Gross margin'], ['opMargin', 'Operating margin']]) {
    const v = vals(k);
    if (v.length < 6 || v.slice(-2).some((x) => x == null) || v.slice(-6, -4).some((x) => x == null)) continue;
    const now = mean(v.slice(-2));
    const before = mean(v.slice(-6, -4));
    const d = now - before;
    out.push({ metric: label, now, before, change: d, dir: d >= 1.5 ? 'expanding' : d <= -1.5 ? 'contracting' : 'stable', unit: 'pp' });
  }
  return out;
}

export async function secQuarterly(env, ticker) {
  const info = await cikForTicker(env, ticker);
  if (!info) return null;
  return cached(env, `xq:v1:${info.cik}`, 86400, async () => {
    const res = await pool(TAGS, 4, (t) => concept(env, info.cik, t));
    const by = Object.fromEntries(TAGS.map((t, i) => [t, res[i] && !res[i].error ? res[i] : null]));
    const s = {
      revenue: mergeSeries(REV_TAGS.map((t) => by[t])),
      gross: by.GrossProfit,
      cost: mergeSeries([by.CostOfRevenue, by.CostOfGoodsAndServicesSold]),
      opInc: by.OperatingIncomeLoss,
      net: by.NetIncomeLoss,
    };
    const rows = buildQuarterRows(s);
    return { cik: info.cik, rows, flags: trendFlags(rows) };
  });
}

// ---------- valuation snapshot ----------

const LIGHT = 'price,summaryDetail,defaultKeyStatistics,financialData,quoteType';

export function valuationOf(q, ticker) {
  if (!q) return null;
  const pr = q.price || {};
  const sd = q.summaryDetail || {};
  const ks = q.defaultKeyStatistics || {};
  const fd = q.financialData || {};
  const cap = raw(pr.marketCap);
  const fcf = raw(fd.freeCashflow);
  const de = raw(fd.debtToEquity);
  return {
    ticker,
    name: pr.shortName || pr.longName || ticker,
    type: (q.quoteType && q.quoteType.quoteType) || null,
    price: raw(pr.regularMarketPrice),
    marketCap: cap,
    pe: raw(sd.trailingPE),
    forwardPe: raw(sd.forwardPE) ?? raw(ks.forwardPE),
    ps: raw(sd.priceToSalesTrailing12Months),
    evEbitda: raw(ks.enterpriseToEbitda),
    pb: raw(ks.priceToBook),
    fcfYield: fcf != null && cap ? (fcf / cap) * 100 : null,
    debtToEquity: de != null ? de / 100 : null,
    grossMargin: raw(fd.grossMargins) != null ? raw(fd.grossMargins) * 100 : null,
    opMargin: raw(fd.operatingMargins) != null ? raw(fd.operatingMargins) * 100 : null,
    profitMargin: raw(fd.profitMargins) != null ? raw(fd.profitMargins) * 100 : null,
    revGrowth: raw(fd.revenueGrowth) != null ? raw(fd.revenueGrowth) * 100 : null,
    roe: raw(fd.returnOnEquity) != null ? raw(fd.returnOnEquity) * 100 : null,
    currentRatio: raw(fd.currentRatio),
    totalCash: raw(fd.totalCash),
    totalDebt: raw(fd.totalDebt),
    beta: raw(sd.beta) ?? raw(ks.beta),
    instOwn: raw(ks.heldPercentInstitutions) != null ? raw(ks.heldPercentInstitutions) * 100 : null,
    shortFloat: raw(ks.shortPercentOfFloat) != null ? raw(ks.shortPercentOfFloat) * 100 : null,
  };
}

export async function valuation(env, ticker) {
  const r = await settle(quoteSummaryModules(env, ticker, LIGHT, 'light', 3600));
  return r.ok ? valuationOf(r.value, ticker) : null;
}

// Up to `n` closest listed competitors with their valuation snapshot.
export async function peers(env, ticker, n = 3) {
  const s = await settle(similarSymbols(env, ticker));
  if (!s.ok) return [];
  const cands = s.value.slice(0, n + 3);
  const vals = await pool(cands, 3, (t) => valuation(env, t));
  return vals.filter((v) => v && !v.error && (!v.type || v.type === 'EQUITY')).slice(0, n);
}

// ---------- earnings ----------

const EARN = 'earningsHistory,earningsTrend,calendarEvents,price';

export function earningsOf(q) {
  if (!q) return null;
  const hist = ((q.earningsHistory && q.earningsHistory.history) || [])
    .map((h) => ({
      quarter: raw(h.quarter) ? new Date(raw(h.quarter) * 1000).toISOString().slice(0, 10) : null,
      actual: raw(h.epsActual),
      estimate: raw(h.epsEstimate),
      surprisePct: raw(h.surprisePercent) != null ? raw(h.surprisePercent) * 100 : null,
    }))
    .filter((h) => h.actual != null)
    .sort((a, b) => String(a.quarter).localeCompare(String(b.quarter)));
  const label = { '0q': 'This quarter', '+1q': 'Next quarter', '0y': 'This year', '+1y': 'Next year' };
  const trend = ((q.earningsTrend && q.earningsTrend.trend) || [])
    .filter((t) => label[t.period])
    .map((t) => {
      const et = t.epsTrend || {};
      const now = raw(et.current);
      const ago90 = raw(et['90daysAgo']);
      const ago30 = raw(et['30daysAgo']);
      const rv = t.epsRevisions || {};
      return {
        period: label[t.period],
        end: t.endDate || null,
        eps: raw(t.earningsEstimate && t.earningsEstimate.avg) ?? now,
        epsGrowth: raw(t.growth) != null ? raw(t.growth) * 100 : null,
        revenue: raw(t.revenueEstimate && t.revenueEstimate.avg),
        revGrowth: raw(t.revenueEstimate && t.revenueEstimate.growth) != null ? raw(t.revenueEstimate.growth) * 100 : null,
        change30: now != null && ago30 ? (now / ago30 - 1) * 100 : null,
        change90: now != null && ago90 ? (now / ago90 - 1) * 100 : null,
        up30: raw(rv.upLast30days),
        down30: raw(rv.downLast30days),
      };
    });
  return { history: hist, trend };
}

export async function earnings(env, ticker) {
  const r = await settle(quoteSummaryModules(env, ticker, EARN, 'earn', 3 * 3600));
  return r.ok ? earningsOf(r.value) : null;
}

// Strips an HTML filing down to readable text.
export function htmlToText(html) {
  return String(html || '')
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;|&#xa0;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;|&#8220;|&#8221;/g, '"')
    .replace(/&#39;|&apos;|&#8217;|&#8216;/g, "'")
    .replace(/\s*(&#8212;|&#8211;|&mdash;|&ndash;)\s*/g, ', ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

// The latest 8-K with Item 2.02 (results of operations), and the text of its
// press release exhibit (EX-99.1).
export async function earningsRelease(env, ticker) {
  const info = await cikForTicker(env, ticker);
  if (!info) return null;
  const cikNum = parseInt(info.cik, 10);
  return cached(env, `er:v1:${info.cik}`, 6 * 3600, async () => {
    const d = await getJSON(`https://data.sec.gov/submissions/CIK${info.cik}.json`, { headers: secHeaders(env) });
    const r = d.filings && d.filings.recent;
    if (!r) return { found: false };
    let i = -1;
    for (let k = 0; k < r.form.length; k++) {
      if (r.form[k] === '8-K' && /2\.02/.test((r.items && r.items[k]) || '')) {
        i = k;
        break;
      }
    }
    if (i < 0) return { found: false };
    const acc = r.accessionNumber[i];
    const base = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${acc.replace(/-/g, '')}`;
    let doc = r.primaryDocument[i];
    try {
      const idx = await getJSON(`${base}/index.json`, { headers: secHeaders(env) });
      const items = (idx.directory && idx.directory.item) || [];
      const ex = items.find((x) => /ex-?_?99(\.|_|-)?0?1?/i.test(x.name) && /\.htm/i.test(x.name)) || items.find((x) => /99/.test(x.name) && /\.htm/i.test(x.name));
      if (ex) doc = ex.name;
    } catch {}
    const html = await getText(`${base}/${doc}`, { headers: secHeaders(env) }, 12000);
    return {
      found: true,
      filed: r.filingDate[i],
      url: `${base}/${doc}`,
      text: htmlToText(html).slice(0, 14000),
    };
  });
}
