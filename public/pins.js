// Pinned ticker strip under the header on every page. Up to 6 tickers with
// live price and daily change. Saved in this browser when logged out, and to
// the account when logged in (local pins move to the account on first login).
import { esc, req, getMe, me } from './session.js';

const MAX = 6;
const KEY = 'pins';
const DEFAULTS = ['SPY', 'QQQ', 'IWM', 'VIX'];
const bar = document.getElementById('pins');
const IDX = { '^VIX': 'VIX', '^GSPC': 'SPX', '^DJI': 'DJI', '^NDX': 'NDX', '^IXIC': 'IXIC', '^RUT': 'RUT', '^TNX': 'TNX' };
const clean = (t) => {
  const s = String(t || '').trim().toUpperCase().replace(/^\$/, '');
  if (IDX[s]) return IDX[s];
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) || /^\^[A-Z0-9.]{1,10}$/.test(s) ? s : null;
};

let pins = [];
let quotes = new Map();
let editing = false;
let timer = null;
let every = 60; // seconds between refreshes; the server says 15 while the market is open

function readLocal() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw == null) return null;
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a.map(clean).filter(Boolean).slice(0, MAX) : null;
  } catch {
    return null;
  }
}
function writeLocal(list) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {}
}

async function load() {
  await getMe();
  const local = readLocal();
  if (me()) {
    try {
      const { pins: saved } = await req('GET', '/api/pins');
      if (saved == null) {
        // First login on this account: keep whatever this browser had.
        pins = local || DEFAULTS.slice();
        await req('PUT', '/api/pins', { pins });
      } else pins = saved;
      writeLocal(pins);
    } catch {
      pins = local || DEFAULTS.slice();
    }
  } else pins = local || DEFAULTS.slice();
  render();
  refresh();
}

async function save() {
  writeLocal(pins);
  if (me()) {
    try {
      await req('PUT', '/api/pins', { pins });
    } catch {}
  }
}

async function refresh(tries = 0) {
  clearTimeout(timer);
  if (pins.length && document.visibilityState !== 'hidden') {
    try {
      const d = await req('GET', `/api/quotes?t=${pins.map(encodeURIComponent).join(',')}`);
      const moved = [];
      for (const q of d.items) {
        const old = quotes.get(q.ticker);
        const was = old && (old.ext ? old.ext.price : old.price);
        const now = q.ext ? q.ext.price : q.price;
        if (was != null && now != null && was !== now) moved.push([q.ticker, now > was]);
        quotes.set(q.ticker, q);
      }
      if (d.refreshSec) every = d.refreshSec;
      if (!editing) {
        render();
        for (const [t, up] of moved) {
          const a = bar.querySelector(`a.pin[data-t="${CSS.escape(t)}"]`);
          if (a) a.classList.add(up ? 'flash-up' : 'flash-down');
        }
      }
      if (d.items.some((q) => q.pending) && tries < 3) {
        timer = setTimeout(() => refresh(tries + 1), 1500);
        return;
      }
    } catch {}
  }
  timer = setTimeout(refresh, every * 1000);
}

const fmt = (v) => (v == null || !isFinite(v) ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const pct = (v) => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);

function chip(t) {
  const q = quotes.get(t) || {};
  const c = q.change1d > 0 ? 'up' : q.change1d < 0 ? 'down' : '';
  const x = q.ext;
  const xc = x ? (x.changePct > 0 ? 'up' : x.changePct < 0 ? 'down' : '') : '';
  const ext = x ? `<span class="pin-ext"><span class="ext-tag ext-${x.session}">${x.session === 'pre' ? 'Pre' : 'AH'}</span><span class="${xc}">${pct(x.changePct)}</span></span>` : '';
  const body = q.price != null ? `<span class="pin-px">${fmt(q.price)}</span><span class="pin-ch ${c}">${pct(q.change1d)}</span>${ext}` : `<span class="pin-px muted">${q.error ? 'n/a' : '...'}</span>`;
  const title = x ? `${q.name || t}. ${x.session === 'pre' ? 'Pre-market' : 'After hours'} ${fmt(x.price)} (${pct(x.changePct)} vs the last close)` : q.name || t;
  return `<a class="pin" data-t="${esc(t)}" href="#/t/${encodeURIComponent(t)}" title="${esc(title)}"><b>${esc(t)}</b>${body}</a>`;
}

function render() {
  if (!bar) return;
  if (editing) {
    bar.innerHTML = `<div class="wrap pins-inner editing">
      ${pins.map((t) => `<span class="pin edit"><b>${esc(t)}</b><button type="button" class="pin-x" data-t="${esc(t)}" aria-label="Remove ${esc(t)}">&times;</button></span>`).join('')}
      ${pins.length < MAX ? `<form class="pin-add" autocomplete="off"><input type="text" maxlength="10" placeholder="Add ticker" aria-label="Add a ticker to pin" spellcheck="false" /><button type="submit">Add</button></form>` : `<span class="muted pin-note">${MAX} max</span>`}
      <button type="button" class="pin-done">Done</button>
      <span class="pin-msg muted" role="status"></span>
    </div>`;
    const input = bar.querySelector('.pin-add input');
    if (input) input.focus();
    return;
  }
  bar.innerHTML = `<div class="wrap pins-inner">
    ${pins.length ? pins.map(chip).join('') : '<span class="muted pin-note">Pin up to 6 tickers here for quick prices.</span>'}
    <button type="button" class="pin-edit" aria-label="Edit pinned tickers" title="Edit pinned tickers"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16v4z" stroke="currentColor" stroke-width="2" fill="none" stroke-linejoin="round"/></svg>${pins.length ? '' : '<span>Add</span>'}</button>
  </div>`;
}

if (bar) {
  bar.addEventListener('click', async (e) => {
    if (e.target.closest('.pin-edit')) {
      editing = true;
      render();
    } else if (e.target.closest('.pin-done')) {
      editing = false;
      render();
      refresh();
    } else if (e.target.closest('.pin-x')) {
      pins = pins.filter((t) => t !== e.target.closest('.pin-x').dataset.t);
      await save();
      render();
    }
  });
  bar.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = bar.querySelector('.pin-add input');
    const t = clean(input && input.value);
    const msg = bar.querySelector('.pin-msg');
    if (!t) {
      if (msg) msg.textContent = 'That does not look like a ticker.';
      return;
    }
    if (!pins.includes(t) && pins.length < MAX) pins.push(t);
    await save();
    render();
  });
  bar.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && editing) {
      editing = false;
      render();
      refresh();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh();
  });
  window.addEventListener('auth-change', load);
  load();
}
