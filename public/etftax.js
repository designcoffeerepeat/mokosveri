// ETF tax status and the account type it usually suits best. Shared by the
// ticker page (app.js), the dividend page (dividends.js), the income
// calculator (divcalc.js) and the watchlist Tax column (wltable.js). Pure
// data and string building, no DOM, so the offline tests can import it.
//
// Known funds are typed into KNOWN by ticker. Anything else is classified
// from the fund's Yahoo category and name, and the page says it is a guess.
// Tax rules summarized here are general US federal rules for individual
// investors; they change and every fund's mix changes each year.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// acct: taxable | sheltered | roth | any. Drives the colour of the account pill.
export const TAX_TYPES = {
  equity: {
    label: 'Qualified dividends, low payout',
    short: 'Qualified',
    what: 'Dividends from US stocks are mostly "qualified", so they are taxed at the lower long-term capital gains rates (0%, 15% or 20%) rather than your income tax rate, as long as you held the fund more than 60 days around the ex-dividend date. Payouts are small and index ETFs rarely pass out capital gains, so very little tax builds up each year.',
    acct: 'taxable',
    best: 'Taxable brokerage',
    bestShort: 'Taxable',
    why: 'Little yearly tax drag makes it a good fit for a taxable account. A Roth IRA also works well for long-term growth. Save traditional IRA and 401(k) space for funds whose income is taxed as ordinary income.',
  },
  equity_income: {
    label: 'Mostly qualified dividends',
    short: 'Qualified',
    what: 'Dividends from US stocks are mostly qualified, taxed at 0%, 15% or 20% if you held the fund more than 60 days around the ex-dividend date. A higher payout means a bigger tax bill each year in a taxable account, but at the lower rate.',
    acct: 'any',
    best: 'Any account; Roth IRA if you have room',
    bestShort: 'Any',
    why: 'In a Roth IRA the dividends compound tax free for good. In a taxable account most of the payout is still taxed at the lower qualified rate, so it is a fine second choice.',
  },
  foreign: {
    label: 'Qualified dividends, foreign tax withheld',
    short: 'Foreign tax',
    what: 'Foreign countries often withhold 10% to 30% of the dividends before the fund receives them. In a taxable account you can usually get that back as the foreign tax credit (straight on your return up to $300 single or $600 joint, Form 1116 above that). Much of the rest is qualified, but not all foreign dividends are.',
    acct: 'taxable',
    best: 'Taxable brokerage',
    bestShort: 'Taxable',
    why: 'The foreign tax credit only works in a taxable account. In an IRA, Roth or 401(k) the withheld tax is simply lost.',
  },
  covered_call: {
    label: 'Option income, mostly ordinary',
    short: 'Ordinary',
    what: 'The payout mixes stock dividends with option premium. Premium from options on single stocks is usually a short-term gain, taxed as ordinary income at your full income tax rate, so only part of the payout gets the lower qualified rate. The mix changes every year.',
    acct: 'sheltered',
    best: 'IRA, Roth IRA or 401(k)',
    bestShort: 'IRA / Roth',
    why: 'A high payout taxed largely at ordinary rates loses the most in a taxable account. Sheltering it keeps the full income working.',
  },
  covered_call_ordinary: {
    label: 'Mostly ordinary income',
    short: 'Ordinary',
    what: 'Most of the payout is option premium earned through equity linked notes, which is taxed as ordinary income at your full income tax rate. Only a small slice is qualified dividends.',
    acct: 'sheltered',
    best: 'IRA, Roth IRA or 401(k)',
    bestShort: 'IRA / Roth',
    why: 'A high payout taxed at ordinary rates loses the most in a taxable account. Sheltering it keeps all of the income working.',
  },
  covered_call_1256: {
    label: 'Index options: 60/40 and return of capital',
    short: '60/40, ROC',
    what: 'The fund sells options on an index, which are Section 1256 contracts: gains are taxed 60% as long-term and 40% as short-term no matter how long they were held. Much of the payout has often been labelled return of capital, which is not taxed when paid but lowers your cost basis, so you pay when you sell. The split changes every year.',
    acct: 'any',
    best: 'Either; taxable works, an IRA is simplest',
    bestShort: 'Any',
    why: 'The 60/40 split and return of capital make these more tax efficient than most high payout funds, so a taxable account is reasonable. An IRA or Roth avoids tracking the lower cost basis and any tax on the income.',
  },
  reit: {
    label: 'REIT income, mostly ordinary',
    short: 'Ordinary (REIT)',
    what: 'REITs pass out rental income that is mostly not qualified, so it is taxed at your ordinary income rate. Part of it usually qualifies for the 20% Section 199A deduction, and part may be return of capital.',
    acct: 'sheltered',
    best: 'IRA, Roth IRA or 401(k)',
    bestShort: 'IRA / Roth',
    why: 'High payouts taxed at ordinary rates are the classic thing to shelter. In a taxable account you pay tax on most of the income every year.',
  },
  preferred: {
    label: 'Mix of qualified and ordinary',
    short: 'Mixed',
    what: 'Many preferred stock dividends are qualified, but preferreds issued as debt, by REITs or by some foreign banks pay income taxed as ordinary. Expect a mix that changes each year.',
    acct: 'sheltered',
    best: 'IRA, Roth IRA or 401(k)',
    bestShort: 'IRA / Roth',
    why: 'A high payout with a large ordinary slice is better sheltered from yearly tax.',
  },
  bond: {
    label: 'Interest, taxed as ordinary income',
    short: 'Ordinary (interest)',
    what: 'Bond funds pay interest, which is taxed at your full income tax rate every year, federal and state.',
    acct: 'sheltered',
    best: 'Traditional IRA or 401(k)',
    bestShort: 'IRA / 401(k)',
    why: 'Tax deferred accounts suit income taxed at the highest rates. Bonds usually grow more slowly than stocks, so many people keep bonds in traditional accounts and stocks in the Roth.',
  },
  treasury: {
    label: 'Treasury interest: no state tax',
    short: 'No state tax',
    what: 'Interest from US Treasuries is taxed as ordinary income federally but is exempt from state and local income tax. The fund reports the Treasury share each year so you can leave it off your state return (a few states require a minimum share).',
    acct: 'any',
    best: 'Taxable if your state tax is high, else an IRA',
    bestShort: 'Taxable or IRA',
    why: 'In an IRA the state exemption is wasted. If you live in a state with a high income tax, holding it in taxable keeps that benefit; otherwise a traditional IRA or 401(k) shelters the federal tax.',
  },
  muni: {
    label: 'Federally tax-exempt interest',
    short: 'Tax-exempt',
    what: 'Municipal bond interest is free of federal income tax. Your state may still tax it unless the bonds are from your state, part may count toward the alternative minimum tax, and capital gains are taxed normally.',
    acct: 'taxable',
    best: 'Taxable brokerage only',
    bestShort: 'Taxable only',
    why: 'Munis pay lower yields because the income is already tax free. In an IRA or 401(k) you give up that benefit but keep the lower yield, and traditional account withdrawals are taxed anyway.',
  },
  commodity_k1: {
    label: 'Futures partnership: K-1, 60/40',
    short: 'K-1, 60/40',
    what: 'The fund is a partnership holding futures, so you get a Schedule K-1 instead of a 1099, often in March or later, which can delay your filing. Gains are marked to market every year and taxed 60% long-term and 40% short-term, even if you did not sell and the fund paid you nothing.',
    acct: 'sheltered',
    best: 'IRA or Roth IRA to skip the K-1',
    bestShort: 'IRA / Roth',
    why: 'In an IRA you do not file the K-1 or pay tax on gains you never received. In taxable the 60/40 split is a decent rate, but the paperwork and yearly tax on unsold gains are a hassle.',
  },
  commodity_1099: {
    label: 'Futures fund, 1099, ordinary income',
    short: 'Ordinary (futures)',
    what: 'A regular fund that holds futures through an offshore subsidiary, so you get a normal 1099 and no K-1. The trade-off is that futures gains are usually paid out as ordinary income dividends, often in one large year-end distribution.',
    acct: 'sheltered',
    best: 'IRA, Roth IRA or 401(k)',
    bestShort: 'IRA / Roth',
    why: 'Large year-end payouts taxed at ordinary rates are best sheltered.',
  },
  commodity: {
    label: 'Commodity futures fund',
    short: 'Futures',
    what: 'Commodity funds are taxed one of two ways. Partnerships send a K-1 and tax gains 60% long-term and 40% short-term every year, even unsold. Funds that say "No K-1" send a 1099 but usually pay gains out as ordinary income. Check the fund\'s site for which one this is.',
    acct: 'sheltered',
    best: 'IRA or Roth IRA',
    bestShort: 'IRA / Roth',
    why: 'Either way an IRA avoids the paperwork and yearly tax on futures gains.',
  },
  collectible: {
    label: 'Collectible: up to 28% on gains',
    short: 'Collectible',
    what: 'Physically backed precious metal funds are grantor trusts taxed as if you owned the metal. They pay no income, but long-term gains are taxed as collectibles at up to 28%, not the usual 15% or 20%. Short-term gains are ordinary income. The trust sells a little metal to pay its fee, which can create small taxable gains each year.',
    acct: 'sheltered',
    best: 'Roth or traditional IRA',
    bestShort: 'IRA / Roth',
    why: 'An IRA avoids the higher collectibles rate. Holding these ETFs in an IRA is allowed, unlike most physical coins and bars you own yourself.',
  },
  crypto_spot: {
    label: 'Spot crypto: capital gains only',
    short: 'Capital gains',
    what: 'Spot bitcoin and ether funds are grantor trusts. They pay no income; you owe tax only when you sell, at normal capital gains rates (long-term after a year). The trust sells small amounts of coin to pay its fee, which can create tiny taxable gains you report each year.',
    acct: 'roth',
    best: 'Roth IRA, or taxable',
    bestShort: 'Roth / Taxable',
    why: 'Big expected growth compounds tax free in a Roth. In taxable you choose when to pay by choosing when to sell, and losses can offset other gains.',
  },
  mlp_ccorp: {
    label: 'MLP fund, 1099, return of capital',
    short: 'ROC, no K-1',
    what: 'It holds energy pipeline partnerships (MLPs) but is set up as a regular corporation, so you get a 1099, not a K-1. The fund pays corporate tax itself, which lowers returns. Most of the payout has been return of capital, which is not taxed when paid but lowers your cost basis.',
    acct: 'taxable',
    best: 'Taxable brokerage',
    bestShort: 'Taxable',
    why: 'Return of capital defers tax until you sell, which only helps in a taxable account. Unlike owning MLPs directly (K-1s and possible UBTI tax in an IRA), this fund is simple anywhere.',
  },
  mlp: {
    label: 'MLP or midstream fund',
    short: 'Check K-1',
    what: 'Energy partnership (MLP) funds vary. Funds set up as corporations send a 1099 and pay mostly return of capital; funds that mostly own pipeline corporations pay largely qualified dividends; MLPs owned directly send a K-1. Check the fund\'s tax page.',
    acct: 'taxable',
    best: 'Usually taxable brokerage',
    bestShort: 'Taxable',
    why: 'Return of capital only defers tax in a taxable account, and partnership income inside an IRA can trigger UBTI tax.',
  },
  leveraged: {
    label: 'Ordinary income, short-term gains',
    short: 'Ordinary',
    what: 'Leveraged and inverse funds use swaps and futures. Payouts are usually ordinary income, they can pass out capital gains at year end, and they are built for short holds, so most of your own trades end up as short-term gains taxed at your income rate.',
    acct: 'sheltered',
    best: 'IRA or Roth IRA if you trade them',
    bestShort: 'IRA / Roth',
    why: 'Frequent short-term trades are taxed at your highest rate in taxable. Most IRAs allow these funds, though not margin or short selling.',
  },
  unknown: {
    label: 'Tax status not on file',
    short: 'Check fund',
    what: 'We could not tell how this fund\'s income is taxed from its category. Look for the fund\'s tax or distribution page, which shows the qualified, ordinary and return of capital split each year.',
    acct: 'any',
    best: 'Depends on the fund',
    bestShort: '',
    why: 'As a rule of thumb: income taxed as ordinary (bonds, REITs, option income) goes in an IRA or 401(k); qualified dividends, munis and foreign stocks go in taxable.',
  },
};

// Extra notes added to a type for specific funds.
const NOTES = {
  roc: 'A large share of recent payouts has been return of capital. It is not taxed when paid but lowers your cost basis, so more of the gain is taxed when you sell.',
  tbillState: 'Nearly all of the income is Treasury interest, so it is usually free of state income tax.',
  bitoFutures: 'This is a bitcoin futures fund, not spot bitcoin, so it pays out futures gains as ordinary income.',
};

const LIST = (s) => s.split(/\s+/).filter(Boolean);
const K = {};
const add = (type, tickers, extra) => LIST(tickers).forEach((t) => (K[t] = { type, ...(extra || {}) }));
add('equity', 'SPY VOO IVV SPLG VTI ITOT SCHB SCHX QQQ QQQM IWM IJH IJR VB VO VV VUG VTV SCHG SCHA SCHM RSP DIA MGK IWF IWD IWB IWN IWO MDY XLK XLF XLE XLV XLI XLY XLP XLU XLB XLC VGT SMH SOXX ARKK VOOG VOOV SPYG SPYV IUSG IUSV COWZ MTUM QUAL USMV SCHV');
add('equity_income', 'SCHD VIG DGRO NOBL SDY REGL VYM HDV DVY SPYD FDVV DGRW DHS SPHD RDVY DIV SDOG');
add('foreign', 'SCHY VYMI IDV VXUS VEA VWO IEFA IEMG EFA EEM SCHF SCHE IXUS ACWX VT VEU EWJ FXI INDA MCHI EWZ');
add('covered_call', 'DIVO');
add('covered_call_ordinary', 'JEPI JEPQ');
add('covered_call_1256', 'SPYI QQQI XYLD QYLD RYLD', { note: 'roc' });
add('reit', 'VNQ XLRE SCHH IYR USRT REET RWR VNQI');
add('preferred', 'PFF PGX PFFD FPE PFXF');
add('bond', 'BND AGG VCIT VCSH HYG JNK LQD BIV BSV BNDX EMB USHY SJNK ANGL MBB VMBS BKLN SRLN TIP SCHP VTIP STIP');
add('treasury', 'SGOV BIL USFR TFLO SHV TLT IEF SHY GOVT VGSH VGIT VGLT SCHO SCHR SCHQ BILS TBIL CLTL XHLF', { note: 'tbillState' });
add('muni', 'MUB VTEB TFI SUB HYD SHM ITM PZA JMUB');
add('commodity_k1', 'USO UNG DBC DBA DBO BNO UCO SCO UGA USL USCI GSG UVXY SVXY UUP');
add('commodity_1099', 'PDBC BCI COMT FTGC CMDY');
add('commodity_1099', 'BITO', { note: 'bitoFutures' });
add('collectible', 'GLD IAU GLDM SGOL SLV SIVR PPLT PALL BAR AAAU OUNZ');
add('crypto_spot', 'IBIT FBTC GBTC BTC BITB ARKB HODL BTCO BRRR EZBC ETHA ETHE ETH FETH');
add('mlp_ccorp', 'AMLP MLPA', { note: 'roc' });
add('mlp', 'MLPX AMZA EMLP');
add('leveraged', 'TQQQ SQQQ SOXL SOXS SPXL SPXS UPRO SPXU SSO SDS QLD QID TNA TZA TECL LABU FAS FAZ NVDL TSLL SH PSQ');
export const KNOWN = K;

// [type, regex] tried in order on "category name". The first match wins, so
// the narrow cases come before the broad ones.
const RULES = [
  ['muni', /muni|municipal|tax[- ]?(exempt|free)|tax[- ]?advantaged/i],
  ['leveraged', /leveraged|inverse|trading--|\b(2|3)x\b|-(1|2|3)x\b|ultrapro|proshares ultra|\bbear\b|\bbull\b/i],
  ['crypto_futures', /(bitcoin|ether(eum)?|crypto|digital asset).*(strategy|futures)|(strategy|futures).*(bitcoin|ether)/i],
  ['crypto_spot', /bitcoin|ether(eum)?\b|crypto|digital asset/i],
  ['equity_miners', /miner|mining|equity precious/i],
  ['collectible', /\b(gold|silver|platinum|palladium|precious metals?)\b.*\b(trust|shares)\b|physical (gold|silver|precious)/i],
  ['mlp', /\bmlp\b|midstream|energy limited partnership/i],
  ['commodity', /commodit|crude|\boil\b|natural gas|futures|volatility|\bvix\b/i],
  ['reit', /real estate|\breit/i],
  ['preferred', /preferred/i],
  ['covered_call', /covered call|buy-?write|premium income|option income|derivative income|high income|enhanced income/i],
  ['treasury', /treasury|t-?bill|\bgovernment\b|govt/i],
  ['bond', /bond|fixed income|aggregate|corporate|credit|loan|mortgage|high yield|ultrashort|short-term|intermediate|long-term|inflation/i],
  ['foreign', /foreign|international|intl|global|world|emerging|developed|ex-?us|europe|japan|china|india|pacific|asia|latin|canada|brazil|korea|taiwan|mexico|\buk\b/i],
  ['equity_income', /dividend|equity income|high yield equity|shareholder yield/i],
  ['equity', /large|mid|small|blend|growth|value|technology|health|financial|industrial|energy|utilities|consumer|communications|natural resources|equity|stock|index|s&p|nasdaq|russell|total market|500|sector|semiconductor|momentum|quality/i],
];
const ALIAS = { crypto_futures: 'commodity_1099', equity_miners: 'equity' };

// Tax info for one ETF: { ticker, type, ...TAX_TYPES[type], guess, notes[] }.
// t: ticker; name: fund name; category: Yahoo/Morningstar category; sector:
// this site's own group for the income funds (Bonds, Treasury bills...).
const SECTOR_TYPE = {
  'Dividend growth': 'equity_income',
  Aristocrats: 'equity_income',
  'High yield': 'equity_income',
  International: 'foreign',
  'Covered call income': 'covered_call',
  'Real estate': 'reit',
  Preferreds: 'preferred',
  Bonds: 'bond',
  'Treasury bills': 'treasury',
};
export function etfTax({ t, name, category, sector } = {}) {
  const ticker = String(t || '').toUpperCase();
  const k = KNOWN[ticker];
  let type = k ? k.type : null;
  let guess = !k;
  if (!type && sector && SECTOR_TYPE[sector]) type = SECTOR_TYPE[sector];
  if (!type) {
    const text = `${category || ''} ${String(name || '').replace(/global x/i, '')}`;
    const hit = text.trim() && RULES.find(([, re]) => re.test(text));
    type = hit ? ALIAS[hit[0]] || hit[0] : 'unknown';
  }
  const notes = [];
  if (k && k.note) notes.push(NOTES[k.note]);
  return { ticker, type, guess, notes, ...TAX_TYPES[type] };
}

export const TAX_DISCLAIMER = 'General information, not tax advice. It covers US federal rules for individual investors; your own taxes depend on your income, state and how long you hold. Each fund\'s mix of qualified, ordinary and return of capital income changes every year, and its year-end 1099 or K-1 has the final word. Check with a tax professional before acting on it.';

// Small chip with the short label, for tables. Title carries the detail.
export function taxChip(x) {
  if (!x || x.type === 'unknown') return '';
  return `<span class="chip tx-chip tx-${esc(x.acct)}" title="${esc(`${x.label}. Best account: ${x.best}.`)}">${esc(x.short)}</span>`;
}

// Table cell content: the chip and the best account underneath.
export function taxCell(x) {
  if (!x || x.type === 'unknown') return '<span class="muted small">Check fund</span>';
  return `${taxChip(x)}<div class="small muted tx-best">Best: ${esc(x.bestShort)}</div>`;
}

// One line for the income calculator's info box.
export function taxLine(x) {
  if (!x) return '';
  return `<div class="tx-line small"><b>Taxes:</b> ${esc(x.label)}. <b>Best account:</b> ${esc(x.best)}.${x.guess ? ' <span class="muted">(from the fund\'s category)</span>' : ''} <a href="#/t/${encodeURIComponent(x.ticker)}" class="muted">More</a></div>`;
}

// Full card for the ETF's own page.
export function taxCardHtml(x) {
  if (!x) return '';
  return `<div class="card tx-card">
    <div class="tx-head"><span class="chip tx-chip tx-${esc(x.acct)}">${esc(x.short)}</span><b>${esc(x.label)}</b></div>
    <p class="tx-what">${esc(x.what)}</p>
    ${x.notes.map((n) => `<p class="tx-what">${esc(n)}</p>`).join('')}
    <div class="tx-acct"><div class="k">Best account</div><div class="tx-acct-v tx-${esc(x.acct)}">${esc(x.best)}</div><p class="small">${esc(x.why)}</p></div>
    ${x.guess ? '<p class="small muted">Worked out from the fund\'s category and name, not a check of this exact fund. Confirm on the fund\'s tax page.</p>' : ''}
    <p class="small muted tx-note">${esc(TAX_DISCLAIMER)}</p>
  </div>`;
}

// Legend of the types used in a list, for the dividend page.
export function taxLegendHtml(infos) {
  const seen = new Map();
  for (const x of infos || []) if (x && x.type !== 'unknown' && !seen.has(x.type)) seen.set(x.type, x);
  if (!seen.size) return '';
  return `<details class="card tx-legend"><summary><b>How these funds are taxed, and which account suits each</b></summary>
    <dl>${[...seen.values()]
      .map((x) => `<div><dt><span class="chip tx-chip tx-${esc(x.acct)}">${esc(x.short)}</span> ${esc(x.label)}</dt><dd>${esc(x.what)} <b>Best account:</b> ${esc(x.best)}. ${esc(x.why)}</dd></div>`)
      .join('')}</dl>
    <p class="small muted">${esc(TAX_DISCLAIMER)}</p>
  </details>`;
}
