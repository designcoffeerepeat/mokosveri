// Mokosveri options profit calculator. Route: #/options or #/options?t=TICKER
// Black-Scholes for values before expiration, intrinsic value at expiration.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const DAY = 864e5;
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const money = (v, d = 0) => (v == null || !isFinite(v) ? 'n/a' : `${v < 0 ? '-' : ''}$${fmt(Math.abs(v), d)}`);
const signedMoney = (v, d = 0) => (v == null || !isFinite(v) ? 'n/a' : `${v > 0 ? '+' : v < 0 ? '-' : ''}$${fmt(Math.abs(v), d)}`);
const compact = (v) => {
  if (Math.abs(v) < 0.5) v = 0;
  const a = Math.abs(v);
  const s = v > 0 ? '+' : v < 0 ? '-' : '';
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${s}${(a / 1e3).toFixed(0)}K`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}K`;
  return `${s}${Math.round(a)}`;
};
const dateLabel = (ms, opts = { month: 'short', day: 'numeric' }) => new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', ...opts });

// ---------- math ----------
function ncdf(x) {
  // Abramowitz and Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export function bs(type, S, K, T, r, q, sigma) {
  if (T <= 0 || sigma <= 0) return Math.max(0, type === 'C' ? S - K : K - S);
  if (S <= 0) return type === 'C' ? 0 : K * Math.exp(-r * T);
  const sq = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / sq;
  const d2 = d1 - sq;
  if (type === 'C') return S * Math.exp(-q * T) * ncdf(d1) - K * Math.exp(-r * T) * ncdf(d2);
  return K * Math.exp(-r * T) * ncdf(-d2) - S * Math.exp(-q * T) * ncdf(-d1);
}

export function impliedVol(type, price, S, K, T, r, q) {
  if (!(price > 0) || T <= 0) return null;
  let lo = 0.005;
  let hi = 5;
  if (price <= bs(type, S, K, T, r, q, lo) || price >= bs(type, S, K, T, r, q, hi)) return null;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if (bs(type, S, K, T, r, q, mid) > price) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

// ---------- strategies ----------
// k: strike offset in chain steps from at the money (positive = higher strike)
const STRATS = {
  long_call: { name: 'Long call', legs: [{ side: 1, type: 'C', k: 0 }] },
  long_put: { name: 'Long put', legs: [{ side: 1, type: 'P', k: 0 }] },
  short_put: { name: 'Short (cash secured) put', legs: [{ side: -1, type: 'P', k: -1 }] },
  short_call: { name: 'Short (naked) call', legs: [{ side: -1, type: 'C', k: 1 }] },
  covered_call: { name: 'Covered call', legs: [{ stock: true, side: 1 }, { side: -1, type: 'C', k: 2 }] },
  protective_put: { name: 'Protective put', legs: [{ stock: true, side: 1 }, { side: 1, type: 'P', k: -2 }] },
  bull_call: { name: 'Bull call spread', legs: [{ side: 1, type: 'C', k: 0 }, { side: -1, type: 'C', k: 3 }] },
  bear_put: { name: 'Bear put spread', legs: [{ side: 1, type: 'P', k: 0 }, { side: -1, type: 'P', k: -3 }] },
  bull_put: { name: 'Bull put credit spread', legs: [{ side: -1, type: 'P', k: -1 }, { side: 1, type: 'P', k: -4 }] },
  bear_call: { name: 'Bear call credit spread', legs: [{ side: -1, type: 'C', k: 1 }, { side: 1, type: 'C', k: 4 }] },
  straddle: { name: 'Long straddle', legs: [{ side: 1, type: 'C', k: 0 }, { side: 1, type: 'P', k: 0 }] },
  strangle: { name: 'Long strangle', legs: [{ side: 1, type: 'C', k: 2 }, { side: 1, type: 'P', k: -2 }] },
  iron_condor: { name: 'Iron condor', legs: [{ side: 1, type: 'P', k: -5 }, { side: -1, type: 'P', k: -2 }, { side: -1, type: 'C', k: 2 }, { side: 1, type: 'C', k: 5 }] },
  butterfly: { name: 'Call butterfly', legs: [{ side: 1, type: 'C', k: -2 }, { side: -1, type: 'C', k: 0, n: 2 }, { side: 1, type: 'C', k: 2 }] },
  custom: { name: 'Custom (build your own)', legs: [] },
};

// ---------- state ----------
const S = {
  ticker: '',
  price: null,
  name: '',
  chain: null, // { expirations, expiration, calls, puts }
  chainNote: '',
  expiry: null, // ms at 21:00 UTC on expiration date
  rate: 4.0,
  divYield: 0,
  ivOverride: '',
  defaultIv: 30,
  strat: 'long_call',
  legs: [],
  range: 0, // 0 = auto, else +/- percent
  pxLo: '', // custom low and high stock price for the table and chart ('' = use range)
  pxHi: '',
  view: 'pl', // pl | pct | value
  dateIdx: 0,
  loading: false,
  error: '',
};

let root = null;
let api = null;

const expClose = (epochSec) => {
  const d = new Date(epochSec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21, 0, 0);
};
const yearsTo = (from, to) => Math.max(0, (to - from) / (365 * DAY));

function nextFridayAfter(days) {
  const d = new Date(Date.now() + days * DAY);
  while (d.getUTCDay() !== 5) d.setTime(d.getTime() + DAY);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21);
}

function strikeList() {
  const set = new Set();
  if (S.chain) for (const c of [...S.chain.calls, ...S.chain.puts]) set.add(c.strike);
  if (set.size >= 6) return [...set].sort((a, b) => a - b);
  // Synthetic strikes when there is no chain
  const p = S.price || 100;
  const step = p < 5 ? 0.5 : p < 25 ? 1 : p < 100 ? 2.5 : p < 250 ? 5 : p < 1000 ? 10 : 25;
  const out = [];
  const base = Math.round(p / step) * step;
  for (let i = -30; i <= 30; i++) {
    const k = +(base + i * step).toFixed(2);
    if (k > 0) out.push(k);
  }
  for (const l of S.legs) if (l.strike && !out.includes(l.strike)) out.push(l.strike);
  return out.sort((a, b) => a - b);
}

function quoteFor(type, strike) {
  if (!S.chain) return null;
  return (type === 'C' ? S.chain.calls : S.chain.puts).find((c) => c.strike === strike) || null;
}

function marketPremium(type, strike) {
  const q = quoteFor(type, strike);
  if (q) {
    if (q.bid > 0 && q.ask > 0) return +((q.bid + q.ask) / 2).toFixed(2);
    if (q.last > 0) return q.last;
  }
  if (!S.price || !S.expiry) return null;
  const T = yearsTo(Date.now(), S.expiry);
  return +bs(type, S.price, strike, T, S.rate / 100, S.divYield, (q && q.iv) || S.defaultIv / 100).toFixed(2);
}

function buildLegs() {
  const strikes = strikeList();
  const p = S.price || 100;
  let atm = 0;
  strikes.forEach((k, i) => {
    if (Math.abs(k - p) < Math.abs(strikes[atm] - p)) atm = i;
  });
  const prevQty = S.legs.find((l) => !l.stock)?.qty || 1;
  S.legs = STRATS[S.strat].legs.map((t) => {
    if (t.stock) return { stock: true, side: t.side, qty: prevQty, premium: S.price };
    const k = strikes[Math.max(0, Math.min(strikes.length - 1, atm + t.k))];
    return { side: t.side, type: t.type, strike: k, qty: prevQty * (t.n || 1), premium: marketPremium(t.type, k), edited: false };
  });
}

function refreshPremiums() {
  for (const l of S.legs) {
    if (l.stock) l.premium = S.price;
    else if (!l.edited) l.premium = marketPremium(l.type, l.strike);
  }
}

// Per leg volatility used for projections
function legIv(l) {
  if (S.ivOverride !== '' && +S.ivOverride > 0) return +S.ivOverride / 100;
  const T = yearsTo(Date.now(), S.expiry);
  const iv = impliedVol(l.type, l.premium, S.price, l.strike, T, S.rate / 100, S.divYield);
  if (iv) return iv;
  const q = quoteFor(l.type, l.strike);
  return (q && q.iv) || S.defaultIv / 100;
}

// ---------- position math ----------
function positionModel() {
  const r = S.rate / 100;
  const q = S.divYield;
  const legs = S.legs
    .filter((l) => l.stock || (l.strike > 0 && l.premium != null && isFinite(l.premium)))
    .map((l) => ({ ...l, iv: l.stock ? 0 : legIv(l), mult: l.stock ? l.qty * 100 : l.qty * 100 }));
  const cost = legs.reduce((a, l) => a + l.side * l.mult * (l.premium || 0), 0); // positive = debit
  const valueAt = (px, t) => {
    const T = yearsTo(t, S.expiry);
    let v = 0;
    for (const l of legs) v += l.side * l.mult * (l.stock ? px : bs(l.type, px, l.strike, T, r, q, l.iv));
    return v;
  };
  const plAt = (px, t) => valueAt(px, t) - cost;
  return { legs, cost, valueAt, plAt };
}

function analyzeExpiry(m) {
  const strikes = m.legs.filter((l) => !l.stock).map((l) => l.strike);
  const hiK = Math.max(S.price, ...strikes);
  const pts = [0];
  const top = hiK * 3;
  for (let i = 1; i <= 1200; i++) pts.push((top * i) / 1200);
  for (const k of strikes) pts.push(k);
  pts.sort((a, b) => a - b);
  const pl = pts.map((x) => m.plAt(x, S.expiry));
  // slope beyond the highest strike: long calls and stock add, short ones subtract
  const slope = m.legs.reduce((a, l) => a + (l.stock || l.type === 'C' ? l.side * l.mult : 0), 0);
  let maxP = Math.max(...pl);
  let maxL = Math.min(...pl);
  const unlimitedProfit = slope > 0;
  const unlimitedLoss = slope < 0;
  const be = [];
  for (let i = 1; i < pts.length; i++) {
    const a = pl[i - 1];
    const b = pl[i];
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0) || (a === 0 && i === 1)) {
      const x = b === a ? pts[i] : pts[i - 1] + ((0 - a) / (b - a)) * (pts[i] - pts[i - 1]);
      if (!be.some((y) => Math.abs(y - x) < 0.005 * S.price)) be.push(x);
    }
  }
  // Probability of profit at expiration (lognormal, average leg IV)
  const ivs = m.legs.filter((l) => !l.stock).map((l) => l.iv);
  const sigma = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : S.defaultIv / 100;
  const T = yearsTo(Date.now(), S.expiry);
  let pop = null;
  if (T > 0 && sigma > 0) {
    const mu = Math.log(S.price) + (S.rate / 100 - S.divYield - (sigma * sigma) / 2) * T;
    const sd = sigma * Math.sqrt(T);
    const cdf = (x) => (x <= 0 ? 0 : ncdf((Math.log(x) - mu) / sd));
    pop = 0;
    for (let i = 1; i < pts.length; i++) if ((pl[i] + pl[i - 1]) / 2 > 0) pop += cdf(pts[i]) - cdf(pts[i - 1]);
    if (pl[pl.length - 1] > 0) pop += 1 - cdf(pts[pts.length - 1]);
  }
  return { maxP, maxL, unlimitedProfit, unlimitedLoss, be, pop, sigma };
}

function greeks(m) {
  const now = Date.now();
  const h = S.price * 0.001;
  const delta = (m.valueAt(S.price + h, now) - m.valueAt(S.price - h, now)) / (2 * h);
  const gamma = (m.valueAt(S.price + h, now) - 2 * m.valueAt(S.price, now) + m.valueAt(S.price - h, now)) / (h * h);
  const tNext = Math.min(now + DAY, S.expiry);
  const theta = m.valueAt(S.price, tNext) - m.valueAt(S.price, now);
  return { delta, gamma, theta };
}

function tableDates() {
  const now = Date.now();
  const days = Math.max(0, Math.ceil((S.expiry - now) / DAY));
  const today = new Date(now);
  const day0 = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(), 21);
  const out = [{ t: now, label: 'Now' }];
  if (days <= 0) return out;
  const cols = Math.min(days, 9);
  for (let i = 1; i <= cols; i++) {
    const d = Math.round((days * i) / cols);
    const t = i === cols ? S.expiry : Math.min(day0 + d * DAY, S.expiry);
    if (t <= out[out.length - 1].t) continue;
    out.push({ t, label: i === cols ? 'Exp' : null });
  }
  return out;
}

// Stock price bounds: typed low and high prices win, else the range slider,
// else about two standard deviations.
export function priceBounds(price, sigma, T, range = 0, pxLo = '', pxHi = '') {
  const auto = Math.min(0.6, Math.max(0.06, 2 * sigma * Math.sqrt(Math.max(T, 1 / 365))));
  const pct = range > 0 ? range / 100 : auto;
  let lo = price * (1 - pct);
  let hi = price * (1 + pct);
  const cLo = pxLo !== '' && +pxLo >= 0 ? +pxLo : null;
  const cHi = pxHi !== '' && +pxHi > 0 ? +pxHi : null;
  if (cLo != null) lo = cLo;
  if (cHi != null) hi = cHi;
  if (hi <= lo) {
    // Only one side typed and it crossed the price: keep a sensible window.
    if (cHi != null && cLo == null) lo = Math.max(0, hi * (1 - pct));
    else if (cLo != null && cHi == null) hi = lo * (1 + pct) || price;
    else [lo, hi] = [hi, lo];
  }
  if (hi <= lo) hi = lo + Math.max(0.01, price * 0.01);
  return { lo, hi, pct, custom: cLo != null || cHi != null };
}

function priceRows(sigma) {
  const T = yearsTo(Date.now(), S.expiry);
  const { lo, hi, pct, custom } = priceBounds(S.price, sigma, T, S.range, S.pxLo, S.pxHi);
  const raw = (hi - lo) / 22;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const rows = [];
  for (let x = Math.ceil(hi / step) * step; x >= lo - 1e-9; x -= step) if (x > 0) rows.push(+x.toFixed(4));
  // Insert the current price as its own row
  if (S.price >= lo && S.price <= hi && !rows.some((x) => Math.abs(x - S.price) < step * 0.15)) rows.push(S.price);
  return { rows: rows.sort((a, b) => b - a), step, pct, lo, hi, custom };
}

// ---------- rendering ----------
function stratOptions() {
  return Object.entries(STRATS)
    .map(([k, v]) => `<option value="${k}" ${k === S.strat ? 'selected' : ''}>${esc(v.name)}</option>`)
    .join('');
}

function expiryControl() {
  if (S.chain && S.chain.expirations.length) {
    return `<select id="oxExp">${S.chain.expirations
      .map((e) => {
        const ms = expClose(e);
        const dte = Math.max(0, Math.ceil((ms - Date.now()) / DAY));
        return `<option value="${e}" ${ms === S.expiry ? 'selected' : ''}>${dateLabel(ms, { month: 'short', day: 'numeric' })}${new Date(ms).getUTCFullYear() !== new Date().getUTCFullYear() ? ` '${String(new Date(ms).getUTCFullYear()).slice(2)}` : ''} · ${dte}d</option>`;
      })
      .join('')}</select>`;
  }
  const iso = S.expiry ? new Date(S.expiry).toISOString().slice(0, 10) : '';
  return `<input id="oxExpDate" type="date" value="${iso}" min="${new Date().toISOString().slice(0, 10)}" />`;
}

function legRow(l, i, strikes) {
  if (l.stock) {
    return `<tr data-i="${i}">
      <td><select data-f="side"><option value="1" ${l.side > 0 ? 'selected' : ''}>Buy</option><option value="-1" ${l.side < 0 ? 'selected' : ''}>Sell</option></select></td>
      <td><span class="ox-tag">Stock</span></td>
      <td class="muted">${l.qty * 100} sh</td>
      <td><input data-f="premium" type="number" step="0.01" min="0" value="${l.premium ?? ''}" aria-label="Entry price per share" /></td>
      <td><input data-f="qty" type="number" min="1" step="1" value="${l.qty}" aria-label="Lots of 100 shares" /></td>
      <td class="muted ox-hide-sm">n/a</td>
      <td class="muted ox-hide-sm">Per share</td>
      <td><button class="ox-x" data-act="rm" aria-label="Remove leg">×</button></td>
    </tr>`;
  }
  const q = quoteFor(l.type, l.strike);
  const iv = legIv(l);
  const quote = q ? `${q.bid != null ? fmt(q.bid) : 'n/a'} / ${q.ask != null ? fmt(q.ask) : 'n/a'}` : '<span class="muted">no quote</span>';
  return `<tr data-i="${i}">
    <td><select data-f="side"><option value="1" ${l.side > 0 ? 'selected' : ''}>Buy</option><option value="-1" ${l.side < 0 ? 'selected' : ''}>Sell</option></select></td>
    <td><select data-f="type"><option value="C" ${l.type === 'C' ? 'selected' : ''}>Call</option><option value="P" ${l.type === 'P' ? 'selected' : ''}>Put</option></select></td>
    <td><select data-f="strike">${strikes.map((k) => `<option value="${k}" ${k === l.strike ? 'selected' : ''}>${fmt(k, k % 1 ? 2 : 0)}</option>`).join('')}</select></td>
    <td><input data-f="premium" type="number" step="0.01" min="0" value="${l.premium ?? ''}" aria-label="Price per share" class="${l.edited ? 'ox-edited' : ''}" /></td>
    <td><input data-f="qty" type="number" min="1" step="1" value="${l.qty}" aria-label="Contracts" /></td>
    <td class="mono ox-hide-sm">${fmt(iv * 100, 1)}%</td>
    <td class="mono ox-hide-sm">${quote}</td>
    <td><button class="ox-x" data-act="rm" aria-label="Remove leg">×</button></td>
  </tr>`;
}

function inputsHtml() {
  const strikes = strikeList();
  return `
  <section class="hero ox-hero"><h1>Options profit calculator</h1>
    <p>Model a trade before you place it. Pick a ticker, a strategy and an expiration, then see estimated profit or loss for every price and date until expiration.</p></section>
  <div class="card ox-card">
    <form class="ox-grid" id="oxForm" autocomplete="off">
      <label class="ox-f ox-tk"><span>Ticker</span>
        <div class="ox-join"><input id="oxTicker" type="text" value="${esc(S.ticker)}" placeholder="e.g. AAPL" spellcheck="false" /><button type="submit">${S.loading ? 'Loading…' : 'Load'}</button></div>
      </label>
      <label class="ox-f"><span>Stock price</span><input id="oxPrice" type="number" step="0.01" min="0" value="${S.price ?? ''}" /></label>
      <label class="ox-f"><span>Strategy</span><select id="oxStrat">${stratOptions()}</select></label>
      <label class="ox-f"><span>Expiration</span>${expiryControl()}</label>
      <label class="ox-f"><span>Interest rate %</span><input id="oxRate" type="number" step="0.1" value="${S.rate}" /></label>
      <label class="ox-f"><span>IV override %</span><input id="oxIv" type="number" step="0.5" min="0" placeholder="auto" value="${esc(S.ivOverride)}" /></label>
    </form>
    ${S.error ? `<div class="ox-msg down">${esc(S.error)}</div>` : ''}
    ${S.chainNote ? `<div class="ox-msg muted">${esc(S.chainNote)}</div>` : ''}
    ${
      S.price
        ? `<div class="tbl-wrap"><table class="ox-legs">
      <thead><tr><th>Action</th><th>Type</th><th>Strike</th><th>Price</th><th>Qty</th><th class="ox-hide-sm">IV</th><th class="ox-hide-sm">Bid / ask</th><th></th></tr></thead>
      <tbody>${S.legs.map((l, i) => legRow(l, i, strikes)).join('') || '<tr><td colspan="8" class="muted">No legs yet. Add one below.</td></tr>'}</tbody>
    </table></div>
    <div class="ox-legbar">
      <button class="ox-btn" data-act="add-C">+ Call leg</button>
      <button class="ox-btn" data-act="add-P">+ Put leg</button>
      <button class="ox-btn" data-act="add-S">+ Stock</button>
      <button class="ox-btn ghost" data-act="reprice">Reset prices to market</button>
    </div>`
        : ''
    }
  </div>`;
}

function summaryHtml(m, a, g) {
  const stat = (k, v, cls = '', hint = '') => `<div class="ox-stat"><div class="k">${k}</div><div class="v ${cls}">${v}</div>${hint ? `<div class="h">${hint}</div>` : ''}</div>`;
  const entry = m.cost >= 0 ? `${money(m.cost)} debit` : `${money(-m.cost)} credit`;
  const maxP = a.unlimitedProfit ? 'Unlimited' : signedMoney(a.maxP);
  const maxL = a.unlimitedLoss ? 'Unlimited' : signedMoney(a.maxL);
  const be = a.be.length ? a.be.map((x) => `$${fmt(x)} <small class="muted">(${(((x - S.price) / S.price) * 100).toFixed(1)}%)</small>`).join('<br>') : 'None';
  return `<div class="ox-stats">
    ${stat('Entry cost', entry, '', 'Premium paid or received')}
    ${stat('Max profit', maxP, 'up', 'At expiration')}
    ${stat('Max loss', maxL, 'down', 'At expiration')}
    ${stat(a.be.length > 1 ? 'Breakevens' : 'Breakeven', be, '', 'Stock price at expiration')}
    ${stat('Chance of profit', a.pop == null ? 'n/a' : `${(a.pop * 100).toFixed(0)}%`, '', `Lognormal, IV ${fmt(a.sigma * 100, 0)}%`)}
    ${stat('Delta / Theta', `${fmt(g.delta, 0)} / ${signedMoney(g.theta)}`, '', 'Share equivalent / per day')}
  </div>`;
}

function cellBg(v, maxAbs) {
  if (!maxAbs || !isFinite(v)) return '';
  const p = Math.min(1, Math.abs(v) / maxAbs);
  const pct = Math.round(8 + p * 52);
  return `background:color-mix(in srgb, var(${v >= 0 ? '--up' : '--down'}) ${pct}%, var(--surface))`;
}

function tableHtml(m, a) {
  const dates = tableDates();
  const { rows } = priceRows(a.sigma);
  const basis = m.cost > 0 ? m.cost : a.unlimitedLoss ? null : Math.abs(a.maxL) || null;
  const val = (px, t) => {
    const pl = m.plAt(px, t);
    if (S.view === 'pct') return basis ? (pl / basis) * 100 : null;
    if (S.view === 'value') return m.valueAt(px, t);
    return pl;
  };
  const grid = rows.map((px) => dates.map((d) => val(px, d.t)));
  const plGrid = rows.map((px) => dates.map((d) => m.plAt(px, d.t)));
  const maxAbs = Math.max(1, ...plGrid.flat().map(Math.abs));
  const head = dates
    .map((d, i) => `<th class="num ${i === dates.length - 1 ? 'ox-exp' : ''}">${d.label === 'Now' ? 'Now' : dateLabel(d.t)}<small>${d.label === 'Now' ? 'today' : d.label === 'Exp' ? 'expiry' : dateLabel(d.t, { weekday: 'short' })}</small></th>`)
    .join('');
  const body = rows
    .map((px, ri) => {
      const isCur = Math.abs(px - S.price) < 1e-6;
      const chg = ((px - S.price) / S.price) * 100;
      const cells = grid[ri]
        .map((v, ci) => {
          const txt = v == null ? 'n/a' : S.view === 'pct' ? `${v > 0 ? '+' : ''}${v.toFixed(0)}%` : S.view === 'value' ? compact(v).replace('+', '') : compact(v);
          return `<td class="num" style="${cellBg(plGrid[ri][ci], maxAbs)}">${txt}</td>`;
        })
        .join('');
      return `<tr class="${isCur ? 'ox-cur' : ''}"><th class="num ox-px">$${fmt(px)}<small class="${chg > 0 ? 'up' : chg < 0 ? 'down' : ''}">${isCur ? 'current' : `${chg > 0 ? '+' : ''}${chg.toFixed(1)}%`}</small></th>${cells}</tr>`;
    })
    .join('');
  return `<table class="ox-heat"><thead><tr><th class="ox-px">Stock price</th>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

const rangeText = () =>
  S.pxLo !== '' || S.pxHi !== ''
    ? 'Custom prices (move the slider to go back)'
    : S.range > 0
      ? `±${S.range}%`
      : 'Auto (about 2 standard deviations)';

function tableCard(m, a) {
  return `<div class="card ox-card">
    <div class="card-h ox-tbar"><h3>Profit and loss by price and date</h3>
      <div class="ox-seg" role="group" aria-label="Table values">
        <button data-view="pl" class="${S.view === 'pl' ? 'on' : ''}">P/L $</button>
        <button data-view="pct" class="${S.view === 'pct' ? 'on' : ''}">P/L %</button>
        <button data-view="value" class="${S.view === 'value' ? 'on' : ''}">Value</button>
      </div>
    </div>
    <div class="ox-range"><label>Price range <input id="oxRange" type="range" min="0" max="90" step="1" value="${S.range}" /></label><span class="muted" id="oxRangeTxt">${rangeText()}</span>
      <div class="ox-pxset"><label>Low $<input id="oxLo" type="number" min="0" step="any" inputmode="decimal" placeholder="${fmt(priceRows(a.sigma).lo)}" value="${esc(S.pxLo)}" aria-label="Lowest stock price to show" /></label>
        <label>High $<input id="oxHi" type="number" min="0" step="any" inputmode="decimal" placeholder="${fmt(priceRows(a.sigma).hi)}" value="${esc(S.pxHi)}" aria-label="Highest stock price to show" /></label>
        ${S.pxLo !== '' || S.pxHi !== '' ? '<button type="button" class="ox-pxreset" data-act="pxreset">Reset</button>' : ''}</div></div>
    <div class="tbl-wrap" id="oxHeatInner">${tableHtml(m, a)}</div>
  </div>`;
}

// Chart x range: typed prices are shown exactly, otherwise the table range padded a little.
function chartBounds(a) {
  const b = priceRows(a.sigma);
  if (b.custom) return { lo: b.lo, hi: b.hi };
  return { lo: Math.max(0, S.price - (S.price - b.lo) * 1.25), hi: S.price + (b.hi - S.price) * 1.25 };
}

// Draw at the real pixel width so axis labels stay readable on phones.
function chartSize() {
  const w = Math.round(Math.max(300, Math.min(1120, ((root && root.clientWidth) || 800) - 22)));
  return { W: w, H: w < 600 ? 260 : 320 };
}

function chartHtml(m, a) {
  const dates = tableDates();
  if (S.dateIdx >= dates.length) S.dateIdx = 0;
  const { lo, hi } = chartBounds(a);
  const N = 160;
  const xs = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N);
  const tSel = dates[S.dateIdx].t;
  const yExp = xs.map((x) => m.plAt(x, S.expiry));
  const ySel = xs.map((x) => m.plAt(x, tSel));
  let yMin = Math.min(0, ...yExp, ...ySel);
  let yMax = Math.max(0, ...yExp, ...ySel);
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad;
  yMax += pad;
  const { W, H } = chartSize();
  const L = 64;
  const R = 14;
  const T = 14;
  const B = 34;
  const px = (x) => L + ((x - lo) / (hi - lo)) * (W - L - R);
  const py = (y) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
  const path = (ys) => ys.map((y, i) => `${i ? 'L' : 'M'}${px(xs[i]).toFixed(1)},${py(y).toFixed(1)}`).join('');
  // Profit / loss fill under the expiry curve
  const zero = py(0);
  const area = `${path(yExp)}L${px(hi).toFixed(1)},${zero.toFixed(1)}L${px(lo).toFixed(1)},${zero.toFixed(1)}Z`;
  const ticksY = [];
  const raw = (yMax - yMin) / 5;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((s) => s >= raw);
  for (let v = Math.ceil(yMin / step) * step; v <= yMax; v += step) ticksY.push(v);
  const ticksX = [];
  const rx = (hi - lo) / 6;
  const mx = Math.pow(10, Math.floor(Math.log10(rx)));
  const sx = [1, 2, 2.5, 5, 10].map((k) => k * mx).find((s) => s >= rx);
  for (let v = Math.ceil(lo / sx) * sx; v <= hi; v += sx) ticksX.push(v);
  const selLabel = S.dateIdx === 0 ? 'today' : dateLabel(tSel);
  return `<div class="card-h"><h3>Profit and loss chart</h3>
      <div class="ox-legend"><span><i class="ox-sw exp"></i>At expiration</span>${S.dateIdx < dates.length - 1 ? `<span><i class="ox-sw sel"></i>On ${esc(selLabel)}</span>` : ''}</div>
    </div>
    <div class="ox-chart" id="oxChart">
      <svg viewBox="0 0 ${W} ${H}" style="height:${H}px" role="img" aria-label="Profit and loss by stock price">
        <defs><clipPath id="oxUp"><rect x="0" y="0" width="${W}" height="${zero}"/></clipPath><clipPath id="oxDn"><rect x="0" y="${zero}" width="${W}" height="${H - zero}"/></clipPath></defs>
        ${ticksY.map((v) => `<line x1="${L}" x2="${W - R}" y1="${py(v)}" y2="${py(v)}" class="ox-grid-l"/><text x="${L - 8}" y="${py(v) + 4}" text-anchor="end" class="ox-ax">${compact(v)}</text>`).join('')}
        ${ticksX.map((v) => `<text x="${px(v)}" y="${H - 12}" text-anchor="middle" class="ox-ax">$${fmt(v, v % 1 ? 2 : 0)}</text>`).join('')}
        <path d="${area}" class="ox-fill-up" clip-path="url(#oxUp)"/>
        <path d="${area}" class="ox-fill-dn" clip-path="url(#oxDn)"/>
        <line x1="${L}" x2="${W - R}" y1="${zero}" y2="${zero}" class="ox-zero"/>
        <line x1="${px(S.price)}" x2="${px(S.price)}" y1="${T}" y2="${H - B}" class="ox-now"/>
        ${a.be.filter((x) => x > lo && x < hi).map((x) => `<circle cx="${px(x)}" cy="${zero}" r="4" class="ox-be"/>`).join('')}
        <path d="${path(yExp)}" class="ox-line-exp"/>
        ${S.dateIdx < dates.length - 1 ? `<path d="${path(ySel)}" class="ox-line-sel"/>` : ''}
        <g id="oxHover" style="display:none"><line y1="${T}" y2="${H - B}" class="ox-hov"/><circle r="4" class="ox-dot-exp"/><circle r="4" class="ox-dot-sel"/></g>
      </svg>
      <div class="ox-tip" id="oxTip" hidden></div>
    </div>`;
}

function dateText() {
  const dates = tableDates();
  const t = dates[Math.min(S.dateIdx, dates.length - 1)].t;
  return S.dateIdx === 0 ? 'Today' : S.dateIdx >= dates.length - 1 ? 'Expiration' : dateLabel(t, { weekday: 'short', month: 'short', day: 'numeric' });
}

function chartCard(m, a) {
  const dates = tableDates();
  return `<div class="card ox-card"><div id="oxChartInner">${chartHtml(m, a)}</div>
    <div class="ox-range"><label>Date <input id="oxDate" type="range" min="0" max="${dates.length - 1}" step="1" value="${S.dateIdx}" /></label><span class="muted" id="oxDateTxt">${dateText()}</span></div>
  </div>`;
}

function bindChartHover(m, a) {
  const box = root.querySelector('#oxChart');
  if (!box) return;
  const svg = box.querySelector('svg');
  const g = box.querySelector('#oxHover');
  const tip = box.querySelector('#oxTip');
  const dates = tableDates();
  const tSel = dates[S.dateIdx].t;
  const { lo, hi } = chartBounds(a);
  // recompute the same scale as chartHtml
  const N = 160;
  const xs = Array.from({ length: N + 1 }, (_, i) => lo + ((hi - lo) * i) / N);
  const ys = [...xs.map((x) => m.plAt(x, S.expiry)), ...xs.map((x) => m.plAt(x, tSel))];
  let yMin = Math.min(0, ...ys);
  let yMax = Math.max(0, ...ys);
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad;
  yMax += pad;
  const { W, H } = chartSize();
  const L = 64, R = 14, T = 14, B = 34;
  const move = (ev) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((ev.clientX - rect.left) / rect.width) * W;
    if (sx < L || sx > W - R) return leave();
    const price = lo + ((sx - L) / (W - L - R)) * (hi - lo);
    const pe = m.plAt(price, S.expiry);
    const ps = m.plAt(price, tSel);
    const py = (y) => T + (1 - (y - yMin) / (yMax - yMin)) * (H - T - B);
    g.style.display = '';
    g.querySelector('line').setAttribute('x1', sx);
    g.querySelector('line').setAttribute('x2', sx);
    const [c1, c2] = g.querySelectorAll('circle');
    c1.setAttribute('cx', sx);
    c1.setAttribute('cy', py(pe));
    c2.setAttribute('cx', sx);
    c2.setAttribute('cy', py(ps));
    c2.style.display = S.dateIdx < dates.length - 1 ? '' : 'none';
    tip.hidden = false;
    tip.innerHTML = `<b>$${fmt(price)}</b> <span class="muted">(${(((price - S.price) / S.price) * 100).toFixed(1)}%)</span><br>Expiration: <span class="${pe >= 0 ? 'up' : 'down'}">${signedMoney(pe)}</span>${S.dateIdx < dates.length - 1 ? `<br>${S.dateIdx === 0 ? 'Today' : dateLabel(tSel)}: <span class="${ps >= 0 ? 'up' : 'down'}">${signedMoney(ps)}</span>` : ''}`;
    const left = ev.clientX - rect.left;
    tip.style.left = `${Math.min(Math.max(left + 12, 0), rect.width - 180)}px`;
    tip.style.top = `${Math.max(0, ev.clientY - rect.top - 70)}px`;
  };
  const leave = () => {
    g.style.display = 'none';
    tip.hidden = true;
  };
  box.addEventListener('pointermove', move);
  box.addEventListener('pointerleave', leave);
}

let cur = { m: null, a: null };

// Slider moves only redraw the chart and table so the slider keeps its drag.
function redrawOutputs(what) {
  const { m, a } = cur;
  if (!m || !a) return;
  if (what.includes('chart')) {
    const el = root.querySelector('#oxChartInner');
    if (el) el.innerHTML = chartHtml(m, a);
    const dt = root.querySelector('#oxDateTxt');
    if (dt) dt.textContent = dateText();
    bindChartHover(m, a);
  }
  if (what.includes('table')) {
    const el = root.querySelector('#oxHeatInner');
    if (el) el.innerHTML = tableHtml(m, a);
    const rt = root.querySelector('#oxRangeTxt');
    if (rt) rt.textContent = rangeText();
  }
}

function render() {
  if (!root) return;
  const active = document.activeElement;
  const focusId = active && root.contains(active) ? active.id : null;
  let out = inputsHtml();
  let m = null;
  let a = null;
  if (S.price && S.expiry && S.legs.length) {
    m = positionModel();
    if (m.legs.length) {
      a = analyzeExpiry(m);
      out += summaryHtml(m, a, greeks(m));
      out += chartCard(m, a);
      out += tableCard(m, a);
    }
  }
  cur = { m, a };
  out += `<div class="notice"><b>Estimates only, not financial advice.</b> Values before expiration use the Black-Scholes model with each leg's implied volatility, which assumes European exercise and constant volatility. Real option prices also move with changes in volatility, dividends, early assignment and bid/ask spreads. Option quotes may be delayed.</div>`;
  root.innerHTML = out;
  if (focusId) {
    const el = root.querySelector(`#${focusId}`);
    if (el) el.focus();
  }
  if (m && a) bindChartHover(m, a);
}

// ---------- data ----------
async function loadTicker(t, date = null, preset = null) {
  t = String(t || '').trim().toUpperCase().replace(/^\$/, '');
  if (!t) return;
  S.loading = true;
  S.error = '';
  render();
  try {
    let d = await api(`/api/options/${encodeURIComponent(t)}${date ? `?date=${date}` : ''}`);
    // Default to an expiration about a month out rather than one expiring this week
    if (!date && d.chain && d.expirations && d.expirations.length) {
      const pick = d.expirations.find((e) => expClose(e) >= Date.now() + 25 * DAY) || d.expirations[d.expirations.length - 1];
      if (pick !== d.expiration) d = await api(`/api/options/${encodeURIComponent(t)}?date=${pick}`);
    }
    const changedTicker = t !== S.ticker;
    S.ticker = d.symbol || t;
    S.name = d.name || '';
    S.price = d.price != null ? +(+d.price).toFixed(2) : S.price;
    S.divYield = d.dividendYield || 0;
    if (d.chain) {
      S.chain = d;
      S.expiry = expClose(d.expiration);
      S.chainNote = `${S.ticker}${S.name ? ` (${S.name})` : ''}: $${fmt(S.price)}. Mid prices from the live option chain, editable.`;
    } else {
      S.chain = null;
      if (!S.expiry || S.expiry < Date.now()) S.expiry = nextFridayAfter(30);
      S.chainNote = `${S.ticker}${S.name ? ` (${S.name})` : ''}: $${fmt(S.price)}. Option chain unavailable right now, so prices are estimated at ${S.defaultIv}% volatility. Enter real premiums from your broker for accurate results.`;
    }
    if (preset) {
      // Exactly the contract that was tapped, priced from this chain.
      S.strat = preset.strat;
      S.dateIdx = 0;
      const qty = S.legs.find((l) => !l.stock)?.qty || 1;
      S.legs = [{ side: preset.side, type: preset.type, strike: preset.strike, qty, premium: marketPremium(preset.type, preset.strike), edited: false }];
    } else if (changedTicker || !date) buildLegs();
    else {
      // New expiration: keep the structure, snap strikes to this chain, refresh prices
      const strikes = strikeList();
      for (const l of S.legs) {
        if (l.stock) continue;
        l.strike = strikes.reduce((b, k) => (Math.abs(k - l.strike) < Math.abs(b - l.strike) ? k : b), strikes[0]);
        l.edited = false;
      }
      refreshPremiums();
    }
    try {
      if (location.hash !== `#/options?t=${S.ticker}`) history.replaceState(null, '', `#/options?t=${encodeURIComponent(S.ticker)}`);
    } catch {}
    document.title = `${S.ticker} options calculator · Mokosveri`;
  } catch (e) {
    S.error = e.message || 'Could not load that ticker.';
  }
  S.loading = false;
  render();
}

// ---------- events ----------
function onSubmit(e) {
  if (e.target.id !== 'oxForm') return;
  e.preventDefault();
  loadTicker(root.querySelector('#oxTicker').value);
}

function onChange(e) {
  const el = e.target;
  if (el.id === 'oxStrat') {
    S.strat = el.value;
    buildLegs();
    return render();
  }
  if (el.id === 'oxExp') {
    S.dateIdx = 0;
    return loadTicker(S.ticker, el.value);
  }
  if (el.id === 'oxExpDate') {
    const d = el.value ? Date.parse(`${el.value}T21:00:00Z`) : null;
    if (d && d > Date.now()) {
      S.expiry = d;
      S.dateIdx = 0;
      refreshPremiums();
    }
    return render();
  }
  if (el.id === 'oxPrice') {
    const v = parseFloat(el.value);
    if (v > 0) {
      S.price = v;
      refreshPremiums();
    }
    return render();
  }
  if (el.id === 'oxRate') {
    S.rate = parseFloat(el.value) || 0;
    refreshPremiums();
    return render();
  }
  if (el.id === 'oxIv') {
    S.ivOverride = el.value;
    return render();
  }
  if (el.id === 'oxLo' || el.id === 'oxHi') {
    const v = el.value.trim();
    S[el.id === 'oxLo' ? 'pxLo' : 'pxHi'] = v !== '' && +v >= 0 ? String(+v) : '';
    return render();
  }
  if (el.id === 'oxRange' || el.id === 'oxDate') return;
  const tr = el.closest('tr[data-i]');
  if (tr && el.dataset.f) {
    const l = S.legs[+tr.dataset.i];
    const f = el.dataset.f;
    if (f === 'side') l.side = +el.value;
    if (f === 'type') {
      l.type = el.value;
      l.edited = false;
    }
    if (f === 'strike') {
      l.strike = +el.value;
      l.edited = false;
    }
    if (f === 'qty') l.qty = Math.max(1, parseInt(el.value, 10) || 1);
    if (f === 'premium') {
      const v = parseFloat(el.value);
      l.premium = v >= 0 ? v : null;
      if (!l.stock) l.edited = true;
    }
    if (f !== 'qty' && f !== 'premium' && f !== 'side') refreshPremiums();
    if (f === 'type' || f === 'side') S.strat = 'custom';
    render();
  }
}

function onInput(e) {
  const el = e.target;
  if (el.id === 'oxRange') {
    S.range = +el.value;
    // The slider takes over from typed prices.
    if (S.pxLo !== '' || S.pxHi !== '') {
      S.pxLo = '';
      S.pxHi = '';
      for (const id of ['oxLo', 'oxHi']) {
        const f = root.querySelector(`#${id}`);
        if (f) f.value = '';
      }
      const r = root.querySelector('.ox-pxreset');
      if (r) r.remove();
    }
    redrawOutputs(['chart', 'table']);
  } else if (el.id === 'oxDate') {
    S.dateIdx = +el.value;
    redrawOutputs(['chart']);
  }
}

function onClick(e) {
  const b = e.target.closest('button');
  if (!b || !root.contains(b)) return;
  if (b.dataset.view) {
    S.view = b.dataset.view;
    return render();
  }
  const act = b.dataset.act;
  if (!act) return;
  e.preventDefault();
  if (act === 'rm') {
    S.legs.splice(+b.closest('tr').dataset.i, 1);
    S.strat = 'custom';
  } else if (act === 'add-C' || act === 'add-P') {
    const type = act.slice(-1);
    const strikes = strikeList();
    const k = strikes.reduce((a, x) => (Math.abs(x - S.price) < Math.abs(a - S.price) ? x : a), strikes[0]);
    S.legs.push({ side: 1, type, strike: k, qty: 1, premium: marketPremium(type, k), edited: false });
    S.strat = 'custom';
  } else if (act === 'add-S') {
    S.legs.push({ stock: true, side: 1, qty: 1, premium: S.price });
    S.strat = 'custom';
  } else if (act === 'pxreset') {
    S.pxLo = '';
    S.pxHi = '';
  } else if (act === 'reprice') {
    for (const l of S.legs) l.edited = false;
    refreshPremiums();
  }
  render();
}

let bound = false;
export function renderOptions(appEl, apiFn) {
  root = appEl;
  api = apiFn;
  document.title = 'Options calculator · Mokosveri';
  if (!bound) {
    // Delegated listeners on the app container, ignored when another page is showing
    const guard = (fn) => (e) => {
      if (root && root.querySelector('#oxForm')) fn(e);
    };
    root.addEventListener('submit', guard(onSubmit));
    root.addEventListener('change', guard(onChange));
    root.addEventListener('input', guard(onInput));
    root.addEventListener('click', guard(onClick));
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => root.querySelector('#oxChartInner') && redrawOutputs(['chart']), 150);
    });
    bound = true;
  }
  const preset = parsePreset(location.hash);
  const m = location.hash.match(/[?&]t=([^&]+)/);
  const t = m ? decodeURIComponent(m[1]).toUpperCase() : S.ticker || 'SPY';
  render();
  if (preset) loadTicker(t, preset.exp, preset);
  else if (t !== S.ticker || !S.price) loadTicker(t);
}

// A contract linked from the option chain on a stock page:
// #/options?t=AAPL&exp=1766102400&k=190&type=C&side=1
export function parsePreset(hash) {
  const q = new URLSearchParams(String(hash || '').split('?')[1] || '');
  const exp = q.get('exp');
  const k = parseFloat(q.get('k'));
  const type = (q.get('type') || '').toUpperCase();
  if (!/^\d{9,11}$/.test(exp || '') || !(k > 0) || !['C', 'P'].includes(type)) return null;
  const side = q.get('side') === '-1' ? -1 : 1;
  const strat = side === 1 ? (type === 'C' ? 'long_call' : 'long_put') : type === 'C' ? 'short_call' : 'short_put';
  return { exp, strike: k, type, side, strat };
}
