// One watchlist as a live, sortable, reorderable table card. Used by the
// Watchlist page and by the accordion on the home page.
import { esc, req } from './session.js';
import { COLUMNS, COLUMN_GROUPS, DEFAULT_COLUMNS, MAX_COLUMNS, cleanColumns, columnNeeds } from './wlcols.js';

const fmtNum = (v, d = 2) => (v == null || !isFinite(v) ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtPct = (v, d = 1) => (v == null || !isFinite(v) ? 'n/a' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const pillCls = (s) => (s >= 15 ? 'up' : s <= -15 ? 'down' : 'flat');
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' });
const EXT_TAG = { pre: 'Pre', post: 'After' };
const EXT_NAME = { pre: 'Pre-market', post: 'After hours' };
const extTitle = (x) => {
  const d = new Date(x.time);
  const same = d.toDateString() === new Date().toDateString();
  const when = d.toLocaleString('en-US', same ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  return `${EXT_NAME[x.session]} ${fmtNum(x.price)} (${fmtPct(x.changePct, 2)} vs the last close), as of ${when}`;
};
// Second line under the price and today cells for pre-market or after hours trading.
const extPx = (x) => (x ? `<div class="ext" title="${esc(extTitle(x))}"><span class="ext-tag ext-${x.session}">${EXT_TAG[x.session]}</span>${fmtNum(x.price)}</div>` : '');
const extCh = (x) => (x ? `<div class="ext ${cls(x.changePct)}" title="${esc(extTitle(x))}">${fmtPct(x.changePct, 2)}</div>` : '');
// Values worked out from the live price: "Pre/After %", "Since added" and "Off high".
const withExt = (r) => {
  r.extPct = r.ext ? r.ext.changePct : null;
  r.sinceAdded = r.addedPrice > 0 && r.price != null && isFinite(r.price) ? (r.price / r.addedPrice - 1) * 100 : null;
  r.fromHigh = r.hi52 > 0 && r.price != null && isFinite(r.price) ? (Math.min(r.price, r.hi52) / r.hi52 - 1) * 100 : null;
  return r;
};
// 2.85T, 412.3B, 18.6M, 950K
const fmtBig = (v, d = 2) => {
  if (v == null || !isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  for (const [n, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= n) return `${(v / n).toFixed(a / n >= 100 ? Math.max(0, d - 1) : d)}${s}`;
  return String(Math.round(v));
};
const monthDay = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
const daysUntil = (ms) => {
  const a = new Date();
  a.setHours(0, 0, 0, 0);
  const b = new Date(ms);
  b.setHours(0, 0, 0, 0);
  return Math.round((b - a) / 864e5);
};
const fmtDay = (ms, long = false) => {
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', long || !sameYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
};
// Compact date for the phone layout: 11/19, or 11/19/25 for another year.
const shortDay = (ms) => {
  const d = new Date(ms);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${md}/${String(d.getFullYear()).slice(2)}`;
};
const daysAgo = (ms) => {
  const n = Math.floor((Date.now() - ms) / 864e5);
  return n < 1 ? 'today' : n === 1 ? '1 day ago' : `${n} days ago`;
};
// The Added cell: the date, plus a hover or tap card with the move since then.
const addedCell = (r, short = false) =>
  r.addedAt
    ? `<button type="button" class="wl-added${r.sinceAdded != null ? ` ${cls(r.sinceAdded)}-mark` : ''}" aria-label="${esc(addedText(r))}">${short ? shortDay(r.addedAt) : fmtDay(r.addedAt)}</button>`
    : '';
function addedText(r) {
  const when = `Added ${fmtDay(r.addedAt, true)} (${daysAgo(r.addedAt)}).`;
  if (r.sinceAdded == null) return `${when} The price when it was added is not available yet.`;
  const diff = r.price - r.addedPrice;
  return `${when} ${r.sinceAdded >= 0 ? 'Up' : 'Down'} ${fmtPct(Math.abs(r.sinceAdded), 2).replace('+', '')} since then, from ${fmtNum(r.addedPrice)} to ${fmtNum(r.price)} (${diff >= 0 ? '+' : '-'}${fmtNum(Math.abs(diff))}).`;
}
function addedTip(r) {
  const head = `<div class="tt-head">Added ${esc(fmtDay(r.addedAt, true))} <span class="muted">${esc(daysAgo(r.addedAt))}</span></div>`;
  if (r.sinceAdded == null) return `${head}<div class="muted">Price when added is not available yet.</div>`;
  const diff = r.price - r.addedPrice;
  const dir = r.sinceAdded > 0 ? 'Up' : r.sinceAdded < 0 ? 'Down' : 'Flat';
  return `${head}
    <div class="wl-tip-big ${cls(r.sinceAdded)}">${dir} ${fmtPct(Math.abs(r.sinceAdded), 2).replace('+', '')}</div>
    <div class="tt-row"><span>Then</span><b>${fmtNum(r.addedPrice)}</b></div>
    <div class="tt-row"><span>Now</span><b>${fmtNum(r.price)}</b></div>
    <div class="tt-row"><span>Change</span><b class="${cls(diff)}">${diff > 0 ? '+' : diff < 0 ? '-' : ''}${fmtNum(Math.abs(diff))}</b></div>`;
}
const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
};

function spark(values, w = 84, h = 26) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const rng = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / rng) * (h - 4)).toFixed(1)}`).join(' ');
  const up = values[values.length - 1] >= values[0];
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="var(--${up ? 'up' : 'down'})" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

const COL = new Map(COLUMNS.map((c) => [c.key, c]));
// Cell classes that keep the old phone layout (name, 1Y and chart drop first).
const CELL_CLS = { name: 'wl-name', ret1m: 'wl-m', ret1y: 'wl-y', spark: 'wl-sp', addedAt: 'wl-ad' };
// Columns that move with the live price, redrawn on every poll.
const LIVE = new Set(['price', 'change1d', 'sinceAdded', 'fromHigh', 'addedAt']);
const pctCell = (v, d = 1) => (v == null ? ['', ''] : [fmtPct(v, d), cls(v)]);

// [html, extra class, title] for column `k` of row `r`.
function cellParts(k, r) {
  const has = r.price != null;
  switch (k) {
    case 'name':
      return [esc(r.name || '')];
    case 'price':
      return [r.pending ? '<span class="muted">loading</span>' : r.error ? '<span class="muted">n/a</span>' : `<span class="px">${fmtNum(r.price)}</span>${extPx(r.ext)}`];
    case 'change1d':
      return [has ? `<span class="px ${cls(r.change1d)}">${fmtPct(r.change1d, 2)}</span>${extCh(r.ext)}` : ''];
    case 'ret5d':
    case 'ret1m':
    case 'ret3m':
    case 'ytd':
    case 'ret1y':
    case 'vs50':
    case 'vs200':
    case 'sinceAdded':
      return has || k === 'sinceAdded' ? pctCell(r[k]) : [''];
    case 'fromHigh':
      return r.fromHigh == null ? [''] : [r.fromHigh > -0.05 ? 'At high' : fmtPct(r.fromHigh), r.fromHigh > -0.05 ? 'up' : '', r.hi52 ? `52 week high ${fmtNum(r.hi52)}` : ''];
    case 'spark':
      return [spark(r.spark)];
    case 'score': {
      if (r.score == null) return [''];
      const est = r.scoreSource && r.scoreSource !== 'full';
      return [`<span class="pill ${pillCls(r.score)} wl-pill" title="${esc(scoreTitle(r))}">${est ? '~' : ''}${r.score > 0 ? '+' : ''}${r.score}</span>`];
    }
    case 'addedAt':
      return [addedCell(r)];
    case 'mcap':
      return [r.mcap == null ? '' : fmtBig(r.mcap)];
    case 'pe':
    case 'fwdPe':
    case 'pb': {
      const eps = k === 'pe' ? r.eps : k === 'fwdPe' ? r.fwdEps : null;
      if (r[k] == null) return eps != null && eps < 0 ? ['<span class="muted small">loss</span>', '', 'No P/E: the company is losing money'] : [''];
      return [fmtNum(r[k], 1)];
    }
    case 'eps':
    case 'fwdEps':
    case 'beta':
    case 'hi52':
    case 'lo52':
      return [r[k] == null ? '' : fmtNum(r[k]), k.endsWith('ps') ? cls(r[k]) : ''];
    case 'rating':
      return r.rating == null ? [''] : [`${fmtNum(r.rating, 1)} <span class="muted small">${esc(r.ratingLabel || '')}</span>`, '', `Average analyst rating ${fmtNum(r.rating, 1)} (${r.ratingLabel || ''}). 1 is strong buy, 5 is sell.`];
    case 'earnings': {
      if (r.earnings == null) return [''];
      const n = daysUntil(r.earnings);
      const when = n === 0 ? 'today' : n === 1 ? 'tomorrow' : `in ${n} days`;
      return [`${r.earningsEst ? '~' : ''}${monthDay(r.earnings)}`, n <= 7 ? 'wl-soon' : '', `${r.earningsEst ? 'Expected' : 'Confirmed'} ${fmtDay(r.earnings, true)}, ${when}${r.earningsEst ? '. Not confirmed by the company yet.' : ''}`];
    }
    case 'exDiv': {
      if (r.exDiv == null) return [''];
      const past = daysUntil(r.exDiv) < 0;
      return [monthDay(r.exDiv), past ? 'muted' : '', past ? 'Last ex-dividend date. The next one is not set yet.' : 'Next ex-dividend date'];
    }
    case 'divYield':
      return [r.divYield == null ? '' : `${fmtNum(r.divYield)}%`];
    case 'volume':
    case 'avgVolume':
      return [r[k] == null ? '' : fmtBig(r[k], 1)];
    case 'relVolume':
      return [r.relVolume == null ? '' : `${fmtNum(r.relVolume)}x`, r.relVolume >= 1.5 ? 'up' : ''];
    case 'rsi':
      return [r.rsi == null ? '' : fmtNum(r.rsi, 0), r.rsi >= 70 ? 'down' : r.rsi <= 30 ? 'up' : ''];
    default:
      return [''];
  }
}
function cellHtml(k, r) {
  const c = COL.get(k);
  const [html, extra, title] = cellParts(k, r);
  const klass = [c.num ? 'num' : '', CELL_CLS[k] || '', extra || ''].filter(Boolean).join(' ');
  const dc = k === 'price' ? ' data-c="price"' : k === 'change1d' ? ' data-c="chg"' : '';
  return `<td data-k="${k}"${klass ? ` class="${klass}"` : ''}${title ? ` title="${esc(title)}"` : ''}${dc}>${html}</td>`;
}

// Sort choice is remembered per list.
const sortKey = (id) => `wlSort:${id}`;
function readSort(id) {
  try {
    const s = JSON.parse(localStorage.getItem(sortKey(id)) || localStorage.getItem('wlSort'));
    if (s && (s.key === 'custom' || s.key === 'extPct' || s.key === 'ticker' || (COL.has(s.key) && COL.get(s.key).sortable !== false))) return s;
  } catch {}
  return { key: 'custom', dir: 1 };
}
function writeSort(id, s) {
  try {
    localStorage.setItem(sortKey(id), JSON.stringify(s));
  } catch {}
}

const scoreTitle = (r) =>
  r.scoreSource === 'full'
    ? `Full analysis score, ${ago(r.scoredAt)}`
    : r.scoreSource === 'buzz'
      ? 'Score from the market buzz board. Open the ticker for the full analysis.'
      : 'Estimate from price technicals only. Open the ticker for the full score.';

// Renders list `listId` into `root`. Options:
//   active(): false pauses live polling (e.g. a closed accordion section)
//   onData(d): called with each full load ({ list, lists, items, ... })
//   onAuthLost(): called on a 401
// Returns { reload, poll }.
export function mountWatchTable(root, listId, opts = {}) {
  let items = [];
  let max = 40;
  let sort = readSort(listId);
  let meta = {};
  let dragging = false;
  let pollTimer = null;
  let loaded = false;
  let cols = DEFAULT_COLUMNS.slice(); // replaced by the list's saved choice on load
  let fetchedFor = { stats: false, spy: false }; // what the last load fetched
  const active = opts.active || (() => true);

  root.innerHTML = `<div class="card wl-card">
      <div class="wl-bar">
        <form class="wl-add" autocomplete="off"><input type="text" maxlength="12" placeholder="Add a ticker, e.g. AAPL" aria-label="Add a ticker to this watchlist" spellcheck="false" /><button type="submit">Add</button></form>
        <div class="wl-live muted small" role="status"></div>
        <div class="wl-tools-r">
          <label class="wl-sort"><span class="muted small">Sort</span><select></select><button type="button" class="btn-ghost sm wl-dir" aria-label="Flip sort direction" title="Flip sort direction"></button></label>
          <button type="button" class="btn-ghost sm wl-colbtn" aria-expanded="false">Columns</button>
        </div>
      </div>
      <div class="wl-colpanel" hidden></div>
      <div class="auth-err wl-err" role="alert"></div>
      <div class="tbl-wrap wl-tbl"><div class="loading"><div class="spinner"></div>Loading…</div></div>
      <div class="wl-foot muted small"></div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const table = $('.wl-tbl');
  const err = (m) => ($('.wl-err').textContent = m || '');
  // Re-mounting into the same element retires the previous instance.
  const gen = (root._wlGen = (root._wlGen || 0) + 1);
  const alive = () => root.isConnected && root._wlGen === gen;
  const q = (extra = '') => `list=${encodeURIComponent(listId)}${extra}`;

  // Sort menu: My order, then the shown columns, then the other sortable ones.
  function sortOptions() {
    const shown = cols.filter((k) => COL.get(k).sortable !== false);
    const rest = COLUMNS.filter((c) => c.sortable !== false && !cols.includes(c.key)).map((c) => c.key);
    const opt = (k) => `<option value="${k}">${k === 'ticker' ? 'Ticker' : COL.get(k).label}</option>`;
    return `<option value="custom">My order</option><optgroup label="Shown">${['ticker', ...shown].map(opt).join('')}<option value="extPct">Pre/After %</option></optgroup>${rest.length ? `<optgroup label="Other">${rest.map(opt).join('')}</optgroup>` : ''}`;
  }

  const sorted = () => {
    if (sort.key === 'custom') return items.slice();
    const k = sort.key;
    return items.slice().sort((a, b) => {
      const x = a[k];
      const y = b[k];
      if (x == null && y == null) return 0;
      if (x == null) return 1; // blanks always last
      if (y == null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y) : x - y) * sort.dir;
    });
  };

  function paint() {
    const sel = $('.wl-sort select');
    const opts = sortOptions();
    if (sel._opts !== opts) {
      sel.innerHTML = opts;
      sel._opts = opts;
    }
    sel.value = sort.key;
    $('.wl-dir').textContent = sort.key === 'custom' ? '' : sort.dir > 0 ? 'Asc' : 'Desc';
    $('.wl-dir').hidden = sort.key === 'custom';
    $('.wl-foot').textContent = items.length
      ? `${items.length} of ${max} tickers. ${sort.key === 'custom' ? 'Drag the handle (or focus it and use the arrow keys) to reorder.' : 'Click a column again to flip it. Choose "My order" to drag and reorder.'}${cols.includes('score') ? ' Scores marked ~ are quick estimates.' : ''}${cols.includes('earnings') ? ' Earnings dates marked ~ are not confirmed yet.' : ''}${cols.includes('addedAt') ? ' Hover or tap an Added date to see the move since then.' : ''} Use Columns to choose what shows.`
      : '';
    if (!items.length) {
      table.innerHTML = '<div class="empty">This list is empty. Add a ticker above, or use "Add to watchlist" on any ticker page.</div>';
      return;
    }
    const custom = sort.key === 'custom';
    const arrow = (k) => (sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
    const th = (k, label, num, extra = '', title = '') =>
      `<th class="${[num ? 'num' : '', extra].filter(Boolean).join(' ')}" aria-sort="${sort.key === k ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"${title ? ` title="${esc(title)}"` : ''}><button type="button" class="th-btn" data-k="${k}">${label}${arrow(k)}</button></th>`;
    const showAdded = cols.includes('addedAt');
    table.innerHTML = `<table class="wl"><thead><tr>
      <th class="wl-h" aria-label="Reorder"></th>
      ${th('ticker', 'Ticker', false, 'wl-tk')}
      ${cols
        .map((k) => {
          const c = COL.get(k);
          return c.sortable === false ? `<th class="${CELL_CLS[k] || ''}" title="${esc(c.help)}">${c.label}</th>` : th(k, c.label, c.num, CELL_CLS[k] || '', c.help);
        })
        .join('')}
      <th aria-label="Remove"></th></tr></thead>
      <tbody>${sorted()
        .map(
          (r) => `<tr data-t="${esc(r.ticker)}">
            <td class="wl-h">${custom ? `<button type="button" class="handle" aria-label="Move ${esc(r.ticker)}. Use arrow keys." title="Drag to reorder">⋮⋮</button>` : ''}</td>
            <td class="mono wl-tk"><a href="#/t/${encodeURIComponent(r.ticker)}">${esc(r.ticker)}</a>${showAdded ? `<div class="wl-ad-sub" data-a="short">${addedCell(r, true)}</div>` : ''}</td>
            ${cols.map((k) => cellHtml(k, r)).join('')}
            <td><button type="button" class="rm" aria-label="Remove ${esc(r.ticker)}" title="Remove">&times;</button></td>
          </tr>`
        )
        .join('')}</tbody></table>`;
    refreshTip();
  }

  // ---------- added date card (hover on desktop, tap on touch) ----------
  let tip = null;
  let tipFor = null; // ticker the card is showing
  let tipPinned = false; // opened by a tap or click, stays until dismissed
  function showTip(btn, pinned) {
    const t = btn.closest('tr').dataset.t;
    const r = items.find((x) => x.ticker === t);
    if (!r) return;
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'wl-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    tipFor = t;
    tipPinned = pinned;
    tip.innerHTML = addedTip(r);
    tip.hidden = false;
    const b = btn.getBoundingClientRect();
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    const left = Math.max(8, Math.min(window.innerWidth - w - 8, b.left + b.width / 2 - w / 2));
    const below = b.bottom + 8 + h <= window.innerHeight;
    tip.style.left = `${left}px`;
    tip.style.top = `${below ? b.bottom + 8 : Math.max(8, b.top - h - 8)}px`;
  }
  function hideTip() {
    if (tip) tip.hidden = true;
    tipFor = null;
    tipPinned = false;
  }
  function refreshTip() {
    if (!tip || tip.hidden || !tipFor) return;
    const btn = [...table.querySelectorAll(`tr[data-t="${CSS.escape(tipFor)}"] .wl-added`)].find((b) => b.offsetParent);
    if (btn) showTip(btn, tipPinned);
    else hideTip();
  }
  table.addEventListener('pointerover', (e) => {
    const btn = e.target.closest('.wl-added');
    if (btn && e.pointerType === 'mouse' && !tipPinned) showTip(btn, false);
  });
  table.addEventListener('pointerout', (e) => {
    const btn = e.target.closest('.wl-added');
    if (btn && e.pointerType === 'mouse' && !tipPinned && !btn.contains(e.relatedTarget)) hideTip();
  });
  table.addEventListener('focusin', (e) => {
    const btn = e.target.closest('.wl-added');
    if (btn && !tipPinned) showTip(btn, false);
  });
  table.addEventListener('focusout', (e) => {
    if (e.target.closest('.wl-added') && !tipPinned) hideTip();
  });
  const onDocDown = (e) => {
    if (!alive()) {
      document.removeEventListener('pointerdown', onDocDown);
      document.removeEventListener('keydown', onEsc);
      window.removeEventListener('scroll', onScroll, true);
      if (tip) tip.remove();
      return;
    }
    if (tipPinned && !e.target.closest('.wl-added') && !(tip && tip.contains(e.target))) hideTip();
  };
  const onEsc = (e) => e.key === 'Escape' && hideTip();
  const onScroll = () => tip && !tip.hidden && hideTip();
  document.addEventListener('pointerdown', onDocDown);
  document.addEventListener('keydown', onEsc);
  window.addEventListener('scroll', onScroll, true);

  // ---------- live prices ----------
  function paintLive() {
    const el = $('.wl-live');
    if (!el || !meta.at) return;
    const open = meta.market === 'open';
    const label = open ? 'Live' : meta.market === 'pre-market' ? 'Pre-market' : meta.market === 'after hours' ? 'After hours' : meta.market ? `Market ${esc(meta.market)}` : 'Prices';
    el.innerHTML = `<span class="live-dot${open ? ' on' : meta.market === 'pre-market' || meta.market === 'after hours' ? ' ext' : ''}"></span>${label} · updated ${clock(meta.at)}`;
    el.title = `Prices refresh every ${meta.refreshSec || 60} seconds while this list is open. Price and Today are the regular session. Pre and After lines show pre-market and after hours trading against the last close. Quotes from Yahoo Finance, some may be delayed.`;
  }
  function flash(t, up) {
    const tr = table.querySelector(`tr[data-t="${CSS.escape(t)}"]`);
    if (!tr) return;
    for (const td of tr.querySelectorAll('[data-c]')) {
      td.classList.remove('flash-up', 'flash-down');
      void td.offsetWidth; // restart the animation
      td.classList.add(up ? 'flash-up' : 'flash-down');
    }
  }
  function applyLive(d) {
    meta = { refreshSec: d.refreshSec, market: d.market, at: d.at };
    const changed = [];
    const by = new Map(items.map((r) => [r.ticker, r]));
    for (const lq of d.items) {
      const r = by.get(lq.ticker);
      if (!r) continue;
      const was = r.ext ? r.ext.price : r.price;
      const now = lq.ext ? lq.ext.price : lq.price;
      if (was != null && now !== was) changed.push([lq.ticker, now > was]);
      r.price = lq.price;
      if (lq.change1d != null) r.change1d = lq.change1d;
      if ('ext' in lq) r.ext = lq.ext;
      withExt(r);
      r.pending = false;
      r.error = null;
    }
    if (!dragging && (LIVE.has(sort.key) || sort.key === 'extPct')) paint();
    else
      for (const r of items) {
        const tr = table.querySelector(`tr[data-t="${CSS.escape(r.ticker)}"]`);
        if (!tr || r.price == null) continue;
        for (const td of tr.querySelectorAll('td[data-k]')) if (LIVE.has(td.dataset.k)) td.outerHTML = cellHtml(td.dataset.k, r);
        for (const a of tr.querySelectorAll('[data-a="short"]')) a.innerHTML = addedCell(r, true);
      }
    refreshTip();
    paintLive();
    for (const [t, up] of changed) flash(t, up);
  }
  function schedule() {
    clearTimeout(pollTimer);
    if (!alive()) return;
    pollTimer = setTimeout(poll, (meta.refreshSec || 60) * 1000);
  }
  async function poll() {
    clearTimeout(pollTimer);
    if (!alive()) return;
    if (!loaded) return load();
    if (document.visibilityState === 'hidden' || !active() || !items.length) return schedule();
    try {
      applyLive(await req('GET', `/api/watchlist/live?${q()}`));
    } catch {}
    schedule();
  }
  const onVisible = () => {
    if (!alive()) return document.removeEventListener('visibilitychange', onVisible);
    if (document.visibilityState === 'visible' && active()) poll();
  };
  document.addEventListener('visibilitychange', onVisible);

  async function load(tries = 0) {
    try {
      const d = await req('GET', `/api/watchlist?${q()}`);
      if (!alive()) return;
      loaded = true;
      items = d.items.map(withExt);
      max = d.max;
      if (d.list && Array.isArray(d.list.columns)) cols = cleanColumns(d.list.columns);
      fetchedFor = { stats: columnNeeds(cols, 'stats'), spy: columnNeeds(cols, 'spy') };
      if (d.at) meta = { refreshSec: d.refreshSec, market: d.market, at: d.at };
      err('');
      paint();
      paintLive();
      schedule();
      if (opts.onData) opts.onData(d);
      if (items.some((r) => r.pending) && tries < 4) setTimeout(() => alive() && load(tries + 1), 1500);
    } catch (e) {
      if (e.status === 401 && opts.onAuthLost) return opts.onAuthLost();
      table.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  const saveOrder = async () => {
    try {
      await req('PUT', '/api/watchlist/order', { list: listId, tickers: items.map((r) => r.ticker) });
    } catch (e) {
      err(e.message);
    }
  };

  $('.wl-add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('.wl-add input');
    const t = input.value.trim().toUpperCase().replace(/^\$/, '');
    if (!t) return;
    try {
      await req('POST', '/api/watchlist', { list: listId, ticker: t });
      input.value = '';
      await load();
    } catch (ex) {
      err(ex.message);
    }
  });

  $('.wl-sort select').addEventListener('change', (e) => {
    sort = { key: e.target.value, dir: sort.dir || 1 };
    writeSort(listId, sort);
    paint();
  });
  $('.wl-dir').addEventListener('click', () => {
    sort.dir = -sort.dir;
    writeSort(listId, sort);
    paint();
  });

  table.addEventListener('click', async (e) => {
    const th = e.target.closest('.th-btn');
    if (th) {
      const k = th.dataset.k;
      // Click cycles: first direction (descending for numbers), flipped, then back to my order.
      const first = k !== 'ticker' && COL.get(k).num && !COL.get(k).asc ? -1 : 1;
      if (sort.key !== k) sort = { key: k, dir: first };
      else if (sort.dir === first) sort = { key: k, dir: -first };
      else sort = { key: 'custom', dir: 1 };
      writeSort(listId, sort);
      paint();
      return;
    }
    const ad = e.target.closest('.wl-added');
    if (ad) {
      const t = ad.closest('tr').dataset.t;
      if (tipPinned && tipFor === t) hideTip();
      else showTip(ad, true);
      return;
    }
    const rm = e.target.closest('.rm');
    if (rm) {
      const t = rm.closest('tr').dataset.t;
      items = items.filter((r) => r.ticker !== t);
      paint();
      try {
        await req('DELETE', `/api/watchlist/${encodeURIComponent(t)}?${q()}`);
        if (opts.onData) opts.onData({ list: { id: listId, count: items.length } });
      } catch (ex) {
        err(ex.message);
        load();
      }
    }
  });

  // Keyboard reorder on the handle.
  table.addEventListener('keydown', (e) => {
    const h = e.target.closest('.handle');
    if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const t = h.closest('tr').dataset.t;
    const i = items.findIndex((r) => r.ticker === t);
    const j = i + (e.key === 'ArrowUp' ? -1 : 1);
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    paint();
    const again = table.querySelector(`tr[data-t="${CSS.escape(t)}"] .handle`);
    if (again) again.focus();
    saveOrder();
  });

  // Pointer drag reorder (mouse, pen and touch) on the handle.
  table.addEventListener('pointerdown', (e) => {
    const h = e.target.closest('.handle');
    if (!h) return;
    e.preventDefault();
    const row = h.closest('tr');
    const tbody = row.parentElement;
    row.classList.add('dragging');
    dragging = true;
    // Listen on window: moving the row in the DOM drops pointer capture.
    const move = (ev) => {
      const others = [...tbody.children].filter((r) => r !== row);
      const after = others.find((r) => {
        const b = r.getBoundingClientRect();
        return ev.clientY < b.top + b.height / 2;
      });
      if (after) tbody.insertBefore(row, after);
      else tbody.appendChild(row);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      row.classList.remove('dragging');
      dragging = false;
      const order = [...tbody.children].map((r) => r.dataset.t);
      if (order.some((t, i) => items[i].ticker !== t)) {
        const by = new Map(items.map((r) => [r.ticker, r]));
        items = order.map((t) => by.get(t));
        saveOrder();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  });

  // ---------- column picker ----------
  const panel = $('.wl-colpanel');
  const colBtn = $('.wl-colbtn');
  let saveTimer = null;
  function paintPanel() {
    const shown = cols
      .map(
        (k, i) => `<li data-k="${k}"><span class="wl-cp-name">${COL.get(k).label}</span>
          <button type="button" class="wl-cp-mv" data-mv="-1" aria-label="Move ${esc(COL.get(k).label)} left" ${i === 0 ? 'disabled' : ''}>&larr;</button>
          <button type="button" class="wl-cp-mv" data-mv="1" aria-label="Move ${esc(COL.get(k).label)} right" ${i === cols.length - 1 ? 'disabled' : ''}>&rarr;</button>
          <button type="button" class="wl-cp-rm" aria-label="Hide ${esc(COL.get(k).label)}">&times;</button></li>`
      )
      .join('');
    const full = cols.length >= MAX_COLUMNS;
    panel.innerHTML = `<div class="wl-cp-head"><b>Columns for this list</b><span class="muted small">${cols.length} of ${MAX_COLUMNS} shown. Saved to your account.</span></div>
      <div class="wl-cp-sub muted small">Shown, left to right</div>
      <ol class="wl-cp-shown">${shown || '<li class="muted small">Only the ticker. Tick a few below.</li>'}</ol>
      <div class="wl-cp-groups">${COLUMN_GROUPS.map(
        (g) => `<fieldset><legend>${g}</legend>${COLUMNS.filter((c) => c.group === g)
          .map((c) => {
            const on = cols.includes(c.key);
            return `<label title="${esc(c.help)}"><input type="checkbox" value="${c.key}" ${on ? 'checked' : ''} ${!on && full ? 'disabled' : ''}/> ${c.label}</label>`;
          })
          .join('')}</fieldset>`
      ).join('')}</div>
      <div class="wl-cp-foot"><button type="button" class="btn-ghost sm wl-cp-reset">Reset to default</button><button type="button" class="btn-ghost sm wl-cp-done">Done</button></div>`;
  }
  function setCols(next, focusSel) {
    cols = cleanColumns(next);
    paintPanel();
    if (focusSel) {
      const el = panel.querySelector(focusSel);
      if (el) el.focus();
    }
    paint();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        await req('PUT', `/api/watchlists/${encodeURIComponent(listId)}/columns`, { columns: cols });
        err('');
      } catch (e) {
        err(e.message);
      }
      // New columns that need data the last load skipped.
      if ((columnNeeds(cols, 'stats') && !fetchedFor.stats) || (columnNeeds(cols, 'spy') && !fetchedFor.spy)) load();
    }, 500);
  }
  colBtn.addEventListener('click', () => {
    const open = panel.hidden;
    panel.hidden = !open;
    colBtn.setAttribute('aria-expanded', String(open));
    if (open) paintPanel();
  });
  panel.addEventListener('change', (e) => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const k = box.value;
    setCols(box.checked ? [...cols, k] : cols.filter((x) => x !== k), `input[value="${k}"]`);
  });
  panel.addEventListener('click', (e) => {
    if (e.target.closest('.wl-cp-done')) {
      panel.hidden = true;
      colBtn.setAttribute('aria-expanded', 'false');
      colBtn.focus();
      return;
    }
    if (e.target.closest('.wl-cp-reset')) return setCols(DEFAULT_COLUMNS);
    const li = e.target.closest('.wl-cp-shown li[data-k]');
    if (!li) return;
    const k = li.dataset.k;
    if (e.target.closest('.wl-cp-rm')) return setCols(cols.filter((x) => x !== k));
    const mv = e.target.closest('.wl-cp-mv');
    if (mv) {
      const i = cols.indexOf(k);
      const j = i + Number(mv.dataset.mv);
      if (j < 0 || j >= cols.length) return;
      const next = cols.slice();
      [next[i], next[j]] = [next[j], next[i]];
      setCols(next, `li[data-k="${k}"] .wl-cp-mv[data-mv="${mv.dataset.mv}"]:not([disabled]), li[data-k="${k}"] .wl-cp-mv:not([disabled])`);
    }
  });

  if (active()) load();
  return { reload: load, poll };
}
