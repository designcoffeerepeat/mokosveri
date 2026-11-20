// Offline test: mocks every upstream API with realistic fixtures and runs the
// full analysis and buzz pipelines. Run: node test/run.mjs
import assert from 'node:assert/strict';
import { parseForm4 } from '../src/sources/sec.js';
import { parseOpenInsiderTable, aggregatePurchases } from '../src/sources/openinsider.js';
import { computeTechnicals, rsi } from '../src/analysis/technicals.js';
import { analyzeTicker } from '../src/analyze.js';
import { buildBuzz } from '../src/buzz.js';
import { cleanTicker, yahooSymbol } from '../src/util.js';

const today = new Date().toISOString().slice(0, 10);
const dAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const FORM4 = (code, owner, title, shares, price, after, plan = false) => `<?xml version="1.0"?>
<ownershipDocument><schemaVersion>X0508</schemaVersion><documentType>4</documentType><periodOfReport>${dAgo(3)}</periodOfReport>
${plan ? '<aff10b5One>1</aff10b5One>' : '<aff10b5One>0</aff10b5One>'}
<issuer><issuerCik>0000123456</issuerCik><issuerName>Acme Corp</issuerName><issuerTradingSymbol>ACME</issuerTradingSymbol></issuer>
<reportingOwner><reportingOwnerId><rptOwnerCik>000999${shares}</rptOwnerCik><rptOwnerName>${owner}</rptOwnerName></reportingOwnerId>
<reportingOwnerRelationship><isDirector>0</isDirector><isOfficer>1</isOfficer><isTenPercentOwner>0</isTenPercentOwner><officerTitle>${title}</officerTitle></reportingOwnerRelationship></reportingOwner>
<nonDerivativeTable><nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>${dAgo(4)}</value></transactionDate>
<transactionCoding><transactionFormType>4</transactionFormType><transactionCode>${code}</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
<transactionAmounts><transactionShares><value>${shares}</value></transactionShares><transactionPricePerShare><value>${price}</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>${code === 'P' ? 'A' : 'D'}</value></transactionAcquiredDisposedCode></transactionAmounts>
<postTransactionAmounts><sharesOwnedFollowingTransaction><value>${after}</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeTransaction></nonDerivativeTable>
<footnotes></footnotes></ownershipDocument>`;

// 1y of synthetic bars trending up
function bars(n = 260, start = 50, drift = 0.002, seed = 1) {
  let p = start;
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  const t0 = Math.floor(Date.now() / 1000) - n * 86400;
  for (let i = 0; i < n; i++) {
    const o = p;
    p = p * (1 + drift + rnd() * 0.04);
    out.t.push(t0 + i * 86400);
    out.o.push(o);
    out.c.push(p);
    out.h.push(Math.max(o, p) * 1.01);
    out.l.push(Math.min(o, p) * 0.99);
    out.v.push(1e6 * (1 + (i > n - 5 ? 2 : 0) + Math.abs(rnd())));
  }
  return out;
}
const chartJson = (b, name, type = 'EQUITY') => ({
  chart: { result: [{ meta: { currency: 'USD', fullExchangeName: 'NasdaqGS', instrumentType: type, regularMarketPrice: b.c.at(-1), longName: name }, timestamp: b.t, indicators: { quote: [{ open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v }] } }] },
});

const OI_HTML = `<table width="100%" cellpadding="0" cellspacing="0" border="0" class="tinytable"><thead><tr><th>X</th><th>Filing&nbsp;Date</th><th>Trade&nbsp;Date</th><th>Ticker</th><th>Company&nbsp;Name</th><th>Insider&nbsp;Name</th><th>Title</th><th>Trade&nbsp;Type</th><th>Price</th><th>Qty</th><th>Owned</th><th>&Delta;Own</th><th>Value</th></tr></thead><tbody>
<tr><td></td><td>${dAgo(2)} 16:01:02</td><td>${dAgo(3)}</td><td><a href="/ACME">ACME</a></td><td>Acme Corp</td><td>Doe Jane</td><td>CEO</td><td>P - Purchase</td><td>$20.10</td><td>+10,000</td><td>110,000</td><td>+10%</td><td>+$201,000</td></tr>
<tr><td></td><td>${dAgo(2)} 16:01:02</td><td>${dAgo(3)}</td><td><a href="/ACME">ACME</a></td><td>Acme Corp</td><td>Roe Rick</td><td>Dir</td><td>P - Purchase</td><td>$20.00</td><td>+5,000</td><td>50,000</td><td>+11%</td><td>+$100,000</td></tr>
<tr><td></td><td>${dAgo(5)} 16:01:02</td><td>${dAgo(6)}</td><td><a href="/ZETA">ZETA</a></td><td>Zeta Inc</td><td>Smith Al</td><td>CFO</td><td>P - Purchase</td><td>$5.00</td><td>+20,000</td><td>40,000</td><td>+100%</td><td>+$100,000</td></tr>
</tbody></table>`;

function mockFetch(url) {
  const u = String(url);
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const T = (s, status = 200, headers = {}) => new Response(s, { status, headers });
  if (u.includes('/v8/finance/chart/SPY')) return J(chartJson(bars(260, 400, 0.0008, 7), 'SPDR S&P 500', 'ETF'));
  if (u.includes('/v8/finance/chart/')) {
    const sym = u.split('/chart/')[1].split('?')[0];
    return J(chartJson(bars(260, 20, sym === 'BEAR' ? -0.003 : 0.002, sym.length + 3), `${sym} Inc`));
  }
  if (u.includes('fc.yahoo.com')) return T('', 404, { 'set-cookie': 'A3=abc; Domain=.yahoo.com; Path=/' });
  if (u.includes('getcrumb')) return T('crumb123');
  if (u.includes('quoteSummary') && u.includes('%5EVIX')) return J({ quoteSummary: { result: [{ price: { longName: 'CBOE Volatility Index' }, quoteType: { quoteType: 'INDEX' } }] } });
  if (u.includes('quoteSummary')) {
    const now = Math.floor(Date.now() / 1000);
    return J({
      quoteSummary: {
        result: [
          {
            price: { longName: 'Acme Corporation', marketCap: { raw: 5e9 } },
            quoteType: { quoteType: 'EQUITY' },
            financialData: { targetMeanPrice: { raw: 40 }, recommendationMean: { raw: 1.9 }, numberOfAnalystOpinions: { raw: 12 }, recommendationKey: 'buy' },
            defaultKeyStatistics: { shortPercentOfFloat: { raw: 0.22 }, sharesShort: { raw: 8e6 }, sharesShortPriorMonth: { raw: 1e7 }, shortRatio: { raw: 6.1 }, dateShortInterest: { raw: now - 10 * 86400 } },
            upgradeDowngradeHistory: { history: [{ epochGradeDate: now - 5 * 86400, firm: 'Goldman Sachs', toGrade: 'Buy', fromGrade: 'Neutral', action: 'up', priceTargetAction: 'Raises', currentPriceTarget: 45, priorPriceTarget: 30 }] },
            calendarEvents: { earnings: { earningsDate: [{ raw: now + 6 * 86400 }] } },
            assetProfile: { sector: 'Technology', industry: 'Software', longBusinessSummary: 'Acme Corporation builds workflow software for logistics companies and sells it on a subscription basis.', fullTimeEmployees: 4200, website: 'https://www.acme.example', city: 'Austin', state: 'TX', country: 'United States', companyOfficers: [{ name: 'Jane Doe', title: 'CEO & Director' }, { name: 'Pat Poe', title: 'CFO' }] },
          },
        ],
      },
    });
  }
  if (u.includes('feeds.finance.yahoo.com')) return T(`<rss><channel><item><title>Acme wins major defense contract</title><link>https://r1</link><pubDate>${new Date(Date.now() - 5 * 3600e3).toUTCString()}</pubDate></item><item><title>Acme beats estimates, raises guidance</title><link>https://dup</link><pubDate>${new Date(Date.now() - 3600e3).toUTCString()}</pubDate></item></channel></rss>`);
  if (u.includes('news.google.com')) return T(`<rss><channel><item><title><![CDATA[Acme shares tumble after short seller report - MarketWatch]]></title><link>https://g1</link><pubDate>${new Date(Date.now() - 30 * 3600e3).toUTCString()}</pubDate><source url="https://mw">MarketWatch</source></item></channel></rss>`);
  if (u.includes('/v1/finance/search')) return J({ news: [{ title: 'Acme beats estimates, raises guidance', publisher: 'Reuters', link: 'https://x', providerPublishTime: Date.now() / 1000 - 3600 }, { title: 'Acme faces lawsuit', publisher: 'AP', link: 'https://y', providerPublishTime: Date.now() / 1000 - 7200 }] });
  if (u.includes('browse-edgar')) return T('<feed><company-info><cik>0000123456</cik><conformed-name>ACME CORP</conformed-name></company-info></feed>');
  if (u.includes('data.sec.gov/submissions')) {
    return J({ name: 'ACME CORP', filings: { recent: { form: ['4', '4', '4', '10-Q', '4'], filingDate: [dAgo(2), dAgo(2), dAgo(5), dAgo(10), dAgo(100)], accessionNumber: ['0001-26-000001', '0001-26-000002', '0001-26-000003', '0001-26-000004', '0001-25-000009'], primaryDocument: ['xslF345X05/a.xml', 'xslF345X05/b.xml', 'xslF345X05/c.xml', 'q.htm', 'old.xml'] } } });
  }
  if (u.includes('/Archives/edgar/data/')) {
    if (u.endsWith('/a.xml')) return T(FORM4('P', 'Doe Jane', 'CEO', 10000, 20.1, 110000));
    if (u.endsWith('/b.xml')) return T(FORM4('P', 'Roe Rick', 'Director', 5000, 20, 50000));
    if (u.endsWith('/c.xml')) return T(FORM4('S', 'Poe Pat', 'CFO', 2000, 21, 30000, true));
    return T('', 404);
  }
  if (u.includes('apewisdom')) return J({ results: u.endsWith('/1') ? [{ rank: 3, ticker: 'ACME', name: 'Acme', mentions: 120, upvotes: 400, rank_24h_ago: 15, mentions_24h_ago: 30 }, { rank: 4, ticker: 'BEAR', name: 'Bear Co', mentions: 90, upvotes: 100, rank_24h_ago: 4, mentions_24h_ago: 80 }] : [] });
  if (u.includes('stocktwits.com/api/2/trending')) return J({ symbols: [{ symbol: 'ACME', title: 'Acme', watchlist_count: 1000 }, { symbol: 'BTC.X', title: 'Bitcoin' }] });
  if (u.includes('stocktwits.com/api/2/streams')) return J({ symbol: { watchlist_count: 5000 }, messages: Array.from({ length: 20 }, (_, i) => ({ body: `post ${i}`, created_at: new Date(Date.now() - i * 600000).toISOString(), user: { username: 'u' + i }, entities: { sentiment: i % 4 === 0 ? { basic: 'Bearish' } : { basic: 'Bullish' } } })) });
  if (u.includes('capitoltrades')) return J({ data: [{ txDate: dAgo(20), pubDate: dAgo(3), txType: 'buy', value: 50000, issuer: { issuerTicker: 'ACME:US' }, politician: { firstName: 'Nancy', lastName: 'Example', chamber: 'house', party: 'democrat' } }, { txDate: dAgo(25), pubDate: dAgo(4), txType: 'sell', value: 15000, issuer: { issuerTicker: 'BEAR:US' }, politician: { firstName: 'Tom', lastName: 'Sample', chamber: 'senate', party: 'republican' } }] });
  if (u.includes('openinsider')) return T(OI_HTML);
  return T('not mocked: ' + u, 500);
}
globalThis.fetch = async (url) => mockFetch(url);

const mem = new Map();
const env = {
  INSIDER_DAYS: '30',
  BUZZ_MAX_TICKERS: '20',
  CACHE: {
    async get(k, type) {
      const v = mem.get(k);
      return v == null ? null : type === 'json' ? JSON.parse(v) : v;
    },
    async put(k, v) {
      mem.set(k, v);
    },
  },
};

// --- unit checks
const f = parseForm4(FORM4('P', 'Doe Jane', 'CEO', 10000, 20.1, 110000));
assert.equal(f.ticker, 'ACME');
assert.equal(f.transactions[0].code, 'P');
assert.equal(f.transactions[0].value, 201000);
assert.equal(f.plan10b5, false);
assert.equal(parseForm4(FORM4('S', 'x', 'CFO', 1, 1, 1, true)).plan10b5, true);

const oi = parseOpenInsiderTable(OI_HTML);
assert.equal(oi.length, 3);
assert.equal(oi[0].ticker, 'ACME');
assert.equal(oi[0].value, 201000);
const agg = aggregatePurchases(oi);
assert.equal(agg[0].ticker, 'ACME');
assert.equal(agg[0].buyers, 2);

assert.equal(Math.round(rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])), 100);
const b = bars();
const tech = computeTechnicals(b.c.map((c, i) => ({ t: b.t[i], o: b.o[i], h: b.h[i], l: b.l[i], c, v: b.v[i] })));
assert.ok(tech.rsi14 > 0 && tech.rsi14 < 100);
assert.ok(tech.sma200 > 0);

// --- full pipeline (keywords only, no AI binding)
const a = await analyzeTicker(env, 'ACME');
console.log('news', a.news.map((n) => `${n.tone}:${n.title}${n.catalyst ? ' [' + n.catalyst + ']' : ''}`).join(' | '));
console.log('plain:', a.plain.paragraph);
console.log('good:', a.plain.good, '\nbad:', a.plain.bad, '\nwatch:', a.plain.watch);
assert.equal(a.news.length, 4, 'merged + deduped news');
assert.ok(!/[\u2014\u2013]/.test(JSON.stringify(a.plain)), 'no dashes in plain copy');
assert.ok(a.plain.paragraph.length > 100);
assert.ok(!/tiny piece|is a company in/i.test(JSON.stringify(a.plain)), 'no beginner explainers');
assert.equal(a.profile.employees, 4200);
assert.ok(a.profile.description.startsWith('Acme'));
assert.equal(a.profile.hq, 'Austin, TX, United States');
assert.equal(a.profile.officers.length, 2);
assert.ok(!a.error, a.error);
console.log('ACME score', a.score, a.verdict, '| move', a.move.level, a.move.value, a.move.why.join('; '));
for (const c of a.components) console.log(`  ${c.label.padEnd(22)} ${String(Math.round(c.score * 100)).padStart(4)}  ${c.signals.map((s) => s.text).join(' | ')}`);
assert.equal(a.insider.transactions.filter((t) => t.code === 'P').length, 2);
assert.ok(a.score > 15, 'expected bullish');
assert.ok(Object.values(a.sources).every(Boolean), JSON.stringify(a.errors));

// with a mocked Workers AI binding
mem.clear();
const aiEnv = { ...env, AI: { run: async (model, inp) => {
  const u = inp.messages[1].content;
  if (/^Stock: ACME\n1\./.test(u)) return { response: u.split('\n').slice(1).map((l, i) => `${i + 1}: ${/tumble/.test(l) ? 'negative' : 'positive'}`).join('\n') };
  return { response: 'Net read leans bullish at +40 \u2014 driven by $160K of CEO and director buying in the last 30 days. Goldman upgraded with a $45 target, 22% of float is short with 6.1 days to cover. Earnings in 6 days is the gap risk to watch.' };
} } };
const a2 = await analyzeTicker(aiEnv, 'ACME');
console.log('AI plain:', a2.plain.paragraph, '| method', a2.newsMeta.method);
assert.equal(a2.plain.aiWritten, true);
assert.equal(a2.newsMeta.method, 'ai');
assert.ok(!/[\u2014\u2013]/.test(a2.plain.paragraph));

// indices: VIX maps to ^VIX, stock-only sources are skipped
assert.equal(cleanTicker('^VIX'), 'VIX');
assert.equal(cleanTicker('^GSPC'), 'SPX');
assert.equal(yahooSymbol('SPX'), '^GSPC');
assert.equal(yahooSymbol('BRK.B'), 'BRK-B');
mem.clear();
const seenUrls = [];
const prevFetch = globalThis.fetch;
globalThis.fetch = (u, o) => { seenUrls.push(String(u)); return prevFetch(u, o); };
const vix = await analyzeTicker(env, 'VIX');
globalThis.fetch = prevFetch;
assert.ok(!vix.error, vix.error);
assert.equal(vix.type, 'Index');
assert.equal(vix.name, 'CBOE Volatility Index');
assert.ok(seenUrls.some((u) => u.includes('/chart/%5EVIX')), 'fetches ^VIX');
assert.ok(!seenUrls.some((u) => /sec\.gov|capitoltrades|stocktwits|apewisdom/.test(u)), 'skips stock-only sources');
assert.equal(vix.profile, null);
assert.equal(vix.analyst, null);
assert.ok(!('secForm4' in vix.sources));
assert.ok(/Volatility gauge/.test(vix.plain.watch[0]));
console.log('VIX', vix.score, vix.verdict, '|', vix.plain.paragraph);

const bz = await buildBuzz(env);
console.log('buzz status', JSON.stringify(bz.status));
console.log('positive', bz.positive.map((r) => `${r.ticker}:${r.score} [${r.reasons.join(', ')}]`).join('  '));
console.log('negative', bz.negative.map((r) => `${r.ticker}:${r.score} [${r.reasons.join(', ')}]`).join('  '));
assert.ok(bz.all.length >= 3);
assert.ok(bz.insiderBuys.length === 2);
assert.ok(bz.congress.length === 2);
console.log('\nAll checks passed.');
if (process.env.DUMP_FIXTURES) (await import('node:fs')).writeFileSync(process.env.DUMP_FIXTURES, JSON.stringify({ a: process.env.FX_VIX ? vix : a, bz }));
