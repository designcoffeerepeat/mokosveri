// Shared login state for every page: who is signed in, JSON helpers, and the
// header account button. Other modules listen for the 'auth-change' event.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function req(method, path, body) {
  const opts = { method, headers: {}, credentials: 'same-origin' };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  const d = await r.json().catch(() => ({ error: 'Bad response' }));
  if (!r.ok) {
    const e = new Error(d.error || `Request failed (${r.status})`);
    e.status = r.status;
    throw e;
  }
  return d;
}

let mePromise = null;
let current = null;

export function getMe(force = false) {
  if (!mePromise || force) {
    mePromise = req('GET', '/api/auth/me')
      .then((d) => (current = d.user || null))
      .catch(() => (current = null));
  }
  return mePromise;
}

export function setMe(user) {
  current = user || null;
  mePromise = Promise.resolve(current);
  paintAccountButton();
  window.dispatchEvent(new CustomEvent('auth-change', { detail: current }));
}

export const me = () => current;

export async function logout() {
  try {
    await req('POST', '/api/auth/logout', {});
  } catch {}
  setMe(null);
}

// ---------- watchlist membership (used by the ticker page picker) ----------
// Adds an "Add to watchlist" button into `el` for `ticker`. It opens a menu of
// the user's lists with a checkbox each, plus a field to make a new list.
export async function mountWatchButton(el, ticker) {
  if (!el) return;
  await getMe();
  if (!current) {
    el.innerHTML = `<a class="watch-btn" href="#/login?next=${encodeURIComponent(`#/t/${ticker}`)}">${STAR} Log in to watch</a>`;
    return;
  }
  let lists = [];
  let open = false;
  let msg = '';
  const load = async () => {
    try {
      lists = (await req('GET', '/api/watchlist/tickers')).lists;
    } catch (e) {
      msg = e.message;
    }
  };
  await load();
  const onLists = () => lists.filter((l) => l.tickers.includes(ticker));

  const paint = () => {
    const n = onLists().length;
    const label = n === 0 ? 'Add to watchlist' : lists.length === 1 ? 'On your watchlist' : `On ${n} of ${lists.length} lists`;
    el.innerHTML = `<div class="watch-wrap">
      <button type="button" class="watch-btn${n ? ' on' : ''}" aria-haspopup="true" aria-expanded="${open}">${n ? STAR_FILLED : STAR} ${label} <span class="caret" aria-hidden="true">▾</span></button>
      ${open ? `<div class="watch-menu" role="menu">
        <div class="watch-menu-h">Save ${esc(ticker)} to</div>
        ${lists.map((l) => `<label class="watch-item" role="menuitemcheckbox" aria-checked="${l.tickers.includes(ticker)}"><input type="checkbox" data-id="${l.id}"${l.tickers.includes(ticker) ? ' checked' : ''} /><span>${esc(l.name)}</span><small>${l.tickers.length}</small></label>`).join('')}
        <form class="watch-new" autocomplete="off"><input maxlength="40" placeholder="New list name" aria-label="New list name" /><button type="submit">Create</button></form>
        <div class="watch-msg" role="status">${esc(msg)}</div>
      </div>` : ''}
    </div>`;
  };

  const close = (ev) => {
    // composedPath is fixed at dispatch, so it still holds el after a repaint.
    if (!open || (ev && ev.composedPath().includes(el))) return;
    open = false;
    paint();
  };
  document.addEventListener('click', (ev) => (el.isConnected ? close(ev) : document.removeEventListener('click', close)));
  el.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && open) {
      open = false;
      paint();
      el.querySelector('.watch-btn').focus();
    }
  });
  el.addEventListener('click', (ev) => {
    if (ev.target.closest('.watch-btn')) {
      open = !open;
      msg = '';
      paint();
      const first = el.querySelector('.watch-item input');
      if (open && first) first.focus();
    }
  });
  el.addEventListener('change', async (ev) => {
    const box = ev.target.closest('.watch-item input');
    if (!box) return;
    const id = +box.dataset.id;
    const l = lists.find((x) => x.id === id);
    box.disabled = true;
    try {
      if (box.checked) await req('POST', '/api/watchlist', { list: id, ticker });
      else await req('DELETE', `/api/watchlist/${encodeURIComponent(ticker)}?list=${id}`);
      if (box.checked) l.tickers.push(ticker);
      else l.tickers = l.tickers.filter((t) => t !== ticker);
      msg = '';
    } catch (e) {
      msg = e.message;
    }
    paint();
    const again = el.querySelector(`.watch-item input[data-id="${id}"]`);
    if (again) again.focus();
  });
  el.addEventListener('submit', async (ev) => {
    if (!ev.target.closest('.watch-new')) return;
    ev.preventDefault();
    const name = ev.target.querySelector('input').value.trim();
    if (!name) return;
    try {
      const d = await req('POST', '/api/watchlists', { name });
      await req('POST', '/api/watchlist', { list: d.list.id, ticker });
      await load();
      msg = `Saved to ${name}.`;
    } catch (e) {
      msg = e.message;
    }
    paint();
  });
  paint();
}

const STAR = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const STAR_FILLED = STAR.replace('fill="none"', 'fill="currentColor"');

// ---------- header account button ----------
function paintAccountButton() {
  const a = document.getElementById('acctBtn');
  if (!a) return;
  if (current) {
    a.href = '#/account';
    a.title = `Signed in as ${current.username}`;
    a.setAttribute('aria-label', `Your watchlist (signed in as ${current.username})`);
    a.innerHTML = `<span class="acct-initial">${esc(current.username.slice(0, 1).toUpperCase())}</span>`;
  } else {
    a.href = '#/login';
    a.title = 'Log in';
    a.setAttribute('aria-label', 'Log in');
    a.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><circle cx="12" cy="8.5" r="3.6" stroke="currentColor" stroke-width="2" fill="none"/><path d="M5 20c1.2-3.6 4-5.2 7-5.2s5.8 1.6 7 5.2" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>';
  }
}
getMe().then(paintAccountButton);
