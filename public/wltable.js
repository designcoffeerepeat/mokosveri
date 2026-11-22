// One watchlist as a live, sortable, reorderable table card. Used by the
// Watchlist page and by the accordion on the home page.
import { esc, req } from './session.js';

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
// Sort value for the "Pre/After %" choice.
const withExt = (r) => {
  r.extPct = r.ext ? r.ext.changePct : null;
  return r;
};
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

const COLS = [
  { key: 'ticker', label: 'Ticker', num: false },
  { key: 'name', label: 'Name', num: false, cls: 'wl-name' },
  { key: 'price', label: 'Price', num: true },
  { key: 'change1d', label: 'Today', num: true },
  { key: 'ret1m', label: '1M', num: true, cls: 'wl-m' },
  { key: 'ret1y', label: '1Y', num: true, cls: 'wl-y' },
  { key: 'score', label: 'Score', num: true },
];

// Sort choice is remembered per list.
const sortKey = (id) => `wlSort:${id}`;
function readSort(id) {
  try {
    const s = JSON.parse(localStorage.getItem(sortKey(id)) || localStorage.getItem('wlSort'));
    if (s && (s.key === 'custom' || s.key === 'extPct' || COLS.some((c) => c.key === s.key))) return s;
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
  const active = opts.active || (() => true);

  root.innerHTML = `<div class="card wl-card">
      <div class="wl-bar">
        <form class="wl-add" autocomplete="off"><input type="text" maxlength="12" placeholder="Add a ticker, e.g. AAPL" aria-label="Add a ticker to this watchlist" spellcheck="false" /><button type="submit">Add</button></form>
        <div class="wl-live muted small" role="status"></div>
        <label class="wl-sort"><span class="muted small">Sort</span><select>${['<option value="custom">My order</option>', ...COLS.map((c) => `<option value="${c.key}">${c.label}</option>`), '<option value="extPct">Pre/After %</option>'].join('')}</select><button type="button" class="btn-ghost sm wl-dir" aria-label="Flip sort direction" title="Flip sort direction"></button></label>
      </div>
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
    $('.wl-sort select').value = sort.key;
    $('.wl-dir').textContent = sort.key === 'custom' ? '' : sort.dir > 0 ? 'Asc' : 'Desc';
    $('.wl-dir').hidden = sort.key === 'custom';
    $('.wl-foot').textContent = items.length
      ? `${items.length} of ${max} tickers. ${sort.key === 'custom' ? 'Drag the handle (or focus it and use the arrow keys) to reorder.' : 'Click a column again to flip it. Choose "My order" to drag and reorder.'} Scores marked ~ are quick estimates.`
      : '';
    if (!items.length) {
      table.innerHTML = '<div class="empty">This list is empty. Add a ticker above, or use "Add to watchlist" on any ticker page.</div>';
      return;
    }
    const custom = sort.key === 'custom';
    const arrow = (k) => (sort.key === k ? (sort.dir > 0 ? ' ▲' : ' ▼') : '');
    table.innerHTML = `<table class="wl"><thead><tr>
      <th class="wl-h" aria-label="Reorder"></th>
      ${COLS.map((c) => `<th class="${c.num ? 'num ' : ''}${c.cls || ''}" aria-sort="${sort.key === c.key ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-k="${c.key}">${c.label}${arrow(c.key)}</button></th>`).join('')}
      <th class="wl-sp">30 days</th><th aria-label="Remove"></th></tr></thead>
      <tbody>${sorted()
        .map((r) => {
          const est = r.scoreSource && r.scoreSource !== 'full';
          return `<tr data-t="${esc(r.ticker)}">
            <td class="wl-h">${custom ? `<button type="button" class="handle" aria-label="Move ${esc(r.ticker)}. Use arrow keys." title="Drag to reorder">⋮⋮</button>` : ''}</td>
            <td class="mono"><a href="#/t/${encodeURIComponent(r.ticker)}">${esc(r.ticker)}</a></td>
            <td class="wl-name">${esc(r.name || '')}</td>
            <td class="num" data-c="price">${r.pending ? '<span class="muted">loading</span>' : r.error ? '<span class="muted">n/a</span>' : `<span class="px">${fmtNum(r.price)}</span>${extPx(r.ext)}`}</td>
            <td class="num" data-c="chg">${r.price != null ? `<span class="px ${cls(r.change1d)}">${fmtPct(r.change1d, 2)}</span>${extCh(r.ext)}` : ''}</td>
            <td class="num wl-m ${cls(r.ret1m)}">${r.price != null ? fmtPct(r.ret1m) : ''}</td>
            <td class="num wl-y ${cls(r.ret1y)}">${r.price != null ? fmtPct(r.ret1y) : ''}</td>
            <td class="num">${r.score != null ? `<span class="pill ${pillCls(r.score)} wl-pill" title="${esc(scoreTitle(r))}">${est ? '~' : ''}${r.score > 0 ? '+' : ''}${r.score}</span>` : ''}</td>
            <td class="wl-sp">${spark(r.spark)}</td>
            <td><button type="button" class="rm" aria-label="Remove ${esc(r.ticker)}" title="Remove">&times;</button></td>
          </tr>`;
        })
        .join('')}</tbody></table>`;
  }

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
    if (!dragging && (sort.key === 'price' || sort.key === 'change1d' || sort.key === 'extPct')) paint();
    else
      for (const r of items) {
        const tr = table.querySelector(`tr[data-t="${CSS.escape(r.ticker)}"]`);
        if (!tr || r.price == null) continue;
        tr.querySelector('[data-c="price"]').innerHTML = `<span class="px">${fmtNum(r.price)}</span>${extPx(r.ext)}`;
        tr.querySelector('[data-c="chg"]').innerHTML = `<span class="px ${cls(r.change1d)}">${fmtPct(r.change1d, 2)}</span>${extCh(r.ext)}`;
      }
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
      const first = COLS.find((c) => c.key === k).num ? -1 : 1;
      if (sort.key !== k) sort = { key: k, dir: first };
      else if (sort.dir === first) sort = { key: k, dir: -first };
      else sort = { key: 'custom', dir: 1 };
      writeSort(listId, sort);
      paint();
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

  if (active()) load();
  return { reload: load, poll };
}
