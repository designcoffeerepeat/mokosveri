// Trader-style summary. Built from the analysis data with fixed templates
// (always works), then optionally tightened into a short read by Workers AI.
// Numbers first, no hand-holding, no dashes.
import { cached, withBudget } from '../util.js';

const money = (v) => {
  if (v == null || !isFinite(v)) return null;
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${Math.round(v / 1e3)}K`;
  return `$${Math.round(v)}`;
};
const pct = (v, d = 0) => `${Math.abs(v).toFixed(d)}%`;
const sgn = (v, d = 1) => `${v >= 0 ? '+' : '-'}${Math.abs(v).toFixed(d)}%`;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const isBoss = (t) => /CEO|Chief Executive|CFO|Chief Financial|President|Chair|COO/i.test(t || '');
const role = (t) => {
  const s = String(t || '');
  if (/CEO|Chief Executive/i.test(s)) return 'CEO';
  if (/CFO|Chief Financial/i.test(s)) return 'CFO';
  if (/COO|Chief Operating/i.test(s)) return 'COO';
  if (/Chair/i.test(s)) return 'Chair';
  if (/President/i.test(s)) return 'President';
  if (/Director/i.test(s)) return 'director';
  if (/10%/i.test(s)) return '10% holder';
  return null;
};

// Upstream feeds (SEC, RSS, analyst firm names) and the AI model sometimes
// hand back HTML entities, at times double encoded (&amp;amp;). The page
// escapes text itself, so copy should hold plain characters.
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };
export function decodeEntities(s) {
  let out = String(s ?? '');
  for (let i = 0; i < 3 && /&(#\d+|#x[0-9a-f]+|[a-z]+);/i.test(out); i++) {
    out = out.replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k in ENTITIES) return ENTITIES[k];
      if (k[0] === '#') {
        const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
      }
      return m;
    });
  }
  return out;
}

const isNum = (x) => typeof x === 'number' && isFinite(x);

// Strip characters the site owner does not want in copy.
export function cleanCopy(s) {
  return decodeEntities(s || '')
    .replace(/\s*[—–]\s*/g, ', ')
    .replace(/\s+-\s+/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export function buildPlainFacts(a) {
  const good = [];
  const bad = [];
  const watch = [];
  const t = a.technicals || {};

  // Insiders
  const tx = (a.insider && a.insider.transactions) || [];
  const buys = tx.filter((x) => x.code === 'P');
  const sells = tx.filter((x) => x.code === 'S' && !x.plan10b5);
  if (buys.length) {
    const people = new Set(buys.map((b) => b.owner)).size;
    const total = buys.reduce((s, b) => s + (b.value || 0), 0);
    const roles = [...new Set(buys.map((b) => role(b.title)).filter(Boolean))].slice(0, 3);
    good.push(`Open market insider buying: ${plural(people, 'insider')}${roles.length ? ` (${roles.join(', ')})` : ''}, ${money(total)} in the last ${a.insiderDays || 30} days${people >= 3 ? ', a cluster buy' : ''}.`);
  }
  if (sells.length) {
    const people = new Set(sells.map((b) => b.owner)).size;
    const total = sells.reduce((s, b) => s + (b.value || 0), 0);
    const boss = sells.some((b) => isBoss(b.title));
    bad.push(`Discretionary insider selling (not 10b5-1): ${plural(people, 'insider')}${boss ? ' incl. a C-suite officer' : ''}, ${money(total)}.`);
  }

  // Trend and momentum
  if (t.sma200 && t.price) {
    const d = (t.price / t.sma200 - 1) * 100;
    const cross = t.goldenCross === true ? ', 50d above 200d' : t.goldenCross === false ? ', 50d below 200d' : '';
    (d >= 0 ? good : bad).push(`Trading ${pct(d, 1)} ${d >= 0 ? 'above' : 'below'} the 200 day average${cross}.`);
  }
  if (a.type !== 'Index' && t.relStrength3m != null && Math.abs(t.relStrength3m) >= 5) {
    (t.relStrength3m > 0 ? good : bad).push(`${t.relStrength3m > 0 ? 'Outperforming' : 'Lagging'} the S&P 500 by ${pct(t.relStrength3m, 1)} over 3 months.`);
  }
  if (t.rsi14 != null) {
    if (t.rsi14 < 30) watch.push(`RSI ${t.rsi14.toFixed(0)}, oversold. Bounce setups possible, but the trend is still down until it turns.`);
    else if (t.rsi14 > 70) watch.push(`RSI ${t.rsi14.toFixed(0)}, overbought. Extended; pullback or consolidation risk.`);
  }
  if (t.macdCross) watch.push(`Fresh ${t.macdCross} MACD cross.`);
  if (t.relVolume && t.relVolume > 1.8) watch.push(`Volume running ${t.relVolume.toFixed(1)}x the 20 day average.`);
  if (t.fromHigh != null && t.fromHigh > -3) watch.push(`Within ${pct(t.fromHigh, 1)} of the 52 week high.`);
  else if (t.fromLow != null && t.fromLow < 5) watch.push(`Within ${pct(t.fromLow, 1)} of the 52 week low.`);

  // Analysts
  const an = a.analyst;
  if (an && an.targetMean && t.price) {
    const up = (an.targetMean / t.price - 1) * 100;
    const n = an.numAnalysts ? ` across ${an.numAnalysts} analysts` : '';
    // Yahoo uses "none" when there is no rating consensus; say nothing then.
    const rk = String(an.recKey || '').trim().toLowerCase();
    const rec = rk && rk !== 'none' && rk !== 'null' && rk !== 'undefined' ? `, consensus ${rk.replace(/_/g, ' ')}` : '';
    if (up > 5) good.push(`Mean target $${an.targetMean.toFixed(2)}${n}, ${sgn(up)} implied upside${rec}.`);
    else if (up < -5) bad.push(`Mean target $${an.targetMean.toFixed(2)}${n}, ${pct(up, 1)} below the current price${rec}.`);
  }
  if (an && an.actions) {
    const recent = an.actions.filter((x) => (Date.now() - new Date(x.date)) / 864e5 <= 30);
    const ups = recent.filter((x) => x.action === 'up');
    const downs = recent.filter((x) => x.action === 'down');
    const firms = (arr) => [...new Set(arr.map((x) => x.firm).filter(Boolean))].slice(0, 3).join(', ');
    if (ups.length > downs.length) good.push(`${plural(ups.length, 'upgrade')} in 30 days${firms(ups) ? ` (${firms(ups)})` : ''}${downs.length ? ` vs ${downs.length} down` : ''}.`);
    if (downs.length > ups.length) bad.push(`${plural(downs.length, 'downgrade')} in 30 days${firms(downs) ? ` (${firms(downs)})` : ''}${ups.length ? ` vs ${ups.length} up` : ''}.`);
  }

  // Short interest
  const p = a.positioning || {};
  if (p.shortPctFloat != null && p.shortPctFloat >= 0.1) {
    const dtc = p.daysToCover ? `, ${p.daysToCover.toFixed(1)} days to cover` : '';
    const chg = p.shortChange != null && Math.abs(p.shortChange) >= 0.05 ? `, ${p.shortChange > 0 ? 'up' : 'down'} ${pct(p.shortChange * 100)} vs last month` : '';
    watch.push(`Short interest ${pct(p.shortPctFloat * 100, 1)} of float${dtc}${chg}. Squeeze fuel on good news, crowded doubt otherwise.`);
  }

  // Congress
  const cong = a.congress || [];
  const cb = cong.filter((c) => c.type === 'buy');
  const cs = cong.filter((c) => c.type === 'sell');
  const who = (arr) => [...new Set(arr.map((c) => c.member).filter(Boolean))].slice(0, 2).join(', ');
  if (cb.length) good.push(`Congress: ${plural(cb.length, 'disclosed buy')}${who(cb) ? ` (${who(cb)})` : ''}.`);
  if (cs.length) bad.push(`Congress: ${plural(cs.length, 'disclosed sale')}${who(cs) ? ` (${who(cs)})` : ''}.`);

  // News
  const news = a.news || [];
  if (news.length) {
    const pos = news.filter((n) => n.tone > 0).length;
    const neg = news.filter((n) => n.tone < 0).length;
    const cats = [...new Set(news.map((n) => n.catalyst).filter(Boolean))].slice(0, 3);
    const tail = cats.length ? ` Catalysts in the flow: ${cats.join(', ').toLowerCase()}.` : '';
    if (pos > neg + 1) good.push(`News flow positive, ${pos} up vs ${neg} down.${tail}`);
    else if (neg > pos + 1) bad.push(`News flow negative, ${neg} down vs ${pos} up.${tail}`);
    else if (cats.length) watch.push(`News flow mixed (${pos} up, ${neg} down).${tail}`);
  }

  // Social
  const st = a.social && a.social.st;
  const ape = a.social && a.social.ape;
  if (ape && ape.rank <= 25) watch.push(`Reddit rank #${ape.rank}${ape.mentions ? ` on ${ape.mentions} mentions` : ''}. Retail attention cuts both ways.`);
  if (st && st.bullish + st.bearish >= 8) {
    const share = st.bullish / (st.bullish + st.bearish);
    if (share >= 0.8) watch.push(`StockTwits ${pct(share * 100)} bullish. Crowded long sentiment, contrarian risk.`);
    else if (share <= 0.5) bad.push(`StockTwits only ${pct(share * 100)} bullish.`);
  }

  // Earnings date
  if (a.earningsDate) {
    const days = Math.round((new Date(a.earningsDate) - Date.now()) / 864e5);
    if (days >= 0 && days <= 21) watch.unshift(`Earnings in ${plural(days, 'day')}. Expect a gap risk event.`);
  }

  // Volatility indices read inverted versus stocks.
  if (a.type === 'Index' && /^(VIX|VVIX|VXN|\^VIX)$/.test(a.ticker)) {
    watch.unshift(`Volatility gauge: a rising ${a.ticker} means rising fear in equities, so a bullish read here is risk off for stocks.`);
    if (t.price) watch.push(`${a.ticker} at ${t.price.toFixed(2)}${t.price >= 30 ? ', stress territory' : t.price >= 20 ? ', elevated' : t.price < 14 ? ', complacent' : ', normal range'}.`);
  }

  // Bottom line
  // Never print NaN: if the score or move odds are missing, say so plainly.
  const s = isNum(a.score) ? Math.round(a.score) : null;
  const dir = s == null ? null : s >= 35 ? 'Bullish' : s >= 15 ? 'Leaning bullish' : s <= -35 ? 'Bearish' : s <= -15 ? 'Leaning bearish' : 'Neutral';
  const cov = isNum(a.coverage) ? `, ${Math.round(a.coverage * 100)}% data coverage` : '';
  const m = a.move;
  const mvTail = m && isNum(m.typicalMonthMovePct) && m.typicalMonthMovePct > 0 ? `, typical month ±${m.typicalMonthMovePct}%` : '';
  const mv = m && isNum(m.value) && m.level ? ` Big move odds ${String(m.level).toLowerCase()} (${Math.round(m.value)}/100)${mvTail}.` : '';
  const head = s == null ? `Score unavailable${cov ? ` (${cov.slice(2)})` : ''}` : `${dir} at ${s > 0 ? '+' : ''}${s} of ±100${cov}`;
  const bottom = `${head}.${mv}`;

  return { bottom, good: good.slice(0, 5), bad: bad.slice(0, 5), watch: watch.slice(0, 5) };
}

export function templateParagraph(f) {
  const parts = [f.bottom];
  if (f.good.length) parts.push(`Bull case: ${f.good.slice(0, 2).map((x) => x.replace(/\.$/, '')).join('; ')}.`);
  if (f.bad.length) parts.push(`Bear case: ${f.bad.slice(0, 2).map((x) => x.replace(/\.$/, '')).join('; ')}.`);
  if (f.watch.length) parts.push(`Watch: ${f.watch[0]}`);
  return cleanCopy(parts.join(' '));
}

async function aiParagraph(env, a, f) {
  if (!env.AI) return null;
  const facts = [f.bottom, ...f.good.map((x) => `Bullish: ${x}`), ...f.bad.map((x) => `Bearish: ${x}`), ...f.watch.map((x) => `Watch: ${x}`)].join('\n');
  const r = await env.AI.run(env.AI_MODEL || '@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content:
          'You write a short desk note for an experienced trader. 3 to 5 tight sentences. Lead with the net read and the strongest signals, keep the specific numbers, then the main risk and what to watch. Use only the facts given. Do not explain basic terms, do not describe what the company is, no filler, no greetings. Do not use dashes of any kind. Do not tell the reader to buy or sell, and do not add a disclaimer.',
      },
      { role: 'user', content: `Ticker: ${a.ticker}\nFacts:\n${facts}` },
    ],
    max_tokens: 260,
    temperature: 0.2,
  });
  const text = cleanCopy((r && (r.response || r.result)) || '');
  if (/\bNaN\b|\bundefined\b/.test(text)) return null;
  // Basic sanity checks so a bad generation never reaches the page.
  if (text.length < 80 || text.length > 1100 || /tiny piece|complete beginner|owning a (small|tiny)/i.test(text)) return null;
  return text;
}

// The AI note gets a few seconds; past that the template note is shown and the
// AI note is cached in the background for the next visit.
export async function plainSummary(env, a, opts = {}) {
  const f = buildPlainFacts(a);
  let paragraph = null;
  let aiWritten = false;
  try {
    const p = cached(env, `sum3:${a.ticker}:${a.score}:${(a.news && a.news[0] && a.news[0].title || '').slice(0, 24)}`, 3 * 3600, () => aiParagraph(env, a, f));
    paragraph = await withBudget(p, opts.budgetMs || 5000, null, opts.waitUntil);
    aiWritten = !!paragraph;
  } catch {}
  if (!paragraph) paragraph = templateParagraph(f);
  return {
    paragraph,
    aiWritten,
    good: f.good.map(cleanCopy),
    bad: f.bad.map(cleanCopy),
    watch: f.watch.map(cleanCopy),
  };
}
