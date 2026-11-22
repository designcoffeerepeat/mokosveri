// Offline test for the AI lenses: XBRL quarter extraction, margin trend flags,
// the chart vs fundamentals read, AI reply parsing, and all six lenses run end
// to end against mocked SEC, Yahoo and Workers AI. Run: node test/lenses.mjs
import assert from 'node:assert/strict';
import { quartersFromFacts, mergeSeries, buildQuarterRows, trendFlags, htmlToText, valuationOf, earningsOf } from '../src/sources/fundamentals.js';
import { convergenceRead, parseAiJson, sanitizeLens, lensParams, lensKey, handleLens, LENS_IDS } from '../src/lenses.js';
import { LENSES, resultHtml, badgeFor } from '../public/lenses.js';

// ---------- XBRL quarters ----------
// Fiscal year = calendar year. Q1 to Q3 reported as 3 month facts, Q4 only in
// the annual total. Revenue grows 2% a quarter.
function revFacts(years = [2022, 2023, 2024, 2025], base = 1000) {
  const out = [];
  let v = base;
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  const starts = ['01-01', '04-01', '07-01', '10-01'];
  for (const y of years) {
    const qs = [];
    for (let i = 0; i < 4; i++) {
      qs.push(Math.round(v));
      v *= 1.02;
    }
    for (let i = 0; i < 3; i++) out.push({ start: `${y}-${starts[i]}`, end: `${y}-${ends[i]}`, val: qs[i], filed: `${y}-${ends[i].slice(0, 2)}-28`, form: '10-Q' });
    out.push({ start: `${y}-01-01`, end: `${y}-12-31`, val: qs.reduce((a, b) => a + b, 0), filed: `${y + 1}-02-15`, form: '10-K' });
    // Year to date six month fact must be ignored.
    out.push({ start: `${y}-01-01`, end: `${y}-06-30`, val: qs[0] + qs[1], filed: `${y}-07-28`, form: '10-Q' });
  }
  return out;
}
const rq = quartersFromFacts(revFacts());
assert.equal(rq.length, 16, 'four years of quarters including derived Q4s');
const q4 = rq.find((r) => r.end === '2024-12-31');
assert.ok(q4 && q4.derived, 'Q4 derived from the annual total');
assert.ok(Math.abs(q4.val / rq.find((r) => r.end === '2024-09-30').val - 1.02) < 0.01, 'derived Q4 keeps the growth path');
// A restated figure (filed later) wins.
const restated = quartersFromFacts([...revFacts([2025]), { start: '2025-01-01', end: '2025-03-31', val: 1, filed: '2026-04-30' }]);
assert.equal(restated.find((r) => r.end === '2025-03-31').val, 1);

// Tag switch: old tag covers 2022, new tag covers 2023 on; merged series spans both.
const old = quartersFromFacts(revFacts([2022]));
const neu = quartersFromFacts(revFacts([2023, 2024, 2025], 1100));
assert.equal(mergeSeries([neu, old]).length, 16);

// Rows and flags: margins compress in the last two quarters.
const rev = quartersFromFacts(revFacts());
const gross = rev.map((r, i) => ({ end: r.end, val: r.val * (i >= 14 ? 0.4 : 0.5) }));
const opInc = rev.map((r) => ({ end: r.end, val: r.val * 0.2 }));
const rows = buildQuarterRows({ revenue: rev, gross, opInc });
assert.equal(rows.length, 12);
assert.ok(Math.abs(rows.at(-1).revGrowth - 8.24) < 0.2, `yoy growth ${rows.at(-1).revGrowth}`);
assert.ok(Math.abs(rows.at(-1).grossMargin - 40) < 0.01);
assert.ok(Math.abs(rows.at(-1).opMargin - 20) < 0.01);
const flags = trendFlags(rows);
const gm = flags.find((f) => f.metric === 'Gross margin');
assert.equal(gm.dir, 'contracting');
assert.equal(flags.find((f) => f.metric === 'Operating margin').dir, 'stable');
assert.equal(flags.find((f) => f.metric === 'Revenue growth').dir, 'steady');
// Cost of revenue fills in when gross profit is not tagged.
const rows2 = buildQuarterRows({ revenue: rev, cost: rev.map((r) => ({ end: r.end, val: r.val * 0.7 })) });
assert.ok(Math.abs(rows2.at(-1).grossMargin - 30) < 0.01);

// ---------- html, valuation, earnings ----------
assert.equal(htmlToText('<html><head><title>x</title></head><body><p>Revenue&nbsp;rose &#8212; 12%</p><script>bad()</script><div>Q3&amp;Q4</div></body></html>'), 'Revenue rose, 12%\nQ3&Q4');
const v = valuationOf({ price: { marketCap: { raw: 1e11 }, shortName: 'Acme' }, summaryDetail: { trailingPE: { raw: 30 }, priceToSalesTrailing12Months: { raw: 6 } }, defaultKeyStatistics: { enterpriseToEbitda: { raw: 20 } }, financialData: { freeCashflow: { raw: 4e9 }, debtToEquity: { raw: 45 }, grossMargins: { raw: 0.6 }, revenueGrowth: { raw: 0.12 } } }, 'ACME');
assert.equal(v.fcfYield, 4);
assert.equal(v.debtToEquity, 0.45);
assert.equal(v.grossMargin, 60);
assert.ok(Math.abs(v.revGrowth - 12) < 1e-9);
const e = earningsOf({
  earningsHistory: { history: [{ quarter: { raw: 1735603200 }, epsActual: { raw: 1.2 }, epsEstimate: { raw: 1.1 }, surprisePercent: { raw: 0.09 } }] },
  earningsTrend: { trend: [{ period: '+1q', endDate: '2026-03-31', earningsEstimate: { avg: { raw: 1.3 } }, epsTrend: { current: { raw: 1.3 }, '30daysAgo': { raw: 1.25 }, '90daysAgo': { raw: 1.2 } }, epsRevisions: { upLast30days: { raw: 5 }, downLast30days: { raw: 1 } } }, { period: '-5y' }] },
});
assert.equal(e.history.length, 1);
assert.equal(e.trend.length, 1);
assert.equal(e.trend[0].period, 'Next quarter');
assert.ok(Math.abs(e.trend[0].change30 - 4) < 1e-9);

// ---------- chart vs fundamentals ----------
const up = { price: 120, sma50: 110, sma200: 100, goldenCross: true, rsi14: 62, macdHist: 0.5 };
const down = { price: 80, sma50: 90, sma200: 100, goldenCross: false, rsi14: 40, macdHist: -0.5 };
const cheap = { fcfYield: 7, debtToEquity: 0.3, pe: 12, revGrowth: 5 };
const rich = { fcfYield: 1, debtToEquity: 2, pe: 60, revGrowth: -3 };
assert.equal(convergenceRead(up, cheap).alignment, 'Congruent, bullish');
assert.equal(convergenceRead(down, rich).alignment, 'Congruent, bearish');
assert.equal(convergenceRead(up, rich).alignment, 'Diverging, momentum ahead of value');
assert.equal(convergenceRead(down, cheap).alignment, 'Diverging, value without momentum');
assert.equal(convergenceRead(null, null).alignment, 'Mixed');

// ---------- AI reply parsing ----------
const good = { verdict: 'Strong counter case', tone: 'negative', rating: 'strong', headline: 'Growth is slowing — fast.', points: [{ tag: 'Macro', title: 'Rates bite', detail: 'Debt costs rise - margins fall.' }, { tag: 'Structural', title: 'Share loss', detail: 'Two rivals cut prices.' }], watch: ['Gross margin under 40%'] };
assert.equal(parseAiJson({ response: good }).verdict, 'Strong counter case');
assert.equal(parseAiJson({ response: '```json\n' + JSON.stringify(good) + '\n```' }).tone, 'negative');
assert.equal(parseAiJson({ response: 'no json here' }), null);
const s = sanitizeLens(good);
assert.ok(!/[—–]/.test(JSON.stringify(s)), 'no long dashes in copy');
assert.ok(!/ - /.test(s.points[0].detail), 'spaced hyphens become commas');
assert.equal(sanitizeLens({ ...good, points: [good.points[0]] }), null, 'needs at least two points');
assert.equal(sanitizeLens({ ...good, tone: 'weird' }).tone, 'neutral');

// ---------- params and cache keys ----------
const qp = (o) => new URLSearchParams(o);
assert.deepEqual(lensParams('devil', qp({ side: 'bearish' }), 'ACME'), { side: 'bearish' });
assert.deepEqual(lensParams('devil', qp({ side: 'x' }), 'ACME'), { side: 'bullish' });
assert.deepEqual(lensParams('macro', qp({ event: 'oil_up', vs: 'zeta' }), 'ACME'), { event: 'oil_up', vs: 'ZETA' });
assert.deepEqual(lensParams('macro', qp({ event: 'nope', vs: 'ACME' }), 'ACME'), { event: 'rates_high', vs: null });
assert.equal(lensKey('ACME', 'macro', { event: 'oil_up', vs: null }), 'lens:v1:ACME:macro:event=oil_up');

// ---------- end to end with mocked upstreams ----------
const concept = (tag) => {
  const f = revFacts();
  if (/Revenue/.test(tag) && tag === 'RevenueFromContractWithCustomerExcludingAssessedTax') return { units: { USD: f } };
  if (tag === 'GrossProfit') return { units: { USD: f.map((x) => ({ ...x, val: x.val * 0.55 })) } };
  if (tag === 'OperatingIncomeLoss') return { units: { USD: f.map((x) => ({ ...x, val: x.val * 0.21 })) } };
  return null;
};
const qsFull = (name) => ({
  price: { longName: `${name} Inc`, shortName: name, marketCap: { raw: 5e10 }, regularMarketPrice: { raw: 100 } },
  quoteType: { quoteType: 'EQUITY' },
  summaryDetail: { trailingPE: { raw: 25 }, forwardPE: { raw: 21 }, priceToSalesTrailing12Months: { raw: 5 }, beta: { raw: 1.1 } },
  defaultKeyStatistics: { enterpriseToEbitda: { raw: 17 }, heldPercentInstitutions: { raw: 0.71 }, shortPercentOfFloat: { raw: 0.03 } },
  financialData: { freeCashflow: { raw: 2e9 }, debtToEquity: { raw: 80 }, grossMargins: { raw: 0.55 }, operatingMargins: { raw: 0.21 }, revenueGrowth: { raw: 0.08 }, returnOnEquity: { raw: 0.22 }, currentRatio: { raw: 1.4 }, totalCash: { raw: 5e9 }, totalDebt: { raw: 8e9 }, targetMeanPrice: { raw: 115 } },
  assetProfile: { sector: 'Technology', industry: 'Software', longBusinessSummary: `${name} sells workflow software.` },
  earningsHistory: { history: [1, 2, 3, 4].map((i) => ({ quarter: { raw: 1700000000 + i * 7776000 }, epsActual: { raw: 1 + i / 10 }, epsEstimate: { raw: 1 + i / 10 - (i === 2 ? -0.05 : 0.03) }, surprisePercent: { raw: i === 2 ? -0.04 : 0.03 } })) },
  earningsTrend: { trend: [{ period: '0q', earningsEstimate: { avg: { raw: 1.5 } }, epsTrend: { current: { raw: 1.5 }, '30daysAgo': { raw: 1.45 } }, epsRevisions: { upLast30days: { raw: 4 }, downLast30days: { raw: 0 } } }] },
});
function bars(n = 260) {
  const t0 = Math.floor(Date.now() / 1000) - n * 86400;
  const c = Array.from({ length: n }, (_, i) => 50 + i * 0.2 + Math.sin(i / 5));
  return { chart: { result: [{ meta: { currency: 'USD', regularMarketPrice: c.at(-1) }, timestamp: c.map((_, i) => t0 + i * 86400), indicators: { quote: [{ open: c, high: c.map((x) => x + 1), low: c.map((x) => x - 1), close: c, volume: c.map(() => 1e6) }] } }] } };
}
const seen = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  seen.push(u);
  const J = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
  const T = (s2, status = 200) => new Response(s2, { status });
  if (u.includes('fc.yahoo.com')) return T('', 404);
  if (u.includes('getcrumb')) return T('crumb123');
  if (u.includes('recommendationsbysymbol')) return J({ finance: { result: [{ symbol: 'ACME', recommendedSymbols: [{ symbol: 'ZETA' }, { symbol: 'QQQ' }, { symbol: 'OMNI' }, { symbol: 'BETA' }] }] } });
  if (u.includes('quoteSummary/QQQ')) return J({ quoteSummary: { result: [{ ...qsFull('QQQ'), quoteType: { quoteType: 'ETF' } }] } });
  if (u.includes('quoteSummary/')) {
    const sym = u.split('quoteSummary/')[1].split('?')[0];
    return J({ quoteSummary: { result: [qsFull(sym)] } });
  }
  if (u.includes('/v8/finance/chart/')) return J(bars());
  if (u.includes('/v1/finance/search')) return J({ news: [{ title: 'Acme beats estimates', publisher: 'Reuters', link: 'https://x', providerPublishTime: Date.now() / 1000 - 3600 }] });
  if (u.includes('feeds.finance.yahoo.com') || u.includes('news.google.com')) return T('<rss><channel></channel></rss>');
  if (u.includes('browse-edgar')) return T('<feed><company-info><cik>0000123456</cik><conformed-name>ACME CORP</conformed-name></company-info></feed>');
  if (u.includes('api/xbrl/companyconcept')) {
    const tag = u.split('/us-gaap/')[1].replace('.json', '');
    const c = concept(tag);
    return c ? J(c) : J({ message: 'not found' }, 404);
  }
  if (u.includes('data.sec.gov/submissions')) return J({ filings: { recent: { form: ['4', '8-K', '8-K'], items: ['', '5.02', '2.02,9.01'], filingDate: ['2026-11-01', '2026-10-30', '2026-10-28'], accessionNumber: ['0001-26-1', '0001-26-2', '0001-26-3'], primaryDocument: ['a.xml', 'b.htm', 'acme-8k.htm'] } } });
  if (u.endsWith('/000126' + '3/index.json')) return J({ directory: { item: [{ name: 'acme-8k.htm' }, { name: 'acme-ex991.htm' }, { name: 'R1.htm' }] } });
  if (u.endsWith('acme-ex991.htm')) return T('<html><body><p>Acme reports record revenue of $1.2 billion, up 8% organically. Results include a $40 million one time tax benefit.</p></body></html>');
  return T('not mocked: ' + u, 500);
};

const mem = new Map();
const prompts = [];
const env = {
  CACHE: { async get(k, type) { const v2 = mem.get(k); return v2 == null ? null : type === 'json' ? JSON.parse(v2) : v2; }, async put(k, v2) { mem.set(k, v2); } },
  AI: {
    async run(model, opts) {
      prompts.push({ model, opts });
      const user = opts.messages[1].content;
      if (/tag the first "Technical"/.test(user) && opts.response_format) throw new Error('json mode not supported');
      const reply = { verdict: 'Test verdict', tone: 'mixed', rating: 'moderate', headline: 'A balanced read.', points: [{ tag: 'A', title: 'One', detail: 'First point.' }, { tag: 'B', title: 'Two', detail: 'Second point.' }, { tag: 'C', title: 'Three', detail: 'Third point.' }], watch: ['Watch this', 'And this'] };
      return opts.response_format ? { response: reply } : { response: `Here you go: ${JSON.stringify(reply)}` };
    },
  },
};
const ctx = { waitUntil() {} };
const url = (lens, q = '') => new URL(`https://x.test/api/lens/ACME/${lens}${q}`);
const req = new Request('https://x.test/', { headers: { 'cf-connecting-ip': '1.2.3.4' } });

for (const lens of LENS_IDS) {
  const r = await handleLens(req, env, ctx, url(lens, lens === 'devil' ? '?side=bearish' : ''), 'ACME', lens, null);
  assert.ok(!r.status, `${lens} ok`);
  const b = r.body;
  assert.equal(b.lens, lens);
  assert.ok(b.ai && b.ai.points.length === 3, `${lens} has an AI read`);
  assert.ok(b.prompt.includes('ACME'), `${lens} prompt filled in`);
  assert.ok(!/\[TICKER\]|\[COMPANY\]|\[SECTOR\]/.test(b.prompt), `${lens} has no unfilled variables`);
  // The page renders every lens without throwing, with a data panel.
  const html = resultHtml(b, lens);
  assert.ok(html.includes('The numbers behind this') && html.includes('Test verdict'), `${lens} renders`);
  assert.ok(!/undefined|NaN/.test(html), `${lens} html has no undefined or NaN`);
}
// Model input carries the real numbers.
const devilIn = prompts.find((p) => /devil's advocate/.test(p.opts.messages[1].content)).opts.messages[1].content;
assert.ok(devilIn.includes('I am currently bearish'));
assert.ok(devilIn.includes('Gross margin'), 'quarterly table included');
const marginIn = prompts.find((p) => /last 12 quarters/.test(p.opts.messages[1].content)).opts.messages[1].content;
assert.ok(/ZETA/.test(marginIn) && /OMNI/.test(marginIn) && !/QQQ \(/.test(marginIn), 'peers exclude ETFs');
const earnIn = prompts.find((p) => /latest earnings report/.test(p.opts.messages[1].content)).opts.messages[1].content;
assert.ok(earnIn.includes('one time tax benefit'), 'press release text reaches the model');
// Convergence: JSON mode failed, the plain text retry was parsed.
const conv = (await handleLens(req, env, ctx, url('convergence'), 'ACME', 'convergence', null)).body;
assert.ok(conv.ai);
assert.ok(conv.data.read.tech.length >= 4);
// Macro defaults to the closest peer and names it.
const mac = (await handleLens(req, env, ctx, url('macro', '?event=oil_up'), 'ACME', 'macro', null)).body;
assert.equal(mac.params.vs, 'ZETA');
assert.ok(mac.prompt.includes('rising oil prices') && mac.prompt.includes('ZETA'));
// Margins data: 12 quarters plus peers.
const mar = (await handleLens(req, env, ctx, url('margins'), 'ACME', 'margins', null)).body;
assert.equal(mar.data.quarters.length, 12);
assert.equal(mar.data.peers.length, 3);
// Earnings data: release found via the 2.02 8-K.
const ear = (await handleLens(req, env, ctx, url('earnings'), 'ACME', 'earnings', null)).body;
assert.ok(ear.data.release && ear.data.release.url.endsWith('acme-ex991.htm'));
assert.equal(ear.data.history.length, 4);

// AI down: data still comes back with a clear message, and the page still renders.
const noAi = (await handleLens(req, { ...env, AI: { async run() { throw new Error('quota'); } } }, ctx, url('moat', '?fresh=1'), 'ACME', 'moat', null)).body;
assert.equal(noAi.ai, null);
assert.ok(/unavailable/.test(noAi.aiError));
assert.ok(resultHtml(noAi, 'moat').includes('No AI read'));

// Rate limit hook.
const limited = await handleLens(req, env, ctx, url('moat', '?fresh=1'), 'ACME', 'moat', async () => false);
assert.equal(limited.status, undefined, 'no DB means no rate limit');
const limited2 = await handleLens(req, { ...env, DB: { prepare() { throw new Error('x'); } } }, ctx, url('moat', '?fresh=1'), 'ACME', 'moat', async () => false);
assert.equal(limited2.status, 429);

// Badges.
assert.equal(LENSES.length, 6);
assert.equal(badgeFor('devil', { rating: 'strong', tone: 'negative' }), 'down');
assert.equal(badgeFor('moat', { rating: 'strong', tone: 'neutral' }), 'up');
assert.equal(badgeFor('convergence', { rating: 'diverging', tone: 'mixed' }), 'warn');

// No em or en dashes anywhere in the new code or copy.
const fs = await import('node:fs');
for (const f of ['src/lenses.js', 'src/sources/fundamentals.js', 'public/lenses.js', 'public/lenses.css']) {
  const txt = fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  assert.ok(!/[—–]/.test(txt), `${f} has no long dashes`);
}

console.log('lenses: all checks passed');
