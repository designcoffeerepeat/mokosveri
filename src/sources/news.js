// Latest news for a ticker from three free feeds, merged and de-duplicated:
// Yahoo Finance search API, Yahoo Finance RSS, and Google News RSS.
// Each headline gets a tone (positive / negative / neutral), from Workers AI
// when available and a finance word list otherwise.
import { getJSON, getText, cached, BROWSER_UA, settle } from '../util.js';

const H = { 'User-Agent': BROWSER_UA };

function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseRss(xml) {
  return [...String(xml).matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => {
    const b = m[1];
    const get = (t) => decode((b.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`, 'i')) || [])[1]);
    const pub = get('pubDate');
    return { title: get('title'), link: get('link'), time: pub ? new Date(pub).toISOString() : null, source: get('source'), description: get('description') };
  });
}

async function yahooSearch(ticker) {
  const d = await getJSON(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(ticker)}&quotesCount=0&newsCount=15&enableFuzzyQuery=false`, { headers: { ...H, Accept: 'application/json' } });
  return (d.news || []).map((n) => ({
    title: n.title,
    publisher: n.publisher,
    link: n.link,
    time: n.providerPublishTime ? new Date(n.providerPublishTime * 1000).toISOString() : null,
    via: 'Yahoo Finance',
  }));
}

async function yahooRss(ticker) {
  const xml = await getText(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`, { headers: H });
  return parseRss(xml).map((i) => ({ title: i.title, publisher: 'Yahoo Finance', link: i.link, time: i.time, via: 'Yahoo Finance RSS' }));
}

async function googleNews(ticker, name) {
  const q = name ? `"${ticker}" OR "${name.replace(/[,.]? (Inc|Corp|Corporation|Ltd|plc|Co|Holdings|Group)\.?$/i, '')}" stock when:7d` : `${ticker} stock when:7d`;
  const xml = await getText(`https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`, { headers: H });
  return parseRss(xml)
    .slice(0, 20)
    .map((i) => {
      // Google appends " - Publisher" to titles
      const m = i.title.match(/^(.*) - ([^-]{2,60})$/);
      return { title: m ? m[1] : i.title, publisher: i.source || (m ? m[2] : 'Google News'), link: i.link, time: i.time, via: 'Google News' };
    });
}

const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);

export async function latestNews(env, ticker, name = '') {
  return cached(env, `news2:${ticker}`, 1200, async () => {
    const res = await Promise.all([settle(yahooSearch(ticker)), settle(yahooRss(ticker)), settle(googleNews(ticker, name))]);
    const seen = new Set();
    const all = [];
    for (const r of res) {
      if (!r.ok) continue;
      for (const n of r.value) {
        const k = norm(n.title);
        if (!n.title || !k || seen.has(k)) continue;
        seen.add(k);
        all.push(n);
      }
    }
    const cutoff = Date.now() - 10 * 864e5;
    const items = all
      .filter((n) => !n.time || new Date(n.time).getTime() >= cutoff)
      .sort((a, b) => (b.time || '').localeCompare(a.time || ''))
      .slice(0, 20);
    return { items, sources: { yahoo: res[0].ok, yahooRss: res[1].ok, google: res[2].ok } };
  });
}

// ---------- tone ----------
const POS = [
  'beat', 'beats', 'surge', 'surges', 'soar', 'soars', 'jump', 'jumps', 'rally', 'rallies', 'upgrade', 'upgraded', 'upgrades', 'raises guidance', 'raised guidance', 'raises outlook',
  'record', 'outperform', 'bullish', 'strong demand', 'tops estimates', 'approval', 'approved', 'fda clears', 'wins', 'win', 'partnership', 'contract', 'buyback', 'repurchase',
  'breakout', 'gains', 'boost', 'boosts', 'expands', 'profit rises', 'dividend increase', 'hikes dividend', 'price target raised', 'raises price target', 'all-time high', 'acquire', 'to be acquired', 'buyout',
];
const NEG = [
  'miss', 'misses', 'plunge', 'plunges', 'sink', 'sinks', 'falls', 'fall', 'drop', 'drops', 'downgrade', 'downgraded', 'cuts guidance', 'cut guidance', 'lowers guidance', 'lawsuit', 'sued',
  'probe', 'investigation', 'subpoena', 'recall', 'bearish', 'weak', 'loss widens', 'warning', 'warns', 'layoffs', 'job cuts', 'fraud', 'sec charges', 'delay', 'delays', 'halt', 'halted',
  'bankruptcy', 'chapter 11', 'dilution', 'stock offering', 'secondary offering', 'short seller', 'short report', 'slump', 'tumble', 'tumbles', 'crash', 'price target cut', 'cuts price target', 'resigns', 'default',
];

export function lexiconTone(title) {
  const t = ` ${String(title || '').toLowerCase()} `;
  let s = 0;
  for (const w of POS) if (t.includes(` ${w}`)) s++;
  for (const w of NEG) if (t.includes(` ${w}`)) s--;
  return Math.sign(s);
}

const CATALYSTS = [
  [/earnings|quarterly results|q[1-4] (results|revenue)|guidance/i, 'Earnings'],
  [/acqui|merger|buyout|takeover|deal to buy/i, 'Deal / merger'],
  [/fda|approval|clinical|trial results|phase [123]/i, 'Regulatory / FDA'],
  [/upgrade|downgrade|price target|initiat/i, 'Analyst call'],
  [/lawsuit|probe|investigation|sec charges|subpoena|fraud/i, 'Legal'],
  [/offering|dilution|convertible/i, 'Share offering'],
  [/layoff|job cuts|restructur/i, 'Restructuring'],
  [/buyback|repurchase|dividend/i, 'Shareholder return'],
];
export const catalystOf = (title) => (CATALYSTS.find(([re]) => re.test(title)) || [])[1] || null;

// Ask Workers AI to tag each headline. One short call, line based output.
async function aiTones(env, ticker, items) {
  if (!env.AI || !items.length) return null;
  const list = items.map((n, i) => `${i + 1}. ${n.title}`).join('\n');
  const r = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: 'You rate news headlines for how they likely affect a stock price. Reply with one line per headline in the form "number: positive", "number: negative" or "number: neutral". No other text.' },
      { role: 'user', content: `Stock: ${ticker}\n${list}` },
    ],
    max_tokens: 400,
    temperature: 0,
  });
  const text = (r && (r.response || r.result || '')) + '';
  const out = new Array(items.length).fill(null);
  for (const m of text.matchAll(/(\d+)\s*[:.)-]\s*(positive|negative|neutral)/gi)) {
    const i = +m[1] - 1;
    if (i >= 0 && i < out.length) out[i] = /pos/i.test(m[2]) ? 1 : /neg/i.test(m[2]) ? -1 : 0;
  }
  return out.filter((x) => x !== null).length >= items.length / 2 ? out : null;
}

// Recency weighted tone. Stories from today count fully; a 3 day old story about half.
export async function scoreHeadlines(env, ticker, items) {
  let ai = null;
  try {
    ai = await cached(env, `newstone:${ticker}:${items.length}:${norm(items[0] && items[0].title).slice(0, 30)}`, 3600, () => aiTones(env, ticker, items));
  } catch {}
  const now = Date.now();
  let num = 0;
  let den = 0;
  const scored = items.map((n, i) => {
    const tone = ai && ai[i] !== null && ai[i] !== undefined ? ai[i] : lexiconTone(n.title);
    const ageDays = n.time ? Math.max(0, (now - new Date(n.time).getTime()) / 864e5) : 5;
    const w = Math.exp(-ageDays / 4);
    num += tone * w;
    den += w;
    return { ...n, tone, catalyst: catalystOf(n.title), ageDays: +ageDays.toFixed(2) };
  });
  const last48h = scored.filter((n) => n.ageDays <= 2).length;
  return { score: den ? num / den : 0, items: scored, method: ai ? 'ai' : 'keywords', last48h };
}
