// Home page accordion: one collapsible section per watchlist, each a live,
// sortable table. Which sections are open is remembered in this browser.
import { esc, req, getMe, me } from './session.js';
import { mountWatchTable } from './wltable.js';

const OPEN_KEY = 'homeListsOpen';
function readOpen() {
  try {
    const v = JSON.parse(localStorage.getItem(OPEN_KEY));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}
function writeOpen(state) {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify(state));
  } catch {}
}

export async function mountHomeLists(el) {
  await getMe();
  if (!me()) {
    el.innerHTML = `<div class="home-lists-cta muted small"><a href="#/login">Log in</a> to see your watchlists here.</div>`;
    return;
  }
  let lists;
  try {
    lists = (await req('GET', '/api/watchlists')).lists;
  } catch {
    el.innerHTML = '';
    return;
  }
  // First visit: open the first list, keep the rest closed.
  const state = readOpen() || { [lists[0].id]: true };

  el.innerHTML = `<div class="acc-head"><h2 class="section">Your watchlists</h2><a class="muted small" href="#/account">Manage lists</a></div>
    <div class="acc">${lists
      .map(
        (l) => `<details class="acc-item card" data-id="${l.id}"${state[l.id] ? ' open' : ''}>
          <summary><span class="acc-chev" aria-hidden="true"></span><span class="acc-name">${esc(l.name)}</span><span class="wl-count">${l.count}</span></summary>
          <div class="acc-body"></div>
        </details>`
      )
      .join('')}</div>`;

  for (const d of el.querySelectorAll('.acc-item')) {
    const id = +d.dataset.id;
    let table = null;
    const mount = () => {
      table = mountWatchTable(d.querySelector('.acc-body'), id, {
        active: () => d.open,
        onData: (data) => {
          const n = data.items ? data.items.length : data.list && data.list.count;
          if (n != null) d.querySelector('.wl-count').textContent = n;
        },
      });
    };
    if (d.open) mount();
    d.addEventListener('toggle', () => {
      state[id] = d.open;
      writeOpen(state);
      if (d.open) {
        if (!table) mount();
        else table.poll(); // catch up right away after being closed
      }
    });
  }
}
