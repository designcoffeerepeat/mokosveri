// Offline test for the under the radar page: mocks Reddit, StockTwits,
// OpenInsider, Capitol Trades and Yahoo, then runs the whole pipeline.
// Run: node test/radar.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gatherCandidates, screenOut, insiderPoints, congressPoints, socialPoints, baseInfo, setupPoints, alreadyRan, levels, scorePick, buildRadar, radarPage, RADAR_KEY } from '../src/radar.js';
import { computeTechnicals } from '../src/analysis/technicals.js';
import { pickCard, benchTable, ranHtml, spark, capLabel } from '../public/radar.js';

for (const f of ['src/radar.js', 'public/radar.js', 'public/radar.css']) assert.ok(!readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('—'), `${f} has no em dash`);

const dAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

// Synthetic daily bars. shape: 'coil' (flat, tight, just under its high),
// 'ran' (up 40% in a month), 'bleed' (long slide).
function bars(shape, n = 260, start = 20) {
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = [];
  let p = start;
  const t0 = Math.floor(Date.now() / 1000) - n * 86400;
  for (let i = 0; i < n; i++) {
    const o = p;
    if (shape === 'coil') p = i < n - 60 ? p * (1 + 0.001 + rnd() * 0.03) : p * (1 + rnd() * 0.008);
    else if (shape === 'ran') p = i < n - 21 ? p * (1 + rnd() * 0.02) : p * 1.017;
    else p = p * (1 - 0.003 + rnd() * 0.02);
    const late = i >= n - 15;
    out.push({ t: t0 + i * 86400, o, h: Math.max(o, p) * 1.004, l: Math.min(o, p) * 0.996, c: p, v: (shape === 'coil' && late ? 2e6 : 1e6) * (1 + (p > o ? 0.3 : 0)) });
  }
  return out;
}
const SHAPES = { QUIET: 'coil', CLUS: 'coil', CONG: 'coil', HOT: 'ran', SLIDE: 'bleed', BIGCO: 'coil', TINY: 'coil', SPY: 'coil', MEME: 'coil', BUZZ: 'coil' };

// --- unit pieces
const coil = bars('coil');
const tc = computeTechnicals(coil);
const bc = baseInfo(coil);
assert.ok(bc.range20 < 8, `coil is tight: ${bc.range20}`);
assert.ok(bc.toPivot >= -4 && bc.toPivot < 15, `coil sits near its pivot: ${bc.toPivot}`);
assert.equal(alreadyRan(tc), null, 'a coil has not run');
const tr = computeTechnicals(bars('ran'));
assert.match(alreadyRan(tr), /up \d+% in a month/);
const lv = levels(tc, bc);
assert.ok(lv.target > lv.trigger && lv.fails < tc.price, 'target above trigger, fail line under price');
assert.ok(setupPoints(tc, bc).pts > 10, 'coil scores on setup');

const ip1 = insiderPoints({ buyers: 1, total_value: 60000, csuite: 0, last_date: dAgo(20) }, 5e9);
const ip3 = insiderPoints({ buyers: 4, total_value: 3e6, csuite: 1, owners: 'Jane Roe (CEO)', last_date: dAgo(2) }, 2e8);
assert.ok(ip3.pts > ip1.pts + 15, 'cluster CEO buy worth a lot more than a lone token buy');
assert.ok(ip3.cluster && ip3.csuite);
assert.match(ip3.why[0], /about 1\.5% of the company/);
assert.equal(congressPoints({ buys: [], sells: [] }).pts, 0);
assert.ok(congressPoints({ buys: [{ member: 'A', amountMin: 50001 }, { member: 'B' }], sells: [] }).pts >= 13);
assert.ok(socialPoints({ mentions: 30, mentions24hAgo: 5, rank: 80 }, false).pts > 5, 'rising mentions score');
assert.equal(socialPoints({ mentions: 30, mentions24hAgo: 29, rank: 200 }, false).pts, 0, 'flat chatter far down the list does not');

assert.equal(screenOut({ quoteType: 'ETF' }), 'not a stock');
assert.equal(screenOut({ quoteType: 'EQUITY', regularMarketPrice: 50, marketCap: 3e11 }), 'large cap');
assert.equal(screenOut({ quoteType: 'EQUITY', regularMarketPrice: 0.5, marketCap: 1e8 }), 'under $1');
assert.equal(screenOut({ quoteType: 'EQUITY', regularMarketPrice: 5, marketCap: 1e8, averageDailyVolume3Month: 1000 }), 'too thinly traded');
assert.equal(screenOut({ quoteType: 'EQUITY', regularMarketPrice: 5, marketCap: 1e8, averageDailyVolume3Month: 1e6 }), null);

const cands = gatherCandidates({
  insiders: [{ ticker: 'ABC', buyers: 2, total_value: 1e5, issuer: 'Abc Inc' }],
  congress: [{ ticker: 'XYZ', type: 'buy', member: 'Rep A' }, { ticker: 'NOPE', type: 'sell', member: 'Rep B' }],
  ape: [{ ticker: 'GME', rank: 1, mentions: 900, mentions24hAgo: 100 }, { ticker: 'SML', rank: 70, mentions: 20, mentions24hAgo: 4 }, { ticker: 'FLAT', rank: 90, mentions: 10, mentions24hAgo: 10 }],
  st: [],
});
assert.ok(cands.has('ABC') && cands.has('XYZ') && cands.has('SML'));
assert.ok(!cands.has('GME'), 'the crowded Reddit top is not under the radar');
assert.ok(!cands.has('FLAT') && !cands.has('NOPE'), 'flat chatter and sell only names are not candidates');

// --- full pipeline with mocked upstreams
const OI = (rows) => `<table class="tinytable"><thead><tr><th>X</th><th>Filing&nbsp;Date</th><th>Trade&nbsp;Date</th><th>Ticker</th><th>Company&nbsp;Name</th><th>Insider&nbsp;Name</th><th>Title</th><th>Trade&nbsp;Type</th><th>Price</th><th>Qty</th><th>Owned</th><th>&Delta;Own</th><th>Value</th></tr></thead><tbody>${rows
  .map(([t, co, who, title, val]) => `<tr><td>M</td><td>${dAgo(2)} 10:00:00</td><td>${dAgo(3)}</td><td><a>${t}</a></td><td>${co}</td><td>${who}</td><td>${title}</td><td>P - Purchase</td><td>$10.00</td><td>+1,000</td><td>10,000</td><td>+10%</td><td>+$${val.toLocaleString('en-US')}</td></tr>`)
  .join('')}</tbody></table>`;
const oiHtml = OI([
  ['CLUS', 'Cluster Co', 'Ann CEO', 'CEO', 900000],
  ['CLUS', 'Cluster Co', 'Bob CFO', 'CFO', 400000],
  ['CLUS', 'Cluster Co', 'Cy Dir', 'Dir', 300000],
  ['QUIET', 'Quiet Corp', 'Dee Dir', 'Dir', 150000],
  ['HOT', 'Hot Stuff', 'Ed CEO', 'CEO', 500000],
  ['SLIDE', 'Slide Inc', 'Flo Dir', 'Dir', 80000],
  ['BIGCO', 'Big Co', 'Gus Dir', 'Dir', 2000000],
  ['TINY', 'Tiny Co', 'Hal Dir', 'Dir', 50000],
]);
const QUOTES = {
  CLUS: { marketCap: 4e8 }, QUIET: { marketCap: 1.2e9 }, HOT: { marketCap: 9e8 }, SLIDE: { marketCap: 6e8 }, CONG: { marketCap: 3e9 },
  BIGCO: { marketCap: 4e11 }, TINY: { marketCap: 1e7 }, BUZZ: { marketCap: 2.5e8 },
};
let newsCalls = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  const J = (d) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.includes('apewisdom')) return J({ results: u.endsWith('/1') ? [{ ticker: 'MEME', name: 'Meme', rank: 2, mentions: 800, mentions_24h_ago: 300 }, { ticker: 'BUZZ', name: 'Buzz Labs', rank: 55, mentions: 24, mentions_24h_ago: 3, rank_24h_ago: 140 }] : [] });
  if (u.includes('stocktwits')) return J({ symbols: [] });
  if (u.includes('openinsider')) return new Response(oiHtml, { status: 200 });
  if (u.includes('capitoltrades')) return J({ data: [{ politician: { firstName: 'Pat', lastName: 'Member' }, issuer: { issuerTicker: 'CONG:US' }, txType: 'buy', value: 100000, txDate: dAgo(10), pubDate: dAgo(5) }] });
  if (u.includes('fc.yahoo.com')) return new Response('', { status: 200, headers: { 'set-cookie': 'A3=x; Path=/' } });
  if (u.includes('getcrumb')) return new Response('crumb123', { status: 200 });
  if (u.includes('/v7/finance/quote')) {
    const syms = decodeURIComponent(u.match(/symbols=([^&]+)/)[1]).split(',');
    return J({ quoteResponse: { result: syms.filter((s) => QUOTES[s]).map((s) => ({ symbol: s, quoteType: 'EQUITY', regularMarketPrice: 20, averageDailyVolume3Month: 5e5, longName: `${s} Holdings`, ...QUOTES[s] })) } });
  }
  if (u.includes('/v8/finance/chart/')) {
    const sym = decodeURIComponent(u.match(/chart\/([^?]+)/)[1]);
    const b = bars(SHAPES[sym] || 'coil');
    return J({ chart: { result: [{ meta: { regularMarketPrice: b[b.length - 1].c, instrumentType: 'EQUITY', longName: sym }, timestamp: b.map((x) => x.t), indicators: { quote: [{ open: b.map((x) => x.o), high: b.map((x) => x.h), low: b.map((x) => x.l), close: b.map((x) => x.c), volume: b.map((x) => x.v) }] } }] } });
  }
  if (u.includes('/v1/finance/search')) {
    newsCalls++;
    return J({ news: [{ title: 'Company wins major contract, shares higher', publisher: 'Wire', link: 'https://example.com/a', providerPublishTime: Math.floor(Date.now() / 1000) - 3600 }] });
  }
  return new Response('not mocked', { status: 404 });
};

const mem = new Map();
const env = { CACHE: { async get(k, ty) { const v = mem.get(k); return v == null ? null : ty === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } } };
const d = await buildRadar(env);
const tick = d.picks.map((p) => p.ticker);
assert.ok(tick.includes('CLUS') && tick.includes('QUIET') && tick.includes('CONG') && tick.includes('BUZZ'), `expected picks, got ${tick}`);
assert.ok(!tick.includes('HOT'), 'a stock up 40% in a month is left off');
assert.ok(d.alreadyRan.some((r) => r.ticker === 'HOT'), 'and listed as already ran');
assert.ok(!tick.includes('BIGCO') && !tick.includes('TINY'), 'large and tiny caps are screened out');
assert.ok(!tick.includes('MEME'), 'Reddit top names are skipped');
assert.equal(d.stats.ruledOut['large cap'], 1);
assert.equal(d.stats.ruledOut['too small'], 1);
assert.equal(tick[0], 'CLUS', `the CEO led cluster buy in a coiled small cap ranks first, got ${tick}`);
const clus = d.picks[0];
assert.ok(clus.score >= 60 && clus.conviction === 'High', `CLUS score ${clus.score}`);
assert.ok(clus.tags.includes('Insider cluster'));
assert.ok(clus.levels && clus.levels.target > clus.price);
assert.ok(clus.thesis.length > 40 && !/advice/i.test(clus.thesis));
assert.ok(clus.headline && /contract/.test(clus.headline.title), 'headline attached');
assert.ok(d.picks.every((p, i) => i === 0 || d.picks[i - 1].score >= p.score), 'sorted by score');
assert.ok(newsCalls > 0 && newsCalls <= 6);
const slide = d.picks.find((p) => p.ticker === 'SLIDE');
if (slide) assert.ok(slide.score < clus.score, 'a downtrend scores below the coil');
for (const k of ['insiders', 'congress', 'reddit', 'quotes']) assert.equal(d.status[k], 'ok', `${k} ok`);

// --- page html
const html = pickCard(clus, 0);
assert.match(html, /#\/t\/CLUS/);
assert.match(html, /Buy trigger|Breaking out at/);
assert.match(html, /Why it made the list/);
assert.ok(!/not financial advice/i.test(html), 'no disclaimers on the cards');
assert.match(benchTable(d.picks), /<table/);
assert.match(ranHtml(d.alreadyRan), /HOT/);
assert.equal(ranHtml([]), '');
assert.match(spark([1, 2, 3], 4), /rd-trig/);
assert.equal(capLabel(4e8), 'Small cap');
assert.equal(capLabel(2e8), 'Micro cap');

// --- cache: fresh hits are served, stale ones are served and rebuilt once
const rows = new Map();
const DB = {
  prepare(sql) {
    return {
      bind(...a) {
        return {
          async first() { return sql.startsWith('SELECT v, exp FROM cache') ? rows.get(a[0]) || null : null; },
          async run() {
            if (sql.startsWith('INSERT OR REPLACE INTO cache')) rows.set(a[0], { v: a[1], exp: a[2] });
            else if (sql.startsWith('UPDATE cache SET v')) rows.set(a[1], { ...rows.get(a[1]), v: a[0] });
          },
        };
      },
    };
  },
};
const env2 = { ...env, DB };
const p1 = await radarPage(env2, null);
assert.ok(rows.has(RADAR_KEY) && p1.picks.length);
const p2 = await radarPage(env2, null);
assert.equal(p2.asOf, p1.asOf, 'fresh cache is reused');
rows.set(RADAR_KEY, { ...rows.get(RADAR_KEY), v: JSON.stringify({ ...p1, asOf: new Date(Date.now() - 2 * 3600e3).toISOString() }) });
const jobs = [];
const p3 = await radarPage(env2, (p) => jobs.push(p));
assert.ok(p3.refreshing && jobs.length === 1, 'stale cache served while one rebuild runs');
await radarPage(env2, (p) => jobs.push(p));
assert.equal(jobs.length, 1, 'no second rebuild while the first is running');
await Promise.all(jobs);

console.log('radar tests passed');
