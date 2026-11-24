// Offline test for the breakout watch: mocks every feed and checks the run
// filter, the setup score, the picks and the home page panels.
// Run: node test/breakout.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setupFacts, recentRun, insiderPart, congressPart, socialPart, setupScore, pickCandidates, buildBreakout, MAX_RUN_PCT } from '../src/breakout.js';
import { breakoutHtml, sparkWithTrigger } from '../public/breakout.js';

for (const f of ['src/breakout.js', 'public/breakout.js', 'public/breakout.css']) assert.ok(!readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('—'), `${f} has no em dash`);

const dAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
// Daily bars from a close function f(i) over n days.
function series(n, f, vol = () => 1e6) {
  const t0 = Math.floor(Date.now() / 1000) - n * 86400;
  const out = { t: [], o: [], h: [], l: [], c: [], v: [] };
  for (let i = 0; i < n; i++) {
    const c = f(i);
    out.t.push(t0 + i * 86400);
    out.o.push(c);
    out.c.push(c);
    out.h.push(c * 1.005);
    out.l.push(c * 0.995);
    out.v.push(vol(i));
  }
  return out;
}
const toBars = (s) => s.c.map((c, i) => ({ t: s.t[i], o: s.o[i], h: s.h[i], l: s.l[i], c, v: s.v[i] }));
const wiggle = (i) => Math.sin(i / 3) * 0.4;
const SHAPES = {
  // Flat for months, tight range lately, near its 3 month high.
  ACME: series(260, (i) => (i < 200 ? 18 + i * 0.01 + wiggle(i) * 1.5 : 20 + wiggle(i) * (i > 240 ? 0.3 : 1)), (i) => (i > 250 ? 1.6e6 : 1e6)),
  // Up 40% in two months: must be dropped.
  RUNR: series(260, (i) => (i < 218 ? 10 : 10 + (i - 218) * 0.1)),
  // Fell then bounced 30% off the low: also dropped (moved off its 3 month low).
  BNCE: series(260, (i) => (i < 220 ? 30 : i < 240 ? 30 - (i - 220) * 0.5 : 20 + (i - 240) * 0.3)),
  // Quiet stock with Congress buying.
  CNGR: series(260, (i) => 50 + wiggle(i)),
  // Social only, drifting.
  SOCL: series(260, (i) => 12 + i * 0.002 + wiggle(i) * 0.2),
  // Penny stock: too thin.
  PNNY: series(260, () => 0.5),
  // An ETF.
  FUND: series(260, (i) => 100 + wiggle(i)),
};

function mockFetch(url) {
  const u = String(url);
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  if (u.includes('/v8/finance/chart/')) {
    const sym = decodeURIComponent(u.split('/chart/')[1].split('?')[0]);
    const s = sym === 'SPY' ? series(260, (i) => 500 + i * 0.1) : SHAPES[sym];
    if (!s) return J({ chart: { result: null } }, 404);
    return J({ chart: { result: [{ meta: { currency: 'USD', instrumentType: sym === 'FUND' || sym === 'SPY' ? 'ETF' : 'EQUITY', regularMarketPrice: s.c.at(-1), longName: `${sym} Inc` }, timestamp: s.t, indicators: { quote: [{ open: s.o, high: s.h, low: s.l, close: s.c, volume: s.v }] } }] } });
  }
  if (u.includes('/v1/finance/search')) {
    const q = new URL(u).searchParams.get('q');
    return J({ news: q === 'ACME' ? [{ title: 'Acme wins record contract with the Navy', publisher: 'Wire', link: 'https://x', providerPublishTime: Math.floor(Date.now() / 1000) - 3600 }] : [] });
  }
  if (u.includes('apewisdom')) {
    return J({
      results: u.endsWith('/1')
        ? [
            { rank: 12, ticker: 'SOCL', name: 'Social Co', mentions: 60, upvotes: 300, rank_24h_ago: 40, mentions_24h_ago: 15 },
            { rank: 30, ticker: 'ACME', name: 'Acme', mentions: 20, upvotes: 50, rank_24h_ago: 60, mentions_24h_ago: 8 },
          ]
        : [],
    });
  }
  if (u.includes('stocktwits.com/api/2/trending')) return J({ symbols: [{ symbol: 'SOCL', title: 'Social Co' }, { symbol: 'BTC.X', title: 'Bitcoin' }] });
  if (u.includes('capitoltrades')) {
    return J({
      data: [
        { txDate: dAgo(20), pubDate: dAgo(3), txType: 'buy', value: 50000, issuer: { issuerTicker: 'CNGR:US' }, politician: { firstName: 'Nancy', lastName: 'Example', chamber: 'house' } },
        { txDate: dAgo(18), pubDate: dAgo(2), txType: 'buy', value: 15000, issuer: { issuerTicker: 'CNGR:US' }, politician: { firstName: 'Tom', lastName: 'Sample', chamber: 'senate' } },
        { txDate: dAgo(18), pubDate: dAgo(2), txType: 'buy', value: 15000, issuer: { issuerTicker: 'ACME:US' }, politician: { firstName: 'Tom', lastName: 'Sample', chamber: 'senate' } },
      ],
    });
  }
  if (u.includes('openinsider')) {
    const row = (tk, co, who, title, val) => `<tr><td></td><td>${dAgo(2)} 16:01:02</td><td>${dAgo(3)}</td><td><a>${tk}</a></td><td>${co}</td><td>${who}</td><td>${title}</td><td>P - Purchase</td><td>$20</td><td>+1</td><td>1</td><td>+5%</td><td>+$${val}</td></tr>`;
    const body = [
      row('ACME', 'Acme Corp', 'Doe Jane', 'CEO', '400,000'),
      row('ACME', 'Acme Corp', 'Roe Rick', 'Dir', '150,000'),
      row('ACME', 'Acme Corp', 'Poe Pat', 'CFO', '90,000'),
      row('RUNR', 'Runner Inc', 'Fast Fred', 'CEO', '2,000,000'),
      row('RUNR', 'Runner Inc', 'Quick Q', 'Dir', '900,000'),
      row('BNCE', 'Bounce Co', 'Up Ursula', 'CEO', '500,000'),
      row('PNNY', 'Penny Co', 'Small Sam', 'CEO', '50,000'),
      row('FUND', 'A Fund', 'Some One', 'Dir', '50,000'),
    ].join('');
    const head = '<tr><th>X</th><th>Filing&nbsp;Date</th><th>Trade&nbsp;Date</th><th>Ticker</th><th>Company&nbsp;Name</th><th>Insider&nbsp;Name</th><th>Title</th><th>Trade&nbsp;Type</th><th>Price</th><th>Qty</th><th>Owned</th><th>&Delta;Own</th><th>Value</th></tr>';
    return new Response(`<table class="tinytable"><thead>${head}</thead><tbody>${body}</tbody></table>`, { status: 200 });
  }
  return new Response('not mocked: ' + u, { status: 500 });
}
globalThis.fetch = async (url) => mockFetch(url);
const mem = new Map();
const env = {
  INSIDER_DAYS: '30',
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

// --- run filter
const run = (s) => recentRun(setupFacts(toBars(s)));
assert.ok(run(SHAPES.RUNR) >= MAX_RUN_PCT, 'a 40% run is caught');
assert.ok(run(SHAPES.BNCE) >= MAX_RUN_PCT, 'a 30% bounce off the 3 month low is caught');
assert.ok(run(SHAPES.ACME) < MAX_RUN_PCT, `flat stock passes (${run(SHAPES.ACME)})`);
assert.ok(setupFacts(toBars(SHAPES.ACME)).squeezePct <= 25, 'tight recent range reads as a squeeze');

// --- parts
assert.equal(insiderPart(null), null);
const cl = insiderPart({ buyers: 3, csuite: 2, total_value: 640000, last_date: dAgo(3) });
assert.ok(cl.pts > insiderPart({ buyers: 1, csuite: 0, total_value: 20000, last_date: dAgo(25) }).pts, 'cluster beats a lone small buy');
assert.ok(cl.pts <= 35);
assert.equal(cl.tag, 'Insider cluster');
assert.ok(congressPart([{ type: 'buy', member: 'A', amountMin: 50000 }]).pts > 0);
assert.ok(congressPart([{ type: 'sell', member: 'A', amountMin: 50000 }]).pts < 0);
const hype = socialPart({ rank: 2, rank24hAgo: 3, mentions: 900, mentions24hAgo: 850 }, false, { rsi14: 80 });
assert.ok(hype.pts < 0, 'crowded hype on an overbought chart counts against');
assert.equal(setupScore([{ pts: 20 }, { pts: 10 }, { pts: 6 }]), 46, 'three agreeing parts earn the bonus');
assert.equal(setupScore([{ pts: -30 }]), 0, 'score floors at 0');

// --- candidates: multi signal names first, no crypto or index funds
const cands = pickCandidates({ insiders: [{ ticker: 'ACME' }, { ticker: 'SPY' }, { ticker: 'ZED' }], congress: [{ ticker: 'ACME', type: 'buy' }, { ticker: 'XX', type: 'sell' }], ape: [], trending: [{ ticker: 'BTC-USD' }] });
assert.deepEqual(cands, ['ACME', 'ZED']);

// --- full build
const d = await buildBreakout(env);
const got = d.picks.map((p) => p.ticker);
assert.equal(got[0], 'ACME', `ACME leads (${got.join(', ')})`);
for (const t of ['RUNR', 'BNCE', 'PNNY', 'FUND']) assert.ok(!got.includes(t), `${t} is filtered out`);
assert.ok(got.includes('CNGR') && got.includes('SOCL'), `congress and social names make the list (${got.join(', ')})`);
assert.ok(d.status.skipped.ran >= 2 && d.status.skipped.etf >= 1 && d.status.skipped.thin >= 1, JSON.stringify(d.status.skipped));
const acme = d.picks[0];
assert.ok(acme.reasons.some((r) => /Cluster buy: 3 insiders/.test(r)), acme.reasons.join(' | '));
assert.ok(acme.breakdown.news > 0, 'positive headline counts');
assert.ok(acme.trigger > acme.price * 0.99);
assert.ok(d.picks.every((p) => p.run < MAX_RUN_PCT && p.score >= 0 && p.score <= 100));

// --- panels
const html = breakoutHtml(d);
assert.ok(html.includes('Breakout watch'));
assert.equal((html.match(/class="bo-card card"/g) || []).length, d.picks.length);
assert.ok(html.includes('href="#/t/ACME"'));
assert.ok(!/not financial advice|risk/i.test(html), 'no warnings in the panels');
assert.ok(breakoutHtml({ picks: [] }).includes('No stock passes'));
assert.ok(sparkWithTrigger([1, 2, 3], 4).includes('bo-trig'));

console.log(`breakout: ok (${got.join(', ')}; scores ${d.picks.map((p) => p.score).join(', ')})`);
