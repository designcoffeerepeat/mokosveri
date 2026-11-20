// Accounts UI: #/login, #/signup, #/account (watchlist, password, admin).
import { esc, req, getMe, setMe, me, logout } from './session.js';
import { mountWatchTable } from './wltable.js';
import { openImport } from './csvimport.js';

const ago = (ms) => {
  if (!ms) return 'never';
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hr ago`;
  return `${Math.round(h / 24)} days ago`;
};
const dateStr = (ms) => (ms ? new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');
const hashParams = () => new URLSearchParams((location.hash.split('?')[1] || ''));

// ---------- Turnstile ----------
let tsLoad = null;
function loadTurnstile() {
  if (!tsLoad) {
    tsLoad = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      s.async = true;
      s.onload = () => resolve(window.turnstile);
      s.onerror = () => reject(new Error('Could not load the human check.'));
      document.head.appendChild(s);
    });
  }
  return tsLoad;
}
// Renders the widget into `el` when the site has Turnstile on. Returns a
// getter for the current token and a reset function.
async function mountTurnstile(el, siteKey) {
  let token = null;
  let id = null;
  if (!siteKey || !el) return { token: () => null, reset() {} };
  try {
    const ts = await loadTurnstile();
    const dark = document.documentElement.dataset.theme === 'dark' || (!document.documentElement.dataset.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    id = ts.render(el, { sitekey: siteKey, theme: dark ? 'dark' : 'light', callback: (t) => (token = t), 'expired-callback': () => (token = null) });
  } catch (e) {
    el.textContent = e.message;
  }
  return {
    token: () => token,
    reset() {
      token = null;
      try {
        if (id != null) window.turnstile.reset(id);
      } catch {}
    },
  };
}

const field = (id, label, attrs = '') => `<label class="fld"><span>${label}</span><input id="${id}" ${attrs} /></label>`;

// ---------- login ----------
export async function renderLogin(app) {
  document.title = 'Log in · Mokosveri';
  const next = hashParams().get('next') || '#/account';
  await getMe();
  if (me()) {
    location.hash = next;
    return;
  }
  const cfg = await req('GET', '/api/auth/config').catch(() => ({}));
  app.innerHTML = `<section class="auth-wrap"><div class="card auth-card">
    <h1>Log in</h1>
    <p class="muted">Log in to see your watchlist and keep your pinned tickers on every device.</p>
    <form id="loginForm" autocomplete="on">
      ${field('lgUser', 'Username', 'name="username" autocomplete="username" required maxlength="24" spellcheck="false" autocapitalize="off"')}
      ${field('lgPass', 'Password', 'name="password" type="password" autocomplete="current-password" required maxlength="200"')}
      <div class="ts" id="lgTs"></div>
      <div class="auth-err" id="lgErr" role="alert"></div>
      <button class="btn-primary" type="submit">Log in</button>
    </form>
    <p class="muted small">No account? Accounts are invite only. Ask the site owner for an invite link, then <a href="#/signup">sign up here</a>.</p>
  </div></section>`;
  const ts = await mountTurnstile(app.querySelector('#lgTs'), cfg.turnstileSiteKey);
  app.querySelector('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const err = app.querySelector('#lgErr');
    err.textContent = '';
    if (cfg.turnstileSiteKey && !ts.token()) {
      err.textContent = 'Please finish the human check first.';
      return;
    }
    btn.disabled = true;
    try {
      const d = await req('POST', '/api/auth/login', { username: app.querySelector('#lgUser').value, password: app.querySelector('#lgPass').value, turnstile: ts.token() });
      setMe(d.user);
      location.hash = next;
    } catch (ex) {
      err.textContent = ex.message;
      ts.reset();
      btn.disabled = false;
    }
  });
}

// ---------- signup ----------
export async function renderSignup(app) {
  document.title = 'Sign up · Mokosveri';
  await getMe();
  if (me()) {
    location.hash = '#/account';
    return;
  }
  const code = hashParams().get('code') || '';
  const cfg = await req('GET', '/api/auth/config').catch(() => ({}));
  if (cfg.full) {
    app.innerHTML = `<section class="auth-wrap"><div class="card auth-card"><h1>Sign ups are closed</h1><p class="muted">This site is limited to ${cfg.maxUsers} accounts and all of them are taken.</p><p><a href="#/login">Log in</a> if you already have an account.</p></div></section>`;
    return;
  }
  app.innerHTML = `<section class="auth-wrap"><div class="card auth-card">
    <h1>Create an account</h1>
    <p class="muted">Accounts are invite only${cfg.maxUsers ? `, and limited to ${cfg.maxUsers} people (${cfg.users} taken)` : ''}.</p>
    <form id="suForm" autocomplete="on">
      ${field('suCode', 'Invite code', `required maxlength="64" spellcheck="false" autocapitalize="off" value="${esc(code)}"`)}
      ${field('suUser', 'Username', 'name="username" autocomplete="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]{3,24}" spellcheck="false" autocapitalize="off"')}
      <div class="hint">3 to 24 letters, numbers or underscores.</div>
      ${field('suPass', 'Password', 'name="password" type="password" autocomplete="new-password" required minlength="8" maxlength="200"')}
      ${field('suPass2', 'Confirm password', 'type="password" autocomplete="new-password" required minlength="8" maxlength="200"')}
      <div class="ts" id="suTs"></div>
      <div class="auth-err" id="suErr" role="alert"></div>
      <button class="btn-primary" type="submit">Create account</button>
    </form>
    <p class="muted small">Already have one? <a href="#/login">Log in</a>.</p>
  </div></section>`;
  const ts = await mountTurnstile(app.querySelector('#suTs'), cfg.turnstileSiteKey);
  app.querySelector('#suForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    const err = app.querySelector('#suErr');
    err.textContent = '';
    const pw = app.querySelector('#suPass').value;
    if (pw !== app.querySelector('#suPass2').value) {
      err.textContent = 'The two passwords do not match.';
      return;
    }
    if (cfg.turnstileSiteKey && !ts.token()) {
      err.textContent = 'Please finish the human check first.';
      return;
    }
    btn.disabled = true;
    try {
      const d = await req('POST', '/api/auth/signup', { invite: app.querySelector('#suCode').value, username: app.querySelector('#suUser').value, password: pw, turnstile: ts.token() });
      setMe(d.user);
      location.hash = '#/account';
    } catch (ex) {
      err.textContent = ex.message;
      ts.reset();
      btn.disabled = false;
    }
  });
}

// ---------- account: named watchlists ----------
const CUR_KEY = 'wlCurrent';
const readCur = () => {
  try {
    return parseInt(localStorage.getItem(CUR_KEY), 10) || null;
  } catch {
    return null;
  }
};
const writeCur = (id) => {
  try {
    localStorage.setItem(CUR_KEY, String(id));
  } catch {}
};

export async function renderAccount(app) {
  document.title = 'Watchlists · Mokosveri';
  await getMe();
  const user = me();
  const toLogin = () => {
    setMe(null);
    location.hash = `#/login?next=${encodeURIComponent('#/account')}`;
  };
  if (!user) return toLogin();

  app.innerHTML = `<div class="acct-root">
    <section class="acct-head">
      <div><h1>Your watchlists</h1><div class="muted">Signed in as <b>${esc(user.username)}</b>${user.isAdmin ? ' · admin' : ''}</div></div>
      <button type="button" class="btn-ghost" id="logoutBtn">Log out</button>
    </section>
    <div class="wl-tabs-row">
      <div class="wl-tabs" id="wlTabs" role="tablist" aria-label="Your watchlists"></div>
      <div class="wl-tools" id="wlTools"></div>
    </div>
    <div class="auth-err" id="listErr" role="alert"></div>
    <div id="impBox"></div>
    <div id="wlSlot"></div>
    <div id="adminBox"></div>
    <h2 class="section">Change password</h2>
    <div class="card auth-card wide">
      <form id="pwForm">
        ${field('pwCur', 'Current password', 'type="password" autocomplete="current-password" required maxlength="200"')}
        ${field('pwNew', 'New password', 'type="password" autocomplete="new-password" required minlength="8" maxlength="200"')}
        <div class="auth-err" id="pwErr" role="alert"></div>
        <button class="btn-primary" type="submit">Update password</button>
      </form>
    </div></div>`;

  const root = app.querySelector('.acct-root');
  const $ = (s) => root.querySelector(s);
  const listErr = (m) => ($('#listErr').textContent = m || '');
  let lists = [];
  let maxLists = 10;
  let cur = parseInt(new URLSearchParams(location.hash.split('?')[1] || '').get('list'), 10) || readCur();
  let mode = null; // 'new' | 'rename' | 'delete'

  $('#logoutBtn').addEventListener('click', async () => {
    await logout();
    location.hash = '#/';
  });

  function paintTabs() {
    $('#wlTabs').innerHTML =
      lists
        .map(
          (l) => `<button type="button" role="tab" class="wl-tab${l.id === cur ? ' on' : ''}" aria-selected="${l.id === cur}" data-id="${l.id}">${esc(l.name)}<span class="wl-count">${l.count}</span></button>`
        )
        .join('') +
      (mode === 'new'
        ? `<form class="wl-inline" id="newForm"><input maxlength="40" placeholder="List name" aria-label="New list name" required /><button type="submit" class="btn-primary sm">Create</button><button type="button" class="btn-ghost sm" data-cancel>Cancel</button></form>`
        : lists.length < maxLists
          ? '<button type="button" class="wl-tab new" id="newBtn">+ New list</button>'
          : '');
    const l = lists.find((x) => x.id === cur);
    $('#wlTools').innerHTML = !l
      ? ''
      : mode === 'rename'
        ? `<form class="wl-inline" id="renForm"><input maxlength="40" value="${esc(l.name)}" aria-label="List name" required /><button type="submit" class="btn-primary sm">Save</button><button type="button" class="btn-ghost sm" data-cancel>Cancel</button></form>`
        : `<button type="button" class="btn-ghost sm" id="impBtn">Import CSV</button><button type="button" class="btn-ghost sm" id="renBtn">Rename</button>${lists.length > 1 ? `<button type="button" class="btn-ghost sm danger" id="delBtn">${mode === 'delete' ? `Really delete "${esc(l.name)}"?` : 'Delete list'}</button>` : ''}`;
    const f = root.querySelector('#newForm input, #renForm input');
    if (f) {
      f.focus();
      f.select();
    }
  }

  function show(id) {
    cur = id;
    writeCur(id);
    mode = null;
    paintTabs();
    mountWatchTable($('#wlSlot'), id, {
      onAuthLost: toLogin,
      onData: (d) => {
        if (d.lists) lists = d.lists;
        const l = lists.find((x) => x.id === d.list.id);
        if (l && d.list.count != null) l.count = d.list.count;
        if (l && d.items) l.count = d.items.length;
        paintTabs();
      },
    });
  }

  async function loadLists(pick) {
    try {
      const d = await req('GET', '/api/watchlists');
      lists = d.lists;
      maxLists = d.maxLists;
    } catch (e) {
      if (e.status === 401) return toLogin();
      listErr(e.message);
      return;
    }
    const want = pick || cur;
    show(lists.some((l) => l.id === want) ? want : lists[0].id);
  }

  root.addEventListener('click', async (e) => {
    const tab = e.target.closest('.wl-tab[data-id]');
    if (tab) {
      if (+tab.dataset.id !== cur) show(+tab.dataset.id);
      return;
    }
    if (e.target.closest('#newBtn')) {
      mode = 'new';
      return paintTabs();
    }
    if (e.target.closest('#impBtn')) {
      openImport($('#impBox'), { lists, current: cur, maxLists, onDone: (id) => loadLists(id) });
      $('#impBox').scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.target.closest('#renBtn')) {
      mode = 'rename';
      return paintTabs();
    }
    if (e.target.closest('[data-cancel]')) {
      mode = null;
      return paintTabs();
    }
    if (e.target.closest('#delBtn')) {
      if (mode !== 'delete') {
        mode = 'delete';
        paintTabs();
        setTimeout(() => mode === 'delete' && ((mode = null), paintTabs()), 4000);
        return;
      }
      try {
        await req('DELETE', `/api/watchlists/${cur}`);
        listErr('');
        mode = null;
        await loadLists(lists.find((l) => l.id !== cur).id);
      } catch (ex) {
        listErr(ex.message);
      }
    }
  });
  root.addEventListener('submit', async (e) => {
    if (e.target.id === 'newForm') {
      e.preventDefault();
      try {
        const d = await req('POST', '/api/watchlists', { name: e.target.querySelector('input').value });
        listErr('');
        mode = null;
        await loadLists(d.list.id);
      } catch (ex) {
        listErr(ex.message);
      }
    } else if (e.target.id === 'renForm') {
      e.preventDefault();
      try {
        const d = await req('PATCH', `/api/watchlists/${cur}`, { name: e.target.querySelector('input').value });
        const l = lists.find((x) => x.id === cur);
        if (l) l.name = d.name;
        listErr('');
        mode = null;
        paintTabs();
      } catch (ex) {
        listErr(ex.message);
      }
    }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && (mode === 'new' || mode === 'rename')) {
      mode = null;
      paintTabs();
    }
  });

  $('#pwForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const out = $('#pwErr');
    out.textContent = '';
    try {
      await req('POST', '/api/auth/password', { currentPassword: $('#pwCur').value, newPassword: $('#pwNew').value });
      e.target.reset();
      out.textContent = 'Password updated. Other devices were signed out.';
    } catch (ex) {
      out.textContent = ex.message;
    }
  });

  loadLists();
  if (user.isAdmin) renderAdmin($('#adminBox'));
}

// ---------- admin ----------
async function renderAdmin(box) {
  let d;
  try {
    d = await req('GET', '/api/auth/admin/overview');
  } catch (e) {
    box.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    return;
  }
  const now = Date.now();
  const status = (i) => (i.used_at ? `Used by ${esc(i.used_by || 'a deleted user')}` : i.expires_at && i.expires_at < now ? 'Expired' : `Open until ${dateStr(i.expires_at)}`);
  const link = (code) => `${location.origin}/#/signup?code=${encodeURIComponent(code)}`;
  box.innerHTML = `
    <h2 class="section">Members <small class="muted">${d.users.length} of ${d.maxUsers} accounts used</small></h2>
    <div class="card tbl-wrap"><table><thead><tr><th>Username</th><th class="num">Joined</th><th class="num">Last login</th><th class="num">Watching</th><th></th></tr></thead><tbody>
      ${d.users.map((u) => `<tr><td>${esc(u.username)}${u.is_admin ? ' <span class="tag plan">admin</span>' : ''}</td><td class="num">${dateStr(u.created_at)}</td><td class="num">${ago(u.last_login)}</td><td class="num">${u.watching}</td><td class="num">${u.is_admin ? '' : `<button type="button" class="btn-ghost sm danger" data-del="${u.id}" data-name="${esc(u.username)}">Delete</button>`}</td></tr>`).join('')}
    </tbody></table></div>

    <h2 class="section">Invites <small class="muted">each code works once</small></h2>
    <div class="card inv-card">
      <form id="invForm" class="inv-form">
        <label class="fld"><span>Note (who is it for?)</span><input id="invNote" maxlength="80" placeholder="Optional" /></label>
        <label class="fld sm"><span>Expires in</span><select id="invDays"><option value="1">1 day</option><option value="7" selected>7 days</option><option value="30">30 days</option></select></label>
        <button class="btn-primary" type="submit"${d.users.length >= d.maxUsers ? ' disabled title="All accounts are used"' : ''}>Create invite</button>
      </form>
      <div id="invNew"></div>
      <div class="auth-err" id="invErr" role="alert"></div>
      ${d.invites.length ? `<div class="tbl-wrap"><table><thead><tr><th>Code</th><th>Note</th><th>Status</th><th></th></tr></thead><tbody>
        ${d.invites.map((i) => {
          const open = !i.used_at && !(i.expires_at && i.expires_at < now);
          return `<tr><td class="mono">${esc(i.code)}</td><td>${esc(i.note || '')}</td><td>${status(i)}</td><td class="num">${open ? `<button type="button" class="btn-ghost sm" data-copy="${esc(link(i.code))}">Copy link</button> <button type="button" class="btn-ghost sm danger" data-revoke="${esc(i.code)}">Revoke</button>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>` : '<div class="empty">No invites yet.</div>'}
    </div>`;

  const copy = async (text, btn) => {
    try {
      await navigator.clipboard.writeText(text);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select and copy';
    }
  };

  box.querySelector('#invForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await req('POST', '/api/auth/admin/invites', { note: box.querySelector('#invNote').value, days: box.querySelector('#invDays').value });
      await renderAdmin(box);
      const nb = box.querySelector('#invNew');
      nb.innerHTML = `<div class="notice">New invite link (send it to one person): <input class="inv-link" readonly value="${esc(link(r.code))}" /> <button type="button" class="btn-ghost sm" data-copy="${esc(link(r.code))}">Copy</button></div>`;
      nb.querySelector('.inv-link').select();
    } catch (ex) {
      box.querySelector('#invErr').textContent = ex.message;
    }
  });

  if (box.dataset.wired) return;
  box.dataset.wired = '1';
  box.addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.copy) copy(b.dataset.copy, b);
    else if (b.dataset.revoke) {
      await req('DELETE', `/api/auth/admin/invites/${encodeURIComponent(b.dataset.revoke)}`).catch(() => {});
      renderAdmin(box);
    } else if (b.dataset.del) {
      // Two clicks to delete, no browser dialog.
      if (b.dataset.armed !== '1') {
        b.dataset.armed = '1';
        b.textContent = `Really delete ${b.dataset.name}?`;
        setTimeout(() => {
          if (b.isConnected) {
            b.dataset.armed = '';
            b.textContent = 'Delete';
          }
        }, 4000);
        return;
      }
      try {
        await req('DELETE', `/api/auth/admin/users/${b.dataset.del}`);
      } catch (ex) {
        box.querySelector('#invErr').textContent = ex.message;
      }
      renderAdmin(box);
    }
  });
}
