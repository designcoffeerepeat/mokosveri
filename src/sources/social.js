// Social buzz: ApeWisdom (Reddit + 4chan mention counts, free, no key) and
// StockTwits (trending + bullish/bearish tagged messages, free, no key).
import { getJSON, cached, BROWSER_UA } from '../util.js';

const H = { 'User-Agent': BROWSER_UA, Accept: 'application/json' };

export async function apeWisdom(env) {
  return cached(env, 'ape:all', 900, async () => {
    const pages = await Promise.allSettled([1, 2].map((p) => getJSON(`https://apewisdom.io/api/v1.0/filter/all-stocks/page/${p}`, { headers: H })));
    const out = [];
    for (const p of pages) if (p.status === 'fulfilled') out.push(...(p.value.results || []));
    if (!out.length) throw new Error('ApeWisdom unavailable');
    return out.map((r) => ({
      ticker: String(r.ticker).toUpperCase(),
      name: r.name,
      rank: Number(r.rank),
      rank24hAgo: Number(r.rank_24h_ago) || null,
      mentions: Number(r.mentions) || 0,
      mentions24hAgo: Number(r.mentions_24h_ago) || 0,
      upvotes: Number(r.upvotes) || 0,
    }));
  });
}

export async function stocktwitsTrending(env) {
  return cached(env, 'st:trending', 900, async () => {
    const d = await getJSON('https://api.stocktwits.com/api/2/trending/symbols.json', { headers: H });
    return (d.symbols || [])
      .filter((s) => s.symbol && !/\.X$/.test(s.symbol)) // drop crypto
      .map((s) => ({ ticker: s.symbol.toUpperCase(), name: s.title, watchers: s.watchlist_count || 0 }));
  });
}

export async function stocktwitsSentiment(env, ticker) {
  return cached(env, `st:sym:${ticker}`, 900, async () => {
    const d = await getJSON(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(ticker)}.json`, { headers: H });
    const msgs = d.messages || [];
    let bull = 0;
    let bear = 0;
    let newest = null;
    let oldest = null;
    for (const m of msgs) {
      const s = m.entities && m.entities.sentiment && m.entities.sentiment.basic;
      if (s === 'Bullish') bull++;
      else if (s === 'Bearish') bear++;
      const t = m.created_at;
      if (t && (!newest || t > newest)) newest = t;
      if (t && (!oldest || t < oldest)) oldest = t;
    }
    const spanH = newest && oldest ? Math.max(0.1, (new Date(newest) - new Date(oldest)) / 3600000) : null;
    return {
      messages: msgs.length,
      bullish: bull,
      bearish: bear,
      watchers: d.symbol && d.symbol.watchlist_count,
      msgsPerHour: spanH ? +(msgs.length / spanH).toFixed(1) : null,
      sample: msgs.slice(0, 5).map((m) => ({ body: String(m.body || '').slice(0, 220), user: m.user && m.user.username, followers: m.user && m.user.followers, sentiment: m.entities && m.entities.sentiment && m.entities.sentiment.basic, time: m.created_at })),
    };
  });
}

// Lightweight headline sentiment. Finance specific word lists keep it simple and fast.
const POS = ['beat', 'beats', 'surge', 'soar', 'soars', 'jumps', 'rally', 'upgrade', 'upgraded', 'raises', 'raised', 'record', 'outperform', 'buy rating', 'bullish', 'strong', 'growth', 'tops', 'approval', 'approved', 'wins', 'partnership', 'contract', 'buyback', 'breakout', 'higher', 'gains', 'boost', 'expands', 'profit'];
const NEG = ['miss', 'misses', 'plunge', 'plunges', 'sinks', 'falls', 'drop', 'drops', 'downgrade', 'downgraded', 'cuts', 'cut', 'lawsuit', 'probe', 'investigation', 'recall', 'bearish', 'weak', 'loss', 'losses', 'warning', 'warns', 'layoffs', 'fraud', 'sec charges', 'delay', 'halt', 'bankruptcy', 'dilution', 'offering', 'short seller', 'lower', 'slump', 'tumbles'];

export function headlineSentiment(items) {
  let score = 0;
  const scored = items.map((n) => {
    const t = ` ${String(n.title || '').toLowerCase()} `;
    let s = 0;
    for (const w of POS) if (t.includes(` ${w}`)) s++;
    for (const w of NEG) if (t.includes(` ${w}`)) s--;
    score += Math.sign(s);
    return { ...n, tone: Math.sign(s) };
  });
  return { score: items.length ? score / items.length : 0, items: scored };
}
