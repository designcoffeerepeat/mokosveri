// OpenInsider: a free, widely used mirror of SEC Form 4 data. Used as a fast
// secondary source for market-wide open-market purchases (one request covers 30 days).
import { getText, num, BROWSER_UA, daysAgo } from '../util.js';

function stripTags(s) {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .trim();
}

export function parseOpenInsiderTable(html) {
  const table = (html.match(/<table[^>]*class="tinytable"[^>]*>([\s\S]*?)<\/table>/i) || [])[1];
  if (!table) return [];
  const headRow = (table.match(/<thead>([\s\S]*?)<\/thead>/i) || [])[1] || '';
  const headers = [...headRow.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => stripTags(m[1]).replace(/\s+/g, ' ').toLowerCase());
  const body = (table.match(/<tbody>([\s\S]*?)<\/tbody>/i) || [])[1] || '';
  const rows = [];
  for (const tr of body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1]));
    if (cells.length < 6) continue;
    const get = (name) => {
      const i = headers.findIndex((h) => h === name || h.startsWith(name));
      return i >= 0 ? cells[i] : '';
    };
    rows.push({
      filed: get('filing date').slice(0, 10),
      date: get('trade date').slice(0, 10),
      ticker: get('ticker').toUpperCase(),
      company: get('company name') || get('company'),
      owner: get('insider name'),
      title: get('title'),
      type: get('trade type'),
      price: num(get('price')),
      qty: num(get('qty')),
      deltaOwn: get('δown') || get('own chg') || get('Δown'.toLowerCase()),
      value: num(get('value')),
      insiders: num(get('ins')),
    });
  }
  return rows;
}

export async function openInsiderPurchases(days = 30) {
  const url =
    `https://openinsider.com/screener?s=&o=&pl=&ph=&ll=&lh=&fd=${days}&fdr=&td=0&tdr=&fdlyl=&fdlyh=&daysago=&xp=1&vl=25&vh=&ocl=&och=&sic1=-1&sicl=100&sich=9999&grp=0&nfl=&nfh=&nil=&nih=&nol=&noh=&v2l=&v2h=&oc2l=&oc2h=&sortcol=0&cnt=500&page=1`;
  const html = await getText(url, { headers: { 'User-Agent': BROWSER_UA } }, 12000);
  const since = daysAgo(days);
  return parseOpenInsiderTable(html).filter((r) => r.ticker && /P/.test(r.type) && (!r.date || r.date >= since));
}

// Group raw purchase rows by ticker.
export function aggregatePurchases(rows) {
  const by = new Map();
  for (const r of rows) {
    const g = by.get(r.ticker) || { ticker: r.ticker, issuer: r.company, owners: new Set(), total_value: 0, last_date: '', csuite: 0, rows: [] };
    g.owners.add(r.owner);
    g.total_value += r.value || 0;
    if ((r.date || '') > g.last_date) g.last_date = r.date;
    if (/CEO|CFO|Pres|Chair|COO/i.test(r.title)) g.csuite++;
    g.rows.push(r);
    by.set(r.ticker, g);
  }
  return [...by.values()]
    .map((g) => ({ ticker: g.ticker, issuer: g.issuer, buyers: g.owners.size, total_value: g.total_value, last_date: g.last_date, csuite: g.csuite, owners: [...g.owners].join(', '), source: 'OpenInsider' }))
    .sort((a, b) => b.buyers - a.buyers || b.total_value - a.total_value);
}
