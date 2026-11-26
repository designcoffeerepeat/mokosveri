// Offline test for the dividend aristocrats page: mocks Yahoo quote, spark and
// Reddit. Run: node test/dividends.mjs
import assert from 'node:assert/strict';
import { ARISTOCRATS, ETFS, YIELD_FALLBACK, mentionsIn, tallyReddit, priceReturns, parseSpark, rowFor, flagsFor, dividendsPage } from '../src/dividends.js';
import { pickRows, etfTableHtml, tableHtml, leaderCards, redditHtml, researchHtml } from '../public/dividends.js';

// --- static data
assert.equal(ARISTOCRATS.length, 69, '69 aristocrats');
assert.equal(new Set(ARISTOCRATS.map((a) => a.t)).size, 69, 'no duplicate tickers');
for (const a of ARISTOCRATS) {
  assert.ok(a.years >= 25, `${a.t} has 25+ years`);
  assert.ok(YIELD_FALLBACK[a.t] != null, `${a.t} has a fallback yield`);
}

// --- no em dashes anywhere in page text
import { readFileSync } from 'node:fs';
for (const f of ['src/dividends.js', 'public/dividends.js', 'public/dividends.css']) assert.ok(!readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('—'), `${f} has no em dash`);

// --- mention matching
assert.deepEqual([...mentionsIn('Thinking about $O and Realty Income')], ['O']);
assert.equal(mentionsIn('O is great, I was LOW on cash and ED was fun').size, 0, 'bare ambiguous words do not count');
assert.deepEqual([...mentionsIn('PEP vs KO for income')].sort(), ['PEP'], 'bare KO is ambiguous; PEP counts');
assert.ok(mentionsIn('Bought more PepsiCo and Coca-Cola').has('KO'));
assert.ok(mentionsIn('ABBV and JNJ forever').has('ABBV'));
const listing = (posts) => ({ data: { children: posts.map((p) => ({ data: p })) } });
const t = tallyReddit([
  listing([{ id: 'a', title: 'Is $PEP a buy at 4.4%?', selftext: '', score: 300, num_comments: 120, permalink: '/r/dividends/comments/a/x/' }, { id: 'b', title: 'My SCHD portfolio', selftext: 'nothing here', score: 50 }]),
  listing([{ id: 'a', title: 'Is $PEP a buy at 4.4%?', score: 300 }, { id: 'c', title: 'Realty Income vs PEP', selftext: '', score: 80, num_comments: 9, permalink: '/r/dividends/comments/c/y/' }]),
]);
assert.equal(t.scanned, 3, 'duplicates count once');
assert.equal(t.tickers[0].t, 'PEP');
assert.equal(t.tickers[0].posts, 2);
assert.equal(t.posts[0].url, 'https://www.reddit.com/r/dividends/comments/a/x/');

// --- returns
const now = Date.UTC(2026, 10, 24);
const wk = 7 * 864e5;
const pts = [];
for (let i = 0; i <= 262; i++) pts.push({ t: now - (262 - i) * wk, c: 100 * 1.002 ** i });
const rt = priceReturns(pts, pts[pts.length - 1].c, now);
assert.ok(rt.r1y > 9 && rt.r1y < 12, `1y return ${rt.r1y}`);
assert.ok(rt.r5y > 9 && rt.r5y < 12, `5y annualized ${rt.r5y}`);
assert.ok(rt.ytd > 8 && rt.ytd < 11, `ytd ${rt.ytd}`);
assert.equal(priceReturns(pts.slice(-60), 120, now).r5y, null, 'no 5y figure without 5y of history');

// --- spark parsing (both shapes)
const by = new Map([['BF-B', 'BF.B'], ['KO', 'KO']]);
assert.equal(parseSpark({ 'BF-B': { timestamp: [1, 2], close: [10, null] } }, by).get('BF.B').length, 1);
assert.equal(parseSpark({ spark: { result: [{ symbol: 'KO', response: [{ timestamp: [1, 2], indicators: { quote: [{ close: [5, 6] }] } }] }] } }, by).get('KO')[1].c, 6);

// --- rows and flags
const a = ARISTOCRATS.find((x) => x.t === 'PEP');
const r = rowFor(a, { regularMarketPrice: 130, dividendRate: 5.69, trailingAnnualDividendYield: 0.042 }, pts, now);
assert.equal(r.yield, 4.38);
assert.equal(r.yieldSrc, 'live');
assert.ok(Math.abs(r.tr1y - (r.r1y + 4.2)) < 0.02, 'total return adds trailing yield');
const fb = rowFor(a, null, null, now);
assert.equal(fb.yieldSrc, 'Oct 23');
assert.equal(fb.yield, YIELD_FALLBACK.PEP);
assert.equal(flagsFor({ yield: 6, r1y: -25, years: 30 })[0].k, 'trap');
assert.equal(flagsFor({ yield: 2.5, r1y: 5, years: 60 })[0].k, 'king');

// --- filtering and sorting
const rows = [
  { t: 'A', sector: 'X', yield: 1.5, tr1y: 50 },
  { t: 'B', sector: 'X', yield: 3.2, tr1y: 10 },
  { t: 'C', sector: 'Y', yield: 4.1, tr1y: 20 },
  { t: 'D', sector: 'Y', yield: 2.0, tr1y: null },
];
assert.deepEqual(pickRows(rows, { min: 2, sort: 'tr1y', sector: 'all' }).map((x) => x.t), ['C', 'B', 'D'], 'yield 2%+ only, missing values last');
assert.deepEqual(pickRows(rows, { min: 0, sort: 'tr1y', sector: 'X' }).map((x) => x.t), ['A', 'B']);
assert.deepEqual(pickRows(rows, { min: 3, sort: 'yield', sector: 'all', asc: true }).map((x) => x.t), ['B', 'C']);

// --- full build with mocked upstreams
const calls = [];
globalThis.fetch = async (url) => {
  url = String(url);
  calls.push(url);
  const res = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'set-cookie': 'A3=x; Path=/' } });
  if (url.startsWith('https://fc.yahoo.com')) return res('');
  if (url.includes('getcrumb')) return res('crumb123');
  if (url.includes('/v7/finance/quote')) {
    const syms = decodeURIComponent(url.match(/symbols=([^&]+)/)[1]).split(',');
    return res({ quoteResponse: { result: syms.filter((s) => s !== 'WST').map((s, i) => ({ symbol: s, regularMarketPrice: 100, dividendRate: 1 + (i % 6), trailingAnnualDividendYield: 0.01 * (1 + (i % 6)), exDividendDate: 1767225600 })) } });
  }
  if (url.includes('/v8/finance/spark')) {
    const syms = decodeURIComponent(url.match(/symbols=([^&]+)/)[1]).split(',');
    const ts = pts.map((p) => Math.floor(p.t / 1000));
    return res(Object.fromEntries(syms.map((s) => [s, { timestamp: ts, close: pts.map((p) => p.c) }])));
  }
  if (url.includes('/v8/finance/chart/')) {
    const ts = pts.map((p) => Math.floor(p.t / 1000));
    const div = { a: { date: Math.floor((now - 30 * 864e5) / 1000), amount: 1.5 }, b: { date: Math.floor((now - 120 * 864e5) / 1000), amount: 1.5 }, c: {} };
    return res({ chart: { result: [{ meta: {}, timestamp: ts, indicators: { quote: [{ open: ts.map(() => 1), high: ts.map(() => 1), low: ts.map(() => 1), close: pts.map((p) => p.c), volume: ts.map(() => 0) }] }, events: { dividends: div } }] } });
  }
  if (url.includes('reddit.com')) return res({ error: 'blocked' }, 403);
  return res({}, 404);
};
const mem = new Map();
const env = { CACHE: { async get(k, ty) { const v = mem.get(k); return v == null ? null : ty === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } } };
const d = await dividendsPage(env);
assert.equal(d.rows.length, 69);
assert.ok(d.quotesOk);
assert.equal(d.reddit.ok, false, 'Reddit refusal is reported, not thrown');
assert.ok(d.rows.every((x) => x.r1y != null), 'every row has a 1y return');
assert.equal(d.rows.find((x) => x.t === 'WST').yieldSrc, 'Oct 23', 'missing live quote falls back');
assert.ok(calls.filter((u) => u.includes('/v8/finance/spark')).length === 4, 'spark in chunks of 20');
assert.equal(d.etfs.length, ETFS.length);
assert.ok(d.etfs.every((x) => x.yield != null && x.r1y != null), 'every ETF has a yield and a 1y return');
assert.ok(d.etfs.find((x) => x.t === 'JEPI').flags.some((f) => f.k === 'cc'), 'covered call funds are flagged');
assert.ok(calls.length < 45, `stays under the subrequest limit (${calls.length})`);

// --- HTML renders
const byT = Object.fromEntries(d.rows.map((x) => [x.t, x]));
const st = { min: 2, sort: 'tr1y', sector: 'all' };
const picked = pickRows(d.rows, st);
assert.ok(picked.length > 0 && picked.every((x) => x.yield >= 2));
assert.ok(tableHtml(picked, st).includes('#/t/'));
assert.ok(leaderCards(picked, 'tr1y').includes('dv-card'));
assert.ok(redditHtml(d, byT).includes('unavailable'));
assert.ok(redditHtml({ ...d, reddit: { ok: true, asOf: new Date().toISOString(), ...t } }, byT).includes('Is $PEP a buy'));
assert.ok(researchHtml(d, byT).includes('Morningstar'));
assert.ok(etfTableHtml(d.etfs, { min: 0, sort: 'years', sector: 'all' }).includes('SCHD'), 'ETF table ranks by yield when the stock sort is years');
assert.ok(!etfTableHtml(d.etfs, { min: 0, sort: 'yield', sector: 'all' }).includes('SGOV'), 'T-bill fund stays out of the dividend ETF table');
// Odd Yahoo values (objects, strings) do not break a row.
const odd = rowFor(ARISTOCRATS[0], { regularMarketPrice: {}, dividendRate: '1.2', exDividendDate: {}, trailingAnnualDividendYield: 'x' }, pts, now);
assert.equal(odd.exDiv, null);
assert.ok(odd.price > 0);

console.log('dividends: all checks passed');
