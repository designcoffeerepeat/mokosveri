// Full insider buying and Congress trades lists for the #/trades page. The
// home page shows the top of each list; this returns everything in the window.
import { settle, daysAgo, cleanTicker } from './util.js';
import { openInsiderPurchases } from './sources/openinsider.js';
import { congressAll } from './sources/congress.js';

export const TRADES_KEY = 'trades:v1';
export const CONGRESS_DAYS = 90;

const CSUITE = /CEO|Chief Exec|CFO|Chief Fin|Pres|Chair|COO|Chief Oper/i;

// One row per Form 4 filing and insider from our SEC store. A filing often
// lists a purchase in several lines (one per price), so they are summed.
export async function dbPurchases(env, days) {
  if (!env.DB) return [];
  const r = await env.DB.prepare(
    `SELECT accession, ticker, MAX(issuer) AS company, owner, MAX(title) AS title, MAX(tx_date) AS date, MAX(filed_date) AS filed,
       SUM(shares) AS qty, SUM(value) AS value, MAX(owned_after) AS owned_after, MAX(plan_10b5) AS plan
     FROM insider_tx WHERE code = 'P' AND tx_date >= ? AND ticker IS NOT NULL AND ticker != '' AND ticker != 'NONE' AND price > 0 AND value > 0
     GROUP BY accession, owner_cik, ticker ORDER BY date DESC LIMIT 3000`
  )
    .bind(daysAgo(days))
    .all();
  return (r.results || []).map((x) => ({
    ticker: x.ticker,
    company: x.company || '',
    owner: x.owner || '',
    title: x.title || '',
    date: x.date || '',
    filed: x.filed || '',
    qty: x.qty || 0,
    price: x.qty ? x.value / x.qty : null,
    value: x.value || 0,
    ownedAfter: x.owned_after || null,
    deltaOwn: x.owned_after && x.qty && x.owned_after > x.qty ? `+${Math.round((x.qty / (x.owned_after - x.qty)) * 100)}%` : x.owned_after && x.qty ? 'New' : '',
    accession: x.accession,
    code: 'P',
    plan10b5: !!x.plan,
    source: 'SEC',
  }));
}

const dayNum = (d) => (d ? Date.parse(d) / 864e5 : NaN);

// Both feeds describe the same filings. A row from OpenInsider counts as a
// duplicate when the SEC store has the same ticker, a trade date within 3 days
// and a dollar value within 3%. SEC rows win since they link to the filing.
export function mergePurchases(sec, oi) {
  const byT = new Map();
  for (const r of sec) {
    if (!byT.has(r.ticker)) byT.set(r.ticker, []);
    byT.get(r.ticker).push(r);
  }
  const out = [...sec];
  for (const r of oi) {
    const t = cleanTicker(r.ticker);
    if (!t || !r.value) continue;
    const dup = (byT.get(t) || []).some((s) => Math.abs(dayNum(s.date) - dayNum(r.date)) <= 3 && Math.abs(s.value - Math.abs(r.value)) <= Math.max(1, Math.abs(r.value)) * 0.03);
    if (dup) continue;
    out.push({
      ticker: t,
      company: r.company || '',
      owner: r.owner || '',
      title: r.title || '',
      date: r.date || '',
      filed: r.filed || '',
      qty: Math.abs(r.qty || 0),
      price: r.price || null,
      value: Math.abs(r.value),
      ownedAfter: null,
      deltaOwn: r.deltaOwn || '',
      accession: null,
      code: 'P',
      plan10b5: null, // OpenInsider does not report the 10b5-1 box
      source: 'OpenInsider',
    });
  }
  return out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || b.value - a.value);
}

const ownerKey = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, '').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');

// Purchases grouped by company, most insiders first, then dollars.
export function groupByCompany(rows) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.ticker) || { ticker: r.ticker, issuer: r.company, owners: new Map(), total_value: 0, last_date: '', csuite: 0, trades: 0 };
    const k = ownerKey(r.owner);
    if (!g.owners.has(k)) {
      g.owners.set(k, r.owner);
      if (CSUITE.test(r.title)) g.csuite++;
    }
    g.total_value += r.value || 0;
    g.trades++;
    if ((r.date || '') > g.last_date) g.last_date = r.date;
    if (!g.issuer && r.company) g.issuer = r.company;
    by.set(r.ticker, g);
  }
  return [...by.values()]
    .map((g) => ({ ticker: g.ticker, issuer: g.issuer, buyers: g.owners.size, total_value: g.total_value, last_date: g.last_date, csuite: g.csuite, trades: g.trades, owners: [...g.owners.values()].join(', ') }))
    .sort((a, b) => b.buyers - a.buyers || b.total_value - a.total_value);
}

export async function buildTrades(env) {
  const days = parseInt(env.INSIDER_DAYS || '30', 10);
  const [sec, oi, cong] = await Promise.all([settle(dbPurchases(env, days)), settle(openInsiderPurchases(days)), settle(congressAll(env, CONGRESS_DAYS))]);
  const purchases = mergePurchases(sec.ok ? sec.value : [], oi.ok ? oi.value : []);
  return {
    updated: new Date().toISOString(),
    insiderDays: days,
    congressDays: CONGRESS_DAYS,
    purchases,
    companies: groupByCompany(purchases),
    congress: cong.ok ? cong.value : [],
    status: {
      secStore: sec.ok ? sec.value.length : sec.error,
      openInsider: oi.ok ? oi.value.length : oi.error,
      congress: cong.ok ? 'ok' : cong.error,
    },
  };
}
