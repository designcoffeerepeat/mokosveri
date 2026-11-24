// Mokosveri front end. Vanilla JS, hash routing: #/ and #/t/TICKER
import { mountWatchButton } from './session.js';
// Coins with long-term power law and rainbow models (kept in step with public/cryptolong.js).
const CRYPTO_LONG = /^(BTC|ETH|SOL|XRP|BNB|DOGE|ADA|LTC)-USD$/;
// AI lenses read company filings, so they show for stocks only (not funds, indices or coins).
const lensOk = (h) => h.type === 'Stock' && !/^[A-Z0-9]+-(USD|EUR|GBP|USDT)$/.test(h.ticker);
// Listed options exist for stocks and funds, not indices or coins.
const chainOk = (h) => (h.type === 'Stock' || h.type === 'ETF') && !/^[A-Z0-9]+-(USD|EUR|GBP|USDT)$/.test(h.ticker);
const $ = (s, el = document) => el.querySelector(s);
const app = $('#app');

// ---------- formatting ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmtNum = (v, d = 2) => (v == null || !isFinite(v) ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPct = (v, d = 1, sign = true) => (v == null || !isFinite(v) ? 'n/a' : `${sign && v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const fmtMoney = (v) => {
  if (v == null || !isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
};
const fmtShares = (v) => (v == null ? 'n/a' : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : Math.abs(v) >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pillCls = (s) => (s >= 15 ? 'up' : s <= -15 ? 'down' : 'flat');
const ago = (iso) => {
  if (!iso) return '';
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
};
const shortDate = (d) => (d ? new Date(d + (d.length === 10 ? 'T12:00:00Z' : '')).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');

function spark(values, w = 84, h = 28) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rng = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / rng) * (h - 4)).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none"><polyline points="${pts}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

async function api(path) {
  const r = await fetch(path);
  const d = await r.json().catch(() => ({ error: 'Bad response' }));
  if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
  return d;
}

const loading = (msg) => `<div class="loading"><div class="spinner"></div>${esc(msg)}</div>`;

// ---------- theme ----------
const root = document.documentElement;
try {
  const t = localStorage.getItem('theme');
  if (t) root.dataset.theme = t;
} catch {}
$('#themeBtn').addEventListener('click', () => {
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('theme', root.dataset.theme);
  } catch {}
});

// ---------- search ----------
const input = $('#searchInput');
const sug = $('#suggest');
let sugItems = [];
let sugIdx = -1;
let sugTimer;
function go(t) {
  t = String(t || '').trim().toUpperCase().replace(/^\$/, '');
  if (!t) return;
  sug.hidden = true;
  input.value = '';
  input.blur();
  location.hash = `#/t/${encodeURIComponent(t)}`;
}
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (sugIdx >= 0 && sugItems[sugIdx]) go(sugItems[sugIdx].symbol);
  else go(input.value);
});
input.addEventListener('input', () => {
  clearTimeout(sugTimer);
  const q = input.value.trim();
  if (q.length < 1) {
    sug.hidden = true;
    return;
  }
  sugTimer = setTimeout(async () => {
    try {
      sugItems = await api(`/api/search?q=${encodeURIComponent(q)}`);
    } catch {
      sugItems = [];
    }
    sugIdx = -1;
    if (!sugItems.length || input.value.trim() !== q) {
      sug.hidden = true;
      return;
    }
    sug.innerHTML = sugItems.map((s, i) => `<li data-i="${i}"><b>${esc(s.symbol)}</b><span>${esc(s.name)}${s.type === 'ETF' ? ' · ETF' : s.type === 'INDEX' ? ' · Index' : ''}</span></li>`).join('');
    sug.hidden = false;
  }, 180);
});
input.addEventListener('keydown', (e) => {
  if (sug.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    sugIdx = (sugIdx + (e.key === 'ArrowDown' ? 1 : -1) + sugItems.length) % sugItems.length;
    [...sug.children].forEach((li, i) => li.classList.toggle('active', i === sugIdx));
  } else if (e.key === 'Escape') sug.hidden = true;
});
sug.addEventListener('mousedown', (e) => {
  const li = e.target.closest('li');
  if (li) go(sugItems[+li.dataset.i].symbol);
});
input.addEventListener('blur', () => setTimeout(() => (sug.hidden = true), 150));

// ---------- home ----------
function buzzRow(r) {
  const chips = (r.reasons || []).slice(0, 3).map((x) => `<span class="chip ${/Insider|Congress/.test(x) ? 'ins' : ''}">${esc(x)}</span>`).join('');
  return `<a class="row" href="#/t/${esc(r.ticker)}">
    <div><div class="tk">${esc(r.ticker)}</div></div>
    <div style="min-width:0"><div class="nm">${esc(r.name || '')}</div><div class="chips">${chips}</div></div>
    <div class="px">${spark(r.spark)}<small class="${cls(r.change1d)}">${fmtNum(r.price)} · ${fmtPct(r.change1d)}</small></div>
    <div class="pill ${pillCls(r.score)}">${r.score > 0 ? '+' : ''}${r.score}</div>
  </a>`;
}

async function renderHome() {
  // Watchlists live in a narrow right-hand column (below the content on phones).
  // The same element is moved into each fresh layout, so it keeps its state.
  const listsEl = document.createElement('aside');
  listsEl.className = 'home-side';
  listsEl.setAttribute('aria-label', 'Your watchlists');
  // Breakout watch panels sit above everything else and load on their own.
  const breakEl = document.createElement('section');
  breakEl.className = 'breakout';
  breakEl.setAttribute('aria-label', 'Breakout watch');
  import('/breakout.js').then((m) => m.mountBreakout(breakEl));
  const placeLists = () => {
    const main = document.createElement('div');
    main.className = 'home-main';
    main.append(breakEl, ...app.childNodes);
    const grid = document.createElement('div');
    grid.className = 'home-grid';
    grid.append(main, listsEl);
    app.append(grid);
  };
  import('/homelists.js').then((m) => m.mountHomeLists(listsEl));
  document.title = 'Mokosveri Research';
  app.innerHTML = `<section class="hero"><h1>What the market is buzzing about</h1>
    <p>Equities drawing unusual attention from insiders, Congress, Wall Street and social media, scored for the odds of a significant move. Search any ticker above for a full breakdown.</p></section>${loading('Gathering buzz, insider filings and price data…')}`;
  placeLists();
  let b;
  try {
    b = await api('/api/buzz');
  } catch (e) {
    app.innerHTML = `<div class="err"><h2>Could not load the buzz board</h2><p class="muted">${esc(e.message)}</p></div>`;
    placeLists();
    return;
  }
  // The home tables show the first few rows; the rest open in place, and the
  // full page (#/trades) has every trade in the window.
  const SHOW = 10;
  const extra = (i) => (i >= SHOW ? ' xp-extra' : '');
  const foot = (n, href, full) =>
    `<div class="tbl-foot">${n > SHOW ? `<button type="button" class="btn-ghost sm xp-btn" aria-expanded="false" data-more="Show all ${n}" data-less="Show top ${SHOW}">Show all ${n}</button>` : '<span></span>'}<a href="${href}">${full} →</a></div>`;
  const insRows = (b.insiderBuys || [])
    .map(
      (r, i) => `<tr class="click${extra(i)}" data-t="${esc(r.ticker)}"><td class="mono">${esc(r.ticker)}</td><td>${esc(r.issuer || '')}</td><td class="num">${r.buyers}</td><td class="num">${fmtMoney(r.total_value)}</td><td>${r.csuite ? '<span class="tag buy">C-suite</span>' : ''}</td><td class="num">${shortDate(r.last_date)}</td></tr>`
    )
    .join('');
  // Congress trades, one row per member; a row expands to that member's trades.
  const tmod = await import('/trades.js');
  const cong = (b.congress || []).length ? tmod.homeCongressHtml(b.congress, SHOW) : null;
  const talked = (b.mostTalked || []).map(buzzRow).join('');
  app.innerHTML = `
    <section class="hero"><h1>What the market is buzzing about</h1>
      <p>Equities drawing unusual attention from insiders, Congress, Wall Street and social media, scored for the odds of a significant move. Search any ticker above for a full breakdown.</p>
      <div class="meta-line">Updated ${ago(b.updated)} · ${b.all.length} tickers scored · insider window: last ${b.insiderDays} days</div>
    </section>

    <div class="grid2" style="margin-top:28px">
      <div class="card"><div class="card-h"><h3><span class="dot up"></span>Bullish buzz</h3><span class="muted small">score</span></div>
        <div class="rows">${b.positive.map(buzzRow).join('') || '<div class="empty">Nothing scoring positive right now.</div>'}</div></div>
      <div class="card"><div class="card-h"><h3><span class="dot down"></span>Bearish buzz</h3><span class="muted small">score</span></div>
        <div class="rows">${b.negative.map(buzzRow).join('') || '<div class="empty">Nothing scoring negative right now.</div>'}</div></div>
    </div>

    <h2 class="section">Insider buying <small class="muted">open market purchases (Form 4, code P), last ${b.insiderDays} days</small></h2>
    <div class="card">${insRows ? `<div class="tbl-wrap xp-rows"><table><thead><tr><th>Ticker</th><th>Company</th><th class="num">Insiders</th><th class="num">Total bought</th><th></th><th class="num">Latest</th></tr></thead><tbody>${insRows}</tbody></table></div>${foot(b.insiderBuys.length, '#/trades/insiders', 'All insider buys, searchable')}` : '<div class="empty">Insider data is still loading. The SEC feed is ingested every 10 minutes.</div>'}</div>

    <h2 class="section">Congress trades <small class="muted">recent STOCK Act disclosures, by member. Tap a name for their trades</small></h2>
    <div class="card">${cong ? `<div class="tbl-wrap xp-rows" id="homeCong">${cong.html}</div>${foot(cong.count, '#/trades/congress', 'All Congress trades, searchable')}` : `<div class="empty">Congressional trade feed is unavailable right now${b.status && b.status.congress && b.status.congress !== 'ok' ? ` (${esc(b.status.congress)})` : ''}.</div>`}</div>

    ${talked ? `<h2 class="section">Most talked about on Reddit</h2><div class="card"><div class="rows">${talked}</div></div>` : ''}

    <h2 class="section">How the score works</h2>
    <div class="card method">
      Every ticker gets a score from <b>-100</b> (strongly bearish) to <b>+100</b> (strongly bullish), a weighted blend of:
      <ul>
        <li><b>Insiders (23%)</b>: open market buys in the last 30 days, extra weight for cluster buys (3+ insiders), C-suite buyers, large dollar amounts and big stake increases. Discretionary sales count against; pre-planned 10b5-1 sales barely count.</li>
        <li><b>Technicals (22%)</b>: trend vs 50 and 200 day averages, MACD, RSI, unusual volume, 52 week breakouts, on balance volume and strength vs the S&amp;P 500.</li>
        <li><b>Analysts (14%)</b>: upgrades and downgrades in the last 30 days, price target changes and implied upside.</li>
        <li><b>Latest news (12%)</b>: headlines from the last 10 days across Yahoo Finance and Google News, each rated positive or negative, with the newest stories counting most.</li>
        <li><b>Short interest (10%)</b>, <b>Congress trades (10%)</b> and <b>social buzz (9%)</b>.</li>
      </ul>
      Separately, <b>move potential</b> estimates how likely a large move is in either direction, based on volatility, volume surges, short interest, social momentum and upcoming earnings. The buzz board uses a faster subset of signals; open a ticker for the full model.
    </div>`;
  placeLists();
  app.querySelectorAll('tr.click').forEach((tr) => !tr.closest('.gp-sub') && tr.addEventListener('click', () => go(tr.dataset.t)));
  const hc = app.querySelector('#homeCong');
  if (hc) tmod.bindGroups(hc);
  app.querySelectorAll('.xp-btn').forEach((btn) =>
    btn.addEventListener('click', () => {
      const box = btn.closest('.card').querySelector('.xp-rows');
      const open = box.classList.toggle('open');
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? btn.dataset.less : btn.dataset.more;
    })
  );
}

// ---------- ticker page ----------
function compBlock(c) {
  const w = Math.abs(c.score) * 50;
  const left = c.score >= 0 ? 50 : 50 - w;
  const color = c.score >= 0 ? 'var(--up)' : 'var(--down)';
  return `<div class="comp"><div class="comp-top">
      <div class="name">${esc(c.label)}<small>weight ${Math.round(c.weight * 100)}%${c.confidence < 0.5 ? ' · low data' : ''}</small></div>
      <div class="div-bar"><i style="left:${left}%;width:${Math.max(w, 1)}%;background:${color}"></i></div>
      <div class="mono ${cls(c.score)}" style="text-align:right">${c.score > 0 ? '+' : ''}${Math.round(c.score * 100)}</div>
    </div>
    <ul class="sigs">${c.signals.map((s) => `<li class="${s.impact > 0 ? 'p' : s.impact < 0 ? 'n' : ''}">${esc(s.text)}</li>`).join('')}</ul></div>`;
}

// ETFs lead their key numbers with the dividend yield, shown large across the
// full width of the card with the payout facts beside it.
function divHero(d) {
  if (!d || d.yieldPct == null) {
    return `<div class="stat stat-hero"><div class="hero-main"><div class="k">Dividend yield</div><div class="v">n/a</div><div class="h">${d && d.lastDate ? `Last paid ${fmtNum(d.lastAmount, 4)} on ${esc(shortDate(d.lastDate))}` : 'No distributions found in the last 12 months'}</div></div></div>`;
  }
  const n = d.payments12m || 0;
  const freq = n >= 11 ? 'Monthly' : n >= 3 && n <= 5 ? 'Quarterly' : n === 2 ? 'Twice a year' : n === 1 ? 'Yearly' : n ? `${n} times a year` : null;
  const facts = [
    d.annualRate != null ? ['Annual payout', `${fmtNum(d.annualRate, 2)} per share`] : null,
    freq ? ['Pays', freq] : null,
    d.lastDate ? ['Last payment', `${fmtNum(d.lastAmount, 4)} on ${shortDate(d.lastDate)}`] : null,
    d.exDate ? ['Ex-dividend', shortDate(d.exDate)] : null,
    d.ttmYieldPct != null && Math.abs(d.ttmYieldPct - d.yieldPct) >= 0.05 ? ['Trailing 12m', fmtPct(d.ttmYieldPct, 2, false)] : null,
  ].filter(Boolean);
  return `<div class="stat stat-hero">
    <div class="hero-main"><div class="k">Dividend yield</div><div class="v">${fmtPct(d.yieldPct, 2, false)}</div><div class="h">per year at today's price</div></div>
    ${facts.length ? `<dl class="hero-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}
  </div>`;
}

function stat(k, v, h = '') {
  return `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div>${h ? `<div class="h">${h}</div>` : ''}</div>`;
}

// Pre-market or after hours line under the big price, from the live quote.
async function showExtended(t) {
  try {
    const d = await api(`/api/quotes?t=${encodeURIComponent(t)}`);
    const q = d.items && d.items[0];
    const x = q && q.ext;
    const el = document.getElementById('extLine');
    if (!x || !el) return;
    const name = x.session === 'pre' ? 'Pre-market' : 'After hours';
    const when = new Date(x.time).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    el.innerHTML = `<span class="ext-tag ext-${x.session}">${name}</span>${fmtNum(x.price)} <span class="${cls(x.changePct)}">${fmtPct(x.changePct, 2)}</span> <span class="muted">${esc(when)}</span>`;
    el.title = `${name} trading against the last regular close. Quotes from Yahoo Finance, some may be delayed.`;
    el.hidden = false;
  } catch {}
}

// The ticker page paints in two steps. A quick snapshot (price and header) plus
// the chart show right away, then the full analysis (SEC filings, news,
// social, analysts, AI note) fills in the sections below when it arrives.
let tickerSeq = 0;

const skel = (rows = 3) => `<div class="card skel-card" aria-hidden="true">${Array.from({ length: rows }, (_, i) => `<div class="skel" style="width:${[92, 76, 84, 64, 88][i % 5]}%"></div>`).join('')}</div>`;

function headHtml(h) {
  return `<div class="tk-head">
      <div>
        <h1><span id="tkName">${esc(h.name)}</span><span class="sym">${esc(h.ticker)}</span></h1>
        <div class="sub" id="tkSub">${subLine(h)}</div>
      </div>
      <div class="price-big"><div class="p">${fmtNum(h.price)} <span class="muted" style="font-size:14px">${esc(h.currency || '')}</span></div>
        <div class="c ${cls(h.change1d)}">${fmtPct(h.change1d, 2)} today · <span class="${cls(h.ret1m)}">${fmtPct(h.ret1m)} 1M</span> · <span class="${cls(h.ret1y)}">${fmtPct(h.ret1y)} 1Y</span></div>
        <div class="ext-line" id="extLine" hidden></div>
        <div class="watch-slot" id="watchSlot"></div></div>
    </div>`;
}
const subLine = (h) => `${esc([h.type, h.exchange, h.sector, h.industry].filter(Boolean).join(' · '))}${h.marketCap ? ` · ${fmtMoney(h.marketCap)} market cap` : ''}`;

// Header facts from a full analysis, for when the snapshot call failed.
const headFromAnalysis = (a) => {
  const tc = a.technicals || {};
  return { ...a, price: tc.price, change1d: tc.change1d, ret1m: tc.ret1m, ret1y: tc.ret1y };
};

function paintShell(h) {
  app.innerHTML = `
    ${headHtml(h)}

    <div id="tkTop">
      <div class="loading-note"><div class="spinner sm"></div>Pulling SEC filings, analyst actions, news and social chatter…</div>
      ${skel(4)}
      ${skel(3)}
    </div>

    <h2 class="section">Price chart</h2>
    <div class="card chart-box pc" id="chartBox"></div>
    ${lensOk(h) ? '<div id="lensWrap"><h2 class="section">AI lenses <small class="muted">tap a question, answered from real filings and prices</small></h2><div id="lensBox"></div></div>' : ''}
    ${chainOk(h) ? '<div id="chainWrap"><h2 class="section">Options chain <small class="muted">calls and puts by strike, tap one to model it</small></h2><div id="chainBox"></div></div>' : ''}
    ${CRYPTO_LONG.test(h.ticker) ? '<h2 class="section">Long-term models <small class="muted">power law and rainbow</small></h2><div id="cryptoBox"></div>' : ''}
    <div id="tkRest">${h.type === 'Index' ? skel(3) : `${skel(5)}${skel(4)}`}</div>
  `;
  mountWatchButton($('#watchSlot'), h.ticker);
  showExtended(h.ticker);
  // The chart loads its own data and is never redrawn when the analysis lands.
  import('/chart.js').then((c) => c.mountChart($('#chartBox'), h.ticker, api));
  // Lenses only fetch when a tile is tapped, so mounting them costs nothing.
  if (lensOk(h)) import('/lenses.js').then((l) => $('#lensBox') && l.mountLenses($('#lensBox'), h.ticker, api));
  // The chain waits until it scrolls near the screen before fetching anything.
  if (chainOk(h)) import('/chain.js').then((c) => $('#chainBox') && c.mountChain($('#chainBox'), h.ticker, api));
  if (CRYPTO_LONG.test(h.ticker)) import('/cryptolong.js').then((c) => c.mountCryptoLong($('#cryptoBox'), h.ticker, api));
}

async function renderTicker(t) {
  const seq = ++tickerSeq;
  const live = () => seq === tickerSeq;
  document.title = `${t} · Mokosveri`;
  app.innerHTML = loading(`Loading ${t}…`);
  const full = api(`/api/analyze/${encodeURIComponent(t)}`).then((a) => ({ a }), (e) => ({ e }));
  let snap = null;
  try {
    snap = await api(`/api/snapshot/${encodeURIComponent(t)}`);
  } catch {}
  if (!live()) return;
  if (snap) paintShell(snap);

  const r = await full;
  if (!live()) return;
  if (r.e) {
    if (!snap) {
      app.innerHTML = `<div class="err"><h2>Could not analyze ${esc(t)}</h2><p class="muted">${esc(r.e.message)}</p><p><a href="#/">Back to the buzz board</a></p></div>`;
      return;
    }
    $('#tkTop').innerHTML = `<div class="err" style="padding:20px 0"><p>Prices are up to date, but the full analysis could not load: <span class="muted">${esc(r.e.message)}</span></p><p><a href="#/t/${encodeURIComponent(t)}" id="tkRetry">Try again</a></p></div>`;
    $('#tkRest').innerHTML = '';
    $('#tkRetry').addEventListener('click', (ev) => {
      ev.preventDefault();
      renderTicker(t);
    });
    return;
  }
  if (!snap) paintShell(headFromAnalysis(r.a));
  fillAnalysis(r.a);

  // An older cached analysis was served so the page could show at once. A new
  // one is being built on the server; swap it in when it is ready.
  if (r.a.stale) {
    for (const wait of [8000, 15000]) {
      await new Promise((res) => setTimeout(res, wait));
      if (!live()) return;
      try {
        const b = await api(`/api/analyze/${encodeURIComponent(t)}`);
        if (!live()) return;
        if (b.asOf !== r.a.asOf) {
          fillAnalysis(b);
          return;
        }
      } catch {}
    }
  }
}

function fillAnalysis(a) {
  document.title = `${a.ticker} ${a.verdict} · Mokosveri`;
  const tc = a.technicals || {};
  const pos = a.positioning || {};
  const an = a.analyst;
  const needle = 50 + a.score / 2;
  const isIdx = a.type === 'Index';

  const insTx = a.insider && a.insider.transactions ? a.insider.transactions : [];
  const insTable = !a.insider.available
    ? `<div class="empty">${esc(a.insider.reason || 'No insider data.')}</div>`
    : insTx.length
      ? `<table><thead><tr><th>Insider</th><th>Type</th><th class="num">Shares</th><th class="num">Price</th><th class="num">Value</th><th class="num">Stake change</th><th class="num">Traded</th><th></th></tr></thead><tbody>${insTx
          .slice(0, 30)
          .map((x) => {
            const chg = x.ownedAfter && x.shares ? (x.code === 'P' ? x.shares / Math.max(x.ownedAfter - x.shares, 1) : -x.shares / (x.ownedAfter + x.shares)) * 100 : null;
            return `<tr><td>${esc(x.owner)}<div class="muted" style="font-size:12px">${esc(x.title || '')}</div></td><td><span class="tag ${x.code === 'P' ? 'buy' : 'sell'}">${x.code === 'P' ? 'Buy' : 'Sell'}</span> ${x.plan10b5 ? '<span class="tag plan" title="Pre-scheduled 10b5-1 trading plan">10b5-1</span>' : ''}</td><td class="num">${fmtShares(x.shares)}</td><td class="num">${fmtNum(x.price)}</td><td class="num">${fmtMoney(x.value)}</td><td class="num ${cls(chg)}">${chg == null ? 'n/a' : fmtPct(Math.max(Math.min(chg, 999), -100), 0)}</td><td class="num">${shortDate(x.date)}</td><td>${x.url ? `<a href="${esc(x.url)}" target="_blank" rel="noopener" class="muted">SEC</a>` : ''}</td></tr>`;
          })
          .join('')}</tbody></table>`
      : `<div class="empty">No open market insider buys or sells in the last ${a.insiderDays} days${a.insider.filingsChecked != null ? ` (${a.insider.filingsChecked} Form 4 filings checked; the rest were grants, option exercises or tax withholding)` : ''}.</div>`;

  const anTable = an && an.actions && an.actions.length
    ? `<table><thead><tr><th>Firm</th><th>Action</th><th>Rating</th><th class="num">Target</th><th class="num">Date</th></tr></thead><tbody>${an.actions
        .slice(0, 15)
        .map(
          (x) => `<tr><td>${esc(x.firm)}</td><td><span class="tag ${x.action === 'up' ? 'buy' : x.action === 'down' ? 'sell' : 'plan'}">${esc({ up: 'Upgrade', down: 'Downgrade', init: 'Initiated', main: 'Maintained', reit: 'Reiterated' }[x.action] || x.action)}</span></td><td>${esc(x.fromGrade && x.fromGrade !== x.toGrade ? `${x.fromGrade} → ${x.toGrade}` : x.toGrade)}</td><td class="num">${x.target ? `${x.priorTarget && x.priorTarget !== x.target ? `<span class="muted">${fmtNum(x.priorTarget, 0)} → </span>` : ''}${fmtNum(x.target, 0)}` : ''}</td><td class="num">${shortDate(x.date)}</td></tr>`
        )
        .join('')}</tbody></table>`
    : `<div class="empty">${a.type === 'ETF' ? 'Analysts do not rate ETFs.' : 'No analyst rating changes in the last 90 days, or the feed is unavailable.'}</div>`;

  const cong = a.congress;
  const congTable = cong == null
    ? '<div class="empty">Congressional trade feed is unavailable right now.</div>'
    : cong.length
      ? `<table><thead><tr><th>Member</th><th>Type</th><th class="num">Amount</th><th class="num">Traded</th><th class="num">Disclosed</th></tr></thead><tbody>${cong
          .map((r) => `<tr><td>${esc(r.member)}<div class="muted" style="font-size:12px">${esc([r.chamber, r.party].filter(Boolean).join(' · '))}</div></td><td><span class="tag ${r.type === 'buy' ? 'buy' : 'sell'}">${esc(r.type)}</span></td><td class="num">${esc(r.amount)}</td><td class="num">${shortDate(r.txDate)}</td><td class="num">${shortDate(r.filedDate)}</td></tr>`)
          .join('')}</tbody></table>`
      : '<div class="empty">No recent congressional trades disclosed for this ticker.</div>';

  const st = a.social && a.social.st;
  const ape = a.social && a.social.ape;
  const bb = st && st.bullish + st.bearish ? (st.bullish / (st.bullish + st.bearish)) * 100 : null;
  const socialHtml = `
    <div class="method" style="padding-bottom:8px">
      ${ape ? `<div><b>Reddit:</b> ${ape.mentions} mentions in 24h, rank #${ape.rank}${ape.rank24hAgo ? ` (was #${ape.rank24hAgo})` : ''}, ${ape.upvotes} upvotes</div>` : '<div class="muted">Not in the Reddit top 200 today.</div>'}
      ${st ? `<div style="margin-top:10px"><b>StockTwits:</b> ${st.bullish} bullish, ${st.bearish} bearish of the last ${st.messages} posts${st.msgsPerHour ? ` · ${st.msgsPerHour} posts per hour` : ''}${st.watchers ? ` · ${Number(st.watchers).toLocaleString()} watchers` : ''}</div>${bb != null ? `<div class="bullbear"><div class="b" style="width:${bb}%"></div><div class="r" style="width:${100 - bb}%"></div></div>` : ''}` : '<div class="muted" style="margin-top:8px">StockTwits feed unavailable.</div>'}
      ${a.social && a.social.trending ? '<div style="margin-top:6px"><span class="chip">Trending on StockTwits</span></div>' : ''}
    </div>
    ${st && st.sample && st.sample.length ? `<div class="posts">${st.sample.map((p) => `<div class="post">${p.sentiment ? `<span class="tag ${p.sentiment === 'Bullish' ? 'buy' : 'sell'}">${esc(p.sentiment)}</span> ` : ''}${esc(p.body)} <span class="muted">@${esc(p.user)}</span></div>`).join('')}</div>` : ''}`;

  const toneWord = (t) => (t > 0 ? 'Positive' : t < 0 ? 'Negative' : 'Neutral');
  const newsHtml = a.news && a.news.length
    ? `<ul>${a.news.slice(0, 12).map((n) => `<li><span class="tone ${n.tone > 0 ? 'p' : n.tone < 0 ? 'n' : ''}" title="${toneWord(n.tone)}"></span><div><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><div class="muted" style="font-size:12px">${esc(n.publisher || '')} · ${ago(n.time)}${n.catalyst ? ` · <span class="chip" style="font-size:10.5px;padding:1px 6px">${esc(n.catalyst)}</span>` : ''}</div></div></li>`).join('')}</ul>`
    : '<div class="empty">No news in the last 10 days.</div>';

  const pl = a.plain;
  const plainList = (title, arr, cls) => (arr && arr.length ? `<div class="plain-col"><div class="plain-h ${cls}">${title}</div><ul>${arr.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></div>` : '');
  const plainHtml = pl
    ? `<div class="card plain"><div class="lbl">The read</div><p class="plain-p">${esc(pl.paragraph)}</p>
        <div class="plain-grid">${plainList('Bullish', pl.good, 'up')}${plainList('Bearish', pl.bad, 'down')}${plainList('Watch', pl.watch, '')}</div>
        <div class="muted" style="font-size:12px;margin-top:10px">${pl.aiWritten ? 'Note drafted by AI from the data on this page. ' : ''}Not financial advice.</div></div>`
    : '';

  const pf = a.profile;
  const pfFacts = pf
    ? [
        ['Sector', pf.sector],
        ['Industry', pf.industry],
        ['Fund family', pf.fundFamily],
        ['Category', pf.fundCategory],
        ['Expense ratio', pf.expenseRatio != null ? fmtPct(pf.expenseRatio * 100, 2, false) : null],
        ['Employees', pf.employees ? Number(pf.employees).toLocaleString() : null],
        ['Headquarters', pf.hq],
        ['Market cap', a.marketCap ? fmtMoney(a.marketCap) : null],
      ].filter(([, v]) => v)
    : [];
  const site = pf && pf.website && /^https?:\/\//i.test(pf.website) ? pf.website : null;
  const profileHtml = pf && (pf.description || pfFacts.length || (pf.officers && pf.officers.length))
    ? `<h2 class="section">${a.type === 'ETF' ? 'Fund profile' : 'Company profile'}</h2>
      <div class="card profile">
        ${pf.description ? `<p class="profile-desc">${esc(pf.description)}</p>` : ''}
        ${pfFacts.length ? `<dl class="profile-facts">${pfFacts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}${site ? `<div><dt>Website</dt><dd><a href="${esc(site)}" target="_blank" rel="noopener">${esc(site.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, ''))}</a></dd></div>` : ''}</dl>` : ''}
        ${pf.officers && pf.officers.length ? `<div class="profile-h">Key executives</div><ul class="profile-officers">${pf.officers.map((o) => `<li><b>${esc(o.name)}</b> <span class="muted">${esc(o.title)}</span></li>`).join('')}</ul>` : ''}
      </div>`
    : '';

  const holdHtml = a.holdings && a.holdings.length
    ? `<h2 class="section">Top holdings</h2><div class="card tbl-wrap"><table><thead><tr><th>Symbol</th><th>Name</th><th class="num">Weight</th></tr></thead><tbody>${a.holdings.map((h) => `<tr class="click" data-t="${esc(h.symbol)}"><td class="mono">${esc(h.symbol)}</td><td>${esc(h.name)}</td><td class="num">${fmtPct((h.pct || 0) * 100, 2, false)}</td></tr>`).join('')}</tbody></table></div>`
    : '';

  const srcNames = { price: 'Prices', benchmark: 'S&P 500 benchmark', yahooFundamentals: 'Analysts and short interest', news: 'News', stocktwits: 'StockTwits', reddit: 'Reddit', congress: 'Congress', secForm4: 'SEC Form 4' };

  // The quick snapshot can mistake a fund for a stock; lenses are for stocks.
  if (!lensOk(a) && $('#lensWrap')) $('#lensWrap').remove();
  if (!chainOk(a) && $('#chainWrap')) $('#chainWrap').remove();
  $('#tkName').textContent = a.name;
  $('#tkSub').innerHTML = subLine(a);
  $('#tkTop').innerHTML = `
    ${plainHtml}

    <div class="card score-card">
      <div class="score-main">
        <div class="lbl">Signal balance</div>
        <div class="verdict ${a.score >= 15 ? 'up' : a.score <= -15 ? 'down' : ''}">${esc(a.verdict)}</div>
        <div class="scorenum">Score ${a.score > 0 ? '+' : ''}${a.score} of ±100 · data coverage ${Math.round(a.coverage * 100)}%</div>
        <div class="meter"><span class="needle" style="left:${needle}%"></span></div>
        <div class="meter-scale"><span>Bearish</span><span>Neutral</span><span>Bullish</span></div>
      </div>
      <div class="score-move">
        <div class="lbl">Odds of a big move</div>
        <div class="move-level">${esc(a.move.level)}</div>
        <div class="bar"><i style="width:${a.move.value}%"></i></div>
        <div class="small">${a.move.typicalMonthMovePct ? `A typical month for this ticker moves about <b>±${a.move.typicalMonthMovePct}%</b> at current volatility.` : ''}</div>
        ${a.move.why.length ? `<ul class="why">${a.move.why.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}
        ${a.earningsDate ? `<div class="small" style="margin-top:8px">Next earnings: <b>${esc(shortDate(a.earningsDate))}</b></div>` : ''}
      </div>
    </div>

    <h2 class="section">Latest news <small class="muted">${a.newsMeta ? `${a.news.length} stories, last 10 days${a.newsMeta.method === 'ai' ? ' · tone rated by AI' : ''}` : ''}</small></h2>
    <div class="card news">${newsHtml}</div>
  `;
  $('#tkRest').innerHTML = `
    <h2 class="section">What is driving the score</h2>
    <div class="card">${a.components.map(compBlock).join('')}</div>

    <h2 class="section">Key numbers</h2>
    <div class="card stats" style="overflow:hidden">
      ${a.type === 'ETF' ? divHero(a.dividend) : ''}
      ${stat('RSI (14)', fmtNum(tc.rsi14, 0), tc.rsi14 > 70 ? 'overbought' : tc.rsi14 < 30 ? 'oversold' : 'neutral range')}
      ${stat('Volume vs 20d avg', tc.relVolume ? `${fmtNum(tc.relVolume, 2)}x` : 'n/a', tc.volume ? `${fmtShares(tc.volume)} today` : '')}
      ${stat('52 week range', `${fmtNum(tc.lo52)} to ${fmtNum(tc.hi52)}`, `${fmtPct(tc.fromHigh)} from high`)}
      ${stat('Volatility', fmtPct(tc.vol20, 0, false), `ATR ${fmtPct(tc.atrPct, 1, false)} per day`)}
      ${isIdx ? '' : `${stat('Short interest', pos.shortPctFloat != null ? fmtPct(pos.shortPctFloat * 100, 1, false) : 'n/a', pos.asOf ? `of float, as of ${shortDate(pos.asOf)}` : 'of float')}
      ${stat('Days to cover', fmtNum(pos.daysToCover, 1), pos.shortChange != null ? `${fmtPct(pos.shortChange * 100, 0)} vs prior month` : '')}
      ${stat('Analyst target', an && an.targetMean ? fmtNum(an.targetMean) : 'n/a', an && an.targetMean && tc.price ? `${fmtPct((an.targetMean / tc.price - 1) * 100)} upside · ${an.numAnalysts || '?'} analysts` : '')}`}
      ${stat('Trend', tc.sma200 ? (tc.price > tc.sma200 ? 'Above 200d' : 'Below 200d') : 'n/a', tc.sma50 ? `50d ${fmtNum(tc.sma50)} · 200d ${fmtNum(tc.sma200)}` : '')}
    </div>

    ${holdHtml}

    ${isIdx ? '' : `<h2 class="section">Insider trades <small class="muted">open market only, last ${a.insiderDays} days, straight from SEC Form 4</small></h2>
    <div class="card tbl-wrap">${insTable}</div>

    <h2 class="section">Analyst actions <small class="muted">last 90 days</small></h2>
    <div class="card tbl-wrap">${anTable}</div>

    <h2 class="section">Congress trades</h2>
    <div class="card tbl-wrap">${congTable}</div>

    <h2 class="section">Social chatter</h2>
    <div class="card">${socialHtml}</div>`}

    ${profileHtml}

    <h2 class="section">Data sources <small class="muted">analyzed ${ago(a.asOf)}${a.stale ? ', refreshing now' : ''}</small></h2>
    <div class="card src">${Object.entries(a.sources).map(([k, v]) => `<span class="chip ${v ? 'ok' : 'no'}" title="${esc((a.errors || {})[k] || '')}">${esc(srcNames[k] || k)}</span>`).join('')}</div>
    <div class="notice"><b>Not financial advice.</b> This score is a rules based summary of public signals, not a prediction or recommendation. Insider and congressional filings are disclosed with a delay and can be amended.</div>
  `;
  app.querySelectorAll('#tkRest tr.click').forEach((tr) => tr.addEventListener('click', () => go(tr.dataset.t)));
}

// ---------- router ----------
function route() {
  const m = location.hash.match(/^#\/t\/([^/?]+)/);
  window.scrollTo(0, 0);
  if (m) renderTicker(decodeURIComponent(m[1]).toUpperCase());
  else if (/^#\/options\b/.test(location.hash)) import('/options.js').then((o) => o.renderOptions(app, api));
  else if (/^#\/sentiment\b/.test(location.hash)) import('/sentiment.js').then((o) => o.renderSentiment(app, api));
  else if (/^#\/trades\b/.test(location.hash)) import('/trades.js').then((o) => o.renderTrades(app, api));
  else if (/^#\/radar\b/.test(location.hash)) import('/radar.js').then((o) => o.renderRadar(app, api));
  else if (/^#\/dividends\b/.test(location.hash)) import('/dividends.js').then((o) => o.renderDividends(app, api));
  else if (/^#\/events\b/.test(location.hash)) import('/events.js').then((o) => o.renderEvents(app, api));
  else if (/^#\/login\b/.test(location.hash)) import('/account.js').then((m) => m.renderLogin(app));
  else if (/^#\/signup\b/.test(location.hash)) import('/account.js').then((m) => m.renderSignup(app));
  else if (/^#\/(account|watchlist)\b/.test(location.hash)) import('/account.js').then((m) => m.renderAccount(app));
  else renderHome();
}
window.addEventListener('hashchange', route);
route();
