// SEC EDGAR: Form 4 insider filings (primary source, free, no key).
// SEC asks for a descriptive User-Agent with a contact address and max 10 req/s.
import { getJSON, getText, cached, daysAgo, num, pool } from '../util.js';

export const secHeaders = (env) => ({
  'User-Agent': env.SEC_USER_AGENT || 'Mokosveri Research contact@example.com',
  'Accept-Encoding': 'gzip, deflate',
});

// ---------- Ticker -> CIK ----------

export async function refreshTickerTable(env) {
  const data = await getJSON('https://www.sec.gov/files/company_tickers.json', { headers: secHeaders(env) }, 20000);
  const rows = Object.values(data);
  const stmts = [];
  const stmt = env.DB.prepare('INSERT OR REPLACE INTO tickers (ticker, cik, name) VALUES (?, ?, ?)');
  for (const r of rows) {
    if (!r || !r.ticker) continue;
    stmts.push(stmt.bind(String(r.ticker).toUpperCase(), String(r.cik_str).padStart(10, '0'), r.title || ''));
  }
  for (let i = 0; i < stmts.length; i += 500) await env.DB.batch(stmts.slice(i, i + 500));
  return stmts.length;
}

export async function cikForTicker(env, ticker) {
  const t = ticker.toUpperCase();
  if (env.DB) {
    const row = await env.DB.prepare('SELECT cik, name FROM tickers WHERE ticker = ?').bind(t).first();
    if (row) return row;
    const alt = await env.DB.prepare('SELECT cik, name FROM tickers WHERE ticker = ?').bind(t.replace('.', '-')).first();
    if (alt) return alt;
  }
  // Fallback: EDGAR company browse accepts a ticker in the CIK field.
  return cached(env, `cik:${t}`, 86400 * 30, async () => {
    const xml = await getText(
      `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(t)}&type=4&count=1&output=atom`,
      { headers: secHeaders(env) }
    );
    const cik = (xml.match(/<cik>\s*(\d+)\s*<\/cik>/i) || [])[1];
    const name = (xml.match(/<conformed-name>\s*([^<]+)<\/conformed-name>/i) || [])[1];
    return cik ? { cik: cik.padStart(10, '0'), name: name || '' } : null;
  });
}

// ---------- Form 4 XML parser ----------

function tagVal(block, tag) {
  const re = new RegExp(`<${tag}>\\s*(?:<value>)?\\s*([^<]*)`, 'i');
  const m = block.match(re);
  return m ? decodeXml(m[1].trim()) : '';
}

function decodeXml(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'");
}

const truthy = (v) => v === '1' || /^true$/i.test(v);

// Insider buying rule (applies everywhere on the site): a trade counts as an
// insider purchase only when it is Form 4 code P, an acquisition, at a real
// price above $0.00, and not footnoted as compensation. Code A (grants,
// awards, bonuses) and code M (option exercises, RSU/PSU conversions) never
// count. 10b5-1 plan trades still count but are flagged.
export const PLAN_RE = /10b5-?1/i;
export const COMP_RE = /\b(compensation|bonus|in lieu of|stock awards?|equity awards?|awarded|granted|grants? of|restricted stock|RSUs?|PSUs?|performance (?:stock|shares?|units?)|vest(?:ed|ing)|employee stock purchase|ESPP|director(?:'s|s')? fees?|retainer|incentive (?:plan|award))\b/i;
export function isRealPurchase(t) {
  return !!t && t.code === 'P' && t.ad !== 'D' && Number(t.price) > 0 && Number(t.shares) > 0 && !t.comp;
}

export function parseForm4(xml) {
  const issuerBlock = (xml.match(/<issuer>([\s\S]*?)<\/issuer>/i) || [])[1] || '';
  const ticker = tagVal(issuerBlock, 'issuerTradingSymbol').toUpperCase();
  const issuer = tagVal(issuerBlock, 'issuerName');
  const issuerCik = tagVal(issuerBlock, 'issuerCik');

  const owners = [...xml.matchAll(/<reportingOwner>([\s\S]*?)<\/reportingOwner>/gi)].map((m) => {
    const b = m[1];
    return {
      name: tagVal(b, 'rptOwnerName'),
      cik: tagVal(b, 'rptOwnerCik'),
      isDirector: truthy(tagVal(b, 'isDirector')),
      isOfficer: truthy(tagVal(b, 'isOfficer')),
      isTenPct: truthy(tagVal(b, 'isTenPercentOwner')),
      title: tagVal(b, 'officerTitle'),
    };
  });
  const owner = owners[0] || { name: '', cik: '', isDirector: false, isOfficer: false, isTenPct: false, title: '' };
  const titleParts = [];
  if (owner.title) titleParts.push(owner.title);
  if (owner.isDirector) titleParts.push('Director');
  if (owner.isTenPct) titleParts.push('10% Owner');

  // Footnotes by id. A transaction's own footnotes (on its code, shares or
  // price, not on holdings after it) tell us whether a code P line was really
  // compensation and whether it ran under a 10b5-1 plan.
  const aff = truthy(tagVal(xml, 'aff10b5One'));
  const footBlock = (xml.match(/<footnotes>([\s\S]*?)<\/footnotes>/i) || [])[1] || '';
  const notes = new Map([...footBlock.matchAll(/<footnote\s+id="([^"]+)"[^>]*>([\s\S]*?)<\/footnote>/gi)].map((m) => [m[1], decodeXml(m[2].replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim()]));
  const plan = aff || PLAN_RE.test(footBlock);

  const txs = [...xml.matchAll(/<nonDerivativeTransaction>([\s\S]*?)<\/nonDerivativeTransaction>/gi)].map((m) => {
    const b = m[1];
    const shares = num(tagVal(b, 'transactionShares'));
    const price = num(tagVal(b, 'transactionPricePerShare'));
    const own = b.replace(/<postTransactionAmounts>[\s\S]*?<\/postTransactionAmounts>|<ownershipNature>[\s\S]*?<\/ownershipNature>/gi, '');
    const ids = [...own.matchAll(/<footnoteId\s+id="([^"]+)"/gi)].map((x) => x[1]);
    const text = ids.map((id) => notes.get(id) || '').join(' ');
    return {
      code: tagVal(b, 'transactionCode').toUpperCase(),
      ad: tagVal(b, 'transactionAcquiredDisposedCode').toUpperCase(),
      date: tagVal(b, 'transactionDate').slice(0, 10),
      shares,
      price,
      value: shares && price ? shares * price : 0,
      ownedAfter: num(tagVal(b, 'sharesOwnedFollowingTransaction')),
      // The box on the form, the trade's own footnote, or a 10b5-1 note in a
      // filing whose trade lines carry no footnotes of their own.
      plan10b5: aff || PLAN_RE.test(text) || (!ids.length && PLAN_RE.test(footBlock)),
      comp: COMP_RE.test(text),
      footnote: text.slice(0, 300),
    };
  });

  return {
    ticker,
    issuer,
    issuerCik,
    owner: owners.map((o) => o.name).filter(Boolean).join('; ') || owner.name,
    ownerCik: owner.cik,
    title: titleParts.join(', '),
    isDirector: owner.isDirector,
    isOfficer: owner.isOfficer,
    isTenPct: owner.isTenPct,
    plan10b5: plan,
    transactions: txs,
  };
}

function rawDocPath(primaryDocument) {
  // submissions JSON gives the XSL-rendered path (xslF345X05/form4.xml); raw XML drops the prefix.
  return String(primaryDocument || '').replace(/^xsl[^/]+\//i, '');
}

// ---------- Per-company insider activity (used by ticker analysis) ----------

export async function companyInsiders(env, ticker, days = 30) {
  const info = await cikForTicker(env, ticker);
  if (!info) return { available: false, reason: 'No SEC filer found (ETFs and foreign issuers usually have no Form 4s).' };
  const cikNum = parseInt(info.cik, 10);
  const subs = await cached(env, `subs:${cikNum}`, 900, async () => {
    const d = await getJSON(`https://data.sec.gov/submissions/CIK${info.cik}.json`, { headers: secHeaders(env) });
    const r = d.filings && d.filings.recent;
    if (!r) return { list: [] };
    const cutoff = daysAgo(60);
    const list = [];
    for (let i = 0; i < r.form.length; i++) {
      if ((r.form[i] === '4' || r.form[i] === '4/A') && r.filingDate[i] >= cutoff) {
        list.push({ acc: r.accessionNumber[i], filed: r.filingDate[i], doc: r.primaryDocument[i] });
      }
    }
    return { name: d.name, list };
  });

  const cutoff = daysAgo(days);
  const recent = subs.list.filter((f) => f.filed >= cutoff).slice(0, 24);
  const parsed = await pool(recent, 6, async (f) =>
    cached(env, `f4v2:${f.acc}`, 86400 * 45, async () => {
      const url = `https://www.sec.gov/Archives/edgar/data/${cikNum}/${f.acc.replace(/-/g, '')}/${rawDocPath(f.doc)}`;
      const xml = await getText(url, { headers: secHeaders(env) });
      const p = parseForm4(xml);
      return { ...p, accession: f.acc, filed: f.filed, url: `https://www.sec.gov/Archives/edgar/data/${cikNum}/${f.acc.replace(/-/g, '')}/${f.acc}-index.htm` };
    })
  );

  const rows = [];
  for (const p of parsed) {
    if (!p || p.error || !p.transactions) continue;
    for (const t of p.transactions) {
      // Open-market sells, and buys that pass the insider buying rule.
      if (t.code !== 'S' && !isRealPurchase(t)) continue;
      if (t.date && t.date < cutoff) continue;
      rows.push({
        owner: p.owner,
        title: p.title,
        isOfficer: p.isOfficer,
        isDirector: p.isDirector,
        isTenPct: p.isTenPct,
        code: t.code,
        date: t.date,
        filed: p.filed,
        shares: t.shares,
        price: t.price,
        value: t.value,
        ownedAfter: t.ownedAfter,
        plan10b5: t.plan10b5 != null ? t.plan10b5 : p.plan10b5,
        url: p.url,
      });
    }
  }
  rows.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  return { available: true, cik: info.cik, name: subs.name || info.name, filingsChecked: recent.length, transactions: rows };
}

// ---------- Market-wide ingestion (cron) ----------

async function eftsPage(env, start, end, from) {
  const url = `https://efts.sec.gov/LATEST/search-index?forms=4&startdt=${start}&enddt=${end}&from=${from}`;
  const d = await getJSON(url, { headers: secHeaders(env) });
  const hits = (d.hits && d.hits.hits) || [];
  return {
    total: (d.hits && d.hits.total && d.hits.total.value) || 0,
    items: hits.map((h) => {
      const [acc, file] = String(h._id).split(':');
      const s = h._source || {};
      return { acc: s.adsh || acc, file, ciks: s.ciks || [], filed: s.file_date, form: s.form || s.file_type };
    }),
  };
}

async function getState(env, k, dflt) {
  const r = await env.DB.prepare('SELECT v FROM kvstate WHERE k = ?').bind(k).first();
  return r ? JSON.parse(r.v) : dflt;
}
async function setState(env, k, v) {
  await env.DB.prepare('INSERT OR REPLACE INTO kvstate (k, v) VALUES (?, ?)').bind(k, JSON.stringify(v)).run();
}

// Pulls newest Form 4s (today/yesterday) plus walks a backfill cursor across the last N days.
export async function ingestForm4(env) {
  const perRun = parseInt(env.FORM4_PER_RUN || '35', 10);
  const days = parseInt(env.INSIDER_DAYS || '30', 10);
  const today = daysAgo(0);
  const candidates = [];
  const log = {};

  // 1) Freshest page
  try {
    const p = await eftsPage(env, daysAgo(2), today, 0);
    candidates.push(...p.items);
    log.fresh = p.items.length;
  } catch (e) {
    log.freshError = String(e.message || e);
  }

  // 2) Backfill cursor: one day at a time, newest to oldest
  let cur = await getState(env, 'form4_cursor', { date: daysAgo(1), from: 0 });
  if (cur.date < daysAgo(days)) cur = { date: daysAgo(1), from: 0, wrapped: true };
  try {
    const p = await eftsPage(env, cur.date, cur.date, cur.from);
    candidates.push(...p.items);
    const next = cur.from + p.items.length;
    if (!p.items.length || next >= p.total) cur = { date: daysAgo(1, new Date(cur.date + 'T12:00:00Z')), from: 0 };
    else cur = { date: cur.date, from: next };
    await setState(env, 'form4_cursor', cur);
    log.backfill = { ...cur, got: p.items.length, total: p.total };
  } catch (e) {
    log.backfillError = String(e.message || e);
  }

  // Dedupe and drop already processed
  const seen = new Set();
  const uniq = candidates.filter((c) => c.acc && !seen.has(c.acc) && seen.add(c.acc));
  const todo = [];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const q = `SELECT accession FROM processed WHERE accession IN (${chunk.map(() => '?').join(',')})`;
    const done = await env.DB.prepare(q).bind(...chunk.map((c) => c.acc)).all();
    const doneSet = new Set((done.results || []).map((r) => r.accession));
    for (const c of chunk) if (!doneSet.has(c.acc)) todo.push(c);
  }
  const batch = todo.slice(0, perRun);
  log.todo = todo.length;

  const ins = env.DB.prepare(
    `INSERT OR IGNORE INTO insider_tx (accession, ticker, issuer, issuer_cik, owner, owner_cik, title, is_director, is_officer, is_ten_pct, code, ad, tx_date, filed_date, shares, price, value, owned_after, plan_10b5)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const mark = env.DB.prepare('INSERT OR REPLACE INTO processed (accession, filed_date, status) VALUES (?, ?, ?)');

  const results = await pool(batch, 6, async (c) => {
    let file = c.file;
    const cikPath = parseInt(c.ciks[0] || '0', 10);
    const accPath = c.acc.replace(/-/g, '');
    if (!file || !/\.xml$/i.test(file)) {
      const idx = await getJSON(`https://www.sec.gov/Archives/edgar/data/${cikPath}/${accPath}/index.json`, { headers: secHeaders(env) });
      const f = (idx.directory && idx.directory.item || []).find((i) => /\.xml$/i.test(i.name) && !/^xsl/i.test(i.name));
      if (!f) return { c, p: null };
      file = f.name;
    }
    const xml = await getText(`https://www.sec.gov/Archives/edgar/data/${cikPath}/${accPath}/${file.replace(/^xsl[^/]+\//i, '')}`, { headers: secHeaders(env) });
    return { c, p: parseForm4(xml) };
  });

  const stmts = [];
  let txCount = 0;
  for (const r of results) {
    if (!r || r.error) continue;
    const { c, p } = r;
    stmts.push(mark.bind(c.acc, c.filed || today, p ? 'ok' : 'skip'));
    if (!p) continue;
    for (const t of p.transactions) {
      if (t.code !== 'S' && !isRealPurchase(t)) continue;
      txCount++;
      stmts.push(
        ins.bind(c.acc, p.ticker || null, p.issuer, p.issuerCik, p.owner, p.ownerCik, p.title, p.isDirector ? 1 : 0, p.isOfficer ? 1 : 0, p.isTenPct ? 1 : 0, t.code, t.ad, t.date, c.filed || today, t.shares, t.price, t.value, t.ownedAfter, t.plan10b5 ? 1 : 0)
      );
    }
  }
  if (stmts.length) await env.DB.batch(stmts);
  log.processed = results.filter((r) => r && !r.error).length;
  log.errors = results.filter((r) => r && r.error).length;
  log.transactions = txCount;
  return log;
}

// Aggregated recent open-market buying from the D1 store.
export async function recentInsiderBuys(env, days = 30, limit = 25) {
  const since = daysAgo(days);
  const q = `SELECT ticker, MAX(issuer) AS issuer, COUNT(DISTINCT owner_cik) AS buyers, SUM(value) AS total_value,
      SUM(shares) AS total_shares, MAX(tx_date) AS last_date,
      SUM(plan_10b5) AS plan_buys,
      SUM(CASE WHEN title LIKE '%CEO%' OR title LIKE '%Chief Executive%' OR title LIKE '%CFO%' OR title LIKE '%Chief Financial%' OR title LIKE '%President%' OR title LIKE '%Chair%' THEN 1 ELSE 0 END) AS csuite,
      GROUP_CONCAT(DISTINCT owner) AS owners
    FROM insider_tx WHERE code = 'P' AND tx_date >= ? AND ticker IS NOT NULL AND ticker != '' AND ticker != 'NONE' AND price > 0 AND value > 0
    GROUP BY ticker ORDER BY buyers DESC, total_value DESC LIMIT ?`;
  const r = await env.DB.prepare(q).bind(since, limit).all();
  return (r.results || []).map((x) => ({ ...x, source: 'SEC Form 4' }));
}

export async function tickerInsiderFromDb(env, ticker, days = 30) {
  const r = await env.DB.prepare(
    `SELECT owner, title, is_officer, is_director, is_ten_pct, code, tx_date, filed_date, shares, price, value, owned_after, plan_10b5, accession
     FROM insider_tx WHERE ticker = ? AND tx_date >= ? AND (code != 'P' OR price > 0) ORDER BY tx_date DESC LIMIT 100`
  )
    .bind(ticker, daysAgo(days))
    .all();
  return r.results || [];
}

export async function pruneOld(env) {
  await env.DB.prepare('DELETE FROM cache WHERE exp < ?').bind(Date.now()).run();
  await env.DB.prepare('DELETE FROM insider_tx WHERE tx_date < ?').bind(daysAgo(120)).run();
  await env.DB.prepare('DELETE FROM processed WHERE filed_date < ?').bind(daysAgo(60)).run();
}
