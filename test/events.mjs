// Offline test for the market events page: mocks the Nasdaq calendars,
// Treasury Fiscal Data and Yahoo. Run: node test/events.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildEvents, opexDate, vixExpiry, nthTradingDay, thirdFriday, ruleEvents, typeOf, readResult, numOf, todayET, OFFICIAL, TYPES, HOLIDAYS } from '../src/events.js';
import { filterEvents, listHtml, relDay, fmtTime, nextUp } from '../public/events.js';

// --- rule dates
assert.equal(thirdFriday(2026, 12), '2026-12-18');
assert.equal(opexDate(2026, 12), '2026-12-18');
assert.equal(opexDate(2027, 1), '2027-01-15');
assert.equal(vixExpiry(2026, 11), '2026-11-18', 'Wednesday 30 days before the December third Friday');
assert.equal(vixExpiry(2026, 12), '2026-12-16');
assert.equal(nthTradingDay(2027, 1, 1), '2027-01-04', 'skips the New Year holiday and the weekend');
assert.equal(nthTradingDay(2026, 12, 3), '2026-12-03');
assert.equal(todayET(new Date('2026-11-23T03:00:00Z')), '2026-11-22', 'Eastern date, not UTC');
const rules = ruleEvents('2026-11-20', '2026-12-31');
const claims = rules.filter((e) => e.type === 'claims').map((e) => e.date);
assert.ok(claims.includes('2026-11-25') && !claims.includes('2026-11-26'), 'claims move to Wednesday on Thanksgiving');
assert.ok(rules.some((e) => e.type === 'quad' && e.date === '2026-12-18'));
assert.ok(rules.some((e) => e.type === 'sprebal' && e.date === '2026-12-18'));
assert.ok(rules.some((e) => e.type === 'ndx' && e.date === '2026-12-18'));
assert.ok(!rules.some((e) => e.type === 'opex' && e.date === '2026-12-18'), 'December is quad witching, not plain opex');
assert.ok(rules.some((e) => e.type === 'halfday' && e.date === '2026-11-27'));
for (const e of OFFICIAL) {
  assert.ok(TYPES[e.type], `known type ${e.type}`);
  assert.ok(!HOLIDAYS[e.date] || e.type === 'opec', `official ${e.type} on ${e.date} is not on a market holiday`);
  assert.ok(e.source && /^https:\/\//.test(e.source[1]), 'official entries cite a source');
}

// --- matching and readings
assert.equal(typeOf('Core CPI (MoM)'), 'cpi');
assert.equal(typeOf('PPI ex Food & Energy (MoM)'), 'ppi');
assert.equal(typeOf('Core PCE Price Index (MoM)'), 'pce');
assert.equal(typeOf('Initial Jobless Claims'), 'claims');
assert.equal(typeOf('Nonfarm Payrolls'), 'jobs');
assert.equal(typeOf('FOMC Meeting Minutes'), 'minutes');
assert.equal(typeOf('Fed Governor Waller Speaks'), 'fedspeak');
assert.equal(typeOf('10-Year Note Auction'), 'auction');
assert.equal(typeOf('Baker Hughes Oil Rig Count'), null, 'noise is dropped');
assert.equal(numOf('245K'), 245000);
assert.equal(numOf('0.3%'), 0.3);
assert.equal(numOf('&nbsp;'), null);
assert.equal(readResult('cpi', { actual: '0.4%', expected: '0.3%' }).tone, 'down', 'hot inflation reads bearish');
assert.equal(readResult('cpi', { actual: '0.2%', expected: '0.3%' }).vs, 'below');
assert.equal(readResult('cpi', { actual: '0.3%', expected: '0.3%' }).vs, 'inline');
assert.equal(readResult('jobs', { actual: '250K', expected: '150K' }).vs, 'above');
assert.equal(readResult('claims', { actual: '260K', expected: '230K' }).tone, 'down', 'more layoffs reads weaker');

// --- full pipeline with mocked feeds
const J = (o) => new Response(JSON.stringify(o), { status: 200, headers: { 'content-type': 'application/json' } });
const ECON = {
  '2026-11-17': [
    { gmt: '08:30', country: 'United States', eventName: 'Retail Sales (MoM)', actual: '0.1%', consensus: '0.4%', previous: '0.6%' },
    { gmt: '08:30', country: 'United States', eventName: 'Core Retail Sales (MoM)', actual: '0.2%', consensus: '0.3%', previous: '0.5%' },
    { gmt: '08:30', country: 'Canada', eventName: 'CPI (MoM)', actual: '0.2%', consensus: '0.3%', previous: '0.1%' },
  ],
  '2026-11-19': [
    { gmt: '08:30', country: 'United States', eventName: 'Initial Jobless Claims', actual: '245K', consensus: '230K', previous: '232K' },
    { gmt: '08:30', country: 'United States', eventName: 'Philly Fed Manufacturing Index', actual: '5', consensus: '3', previous: '1' },
    { gmt: '13:00', country: 'United States', eventName: 'Fed Governor Waller Speaks', actual: '&nbsp;', consensus: '&nbsp;', previous: '&nbsp;' },
  ],
  '2026-11-25': [{ gmt: '08:30', country: 'United States', eventName: 'Core PCE Price Index (MoM)', actual: '&nbsp;', consensus: '0.2%', previous: '0.3%' }],
};
const EARN = {
  '2026-11-19': [
    { symbol: 'NVDA', name: 'NVIDIA Corporation', marketCap: '$4,500,000,000,000', time: 'time-after-hours', epsForecast: '$1.38', eps: '$1.45', fiscalQuarterEnding: 'Oct/2026' },
    { symbol: 'TINY', name: 'Tiny Co', marketCap: '$2,000,000,000', time: 'time-pre-market', epsForecast: '$0.10', eps: '$0.12' },
    { symbol: 'XYZ', name: 'Watched Inc', marketCap: '$5,000,000,000', time: 'time-pre-market', epsForecast: '$0.50', eps: '$0.40' },
  ],
};
const calls = [];
globalThis.fetch = async (url) => {
  const u = String(url);
  calls.push(u);
  let m;
  if ((m = u.match(/economicevents\?date=(\d{4}-\d\d-\d\d)/))) return J({ data: { rows: ECON[m[1]] || [] } });
  if ((m = u.match(/calendar\/earnings\?date=(\d{4}-\d\d-\d\d)/))) return J({ data: { rows: EARN[m[1]] || [] } });
  if ((m = u.match(/ipo\/calendar\?date=(\d{4}-\d\d)/)))
    return J({ data: { priced: { rows: m[1] === '2026-06' ? [{ proposedTickerSymbol: 'BIGI', companyName: 'Big IPO Corp', pricedDate: '06/01/2026', proposedSharePrice: '25.00', dollarValueOfSharesOffered: '$1,500,000,000' }, { proposedTickerSymbol: 'SMOL', companyName: 'Small', pricedDate: '06/02/2026', dollarValueOfSharesOffered: '$20,000,000' }] : [] } } });
  if (u.includes('calendar/splits')) return J({ data: { rows: [{ symbol: 'ABC', name: 'ABC Corp', ratio: '10 : 1', executionDate: '12/01/2026' }, { symbol: 'OLD', name: 'Old', ratio: '2 : 1', executionDate: '01/05/2026' }] } });
  if (u.includes('upcoming_auctions'))
    return J({ data: [{ security_type: 'Note', security_term: '10-Year', auction_date: '2026-12-09', offering_amt: '39000000000', reopening: 'Yes' }, { security_type: 'Bill', security_term: '52-Week', auction_date: '2026-12-01', offering_amt: '1' }] });
  if (u.includes('fc.yahoo.com')) return new Response('', { status: 302, headers: { 'set-cookie': 'A3=x; Path=/' } });
  if (u.includes('getcrumb')) return new Response('crumb123', { status: 200 });
  if ((m = u.match(/quoteSummary\/([^?]+)/))) {
    const t = decodeURIComponent(m[1]);
    const ce = t === 'MSFT' ? { earnings: { earningsDate: [{ raw: Date.parse('2027-01-27T21:00:00Z') / 1000 }], earningsAverage: { raw: 4.1 }, revenueAverage: { raw: 81e9 }, isEarningsDateEstimate: true } } : t === 'NVDA' ? { earnings: { earningsDate: [{ raw: Date.parse('2027-02-24T21:00:00Z') / 1000 }] } } : { earnings: {} };
    return J({ quoteSummary: { result: [{ calendarEvents: ce, price: { shortName: t === 'MSFT' ? 'Microsoft Corporation' : t, marketCap: { raw: 3.9e12 } } }] } });
  }
  return new Response('not mocked: ' + u, { status: 500 });
};
const mem = new Map();
const env = { CACHE: { async get(k, t) { const v = mem.get(k); return v == null ? null : t === 'json' ? JSON.parse(v) : v; }, async put(k, v) { mem.set(k, v); } } };
const NOW = '2026-11-22T22:00:00Z';

// A small budget leaves work for later visits and says so.
const p1 = await buildEvents(env, { now: NOW, watch: ['XYZ', 'BIGI'], budgetScale: 0.3 });
assert.equal(p1.partial, true, 'reports that some feeds are still loading');
const before = calls.length;
const d = await buildEvents(env, { now: NOW, watch: ['XYZ', 'BIGI'], budgetScale: 10 });
assert.ok(calls.length > before);
const cachedRun = calls.length;
await buildEvents(env, { now: NOW, watch: ['XYZ', 'BIGI'], budgetScale: 10 });
assert.equal(calls.length, cachedRun, 'a second visit is served from cache');
assert.equal(d.partial, false);
assert.equal(d.today, '2026-11-22');
for (const [k, f] of Object.entries(d.feeds)) assert.ok(f.ok, `feed ${k} ok: ${f.note}`);
const find = (pred, msg) => {
  const e = d.events.find(pred);
  assert.ok(e, msg);
  return e;
};

const retail = find((e) => e.type === 'retail' && e.date === '2026-11-17', 'retail sales');
assert.equal(retail.official, true);
assert.equal(retail.data.length, 2, 'US rows only');
assert.equal(retail.result.vs, 'below');
assert.equal(retail.result.tone, 'down');
const cl = find((e) => e.type === 'claims' && e.date === '2026-11-19', 'claims');
assert.equal(cl.result.vs, 'above');
assert.ok(!d.events.some((e) => /Philly/.test(e.title)), 'unmapped rows dropped');
find((e) => e.type === 'fedspeak' && /Waller/.test(e.title), 'Fed speaker from the live calendar');
const pce = find((e) => e.type === 'pce' && e.date === '2026-11-25', 'PCE');
assert.equal(pce.data[0].expected, '0.2%');
assert.equal(pce.data[0].actual, null);
assert.equal(pce.result, undefined, 'no reading before release');

const nv = find((e) => e.type === 'earnings' && e.tickers[0] === 'NVDA' && e.date === '2026-11-19', 'NVDA recent earnings');
assert.equal(nv.impact, 3);
assert.equal(nv.result.vs, 'above');
assert.match(nv.means, /AI trade/);
assert.ok(!d.events.some((e) => e.tickers.includes('TINY')), 'small caps not on a watchlist are left out');
const xyz = find((e) => e.tickers[0] === 'XYZ', 'watchlist earnings');
assert.equal(xyz.watch, true);
assert.equal(xyz.impact, 2);
assert.equal(xyz.result.vs, 'below');
const ms = find((e) => e.tickers[0] === 'MSFT', 'MSFT upcoming from Yahoo');
assert.equal(ms.date, '2027-01-27');
assert.equal(ms.tentative, true);
assert.equal(ms.data[0].expected, '4.10');

const lock = find((e) => e.type === 'lockup', 'IPO lockup');
assert.equal(lock.date, '2026-11-30', '180 days after June 1 is a Saturday, so the next trading day');
assert.equal(lock.impact, 2);
assert.equal(lock.watch, true);
assert.equal(d.events.filter((e) => e.type === 'lockup').length, 1, 'tiny IPOs skipped');
const sp = find((e) => e.type === 'split', 'split');
assert.equal(sp.date, '2026-12-01');
assert.equal(d.events.filter((e) => e.type === 'split').length, 1, 'only splits in the window');
const au = find((e) => e.type === 'auction' && e.date === '2026-12-09', '10 year auction');
assert.equal(au.impact, 2);
assert.match(au.title, /reopening/);
assert.ok(!d.events.some((e) => /52-Week/.test(e.title)), 'bills skipped');

find((e) => e.type === 'fomc' && e.date === '2026-12-09', 'December FOMC');
find((e) => e.type === 'cpi' && e.date === '2026-12-10', 'November CPI');
find((e) => e.type === 'jobs' && e.date === '2026-12-04', 'November jobs report');
find((e) => e.type === 'shutdown' && e.date === '2026-12-11', 'funding deadline');
find((e) => e.type === 'opec', 'OPEC+');
assert.ok(d.events.every((e) => e.date >= d.from && e.date <= d.to), 'window respected');
for (let i = 1; i < d.events.length; i++) assert.ok(d.events[i - 1].date <= d.events[i].date, 'sorted by date');

// --- front end helpers
const up = filterEvents(d, { view: 'upcoming', min: 2, cat: 'all', mine: false });
assert.ok(up.every((e) => e.date >= d.today && (e.impact >= 2 || e.watch)));
const rec = filterEvents(d, { view: 'recent', min: 1, cat: 'all', mine: false });
assert.ok(rec.every((e) => e.date <= d.today) && rec.some((e) => e.type === 'retail'));
const mine = filterEvents(d, { view: 'upcoming', min: 1, cat: 'all', mine: true });
assert.ok(mine.length >= 1 && mine.every((e) => e.watch));
assert.ok(filterEvents(d, { view: 'upcoming', min: 1, cat: 'fed', mine: false }).every((e) => e.cat === 'fed'));
assert.equal(nextUp(d)[0].type, 'jobs', 'next high impact event after Nov 22 is the Dec 4 jobs report');
assert.equal(relDay('2026-11-23', '2026-11-22'), 'Tomorrow');
assert.equal(fmtTime('08:30'), '8:30 am ET');
assert.equal(fmtTime('14:00'), '2:00 pm ET');
const html = listHtml(d, { view: 'recent', min: 1, cat: 'all', mine: false }) + listHtml(d, { view: 'upcoming', min: 1, cat: 'all', mine: false });
assert.ok(html.includes('Below forecast'));
assert.ok(html.includes('href="#/t/NVDA"'));
assert.ok(!/<script/i.test(html));

// --- no em or en dashes in data, rendered copy or source files
assert.ok(!/[\u2014\u2013]/.test(JSON.stringify(d)), 'no dashes in data');
assert.ok(!/[\u2014\u2013]/.test(html), 'no dashes in html');
for (const f of ['src/events.js', 'public/events.js', 'public/events.css']) assert.ok(!/[\u2014\u2013]/.test(readFileSync(new URL('../' + f, import.meta.url), 'utf8')), `no dashes in ${f}`);

console.log(`${d.events.length} events from ${d.from} to ${d.to}; ${up.length} upcoming at medium or high impact.`);
console.log('Events checks passed.');
if (process.env.DUMP_EVENTS) (await import('node:fs')).writeFileSync(process.env.DUMP_EVENTS, JSON.stringify(d));
