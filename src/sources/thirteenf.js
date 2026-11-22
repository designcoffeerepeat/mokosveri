// SEC Form 13F-HR: quarterly long positions of large investment managers.
// Free from EDGAR. Filed up to 45 days after quarter end, so it always lags.
import { getJSON, getText, num, clamp, daysBetween } from '../util.js';
import { secHeaders } from './sec.js';

// Notable managers. CIKs are SEC identifiers; names are who people know them by.
export const INVESTORS = [
  { id: 'burry', person: 'Michael Burry', fund: 'Scion Asset Management', cik: '0001649339', style: 'Deep value, contrarian' },
  { id: 'buffett', person: 'Warren Buffett', fund: 'Berkshire Hathaway', cik: '0001067983', style: 'Long term value' },
  { id: 'ackman', person: 'Bill Ackman', fund: 'Pershing Square Capital', cik: '0001336528', style: 'Concentrated activist' },
  { id: 'druckenmiller', person: 'Stanley Druckenmiller', fund: 'Duquesne Family Office', cik: '0001536411', style: 'Global macro' },
  { id: 'tepper', person: 'David Tepper', fund: 'Appaloosa', cik: '0001656456', style: 'Distressed and macro' },
  { id: 'dalio', person: 'Ray Dalio (founder)', fund: 'Bridgewater Associates', cik: '0001350694', style: 'Systematic macro' },
  { id: 'soros', person: 'George Soros', fund: 'Soros Fund Management', cik: '0001029160', style: 'Global macro' },
  { id: 'loeb', person: 'Dan Loeb', fund: 'Third Point', cik: '0001040273', style: 'Event driven activist' },
  { id: 'einhorn', person: 'David Einhorn', fund: 'Greenlight Capital', cik: '0001079114', style: 'Value, long and short' },
  { id: 'klarman', person: 'Seth Klarman', fund: 'Baupost Group', cik: '0001061768', style: 'Deep value' },
];

const ARCHIVE = 'https://www.sec.gov/Archives/edgar/data';

// Latest two original 13F-HR filings (amendments skipped) from the submissions feed.
export function pickFilings(sub) {
  const r = (sub && sub.filings && sub.filings.recent) || {};
  const out = [];
  for (let i = 0; i < (r.form || []).length && out.length < 2; i++) {
    if (r.form[i] !== '13F-HR') continue;
    out.push({ accession: r.accessionNumber[i], filed: r.filingDate[i], period: r.reportDate ? r.reportDate[i] : null });
  }
  return out;
}

const tag = (b, t) => {
  const m = b.match(new RegExp(`<(?:\\w+:)?${t}>\\s*([^<]*)<`, 'i'));
  return m ? m[1].trim().replace(/&amp;/g, '&').replace(/&apos;|&#39;/g, "'") : '';
};

// Parse an information table. Rows for the same security (several managers or
// discretion types) are merged by CUSIP and put or call flag. Values in dollars:
// filings before 2023 reported thousands.
export function parseInfoTable(xml, filedDate = '2024-01-01') {
  const mult = filedDate < '2023-01-03' ? 1000 : 1;
  const map = new Map();
  for (const m of xml.matchAll(/<(?:\w+:)?infoTable>([\s\S]*?)<\/(?:\w+:)?infoTable>/gi)) {
    const b = m[1];
    const cusip = tag(b, 'cusip').toUpperCase();
    const putCall = tag(b, 'putCall').toLowerCase();
    const kind = putCall === 'put' ? 'put' : putCall === 'call' ? 'call' : 'long';
    const key = `${cusip}:${kind}`;
    const value = (num(tag(b, 'value')) || 0) * mult;
    const shares = num(tag(b, 'sshPrnamt')) || 0;
    const prev = map.get(key);
    if (prev) {
      prev.value += value;
      prev.shares += shares;
    } else {
      map.set(key, { key, cusip, name: tag(b, 'nameOfIssuer'), cls: tag(b, 'titleOfClass'), kind, value, shares });
    }
  }
  return [...map.values()];
}

const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);

// Compare two quarters. Returns totals, a stance score in [-1, 1] and the
// biggest moves. The stance mixes two things a 13F can show:
//   flow: net dollars added to long stock (share changes at current prices),
//         as a share of last quarter's long book. Buying is bullish.
//   hedge: put notional minus call notional as a share of the whole book.
//         Heavy puts (Burry style) are bearish.
export function diffHoldings(cur, prev) {
  const prevMap = new Map(prev.map((h) => [h.key, h]));
  const curMap = new Map(cur.map((h) => [h.key, h]));
  const moves = [];
  let flow = 0;
  for (const h of cur) {
    const p = prevMap.get(h.key);
    const px = h.shares ? h.value / h.shares : 0;
    if (!p) {
      moves.push({ action: 'New', name: h.name, kind: h.kind, cusip: h.cusip, value: h.value, change: h.value, pct: null, shares: h.shares });
      if (h.kind === 'long') flow += h.value;
      continue;
    }
    const dSh = h.shares - p.shares;
    const pct = p.shares ? (dSh / p.shares) * 100 : null;
    const dv = dSh * px;
    if (h.kind === 'long') flow += dv;
    if (pct !== null && Math.abs(pct) >= 10) moves.push({ action: dSh > 0 ? 'Added' : 'Trimmed', name: h.name, kind: h.kind, cusip: h.cusip, value: h.value, change: dv, pct, shares: h.shares });
  }
  for (const p of prev) {
    if (curMap.has(p.key)) continue;
    moves.push({ action: 'Exited', name: p.name, kind: p.kind, cusip: p.cusip, value: 0, change: -p.value, pct: -100, shares: 0 });
    if (p.kind === 'long') flow -= p.value;
  }
  moves.sort((a, b) => Math.abs(b.change) - Math.abs(a.change));

  const longNow = sum(cur.filter((h) => h.kind === 'long'), (h) => h.value);
  const longPrev = sum(prev.filter((h) => h.kind === 'long'), (h) => h.value);
  const puts = sum(cur.filter((h) => h.kind === 'put'), (h) => h.value);
  const calls = sum(cur.filter((h) => h.kind === 'call'), (h) => h.value);
  const book = longNow + puts + calls;
  const flowPct = longPrev ? flow / longPrev : 0;
  const hedge = book ? (puts - calls) / book : 0;
  const stance = clamp(2.5 * flowPct - 2 * hedge);
  const top = [...cur].filter((h) => h.kind === 'long').sort((a, b) => b.value - a.value).slice(0, 5).map((h) => ({ name: h.name, value: h.value, weight: longNow ? (h.value / longNow) * 100 : 0 }));
  return {
    totals: { long: longNow, longPrev, puts, calls, positions: cur.length },
    flowPct: flowPct * 100,
    hedgePct: hedge * 100,
    stance,
    moves: moves.slice(0, 12),
    top,
  };
}

// How much a filing still counts. A quarter end within ~4.5 months is fresh.
// After that its weight fades to zero at about 13 months.
export function freshness(period, now = Date.now()) {
  if (!period) return 0;
  const age = daysBetween(period, now);
  if (age <= 135) return 1;
  return clamp(1 - (age - 135) / 265, 0, 1);
}

async function infoTableXml(env, cik, accession) {
  const cikPath = String(parseInt(cik, 10));
  const accPath = accession.replace(/-/g, '');
  const idx = await getJSON(`${ARCHIVE}/${cikPath}/${accPath}/index.json`, { headers: secHeaders(env) });
  const items = (idx.directory && idx.directory.item) || [];
  const xmls = items.filter((it) => /\.xml$/i.test(it.name) && !/primary_doc/i.test(it.name));
  const pick = xmls.find((it) => /info/i.test(it.name)) || xmls.sort((a, b) => num(b.size) - num(a.size))[0];
  if (!pick) throw new Error('No information table in filing');
  return getText(`${ARCHIVE}/${cikPath}/${accPath}/${pick.name}`, { headers: secHeaders(env) }, 20000);
}

// Fetch and summarize one investor. Small result so it caches cheaply.
export async function fetchInvestor(env, inv, known = null) {
  const sub = await getJSON(`https://data.sec.gov/submissions/CIK${inv.cik}.json`, { headers: secHeaders(env) });
  const filings = pickFilings(sub);
  if (!filings.length) throw new Error('No 13F filings found');
  // Same latest filing as last time: nothing to re-parse.
  if (known && known.accession === filings[0].accession) return { ...known, fetchedAt: Date.now() };
  const cur = parseInfoTable(await infoTableXml(env, inv.cik, filings[0].accession), filings[0].filed);
  const prev = filings[1] ? parseInfoTable(await infoTableXml(env, inv.cik, filings[1].accession), filings[1].filed) : [];
  const d = diffHoldings(cur, prev);
  return {
    id: inv.id,
    accession: filings[0].accession,
    filed: filings[0].filed,
    period: filings[0].period,
    prevPeriod: filings[1] ? filings[1].period : null,
    url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${inv.cik}&type=13F-HR&dateb=&owner=include&count=10`,
    ...d,
    fetchedAt: Date.now(),
  };
}

const KEY = (inv) => `13f:v1:${inv.cik}`;
const REFRESH_MS = 12 * 3600e3;

async function readStore(env, key) {
  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT v FROM cache WHERE k = ?').bind(key).first();
      return row ? JSON.parse(row.v) : null;
    }
    if (env.CACHE) return await env.CACHE.get(key, 'json');
  } catch {}
  return null;
}
async function writeStore(env, key, val) {
  try {
    const s = JSON.stringify(val);
    if (env.DB) await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(key, s, Date.now() + 60 * 86400e3).run();
    else if (env.CACHE) await env.CACHE.put(key, s);
  } catch {}
}

// All investors. Each request refreshes at most `budget` stale entries so the
// Worker stays under its per-request fetch limit; the rest serve stored data.
export async function allInvestors(env, budget = 3) {
  const out = [];
  let left = budget;
  for (const inv of INVESTORS) {
    const known = await readStore(env, KEY(inv));
    let data = known;
    let error = null;
    if ((!known || Date.now() - (known.fetchedAt || 0) > REFRESH_MS) && left > 0) {
      left--;
      try {
        data = await fetchInvestor(env, inv, known);
        await writeStore(env, KEY(inv), data);
      } catch (e) {
        error = String(e && e.message ? e.message : e);
      }
    }
    out.push({ ...inv, ...(data || {}), pending: !data, error, weight: data ? freshness(data.period) : 0 });
  }
  return out;
}
