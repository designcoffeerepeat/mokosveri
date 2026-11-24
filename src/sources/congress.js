// Congressional trades (STOCK Act disclosures).
// Order of preference:
//   1) Quiver Quantitative API (QUIVER_API_KEY secret, paid hobby tier)
//   2) Financial Modeling Prep API (FMP_API_KEY secret)
//   3) Capitol Trades public site API (free, unofficial, best effort)
import { getJSON, cached, BROWSER_UA, daysAgo } from '../util.js';

function norm(t) {
  return {
    member: t.member,
    chamber: t.chamber || '',
    party: t.party || '',
    ticker: String(t.ticker || '').toUpperCase().replace(/:US$/, ''),
    type: /purch|buy/i.test(t.type) ? 'buy' : /sale|sell/i.test(t.type) ? 'sell' : String(t.type || '').toLowerCase(),
    amount: t.amount || '',
    amountMin: t.amountMin || amountFloor(t.amount),
    txDate: (t.txDate || '').slice(0, 10),
    filedDate: (t.filedDate || '').slice(0, 10),
    source: t.source,
  };
}

function amountFloor(s) {
  const m = String(s || '').replace(/,/g, '').match(/\$?(\d+)/);
  return m ? Number(m[1]) : 0;
}

async function quiverRecent(env) {
  const d = await getJSON('https://api.quiverquant.com/beta/live/congresstrading', {
    headers: { Authorization: `Bearer ${env.QUIVER_API_KEY}`, Accept: 'application/json' },
  });
  return d.map((x) =>
    norm({ member: x.Representative, chamber: x.House, party: x.Party, ticker: x.Ticker, type: x.Transaction, amount: x.Range || x.Amount, txDate: x.TransactionDate, filedDate: x.ReportDate, source: 'Quiver' })
  );
}

async function fmpRecent(env, page = 0) {
  const [s, h] = await Promise.all([
    getJSON(`https://financialmodelingprep.com/stable/senate-latest?page=${page}&limit=100&apikey=${env.FMP_API_KEY}`),
    getJSON(`https://financialmodelingprep.com/stable/house-latest?page=${page}&limit=100&apikey=${env.FMP_API_KEY}`),
  ]);
  const map = (arr, chamber) =>
    (arr || []).map((x) =>
      norm({ member: `${x.firstName || ''} ${x.lastName || ''}`.trim() || x.office, chamber, ticker: x.symbol, type: x.type, amount: x.amount, txDate: x.transactionDate, filedDate: x.disclosureDate, source: 'FMP' })
    );
  return [...map(s, 'Senate'), ...map(h, 'House')];
}

async function capitolTradesRecent(env, page = 1) {
  const d = await getJSON(`https://bff.capitoltrades.com/trades?per_page=100&page=${page}&sortBy=-pubDate`, {
    headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json', Origin: 'https://www.capitoltrades.com', Referer: 'https://www.capitoltrades.com/' },
  });
  return (d.data || []).map((x) =>
    norm({
      member: x.politician ? `${x.politician.firstName || ''} ${x.politician.lastName || ''}`.trim() : '',
      chamber: x.politician && x.politician.chamber,
      party: x.politician && x.politician.party,
      ticker: x.issuer && x.issuer.issuerTicker,
      type: x.txType,
      amount: x.value ? `~$${Number(x.value).toLocaleString('en-US')}` : '',
      amountMin: x.value || 0,
      txDate: x.txDate,
      filedDate: x.pubDate,
      source: 'Capitol Trades',
    })
  );
}

export async function congressRecent(env, days = 45) {
  return cached(env, 'congress:recent', 3600, async () => {
    const tries = [];
    if (env.QUIVER_API_KEY) tries.push(quiverRecent);
    if (env.FMP_API_KEY) tries.push(fmpRecent);
    tries.push(capitolTradesRecent);
    let lastErr;
    for (const fn of tries) {
      try {
        const rows = (await fn(env)).filter((r) => r.ticker && /^[A-Z.\-]{1,6}$/.test(r.ticker));
        const since = daysAgo(days);
        // Keep trades disclosed recently. Members have up to 45 days to report, so we key on the filing date.
        return rows.filter((r) => (r.filedDate || r.txDate) >= since);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No congressional source');
  });
}

export async function congressForTicker(env, ticker, days = 90) {
  if (env.QUIVER_API_KEY) {
    try {
      return await cached(env, `congress:${ticker}`, 3600, async () => {
        const d = await getJSON(`https://api.quiverquant.com/beta/historical/congresstrading/${encodeURIComponent(ticker)}`, {
          headers: { Authorization: `Bearer ${env.QUIVER_API_KEY}`, Accept: 'application/json' },
        });
        const since = daysAgo(days);
        return d
          .map((x) => norm({ member: x.Representative, chamber: x.House, party: x.Party, ticker, type: x.Transaction, amount: x.Range || x.Amount, txDate: x.TransactionDate, filedDate: x.ReportDate, source: 'Quiver' }))
          .filter((r) => (r.filedDate || r.txDate) >= since);
      });
    } catch {}
  }
  const all = await congressRecent(env);
  return all.filter((r) => r.ticker === ticker);
}

// Several pages from one source, merged. A page that fails after the first is
// skipped so a flaky later page never hides the rows already fetched.
async function pages(fn, env, first, count) {
  const out = await Promise.allSettled(Array.from({ length: count }, (_, i) => fn(env, first + i)));
  if (out[0].status === 'rejected') throw out[0].reason;
  return out.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
}

const tradeKey = (r) => [r.member, r.ticker, r.type, r.txDate, r.amount].join('|').toLowerCase();

// Every trade disclosed in the last `days` days, for the full trades page.
// Pulls more than the one page the buzz board uses.
export async function congressAll(env, days = 90) {
  return cached(env, `congress:all:${days}`, 3600, async () => {
    const tries = [];
    if (env.QUIVER_API_KEY) tries.push(() => quiverRecent(env));
    if (env.FMP_API_KEY) tries.push(() => pages(fmpRecent, env, 0, 3));
    tries.push(() => pages(capitolTradesRecent, env, 1, 5));
    let lastErr;
    const since = daysAgo(days);
    for (const fn of tries) {
      try {
        const seen = new Set();
        const rows = (await fn())
          .filter((r) => r.ticker && /^[A-Z.\-]{1,6}$/.test(r.ticker) && (r.filedDate || r.txDate) >= since)
          .filter((r) => {
            const k = tradeKey(r);
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
          });
        return rows.sort((a, b) => (b.filedDate || '').localeCompare(a.filedDate || '') || (b.txDate || '').localeCompare(a.txDate || ''));
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error('No congressional source');
  });
}
