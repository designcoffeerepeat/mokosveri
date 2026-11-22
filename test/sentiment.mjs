// Offline test for the market sentiment page: mocks SEC 13F, CNN, AAII,
// Yahoo, Polymarket and Kalshi. Run: node test/sentiment.mjs
import assert from 'node:assert/strict';
import { parseInfoTable, diffHoldings, pickFilings, freshness, INVESTORS } from '../src/sources/thirteenf.js';
import { parseAaii, pickPolymarket, pickKalshi } from '../src/sources/gauges.js';
import { composite, labelFor, buildSentiment, recessionOdds } from '../src/market.js';

const dAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

const row = (name, cusip, value, shares, putCall = '') =>
  `<ns1:infoTable><ns1:nameOfIssuer>${name}</ns1:nameOfIssuer><ns1:titleOfClass>COM</ns1:titleOfClass><ns1:cusip>${cusip}</ns1:cusip><ns1:value>${value}</ns1:value><ns1:shrsOrPrnAmt><ns1:sshPrnamt>${shares}</ns1:sshPrnamt><ns1:sshPrnamtType>SH</ns1:sshPrnamtType></ns1:shrsOrPrnAmt>${putCall ? `<ns1:putCall>${putCall}</ns1:putCall>` : ''}<ns1:investmentDiscretion>SOLE</ns1:investmentDiscretion></ns1:infoTable>`;
const table = (rows) => `<?xml version="1.0"?><ns1:informationTable xmlns:ns1="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows.join('')}</ns1:informationTable>`;

const CUR = table([row('APPLE INC', '037833100', 2000000, 10000), row('APPLE INC', '037833100', 1000000, 5000), row('NEW CO', '111111111', 500000, 1000), row('NVIDIA CORP', '67066G104', 4000000, 20000, 'Put')]);
const PREV = table([row('APPLE INC', '037833100', 1800000, 10000), row('OLD CO', '222222222', 700000, 3500)]);

// --- 13F unit checks
const cur = parseInfoTable(CUR, '2025-11-14');
assert.equal(cur.length, 3, 'merges duplicate CUSIP rows');
const aapl = cur.find((h) => h.cusip === '037833100');
assert.equal(aapl.shares, 15000);
assert.equal(aapl.value, 3000000);
assert.equal(parseInfoTable(PREV, '2022-11-14')[0].value, 1800000 * 1000, 'pre 2023 values are thousands');
const prev = parseInfoTable(PREV, '2025-08-14');
const d = diffHoldings(cur, prev);
const acts = Object.fromEntries(d.moves.map((m) => [m.name + ':' + m.kind, m.action]));
assert.equal(acts['APPLE INC:long'], 'Added');
assert.equal(acts['NEW CO:long'], 'New');
assert.equal(acts['OLD CO:long'], 'Exited');
assert.equal(acts['NVIDIA CORP:put'], 'New');
assert.ok(d.hedgePct > 50, 'big put book shows as hedged');
assert.ok(d.stance < 0, 'heavy puts make the stance bearish even with net buying');

const sub = { filings: { recent: { form: ['4', '13F-HR/A', '13F-HR', 'SC 13G', '13F-HR'], accessionNumber: ['a', 'b', 'c', 'd', 'e'], filingDate: ['2025-11-20', '2025-11-18', '2025-11-14', '2025-10-01', '2025-08-14'], reportDate: ['', '2025-09-30', '2025-09-30', '', '2025-06-30'] } } };
assert.deepEqual(pickFilings(sub).map((f) => f.accession), ['c', 'e'], 'skips amendments');
assert.equal(freshness(dAgo(60)), 1);
assert.equal(freshness(dAgo(500)), 0);
assert.ok(freshness(dAgo(250)) > 0 && freshness(dAgo(250)) < 1);

// --- gauge parsers
const AAII = `<table><tr><td>Reported Date</td><td>Bullish</td><td>Neutral</td><td>Bearish</td></tr><tr><td class="x">Nov 19</td><td>41.2%</td><td>30.1%</td><td>28.7%</td></tr><tr><td>Nov 12</td><td>38.0%</td><td>31.0%</td><td>31.0%</td></tr></table>`;
assert.deepEqual(parseAaii(AAII), { week: 'Nov 19', bullish: 41.2, neutral: 30.1, bearish: 28.7 });
const PM = [
  { question: 'US recession in 2026?', outcomes: '["Yes","No"]', outcomePrices: '["0.22","0.78"]', volumeNum: 5e6, slug: 'us-recession-in-2026' },
  { question: 'Fed rate cut in December?', outcomes: '["Yes","No"]', outcomePrices: '["0.61","0.39"]', volumeNum: 9e6, slug: 'fed-dec' },
  { question: 'Will a celebrity win an award?', outcomes: '["Yes","No"]', outcomePrices: '["0.5","0.5"]', volumeNum: 9e7, slug: 'x' },
];
const pm = pickPolymarket(PM);
assert.equal(pm.length, 2, 'only macro questions');
assert.equal(pm.find((m) => m.recession).prob, 0.22);
const KS = { markets: [{ ticker: 'KXRECSSNBER-26', event_ticker: 'KXRECSSNBER-26', title: 'Recession in 2026?', last_price: 30, yes_bid: 29, yes_ask: 31, volume: 1000 }] };
assert.equal(pickKalshi(KS)[0].prob, 0.3);
assert.equal(Math.round(recessionOdds([...pm, ...pickKalshi(KS)]).prob * 100), 26);

// --- composite math
assert.equal(labelFor(75), 'Very bullish');
assert.equal(labelFor(0), 'Neutral');
assert.equal(labelFor(-30), 'Bearish');
assert.equal(labelFor(-100), 'Very bearish');
const c = composite({ trend: { dist200: 8, ret1m: 2 }, fearGreed: { score: 0, rating: 'extreme fear' } });
assert.equal(c.used, 2);
const trendRow = c.components.find((r) => r.id === 'trend');
const fgRow = c.components.find((r) => r.id === 'fearGreed');
assert.equal(trendRow.score, 100);
assert.equal(fgRow.score, -100);
// weights 1.25 vs 1 -> (1.25*100 - 1*100) / 2.25 = 11.1
assert.equal(c.score, 11);
assert.ok(Math.abs(trendRow.contribution + fgRow.contribution - 11.1) < 0.2, 'contributions add up to the score');
assert.equal(c.components.find((r) => r.id === 'aaii').available, false);

// --- full pipeline with mocked upstreams
const closes = (n, start, drift) => Array.from({ length: n }, (_, i) => start * (1 + drift) ** i);
const chartJson = (c) => ({ chart: { result: [{ meta: { regularMarketPrice: c.at(-1) }, timestamp: c.map((_, i) => 1.7e9 + i * 86400), indicators: { quote: [{ open: c, high: c, low: c, close: c, volume: c.map(() => 1) }] } }] } });
const FG = { fear_and_greed: { score: 62.4, rating: 'greed', previous_1_week: 55, timestamp: '2026-11-21T00:00:00Z' }, put_call_options: { rating: 'neutral', data: [{ x: 1, y: 0.9 }, { x: 2, y: 0.78 }] } };
const seen = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  seen.push(u);
  const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
  const T = (s, status = 200) => new Response(s, { status });
  if (u.includes('fearandgreed')) return J(FG);
  if (u.includes('aaii.com')) return T(AAII);
  if (u.includes('%5EVIX3M')) return J(chartJson(closes(120, 19, 0)));
  if (u.includes('%5EVIX')) return J(chartJson(closes(120, 15, 0)));
  if (u.includes('%5EGSPC')) return J(chartJson(closes(260, 5000, 0.0005)));
  if (u.includes('%5ETNX')) return J(chartJson(closes(20, 4.3, 0)));
  if (u.includes('%5EIRX')) return J(chartJson(closes(20, 3.9, 0)));
  if (u.includes('gamma-api.polymarket.com')) return J(PM);
  if (u.includes('kalshi.com')) return J(KS);
  if (u.includes('data.sec.gov/submissions/')) return J({ filings: { recent: { form: ['13F-HR', '13F-HR'], accessionNumber: ['0001-25-000002', '0001-25-000001'], filingDate: [dAgo(10), dAgo(100)], reportDate: [dAgo(50), dAgo(140)] } } });
  if (u.endsWith('/index.json')) return J({ directory: { item: [{ name: 'primary_doc.xml', size: '1000' }, { name: 'infotable.xml', size: '5000' }] } });
  if (u.includes('000125000002/infotable.xml')) return T(CUR);
  if (u.includes('000125000001/infotable.xml')) return T(PREV);
  return T('not mocked: ' + u, 500);
};
const mem = new Map();
const env = { CACHE: { async get(k, t) { const v = mem.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } } };

const s = await buildSentiment(env);
console.log('Composite', s.rating.score, s.rating.label, `(${s.rating.used}/${s.rating.of} components, ${s.rating.confidence})`);
for (const r of s.rating.components) console.log(' ', r.available ? `${String(r.score).padStart(4)} x${r.share}% = ${r.contribution}` : '   n/a', r.name, '|', r.value || r.error);
assert.equal(s.rating.components.find((r) => r.id === 'insiders').available, false, 'no DB in test');
assert.ok(s.rating.used >= 8);
assert.equal(s.investors.length, INVESTORS.length);
assert.equal(s.investors.filter((i) => !i.pending).length, 3, 'refreshes at most 3 investors per request');
assert.ok(s.investors[0].moves.length > 0);
assert.ok(s.markets.length >= 3);
const sumC = s.rating.components.filter((r) => r.available).reduce((a, r) => a + r.contribution, 0);
assert.ok(Math.abs(sumC - s.rating.score) <= 1, 'contributions sum to the composite');

// second request fills in the next investors, third finishes, then only cheap checks
await buildSentiment(env);
const s3 = await buildSentiment(env);
assert.ok(s3.investors.filter((i) => !i.pending).length >= 9);

// no em or en dashes anywhere in user facing copy
const text = JSON.stringify(s3);
assert.ok(!/[\u2014\u2013]/.test(text), 'no em or en dashes');
console.log('\nSentiment checks passed.');
if (process.env.DUMP_SENTIMENT) (await import('node:fs')).writeFileSync(process.env.DUMP_SENTIMENT, JSON.stringify(s3));
