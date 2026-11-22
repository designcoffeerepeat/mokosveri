// Market events calendar: recent and upcoming high impact events with an
// impact rating and a plain language note on what each could mean.
//
// Three kinds of data feed the page:
// 1. Official published calendars typed in by hand where no free API exists
//    (Fed, BLS, BEA, Census, NYSE holidays, Russell, OPEC+, funding deadline).
//    Checked against the official pages on 2026-11-22. See OFFICIAL below.
// 2. Dates computed from exchange rules (options expiration, quad witching,
//    VIX expiration, S&P rebalances, weekly jobless claims, ISM surveys).
// 3. Live feeds, each optional: Nasdaq economic calendar (actual vs expected,
//    Fed speakers), Nasdaq earnings and IPO calendars, Nasdaq splits,
//    Yahoo earnings dates, US Treasury upcoming auctions.
import { BROWSER_UA, getJSON, settle, pool, cleanTicker } from './util.js';
import { quoteSummaryModules, raw } from './sources/yahoo.js';

export const PAST_DAYS = 30;
export const AHEAD_DAYS = 75;
// The hand entered official calendars run through this date.
export const OFFICIAL_THROUGH = '2027-03-31';
// External fetches allowed per request for each feed (Workers Free allows 50
// subrequests in all). Anything over budget loads on the next visits.
export const BUDGETS = { econ: 10, earn: 6, yahoo: 6, ipo: 6, splits: 1, auctions: 1 };

// ---------- dates (all as YYYY-MM-DD strings, US Eastern calendar days) ----------
const D = (s) => new Date(s + 'T12:00:00Z');
const ymd = (d) => d.toISOString().slice(0, 10);
export const addDays = (s, n) => ymd(new Date(D(s).getTime() + n * 864e5));
export const dow = (s) => D(s).getUTCDay();
export const todayET = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
const mmddyyyy = (s) => {
  const m = String(s || '').match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
};

// NYSE full closures and 1:00 pm early closes (NYSE Group calendar for 2026 to 2028).
export const HOLIDAYS = {
  '2026-01-01': "New Year's Day", '2026-01-19': 'Martin Luther King Jr. Day', '2026-02-16': "Washington's Birthday", '2026-04-03': 'Good Friday',
  '2026-05-25': 'Memorial Day', '2026-06-19': 'Juneteenth', '2026-07-03': 'Independence Day (observed)', '2026-09-07': 'Labor Day',
  '2026-11-26': 'Thanksgiving Day', '2026-12-25': 'Christmas Day',
  '2027-01-01': "New Year's Day", '2027-01-18': 'Martin Luther King Jr. Day', '2027-02-15': "Washington's Birthday", '2027-03-26': 'Good Friday',
  '2027-05-31': 'Memorial Day', '2027-06-18': 'Juneteenth (observed)', '2027-07-05': 'Independence Day (observed)', '2027-09-06': 'Labor Day',
  '2027-11-25': 'Thanksgiving Day', '2027-12-24': 'Christmas Day (observed)',
};
export const HALF_DAYS = { '2026-11-27': 'Day after Thanksgiving', '2026-12-24': 'Christmas Eve', '2027-11-26': 'Day after Thanksgiving' };

export const isTradingDay = (s) => dow(s) > 0 && dow(s) < 6 && !HOLIDAYS[s];
export const prevTradingDay = (s) => {
  let d = addDays(s, -1);
  while (!isTradingDay(d)) d = addDays(d, -1);
  return d;
};
// n-th trading day of a month (1 based). month is 1..12.
export function nthTradingDay(y, month, n) {
  let d = `${y}-${String(month).padStart(2, '0')}-01`;
  let k = 0;
  for (;;) {
    if (isTradingDay(d)) k++;
    if (k === n) return d;
    d = addDays(d, 1);
  }
}
export function thirdFriday(y, month) {
  const first = `${y}-${String(month).padStart(2, '0')}-01`;
  const off = (5 - dow(first) + 7) % 7;
  return addDays(first, off + 14);
}
// Monthly options expire on the third Friday, or the trading day before when it is a holiday.
export const opexDate = (y, m) => {
  const f = thirdFriday(y, m);
  return isTradingDay(f) ? f : prevTradingDay(f);
};
// VIX settles on the Wednesday 30 days before the next month's third Friday
// (using the trading day before that Friday if it is a holiday); if that
// Wednesday is a holiday, the trading day before it.
export function vixExpiry(y, m) {
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  let f = thirdFriday(ny, nm);
  if (!isTradingDay(f)) f = prevTradingDay(f);
  const w = addDays(f, -30);
  return isTradingDay(w) ? w : prevTradingDay(w);
}

// ---------- event types: impact, category and the plain language note ----------
export const CATS = {
  fed: 'Fed',
  inflation: 'Inflation',
  jobs: 'Jobs',
  growth: 'Growth',
  earnings: 'Earnings',
  flows: 'Market mechanics',
  rates: 'Treasury',
  policy: 'Policy',
  energy: 'Energy',
  holiday: 'Market hours',
};
export const IMPACT = { 3: 'High', 2: 'Medium', 1: 'Low' };

// dir: how a higher than expected reading usually reads. 'hot' = more inflation,
// 'strong' = stronger economy, 'weakLabor' = more layoffs.
export const TYPES = {
  fomc: { cat: 'fed', impact: 3, time: '14:00', title: 'FOMC rate decision', why: 'Sets the federal funds rate, the base for borrowing costs across the economy.', means: 'The decision itself is usually priced in, so the surprise tends to come from the statement, the projections and the Chair\'s press conference. A more hawkish tone than expected (fewer cuts) tends to lift yields and the dollar and weigh on growth stocks; a dovish tone tends to do the opposite. Expect bigger swings from 2:00 pm ET through the press conference.' },
  fomcStrategy: { cat: 'fed', impact: 1, time: null, title: 'FOMC strategy meeting (no rate decision)', why: 'The Fed has said this meeting reviews its framework and has no policy decision.', means: 'No rate change is scheduled. Any hints about how the Fed thinks about inflation, jobs or its balance sheet can still shift longer term rate expectations.' },
  minutes: { cat: 'fed', impact: 2, time: '14:00', title: 'FOMC minutes', why: 'A detailed record of the last meeting, published three weeks later.', means: 'Markets read the minutes for how many officials leaned toward more or fewer cuts. Usually a modest mover, unless the tone differs from what the Chair said at the press conference.' },
  beige: { cat: 'fed', impact: 1, time: '14:00', title: 'Fed Beige Book', why: 'Anecdotal survey of business conditions in the 12 Fed districts, used to prepare for the next meeting.', means: 'Rarely moves markets on its own. Watch for words like slowing, layoffs or price pressures, which hint at how the Fed sees the economy.' },
  fedspeak: { cat: 'fed', impact: 1, time: null, title: 'Fed speaker', why: 'Comments from Fed officials between meetings can shift rate expectations.', means: 'Most speeches repeat the Fed\'s line. Remarks from the Chair, Vice Chair or New York Fed President matter most; a clear hint about the next meeting can move yields and stocks.' },
  cpi: { cat: 'inflation', impact: 3, time: '08:30', dir: 'hot', title: 'CPI inflation', why: 'The most watched inflation number and a key input for Fed decisions.', means: 'A hotter reading than forecast can push yields up and cut the odds of rate cuts, which tends to hit rate sensitive and growth stocks. A cooler one tends to help both bonds and stocks. Core CPI (excluding food and energy) usually matters most.' },
  ppi: { cat: 'inflation', impact: 2, time: '08:30', dir: 'hot', title: 'Producer prices (PPI)', why: 'Wholesale inflation; parts of it feed the PCE index the Fed targets.', means: 'Can shift inflation forecasts, especially for PCE later in the month. Usually a smaller mover than CPI unless the surprise is large.' },
  pce: { cat: 'inflation', impact: 2, time: '08:30', dir: 'hot', title: 'PCE inflation and consumer spending', why: 'The Fed\'s preferred inflation gauge, released with personal income and spending.', means: 'CPI and PPI come out first, so economists usually forecast PCE closely and big surprises are rarer. The spending figures show how strong the consumer is, which matters for growth and earnings.' },
  jobs: { cat: 'jobs', impact: 3, time: '08:30', dir: 'strong', title: 'Jobs report (nonfarm payrolls)', why: 'Payrolls, unemployment and wages in one release; often the biggest scheduled mover each month.', means: 'Very strong hiring can lift yields if it makes the Fed slower to cut. Weak hiring can raise recession worries but also raise cut odds. Wage growth is watched as an inflation signal, and revisions to earlier months can matter as much as the headline.' },
  claims: { cat: 'jobs', impact: 1, time: '08:30', dir: 'weakLabor', title: 'Weekly jobless claims', why: 'The most timely read on layoffs, out every week.', means: 'One week rarely matters. A steady rise in claims over several weeks is an early warning that the job market is cooling.' },
  jolts: { cat: 'jobs', impact: 2, time: '10:00', dir: 'strong', title: 'Job openings (JOLTS)', why: 'Openings, hires and quits show labor demand, with a one month lag.', means: 'Falling openings and quits point to a cooling labor market and softer wage pressure. Moves markets mainly when the surprise is big.' },
  adp: { cat: 'jobs', impact: 1, time: '08:15', dir: 'strong', title: 'ADP private payrolls', why: 'A private estimate of hiring two days before the official jobs report.', means: 'A loose guide only; it often differs from the official number. Can set the mood for the jobs report.' },
  gdp: { cat: 'growth', impact: 2, time: '08:30', dir: 'strong', title: 'GDP', why: 'The broadest measure of economic growth.', means: 'The first (advance) estimate moves markets most; later revisions usually matter less. Strong growth supports earnings but can keep rates higher for longer. Two weak quarters in a row would fuel recession talk.' },
  retail: { cat: 'growth', impact: 2, time: '08:30', dir: 'strong', title: 'Retail sales', why: 'Consumer spending is about two thirds of the US economy.', means: 'A big miss can raise slowdown fears and hit retailers and consumer stocks. A strong print supports those stocks but can lift yields. The control group (excluding autos, gas, building materials and food services) feeds GDP.' },
  ismm: { cat: 'growth', impact: 2, time: '10:00', dir: 'strong', title: 'ISM manufacturing', why: 'A monthly survey of factory purchasing managers; one of the first reads on each month.', means: 'Above 50 means manufacturing is expanding, below 50 shrinking. New orders hint at future growth and prices paid is watched as an inflation signal.' },
  isms: { cat: 'growth', impact: 2, time: '10:00', dir: 'strong', title: 'ISM services', why: 'The same survey for services, the larger part of the economy.', means: 'Above 50 means expansion. The prices index is a read on sticky services inflation, which the Fed watches closely.' },
  durable: { cat: 'growth', impact: 1, time: '08:30', dir: 'strong', title: 'Durable goods orders', why: 'Orders for long lasting goods, a read on business investment.', means: 'The headline swings with aircraft orders, so markets focus on core capital goods orders as a guide to business spending.' },
  umich: { cat: 'growth', impact: 1, time: '10:00', dir: 'strong', title: 'Consumer sentiment (University of Michigan)', why: 'How consumers feel, plus their inflation expectations.', means: 'The inflation expectations part is watched by the Fed. A jump in expected inflation can move bonds even if sentiment itself is in line.' },
  confidence: { cat: 'growth', impact: 1, time: '10:00', dir: 'strong', title: 'Consumer confidence (Conference Board)', why: 'Survey of consumer views on jobs and business conditions.', means: 'The labor differential (jobs plentiful minus hard to get) is a useful read on the job market. Rarely a big mover alone.' },
  housing: { cat: 'growth', impact: 1, time: '10:00', dir: 'strong', title: 'Housing data', why: 'Housing is very sensitive to mortgage rates.', means: 'Mostly moves homebuilders and mortgage related stocks. Persistent weakness shows how high rates are biting.' },
  opex: { cat: 'flows', impact: 1, time: '16:00', title: 'Monthly options expiration', why: 'Standard monthly stock and index options expire.', means: 'Hedging around big strike prices can pin stocks near those levels or cause choppy moves near the close, and volume runs higher. Usually a short term effect that fades the next week.' },
  quad: { cat: 'flows', impact: 2, time: '16:00', title: 'Quad witching', why: 'Stock options, index options, index futures and single stock futures all expire together.', means: 'Among the highest volume days of the year, often lined up with index rebalances. Expect unusual moves near the close. The effects usually fade by the following week.' },
  vix: { cat: 'flows', impact: 1, time: '09:30', title: 'VIX futures and options expiration', why: 'Monthly VIX contracts settle on a special opening quote.', means: 'Can add noise to volatility products that morning. Rarely matters for long term investors.' },
  sprebal: { cat: 'flows', impact: 2, time: '16:00', title: 'S&P 500 quarterly rebalance takes effect', why: 'Index funds must buy added stocks and sell removed ones at the close.', means: 'Huge closing volume. Stocks joining the S&P 500 often run up before inclusion and can lag after it; removed stocks can be sold hard into the close.' },
  sprebalAnn: { cat: 'flows', impact: 1, time: '17:15', tentative: true, title: 'S&P quarterly rebalance announcement (expected)', why: 'S&P Dow Jones Indices usually names additions and deletions about two weeks before the rebalance, after the close.', means: 'Stocks picked for the S&P 500 often jump the next morning as index funds prepare to buy. The exact day is set by S&P, so treat this date as an estimate.' },
  ndx: { cat: 'flows', impact: 2, time: '16:00', title: 'Nasdaq 100 annual reconstitution takes effect', why: 'Funds tracking the Nasdaq 100 swap out companies once a year in December.', means: 'Added stocks see forced buying from funds such as QQQ and removed ones forced selling, concentrated at the close.' },
  ndxAnn: { cat: 'flows', impact: 1, time: '20:00', tentative: true, title: 'Nasdaq 100 changes announced (expected)', why: 'Nasdaq usually names the yearly additions and deletions about a week before they take effect.', means: 'Added names often rise the next day. Treat this date as an estimate.' },
  russell: { cat: 'flows', impact: 2, time: '16:00', title: 'Russell US indexes reconstitution', why: 'FTSE Russell rebalances its US indexes, now twice a year.', means: 'Funds tracking the Russell 1000, 2000 and 3000 adjust at the close, making it one of the heaviest trading days for small caps. Price effects usually fade within days.' },
  lockup: { cat: 'flows', impact: 1, time: null, title: 'IPO lockup expiration', why: 'Insiders and early investors can usually sell for the first time about 180 days after an IPO.', means: 'Extra supply can weigh on the stock around this date, especially if it trades well above the IPO price. The 180 day date is the typical term; check the prospectus, since some lockups end early or in stages.' },
  split: { cat: 'flows', impact: 1, time: null, title: 'Stock split', why: 'Changes the share count and price per share, not the company\'s value.', means: 'Splits do not make a company worth more, but big ones can draw retail interest and can make a stock eligible for price weighted indexes like the Dow.' },
  auction: { cat: 'rates', impact: 1, time: '13:00', title: 'Treasury auction', why: 'Shows how much demand there is for US government debt.', means: 'Weak demand (a "tail", where the yield clears above where it traded before the auction) can push long term rates up and weigh on stocks. Strong demand can ease yields. The 10 and 30 year auctions draw the most attention.' },
  holiday: { cat: 'holiday', impact: 1, time: null, title: 'US stock markets closed', why: 'NYSE and Nasdaq are closed for the holiday.', means: 'No trading. Volume is usually thin in the sessions around holidays, which can exaggerate moves.' },
  halfday: { cat: 'holiday', impact: 1, time: '13:00', title: 'Early close (1:00 pm ET)', why: 'Stocks close at 1:00 pm ET; bond markets usually close at 2:00 pm.', means: 'Thin volume can make moves look bigger than they are. Many traders are away.' },
  shutdown: { cat: 'policy', impact: 2, time: '23:59', title: 'Federal funding deadline', why: 'Government funding runs out unless Congress acts.', means: 'Past shutdowns had small, short lived market effects, but they can delay official data such as the jobs and CPI reports, which leaves the Fed and investors with less information. A last minute deal is the most common outcome.' },
  opec: { cat: 'energy', impact: 2, time: null, title: 'OPEC+ meeting', why: 'Sets oil output for the group\'s members.', means: 'Production cuts tend to lift oil prices and energy stocks but add to inflation pressure; increases do the reverse. Airlines and transport stocks move the other way to oil.' },
  earnings: { cat: 'earnings', impact: 2, time: null, title: 'Earnings', why: 'Company results and guidance.', means: 'Guidance and commentary often matter more than the quarter itself. A beat with weak guidance can still send a stock lower.' },
};

// ---------- official calendars typed in from the published schedules ----------
const FOMC = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const BLS = 'https://www.bls.gov/schedule/news_release/';
const BEA = 'https://www.bea.gov/news/schedule';
const CENSUS = 'https://www.census.gov/retail/release_schedule.html';
const NYSE = 'https://www.nyse.com/trade/hours-calendars';
const RUSSELL = 'https://www.lseg.com/en/ftse-russell/russell-reconstitution';
const OPEC = 'https://www.opec.org/press-releases.html';
const SHUTDOWN = 'https://www.congress.gov/crs-product/R49353';

const off = (type, date, extra = {}) => ({ type, date, official: true, ...extra });
export const OFFICIAL = [
  // Federal Reserve. 2027 dates are tentative until the Fed confirms them.
  off('fomc', '2026-10-28', { detail: 'October meeting.', source: ['Federal Reserve', FOMC] }),
  off('minutes', '2026-11-18', { detail: 'Minutes of the October 27 and 28 meeting.', source: ['Federal Reserve', FOMC] }),
  off('fomc', '2026-12-09', { detail: 'December meeting with new economic projections (the dot plot) and a press conference at 2:30 pm ET.', impactWhy: 'Projection meetings carry extra weight because the dot plot shows where officials expect rates to go.', source: ['Federal Reserve', FOMC] }),
  off('minutes', '2026-12-30', { tentative: true, detail: 'Minutes of the December meeting, expected three weeks after it.', source: ['Federal Reserve', FOMC] }),
  off('fomc', '2027-01-27', { tentative: true, detail: 'First meeting of 2027 (tentative schedule).', source: ['Federal Reserve', FOMC] }),
  off('minutes', '2027-02-17', { tentative: true, detail: 'Minutes of the January meeting, expected three weeks after it.', source: ['Federal Reserve', FOMC] }),
  off('fomc', '2027-03-17', { tentative: true, detail: 'March meeting (tentative). March meetings usually include new projections.', source: ['Federal Reserve', FOMC] }),
  // BLS
  off('jolts', '2026-12-01', { detail: 'October data.', source: ['BLS', BLS + 'jolts.htm'] }),
  off('jobs', '2026-12-04', { detail: 'November employment report.', source: ['BLS', BLS + 'empsit.htm'] }),
  off('cpi', '2026-12-10', { detail: 'November CPI.', source: ['BLS', BLS + 'cpi.htm'] }),
  off('ppi', '2026-12-15', { detail: 'November PPI.', source: ['BLS', BLS + 'ppi.htm'] }),
  off('jolts', '2027-01-05', { detail: 'November data.', source: ['BLS', BLS + 'jolts.htm'] }),
  off('jobs', '2027-01-08', { detail: 'December employment report.', source: ['BLS', BLS + 'empsit.htm'] }),
  off('cpi', '2027-01-13', { detail: 'December CPI.', source: ['BLS', BLS + 'cpi.htm'] }),
  off('ppi', '2027-01-14', { detail: 'December PPI.', source: ['BLS', BLS + 'ppi.htm'] }),
  off('jolts', '2027-02-02', { detail: 'December data.', source: ['BLS', BLS + 'jolts.htm'] }),
  off('jobs', '2027-02-05', { detail: 'January employment report, which also brings the yearly benchmark revision.', source: ['BLS', BLS + 'empsit.htm'] }),
  off('cpi', '2027-02-11', { detail: 'January CPI.', source: ['BLS', BLS + 'cpi.htm'] }),
  off('ppi', '2027-02-12', { detail: 'January PPI.', source: ['BLS', BLS + 'ppi.htm'] }),
  // BEA
  off('gdp', '2026-10-29', { title: 'GDP, Q3 2026 (advance estimate)', detail: 'First estimate of third quarter growth.', data: [{ label: 'Real GDP, annualized', actual: '3.4%', expected: null, previous: '2.2%' }], source: ['BEA', 'https://www.bea.gov/news/2026/gdp-advance-estimate-3rd-quarter-2026'] }),
  off('gdp', '2026-11-25', { title: 'GDP, Q3 2026 (second estimate)', detail: 'Second estimate of third quarter growth, with corporate profits. The advance estimate was 3.4%.', impact: 1, impactWhy: 'Revisions to an earlier estimate usually move markets less than the first estimate.', source: ['BEA', BEA] }),
  off('pce', '2026-11-25', { detail: 'October personal income, spending and PCE prices.', source: ['BEA', BEA] }),
  off('gdp', '2026-12-23', { title: 'GDP, Q3 2026 (third estimate)', detail: 'Final regular estimate of third quarter growth.', impact: 1, impactWhy: 'The third estimate rarely surprises.', source: ['BEA', BEA] }),
  off('pce', '2026-12-23', { detail: 'November personal income, spending and PCE prices.', source: ['BEA', BEA] }),
  off('gdp', '2027-01-28', { title: 'GDP, Q4 2026 (advance estimate)', detail: 'First estimate of fourth quarter and full year 2026 growth.', source: ['BEA', BEA] }),
  off('pce', '2027-01-28', { detail: 'December personal income, spending and PCE prices.', source: ['BEA', BEA] }),
  off('gdp', '2027-02-25', { title: 'GDP, Q4 2026 (second estimate)', impact: 1, impactWhy: 'Revisions usually move markets less than the first estimate.', source: ['BEA', BEA] }),
  off('pce', '2027-02-25', { detail: 'January personal income, spending and PCE prices.', source: ['BEA', BEA] }),
  off('gdp', '2027-03-31', { title: 'GDP, Q4 2026 (third estimate)', impact: 1, impactWhy: 'The third estimate rarely surprises.', source: ['BEA', BEA] }),
  off('pce', '2027-03-31', { detail: 'February personal income, spending and PCE prices.', source: ['BEA', BEA] }),
  // Census
  off('retail', '2026-11-17', { detail: 'October retail sales.', source: ['Census Bureau', CENSUS] }),
  off('retail', '2026-12-16', { detail: 'November retail sales, the first read on holiday shopping.', source: ['Census Bureau', CENSUS] }),
  off('retail', '2027-01-15', { detail: 'December retail sales, closing out the holiday season.', source: ['Census Bureau', CENSUS] }),
  off('retail', '2027-02-17', { detail: 'January retail sales.', source: ['Census Bureau', CENSUS] }),
  off('retail', '2027-03-16', { detail: 'February retail sales.', source: ['Census Bureau', CENSUS] }),
  off('durable', '2026-11-25', { detail: 'October orders.', source: ['Census Bureau', 'https://www.census.gov/economic-indicators/'] }),
  off('durable', '2026-12-23', { detail: 'November orders.', source: ['Census Bureau', 'https://www.census.gov/economic-indicators/'] }),
  // Index events
  off('russell', '2026-11-13', { title: 'Russell reconstitution: preliminary lists', time: '18:00', impact: 1, detail: 'First December reconstitution under the new twice a year schedule. Preliminary additions and deletions are published after the close; updates follow on later Fridays.', source: ['FTSE Russell', RUSSELL] }),
  off('russell', '2026-12-11', { title: 'Russell reconstitution takes effect', detail: 'Changes take effect after the close; markets reopen on December 14 with the new lineup. Lists are locked from November 30.', source: ['FTSE Russell', RUSSELL] }),
  // Policy and energy
  off('opec', '2026-11-29', { title: 'OPEC+ ministerial meeting', detail: 'Expected to set the 2027 production framework and quotas after a review of members\' capacity. On November 1 the core group kept December output unchanged.', source: ['OPEC', OPEC] }),
  off('shutdown', '2026-12-11', { title: 'Federal funding deadline (shutdown risk)', detail: 'The stopgap funding law (P.L. 119-103) expires at 11:59 pm ET. Without new funding, a partial shutdown begins on December 12.', source: ['Congress.gov (CRS)', SHUTDOWN] }),
];

// Big companies whose earnings can move the whole market. Kept short on purpose.
export const MEGACAPS = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'AVGO', 'TSLA', 'JPM', 'LLY', 'WMT', 'ORCL', 'NFLX', 'COST'];
const SYMPATHY = {
  NVDA: 'NVIDIA sets the tone for the AI trade: chip makers, data center suppliers and power names often move with it.',
  AAPL: 'Apple is one of the largest weights in the S&P 500 and Nasdaq 100; its suppliers and consumer tech often move with it.',
  MSFT: 'Microsoft\'s cloud growth and AI spending plans are read across to chip makers and other cloud providers.',
  GOOGL: 'Alphabet\'s ad and cloud results and its spending plans are read across to digital ads and AI chip makers.',
  AMZN: 'Amazon gives a read on both online retail and cloud demand (AWS), and on AI data center spending.',
  META: 'Meta\'s ad results and AI spending plans move digital ad peers and AI hardware suppliers.',
  AVGO: 'Broadcom\'s custom AI chip and networking sales are a read on AI data center spending.',
  TSLA: 'Tesla is a large index weight and a sentiment gauge for EVs and retail investors.',
  JPM: 'JPMorgan usually kicks off bank earnings; its comments on loans and credit card losses are a read on the US consumer.',
  LLY: 'Eli Lilly is the largest healthcare stock; weight loss drug sales drive the sector.',
  WMT: 'Walmart\'s results and outlook are a broad read on US consumer spending and prices.',
  ORCL: 'Oracle\'s cloud backlog and spending plans are a read on AI infrastructure demand and how it is financed.',
  NFLX: 'Netflix is the bellwether for streaming and media.',
  COST: 'Costco is a read on consumer spending; it also reports monthly sales.',
};

// ---------- matching live economic calendar rows to event types ----------
const MAP = [
  [/minutes/i, 'minutes', /fomc|fed/i],
  [/beige book/i, 'beige'],
  [/fed(eral)? (funds|interest) rate|interest rate decision|fomc (statement|rate|decision|press)|fed rate decision/i, 'fomc'],
  [/pce|personal (income|spending)/i, 'pce'],
  [/\bppi\b|producer price/i, 'ppi'],
  [/\bcpi\b|consumer price/i, 'cpi'],
  [/adp/i, 'adp'],
  [/jobless claims|continuing claims|initial claims/i, 'claims'],
  [/jolts|job openings/i, 'jolts'],
  [/nonfarm|non-farm|unemployment rate|average hourly earnings|employment situation/i, 'jobs'],
  [/\bgdp\b/i, 'gdp'],
  [/retail sales/i, 'retail'],
  [/ism (non-manufacturing|services)/i, 'isms'],
  [/ism manufacturing/i, 'ismm'],
  [/durable goods/i, 'durable'],
  [/michigan|consumer sentiment/i, 'umich'],
  [/consumer confidence/i, 'confidence'],
  [/housing starts|building permits|new home sales|existing home sales|pending home sales/i, 'housing'],
  [/(\d+)[- ]?(year|yr).*(note|bond|tips).*auction/i, 'auction'],
  [/speaks|speech|testifies|testimony|remarks/i, 'fedspeak', /fed|fomc|powell|chair|governor|president/i],
];
export function typeOf(name) {
  for (const [re, t, need] of MAP) if (re.test(name) && (!need || need.test(name))) return t;
  return null;
}
const PRIMARY = {
  cpi: [/core cpi.*(m\/m|mom)/i, /cpi.*(m\/m|mom)/i],
  ppi: [/core ppi.*(m\/m|mom)/i, /ppi.*(m\/m|mom)/i],
  pce: [/core pce.*(m\/m|mom)/i, /pce.*(m\/m|mom)/i],
  jobs: [/nonfarm|non-farm/i],
  claims: [/initial/i],
  gdp: [/gdp.*(q\/q|qoq|annual|growth)/i],
  retail: [/retail sales.*(m\/m|mom)/i, /retail sales/i],
};
const clean = (v) => {
  const s = String(v ?? '').replace(/&nbsp;|\u00a0/g, ' ').trim();
  return s && !/^(-|n\/a|na)$/i.test(s) ? s : null;
};
export function numOf(v) {
  const s = clean(v);
  if (!s) return null;
  const m = s.replace(/[,$]/g, '').match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0]);
  if (/\d\s*K\b/i.test(s)) n *= 1e3;
  else if (/\d\s*M\b/i.test(s)) n *= 1e6;
  else if (/\d\s*B\b/i.test(s)) n *= 1e9;
  return n;
}

// Reading of a released number vs the forecast, in plain language.
export function readResult(type, row) {
  const t = TYPES[type];
  if (!t || !t.dir || !row) return null;
  const a = numOf(row.actual);
  const e = numOf(row.expected);
  if (a == null || e == null) return null;
  const pct = /%/.test(String(row.actual) + String(row.expected));
  const tol = pct ? 0.05 : Math.max(Math.abs(e) * 0.02, 1e-9);
  const diff = a - e;
  const vs = diff > tol ? 'above' : diff < -tol ? 'below' : 'inline';
  const lead = `${row.label ? row.label + ': ' : ''}${clean(row.actual)} vs ${clean(row.expected)} expected.`;
  if (vs === 'inline') return { tone: 'flat', vs, text: `${lead} In line with forecasts, so the surprise was small. Markets tend to look at the details and at what it means for the Fed.` };
  let tone;
  let text;
  if (t.dir === 'hot') {
    tone = vs === 'above' ? 'down' : 'up';
    text = vs === 'above'
      ? 'Hotter than expected. Sticky inflation can push yields up and lower the odds of rate cuts, which tends to weigh on growth and rate sensitive stocks.'
      : 'Cooler than expected. Easing inflation supports the case for rate cuts, which has tended to help bonds and growth stocks.';
  } else if (t.dir === 'weakLabor') {
    tone = vs === 'above' ? 'down' : 'up';
    text = vs === 'above'
      ? 'More layoffs than expected. A sign the job market may be cooling; it can lift rate cut odds but also growth worries.'
      : 'Fewer layoffs than expected. The job market still looks solid.';
  } else {
    tone = vs === 'above' ? 'up' : 'down';
    text = vs === 'above'
      ? 'Stronger than expected. Good for earnings and recession worries, but a hot economy can make the Fed slower to cut, so yields may rise.'
      : 'Weaker than expected. Raises growth worries but can raise the odds of rate cuts; bonds and defensive sectors often hold up better.';
  }
  return { tone, vs, text: `${lead} ${text}` };
}

export function earningsResult(r) {
  const a = numOf(r.actual);
  const e = numOf(r.expected);
  if (a == null || e == null) return null;
  const s = e !== 0 ? ((a - e) / Math.abs(e)) * 100 : null;
  const lead = `EPS ${clean(r.actual)} vs ${clean(r.expected)} expected${s != null ? ` (${s >= 0 ? '+' : ''}${s.toFixed(1)}%)` : ''}.`;
  if (s != null && Math.abs(s) < 1) return { tone: 'flat', vs: 'inline', text: `${lead} Roughly in line; the stock reaction likely hinged on guidance.` };
  return a > e
    ? { tone: 'up', vs: 'above', text: `${lead} Beat estimates. Guidance and commentary still decide how the stock reacts.` }
    : { tone: 'down', vs: 'below', text: `${lead} Missed estimates. A miss with solid guidance can still be shrugged off.` };
}

// ---------- event construction ----------
function makeEvent(type, date, extra = {}) {
  const t = TYPES[type];
  const ev = {
    id: `${type}:${date}${extra.key ? ':' + extra.key : ''}`,
    type,
    date,
    time: extra.time !== undefined ? extra.time : t.time,
    title: extra.title || t.title,
    cat: t.cat,
    impact: extra.impact || t.impact,
    impactWhy: extra.impactWhy || t.why,
    means: extra.means || t.means,
    detail: extra.detail || null,
    tentative: !!(extra.tentative || t.tentative),
    official: !!extra.official,
    source: extra.source ? { name: extra.source[0], url: extra.source[1] } : null,
    tickers: extra.tickers || [],
    data: extra.data ? extra.data.map((r) => ({ ...r })) : [],
  };
  return ev;
}

// Events that follow exchange or agency rules, between two dates.
export function ruleEvents(from, to) {
  const out = [];
  const [y0, m0] = from.split('-').map(Number);
  const [y1, m1] = to.split('-').map(Number);
  for (let y = y0, m = m0; y < y1 || (y === y1 && m <= m1); m === 12 ? (y++, (m = 1)) : m++) {
    const quarterly = m % 3 === 0;
    const ox = opexDate(y, m);
    out.push(makeEvent(quarterly ? 'quad' : 'opex', ox, { source: ['Cboe / OCC expiration calendar', 'https://www.cboe.com/about/hours/'] }));
    if (quarterly) {
      out.push(makeEvent('sprebal', ox, { detail: 'Quarterly share and weight updates, plus any index additions and deletions, take effect after the close.', source: ['S&P Dow Jones Indices', 'https://www.spglobal.com/spdji/en/indices/equity/sp-500/'] }));
      out.push(makeEvent('sprebalAnn', addDays(ox, -14), { source: ['S&P Dow Jones Indices', 'https://www.spglobal.com/spdji/en/'] }));
    }
    if (m === 12) {
      out.push(makeEvent('ndx', ox, { source: ['Nasdaq', 'https://www.nasdaq.com/solutions/global-indexes/nasdaq-100'] }));
      out.push(makeEvent('ndxAnn', addDays(ox, -7), { source: ['Nasdaq', 'https://www.nasdaq.com/solutions/global-indexes/nasdaq-100'] }));
    }
    out.push(makeEvent('vix', vixExpiry(y, m), { source: ['Cboe', 'https://www.cboe.com/tradable_products/vix/vix_futures/specifications/'] }));
    out.push(makeEvent('ismm', nthTradingDay(y, m, 1), { source: ['Institute for Supply Management', 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/'] }));
    out.push(makeEvent('isms', nthTradingDay(y, m, 3), { source: ['Institute for Supply Management', 'https://www.ismworld.org/supply-management-news-and-reports/reports/ism-report-on-business/'] }));
  }
  // Weekly jobless claims: Thursdays, Wednesday when Thursday is a holiday.
  let d = from;
  while (dow(d) !== 4) d = addDays(d, 1);
  for (; d <= to; d = addDays(d, 7)) out.push(makeEvent('claims', HOLIDAYS[d] ? addDays(d, -1) : d, { source: ['US Department of Labor', 'https://www.dol.gov/ui/data.pdf'] }));
  for (const [day, name] of Object.entries(HOLIDAYS)) out.push(makeEvent('holiday', day, { title: `Markets closed: ${name}`, official: true, source: ['NYSE', NYSE] }));
  for (const [day, name] of Object.entries(HALF_DAYS)) out.push(makeEvent('halfday', day, { title: `Early close at 1:00 pm ET: ${name}`, official: true, source: ['NYSE', NYSE] }));
  return out.filter((e) => e.date >= from && e.date <= to);
}

// ---------- live feeds ----------
const NQ = { 'User-Agent': BROWSER_UA, Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };

// Read through cache with a fetch budget: a miss only fetches while budget
// remains, otherwise it reports "skipped" so the page can say it is still loading.
async function cacheGet(env, key) {
  try {
    if (env.DB) {
      const row = await env.DB.prepare('SELECT v, exp FROM cache WHERE k = ?').bind(key).first();
      return row && row.exp > Date.now() ? JSON.parse(row.v) : null;
    }
    if (env.CACHE) return await env.CACHE.get(key, 'json');
  } catch {}
  return null;
}
async function cachePut(env, key, ttl, val) {
  try {
    if (env.DB) await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(key, JSON.stringify(val), Date.now() + ttl * 1000).run();
    else if (env.CACHE) await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: Math.max(60, ttl) });
  } catch {}
}
async function budgeted(env, budget, key, ttl, cost, fn) {
  const hit = await cacheGet(env, key);
  if (hit && hit.__err) throw new Error(hit.__err);
  if (hit != null) return hit;
  if (budget.left < cost) {
    budget.skipped++;
    return undefined;
  }
  budget.left -= cost;
  let val;
  try {
    val = await fn();
  } catch (e) {
    // Remember a failure for 10 minutes so a blocked feed is not retried on every visit.
    await cachePut(env, key, 600, { __err: String(e && e.message ? e.message : e) });
    throw e;
  }
  if (val != null) await cachePut(env, key, ttl, val);
  return val;
}
const dayTtl = (date, today) => (date < addDays(today, -1) ? 3 * 86400 : date <= today ? 900 : 6 * 3600);

export function parseEconRows(d) {
  const rows = (d && d.data && (d.data.rows || d.data)) || [];
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => /united states|^us$|^usa$/i.test(String(r.country || '')))
    .map((r) => ({ name: clean(r.eventName || r.event || r.name), time: clean(r.gmt || r.time), actual: clean(r.actual), expected: clean(r.consensus || r.forecast), previous: clean(r.previous) }))
    .filter((r) => r.name);
}
export function parseEarnRows(d) {
  const rows = (d && d.data && d.data.rows) || [];
  return rows
    .map((r) => ({
      ticker: cleanTicker(r.symbol),
      name: clean(r.name),
      cap: numOf(r.marketCap),
      when: /pre-market/.test(r.time || '') ? 'Before the open' : /after-hours/.test(r.time || '') ? 'After the close' : null,
      expected: clean(r.epsForecast),
      actual: clean(r.eps),
      quarter: clean(r.fiscalQuarterEnding),
    }))
    .filter((r) => r.ticker);
}
export function parseIpos(d) {
  const rows = (d && d.data && d.data.priced && d.data.priced.rows) || [];
  return rows
    .map((r) => ({ ticker: cleanTicker(r.proposedTickerSymbol), name: clean(r.companyName), priced: mmddyyyy(r.pricedDate), price: clean(r.proposedSharePrice), value: numOf(r.dollarValueOfSharesOffered) }))
    .filter((r) => r.ticker && r.priced);
}
export function parseSplits(d) {
  const rows = (d && d.data && d.data.rows) || [];
  return rows.map((r) => ({ ticker: cleanTicker(r.symbol), name: clean(r.name), ratio: clean(r.ratio), date: mmddyyyy(r.executionDate) })).filter((r) => r.ticker && r.date);
}
export function parseAuctions(d) {
  return ((d && d.data) || [])
    .filter((r) => /note|bond|tips|frn/i.test(r.security_type || ''))
    .map((r) => ({ date: String(r.auction_date || '').slice(0, 10), term: clean(r.security_term), type: clean(r.security_type), amount: numOf(r.offering_amt), reopening: /yes/i.test(r.reopening || '') }))
    .filter((r) => /^\d{4}-\d\d-\d\d$/.test(r.date));
}

const money = (v) => (v == null ? '' : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${Math.round(v / 1e6)}M`);
const capTxt = (v) => (v == null ? '' : v >= 1e12 ? `$${(v / 1e12).toFixed(1)}T` : `$${Math.round(v / 1e9)}B`);

function earningsEvent(r, date, watch, source) {
  const mega = MEGACAPS.includes(r.ticker);
  const isWatch = watch.has(r.ticker);
  const impact = mega || (r.cap || 0) >= 1e12 ? 3 : (r.cap || 0) >= 150e9 || isWatch ? 2 : 1;
  const data = r.expected || r.actual ? [{ label: 'EPS', actual: r.actual || null, expected: r.expected || null, previous: null }] : [];
  if (r.revenue) data.push({ label: 'Revenue', actual: null, expected: money(r.revenue), previous: null });
  const ev = makeEvent('earnings', date, {
    key: r.ticker,
    title: `${r.ticker} earnings${r.name ? `: ${r.name}` : ''}`,
    impact,
    impactWhy: mega || (r.cap || 0) >= 1e12
      ? `One of the largest US companies${r.cap ? ` (${capTxt(r.cap)} market value)` : ''}; a big move can sway the S&P 500 and Nasdaq.`
      : isWatch
        ? `On your watchlist${r.cap ? `; ${capTxt(r.cap)} market value` : ''}.`
        : `Large company${r.cap ? ` (${capTxt(r.cap)} market value)` : ''}; can move its sector.`,
    means: `${SYMPATHY[r.ticker] ? SYMPATHY[r.ticker] + ' ' : ''}${TYPES.earnings.means}`,
    detail: [r.quarter ? `Fiscal quarter ending ${r.quarter}` : null, r.estimated ? 'Date not yet confirmed by the company' : null].filter(Boolean).join('. ') || null,
    tentative: !!r.estimated,
    tickers: [r.ticker],
    data,
    source,
  });
  ev.watch = isWatch;
  ev.time = null;
  ev.session = r.when;
  return ev;
}

function yahooEarnings(t, q) {
  const ce = q && q.calendarEvents && q.calendarEvents.earnings;
  const ts = ce && ce.earningsDate && raw(ce.earningsDate[0]);
  if (!ts) return null;
  const p = q.price || {};
  return {
    ticker: t,
    name: clean(p.shortName || p.longName),
    cap: raw(p.marketCap),
    date: todayET(new Date(ts * 1000)),
    expected: raw(ce.earningsAverage) != null ? String(Number(raw(ce.earningsAverage)).toFixed(2)) : null,
    revenue: raw(ce.revenueAverage),
    estimated: !!raw(ce.isEarningsDateEstimate),
  };
}

// ---------- assembly ----------
export async function buildEvents(env, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const today = todayET(now);
  const from = addDays(today, -PAST_DAYS);
  const to = addDays(today, AHEAD_DAYS);
  const watch = new Set((opts.watch || []).map(cleanTicker).filter(Boolean).slice(0, 25));
  const scale = opts.budgetScale ?? 1;
  const B = Object.fromEntries(Object.entries(BUDGETS).map(([k, v]) => [k, { left: Math.round(v * scale), skipped: 0 }]));
  const feeds = {};
  const note = (k, r, extra = '') => (feeds[k] = r.ok ? { ok: true, note: extra } : { ok: false, note: r.error });
  const loading = (k, b) => {
    if (b.skipped && feeds[k].ok) feeds[k].note = `${feeds[k].note ? feeds[k].note + '; ' : ''}more loading`;
    if (b.skipped && !feeds[k].ok && /not loaded/i.test(feeds[k].note)) feeds[k].note = 'Loading, refresh in a minute';
  };

  const events = [...OFFICIAL.filter((e) => e.date >= from && e.date <= to).map((e) => makeEvent(e.type, e.date, e)), ...ruleEvents(from, to)];
  const byKey = new Map();
  const index = (e) => byKey.set(`${e.type}:${e.date}`, e);
  events.forEach(index);

  // 1. Nasdaq economic calendar, nearest days first: actual vs expected and extra events.
  const econDays = [];
  for (let i = 0; i <= 21; i++) for (const s of i ? [-1, 1] : [1]) {
    const day = addDays(today, s * i);
    if (dow(day) > 0 && dow(day) < 6 && day >= addDays(today, -14) && day <= addDays(today, 14)) econDays.push(day);
  }
  let econOk = 0;
  let econErr = null;
  const econ = await pool(econDays.slice(0, 30), 4, async (day) => {
    const r = await settle(budgeted(env, B.econ, `ev:econ:${day}`, dayTtl(day, today), 1, async () => parseEconRows(await getJSON(`https://api.nasdaq.com/api/calendar/economicevents?date=${day}`, { headers: NQ }, 8000))));
    if (r.ok && r.value) econOk++;
    if (!r.ok) econErr = r.error;
    return { day, rows: r.ok ? r.value || [] : [] };
  });
  for (const { day, rows } of econ) {
    const groups = new Map();
    for (const row of rows) {
      const type = typeOf(row.name);
      if (!type) continue;
      if (type === 'fedspeak' || type === 'auction') {
        const ev = makeEvent(type, day, { key: row.name, title: row.name, time: row.time && /^\d\d:\d\d$/.test(row.time) ? row.time : null, source: ['Nasdaq economic calendar', 'https://www.nasdaq.com/market-activity/economic-calendar'] });
        if (type === 'fedspeak' && /chair/i.test(row.name) && !/vice/i.test(row.name)) {
          ev.impact = 2;
          ev.impactWhy = 'Comments from the Fed Chair carry the most weight between meetings.';
        }
        if (type === 'auction' && /\b(10|20|30)[- ]?(year|yr)/i.test(row.name)) ev.impact = 2;
        if (row.actual) ev.data.push({ label: 'High yield', actual: row.actual, expected: null, previous: row.previous });
        events.push(ev);
        continue;
      }
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(row);
    }
    for (const [type, rows] of groups) {
      let ev = byKey.get(`${type}:${day}`);
      if (!ev) {
        ev = makeEvent(type, day, { source: ['Nasdaq economic calendar', 'https://www.nasdaq.com/market-activity/economic-calendar'] });
        events.push(ev);
        index(ev);
      }
      const keep = rows.filter((r) => r.actual || r.expected || r.previous).slice(0, 6);
      ev.data = [...ev.data.filter((x) => !keep.some((k) => k.name === x.label)), ...keep.map((r) => ({ label: r.name, actual: r.actual, expected: r.expected, previous: r.previous }))];
      ev.live = true;
    }
  }
  feeds.econ = econOk ? { ok: true, note: `${econOk} of ${econDays.length} days loaded` } : { ok: false, note: econErr || 'Not loaded yet' };

  // 2. Earnings: Nasdaq daily calendar for big names, plus Yahoo dates for megacaps and the watchlist.
  const earn = new Map();
  const addEarn = (ev) => {
    const t = ev.tickers[0];
    const prev = earn.get(t) || [];
    const near = prev.find((p) => Math.abs(D(p.date) - D(ev.date)) <= 5 * 864e5);
    if (near) {
      if (!near.data.some((x) => x.actual) && ev.data.some((x) => x.actual)) near.data = ev.data;
      if (ev.source && /Nasdaq/.test(ev.source.name)) {
        near.date = ev.date;
        near.tentative = false;
      }
      return;
    }
    earn.set(t, [...prev, ev]);
  };
  const earnDays = econDays.filter((d) => d >= addDays(today, -14) && d <= addDays(today, 10));
  let earnOk = 0;
  let earnErr = null;
  const nq = await pool(earnDays, 4, async (day) => {
    const r = await settle(budgeted(env, B.earn, `ev:earn:${day}`, dayTtl(day, today), 1, async () => parseEarnRows(await getJSON(`https://api.nasdaq.com/api/calendar/earnings?date=${day}`, { headers: NQ }, 8000))));
    if (r.ok && r.value) earnOk++;
    if (!r.ok) earnErr = r.error;
    return { day, rows: r.ok ? r.value || [] : [] };
  });
  for (const { day, rows } of nq) {
    for (const r of rows) if ((r.cap || 0) >= 150e9 || MEGACAPS.includes(r.ticker) || watch.has(r.ticker)) addEarn(earningsEvent(r, day, watch, ['Nasdaq earnings calendar', 'https://www.nasdaq.com/market-activity/earnings']));
  }
  const yTickers = [...new Set([...watch, ...MEGACAPS])];
  let yOk = 0;
  let yErr = null;
  await pool(yTickers, 3, async (t) => {
    // Shares the stock page's cache slot, so a recently viewed stock costs nothing.
    const cachedQ = await cacheGet(env, `qsm:earn:${t}`);
    let q = cachedQ;
    if (!q) {
      if (B.yahoo.left < 1) {
        B.yahoo.skipped++;
        return;
      }
      B.yahoo.left -= 1;
      const r = await settle(quoteSummaryModules(env, t, 'earningsHistory,earningsTrend,calendarEvents,price', 'earn', 3 * 3600));
      if (!r.ok) {
        yErr = r.error;
        return;
      }
      q = r.value;
    }
    yOk++;
    const y = yahooEarnings(t, q);
    if (y && y.date >= from && y.date <= to) addEarn(earningsEvent(y, y.date, watch, ['Yahoo Finance', `https://finance.yahoo.com/quote/${t}`]));
  });
  for (const list of earn.values()) events.push(...list);
  feeds.earnings = earnOk || yOk ? { ok: true, note: `${earnOk} days from Nasdaq, ${yOk} of ${yTickers.length} companies from Yahoo` } : { ok: false, note: earnErr || yErr || 'Not loaded yet' };

  // 3. IPO lockups (priced about 180 days before each date in the window).
  const months = new Set();
  for (let d = addDays(from, -180); d <= addDays(to, -180); d = addDays(d, 20)) months.add(d.slice(0, 7));
  months.add(addDays(to, -180).slice(0, 7));
  const ipoR = await settle(
    Promise.all([...months].map((m) => budgeted(env, B.ipo, `ev:ipo:${m}`, 86400, 1, async () => parseIpos(await getJSON(`https://api.nasdaq.com/api/ipo/calendar?date=${m}`, { headers: NQ }, 8000)))))
  );
  if (ipoR.ok) {
    for (const ipo of ipoR.value.flat().filter(Boolean)) {
      const date = addDays(ipo.priced, 180);
      if (date < from || date > to || ((ipo.value || 0) < 100e6 && !watch.has(ipo.ticker))) continue;
      // Shares become sellable on the next trading day when the date falls on a weekend or holiday.
      let shift = date;
      while (!isTradingDay(shift)) shift = addDays(shift, 1);
      const ev = makeEvent('lockup', shift, {
        key: ipo.ticker,
        title: `IPO lockup expires: ${ipo.ticker}${ipo.name ? `, ${ipo.name}` : ''}`,
        impact: (ipo.value || 0) >= 1e9 || watch.has(ipo.ticker) ? 2 : 1,
        detail: `Priced ${ipo.priced}${ipo.price ? ` at $${String(ipo.price).replace(/^\$/, '')}` : ''}${ipo.value ? `, raising ${money(ipo.value)}` : ''}. Date assumes the standard 180 day lockup.`,
        tentative: true,
        tickers: [ipo.ticker],
        source: ['Nasdaq IPO calendar', 'https://www.nasdaq.com/market-activity/ipos'],
      });
      ev.watch = watch.has(ipo.ticker);
      events.push(ev);
    }
  }
  note('ipo', ipoR, ipoR.ok ? `${months.size} months of IPOs checked` : '');

  // 4. Stock splits.
  const spR = await settle(budgeted(env, B.splits, 'ev:splits', 6 * 3600, 1, async () => parseSplits(await getJSON('https://api.nasdaq.com/api/calendar/splits', { headers: NQ }, 8000))));
  if (spR.ok && spR.value) {
    for (const s of spR.value) {
      if (s.date < from || s.date > to) continue;
      const big = MEGACAPS.includes(s.ticker) || watch.has(s.ticker);
      const ev = makeEvent('split', s.date, { key: s.ticker, title: `Stock split: ${s.ticker}${s.ratio ? ` (${s.ratio})` : ''}`, impact: big ? 2 : 1, detail: s.name, tickers: [s.ticker], source: ['Nasdaq splits calendar', 'https://www.nasdaq.com/market-activity/stock-splits'] });
      ev.watch = watch.has(s.ticker);
      events.push(ev);
    }
  }
  note('splits', spR);

  // 5. Treasury auctions (notes and bonds; bills are weekly and rarely matter).
  const auR = await settle(
    budgeted(env, B.auctions, 'ev:auctions', 6 * 3600, 1, async () => parseAuctions(await getJSON('https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/upcoming_auctions?page%5Bsize%5D=100', { headers: { Accept: 'application/json' } }, 8000)))
  );
  if (auR.ok && auR.value) {
    for (const a of auR.value) {
      if (a.date < from || a.date > to) continue;
      const yrs = (String(a.term).match(/(\d+)-Year/) || [])[1];
      if (events.some((e) => e.type === 'auction' && e.date === a.date && yrs && new RegExp(`\\b${yrs}[- ]?(year|yr)`, 'i').test(e.title))) continue;
      const ev = makeEvent('auction', a.date, {
        key: `${a.term}-${a.type}`,
        title: `${a.term} Treasury ${a.type === 'TIPS' ? 'TIPS' : String(a.type).toLowerCase()} auction${a.reopening ? ' (reopening)' : ''}`,
        impact: ['10', '20', '30'].includes(yrs) && a.type !== 'TIPS' ? 2 : 1,
        detail: a.amount ? `About ${money(a.amount)} offered.` : null,
        source: ['US Treasury (Fiscal Data)', 'https://fiscaldata.treasury.gov/datasets/upcoming-auctions/'],
      });
      events.push(ev);
    }
  }
  note('auctions', auR);

  loading('econ', B.econ);
  loading('earnings', { skipped: B.earn.skipped + B.yahoo.skipped });
  loading('ipo', B.ipo);
  loading('splits', B.splits);
  loading('auctions', B.auctions);

  // Readings for released data.
  for (const e of events) {
    if (!e.data.length) continue;
    if (e.type === 'earnings') {
      const r = e.data.find((x) => x.label === 'EPS' && x.actual && x.expected);
      if (r) e.result = earningsResult(r);
      continue;
    }
    const pats = PRIMARY[e.type] || [];
    const withBoth = e.data.filter((x) => x.actual && x.expected);
    const main = pats.map((p) => withBoth.find((x) => p.test(x.label))).find(Boolean) || withBoth[0];
    if (main) e.result = readResult(e.type, main);
  }
  for (const e of events) if (e.tickers.some((t) => watch.has(t))) e.watch = true;

  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time || '99').localeCompare(b.time || '99') || b.impact - a.impact || a.title.localeCompare(b.title));
  return {
    asOf: now.toISOString(),
    today,
    from,
    to,
    officialThrough: OFFICIAL_THROUGH,
    partial: Object.values(B).some((b) => b.skipped > 0),
    watch: [...watch],
    events,
    feeds,
    cats: CATS,
  };
}
