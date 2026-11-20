// Home page sidebar: the signed-in user's watchlists as a compact accordion
// (ticker, price, today's change), with live prices for the open sections.
// Open sections and each list's sort are remembered in this browser.
import { esc, req, getMe, me } from './session.js';

const OPEN_KEY = 'homeListsOpen';
const SORT_KEY = 'homeListsSort';
const load = (k) => {
  try {
    const v = JSON.parse(localStorage.getItem(k));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};
const save = (k, v) => {
  try {
    localStorage.setItem(k, JSON.stringify(v));
  } catch {}
};
const fmt = (v) => (v == null || !isFinite(v) ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

// Sort cycles per column: first direction, flipped, then back to the list's own order.
const COLS = [
  { key: 'ticker', label: 'Ticker', first: 1 },
  { key: 'price', label: 'Price', first: -1 },
  { key: 'change1d', label: 'Chg', first: -1 },
];

export async function mountHomeLists(el) {
  await getMe();
  if (!me()) {
    el.innerHTML = `<div class="side-card card"><div class="side-h">Watchlists</div><p class="side-cta muted"><a href="#/login">Log in</a> to keep your watchlists here with live prices.</p></div>`;
    return;
  }
  let lists;
  try {
    lists = (await req('GET', '/api/watchlist/tickers')).lists;
  } catch {
    el.innerHTML = '';
    return;
  }
  const open = load(OPEN_KEY) || { [lists[0].id]: true }; // first visit: first list open
  const sorts = load(SORT_KEY) || {};
  const quotes = new Map(); // ticker -> { price, change1d }
  let meta = {};
  let timer = null;

  el.innerHTML = `<div class="side-card card">
    <div class="side-h"><span>Watchlists</span><span class="side-live muted" role="status"></span><a href="#/account" class="muted">Manage</a></div>
    ${lists
      .map(
        (l) => `<details class="side-item" data-id="${l.id}"${open[l.id] ? ' open' : ''}>
          <summary><span class="acc-chev" aria-hidden="true"></span><span class="acc-name">${esc(l.name)}</span><span class="wl-count">${l.tickers.length}</span></summary>
          <div class="side-body"></div>
        </details>`
      )
      .join('')}
  </div>`;

  const rows = (l) => {
    const s = sorts[l.id];
    const list = l.tickers.map((t) => ({ ticker: t, ...(quotes.get(t) || {}) }));
    if (s) {
      list.sort((a, b) => {
        const x = a[s.key];
        const y = b[s.key];
        if (x == null) return 1;
        if (y == null) return -1;
        return (typeof x === 'string' ? x.localeCompare(y) : x - y) * s.dir;
      });
    }
    return list;
  };

  function paint(l, moved = new Map()) {
    const body = el.querySelector(`.side-item[data-id="${l.id}"] .side-body`);
    if (!body) return;
    if (!l.tickers.length) {
      body.innerHTML = '<p class="side-empty muted">Empty. Add tickers from any ticker page.</p>';
      return;
    }
    const s = sorts[l.id];
    const arrow = (k) => (s && s.key === k ? (s.dir > 0 ? ' ▲' : ' ▼') : '');
    body.innerHTML = `<table class="side-tbl"><thead><tr>${COLS.map(
      (c) => `<th${c.key === 'ticker' ? '' : ' class="num"'} aria-sort="${s && s.key === c.key ? (s.dir > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th-btn" data-k="${c.key}">${c.label}${arrow(c.key)}</button></th>`
    ).join('')}</tr></thead><tbody>${rows(l)
      .map((r) => {
        const f = moved.has(r.ticker) ? (moved.get(r.ticker) ? ' flash-up' : ' flash-down') : '';
        return `<tr><td class="mono"><a href="#/t/${encodeURIComponent(r.ticker)}">${esc(r.ticker)}</a></td><td class="num${f}">${r.price != null ? fmt(r.price) : '<span class="muted">...</span>'}</td><td class="num ${cls(r.change1d)}${f}">${pct(r.change1d)}</td></tr>`;
      })
      .join('')}</tbody></table>`;
  }

  function paintLive() {
    const s = el.querySelector('.side-live');
    if (!s || !meta.at) return;
    const live = meta.market === 'open';
    s.innerHTML = `<span class="live-dot${live ? ' on' : ''}"></span>${live ? 'Live' : meta.market ? esc(meta.market) : ''}`;
    s.title = `Updated ${new Date(meta.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}. Quotes from Yahoo Finance, some may be delayed.`;
  }

  async function refresh() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    const openLists = lists.filter((l) => el.querySelector(`.side-item[data-id="${l.id}"]`).open && l.tickers.length);
    if (document.visibilityState !== 'hidden' && openLists.length) {
      const results = await Promise.all(openLists.map((l) => req('GET', `/api/watchlist/live?list=${l.id}`).catch(() => null)));
      results.forEach((d, i) => {
        if (!d) return;
        meta = { refreshSec: d.refreshSec, market: d.market, at: d.at };
        const moved = new Map();
        for (const q of d.items) {
          const old = quotes.get(q.ticker);
          if (old && old.price != null && old.price !== q.price) moved.set(q.ticker, q.price > old.price);
          quotes.set(q.ticker, { price: q.price, change1d: q.change1d });
        }
        paint(openLists[i], moved);
      });
      paintLive();
    }
    if (el.isConnected) timer = setTimeout(refresh, (meta.refreshSec || 60) * 1000);
  }

  for (const l of lists) paint(l);

  el.addEventListener('toggle', (e) => {
    const d = e.target.closest && e.target.closest('.side-item');
    if (!d) return;
    open[d.dataset.id] = d.open;
    save(OPEN_KEY, open);
    if (d.open) refresh();
  }, true); // toggle does not bubble, so listen in the capture phase

  el.addEventListener('click', (e) => {
    const th = e.target.closest('.th-btn');
    if (!th) return;
    const id = +th.closest('.side-item').dataset.id;
    const col = COLS.find((c) => c.key === th.dataset.k);
    const s = sorts[id];
    if (!s || s.key !== col.key) sorts[id] = { key: col.key, dir: col.first };
    else if (s.dir === col.first) sorts[id] = { key: col.key, dir: -col.first };
    else delete sorts[id];
    save(SORT_KEY, sorts);
    paint(lists.find((l) => l.id === id));
  });

  const onVisible = () => {
    if (!el.isConnected) return document.removeEventListener('visibilitychange', onVisible);
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  refresh();
}
