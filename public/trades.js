// Full trades page (#/trades/insiders, #/trades/purchases, #/trades/congress).
// Trades are grouped by company, by insider or by member of Congress, one row
// each, and a row expands to that group's individual trades. The home page
// reuses the Congress grouping. Pure helpers are exported for the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (v) => {
  if (v == null || !isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const shortDate = (d) => (d ? new Date(d.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const qtyFmt = (n) => (n ? Math.round(n).toLocaleString('en-US') : '');
const pxFmt = (n) => (n ? `$${Number(n).toFixed(2)}` : '');
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : '');
const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;
export const CSUITE = /CEO|Chief Exec|CFO|Chief Fin|Pres|Chair|COO|Chief Oper/i;

export const TABS = {
  insiders: 'Insider buys by company',
  purchases: 'Insider buys by person',
  congress: 'Congress trades by member',
};

// ---------- grouping ----------
// Same person spelled slightly differently ("Smith, John" and "Smith John A")
// counts once: lower case, letters only, first two words.
export const personKey = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).slice(0, 2).join(' ');
const memberKey = (s) => String(s || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
const byNewest = (k1, k2) => (a, b) => (b[k1] || '').localeCompare(a[k1] || '') || (b[k2] || '').localeCompare(a[k2] || '');
const rankTickers = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(r.ticker, (m.get(r.ticker) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map((x) => x[0]);
};

export function groupCongress(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const k = memberKey(r.member) || 'unknown';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by.entries()]
    .map(([k, trades]) => {
      trades.sort(byNewest('filedDate', 'txDate'));
      const f = trades[0];
      return {
        key: `c:${k}`,
        member: f.member || 'Unknown member',
        chamber: f.chamber || '',
        party: f.party || '',
        items: trades,
        n: trades.length,
        buys: trades.filter((t) => t.type === 'buy').length,
        sells: trades.filter((t) => t.type === 'sell').length,
        amountMin: trades.reduce((s, t) => s + (t.amountMin || 0), 0),
        tickers: rankTickers(trades),
        latest: f.filedDate || f.txDate || '',
      };
    })
    .sort((a, b) => b.latest.localeCompare(a.latest) || b.n - a.n);
}

export function groupPeople(rows) {
  const by = new Map();
  for (const r of rows || []) {
    const k = personKey(r.owner) || 'unknown';
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  return [...by.entries()]
    .map(([k, trades]) => {
      trades.sort(byNewest('date', 'filed'));
      const f = trades[0];
      return {
        key: `p:${k}`,
        owner: f.owner || 'Unknown insider',
        title: f.title || '',
        company: f.company || '',
        items: trades,
        n: trades.length,
        value: trades.reduce((s, t) => s + (t.value || 0), 0),
        tickers: rankTickers(trades),
        csuite: trades.some((t) => CSUITE.test(t.title || '')),
        latest: f.date || '',
      };
    })
    .sort((a, b) => b.value - a.value);
}

// ---------- columns ----------
const tickChips = (tickers, max = 4) =>
  `<span class="gp-ticks">${tickers
    .slice(0, max)
    .map((t) => `<a class="chip mono" href="#/t/${encodeURIComponent(t)}">${esc(t)}</a>`)
    .join('')}${tickers.length > max ? `<span class="muted small">+${tickers.length - max}</span>` : ''}</span>`;
const bs = (g) => `${g.buys ? `<span class="tag buy">${g.buys} buy${g.buys > 1 ? 's' : ''}</span>` : ''}${g.sells ? `<span class="tag sell">${g.sells} sell${g.sells > 1 ? 's' : ''}</span>` : ''}${g.n - g.buys - g.sells > 0 ? `<span class="tag plan">${g.n - g.buys - g.sells} other</span>` : ''}`;
const caret = '<span class="gp-caret" aria-hidden="true"></span>';

// [key, label, class, sort value, cell html]
export const COLS = {
  insiders: [
    ['ticker', 'Ticker', '', (g) => g.ticker, (g) => `${caret}<a class="mono" href="#/t/${encodeURIComponent(g.ticker)}">${esc(g.ticker)}</a>`],
    ['issuer', 'Company', '', (g) => (g.issuer || '').toLowerCase(), (g) => `${esc(g.issuer || '')}<div class="muted tr-sub" title="${esc(g.owners || '')}">${esc(g.owners || '')}</div>`],
    ['buyers', 'Insiders', 'num', (g) => g.buyers, (g) => g.buyers],
    ['trades', 'Buys', 'num', (g) => g.trades || 0, (g) => g.trades || ''],
    ['total_value', 'Total bought', 'num', (g) => g.total_value || 0, (g) => money(g.total_value)],
    ['csuite', 'C-suite', '', (g) => g.csuite || 0, (g) => (g.csuite ? '<span class="tag buy">C-suite</span>' : '')],
    ['last_date', 'Latest', 'num', (g) => g.last_date || '', (g) => shortDate(g.last_date)],
  ],
  purchases: [
    ['owner', 'Insider', '', (g) => g.owner.toLowerCase(), (g) => `${caret}<b class="gp-name">${esc(g.owner)}</b><div class="muted tr-sub">${esc(g.title || '')}</div>`],
    ['tickers', 'Companies', '', (g) => g.tickers.length, (g) => tickChips(g.tickers)],
    ['n', 'Buys', 'num', (g) => g.n, (g) => g.n],
    ['value', 'Total bought', 'num', (g) => g.value, (g) => money(g.value)],
    ['csuite', 'C-suite', '', (g) => (g.csuite ? 1 : 0), (g) => (g.csuite ? '<span class="tag buy">C-suite</span>' : '')],
    ['latest', 'Latest', 'num', (g) => g.latest, (g) => shortDate(g.latest)],
  ],
  congress: [
    ['member', 'Member', '', (g) => g.member.toLowerCase(), (g) => `${caret}<b class="gp-name">${esc(g.member)}</b><div class="muted tr-sub">${esc([cap(g.chamber), cap(g.party)].filter(Boolean).join(' · '))}</div>`],
    ['n', 'Trades', '', (g) => g.n, (g) => `<span class="gp-bs">${bs(g)}</span>`],
    ['tickers', 'Tickers', '', (g) => g.tickers.length, (g) => tickChips(g.tickers)],
    ['amountMin', 'Total, at least', 'num', (g) => g.amountMin, (g) => money(g.amountMin)],
    ['latest', 'Last disclosed', 'num', (g) => g.latest, (g) => shortDate(g.latest)],
  ],
};

// Each group's own trades, shown when the row is expanded.
const SUB = {
  insiders: [['Insider', ''], ['Title', ''], ['Shares', 'num'], ['Price', 'num'], ['Value', 'num'], ['Stake change', 'num'], ['Traded', 'num'], ['Filed', 'num']],
  purchases: [['Ticker', ''], ['Company', ''], ['Title', ''], ['Shares', 'num'], ['Price', 'num'], ['Value', 'num'], ['Stake change', 'num'], ['Traded', 'num'], ['Filed', 'num']],
  congress: [['Ticker', ''], ['Type', ''], ['Amount', 'num'], ['Traded', 'num'], ['Disclosed', 'num']],
};
// Every insider row is a Form 4 code P purchase; flag the ones made under a 10b5-1 plan.
const planTag = (r) => (r.plan10b5 ? ' <span class="tag plan" title="Made under a pre-scheduled Rule 10b5-1 trading plan">10b5-1</span>' : '');
function subCells(tab, r) {
  const tk = `<td><a class="mono" href="#/t/${encodeURIComponent(r.ticker)}">${esc(r.ticker)}</a></td>`;
  const buy = `<td class="num">${qtyFmt(r.qty)}</td><td class="num">${pxFmt(r.price)}</td><td class="num">${money(r.value)}</td><td class="num">${esc(r.deltaOwn || '')}</td><td class="num">${shortDate(r.date)}</td><td class="num">${shortDate(r.filed)}</td>`;
  if (tab === 'insiders') return `<td>${esc(r.owner)}${planTag(r)}</td><td class="tr-title">${esc(r.title || '')}</td>${buy}`;
  if (tab === 'purchases') return `${tk.replace('</td>', `${planTag(r)}</td>`)}<td class="tr-title">${esc(r.company || '')}</td><td class="tr-title">${esc(r.title || '')}</td>${buy}`;
  return `${tk}<td><span class="tag ${r.type === 'buy' ? 'buy' : r.type === 'sell' ? 'sell' : 'plan'}">${esc(r.type || '')}</span></td><td class="num">${esc(r.amount || '')}</td><td class="num">${shortDate(r.txDate)}</td><td class="num">${shortDate(r.filedDate)}</td>`;
}
const subTable = (tab, trades) =>
  `<table class="gp-sub"><thead><tr>${SUB[tab].map(([l, c]) => `<th class="${c}">${l}</th>`).join('')}</tr></thead><tbody>${trades
    .map((r) => `<tr class="click" data-t="${esc(r.ticker)}">${subCells(tab, r)}</tr>`)
    .join('')}</tbody></table>`;

export const DEFAULT_SORT = { insiders: ['buyers', false], purchases: ['value', false], congress: ['latest', false] };
export const MIN_VALUES = [[0, 'Any size'], [100e3, '$100K+'], [1e6, '$1M+'], [10e6, '$10M+']];
const PAGE = 100;

// ---------- filters ----------
const hay = (tab, r) =>
  (tab === 'insiders' ? [r.ticker, r.issuer, r.owners] : tab === 'purchases' ? [r.ticker, r.company, r.owner, r.title] : [r.ticker, r.member]).join(' ').toLowerCase();
const matchQ = (tab, r, q) => !q || q.split(/\s+/).every((w) => hay(tab, r).includes(w));

// Placeholder tickers some filers use (N/A, NONE) are never shown.
const REAL_TICKER = /^(?!NONE$)[A-Z][A-Z0-9.\-]{0,9}$/;

// Filters apply to single trades (or companies), before grouping.
export function filterRows(tab, rows, st) {
  const q = (st.q || '').trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (!REAL_TICKER.test(r.ticker || '')) return false;
    if (!matchQ(tab, r, q)) return false;
    if (tab === 'insiders') {
      if (st.min && (r.total_value || 0) < st.min) return false;
      if (st.csuite && !r.csuite) return false;
      if (st.cluster && r.buyers < 3) return false;
    } else if (tab === 'purchases') {
      if (st.csuite && !CSUITE.test(r.title || '')) return false;
    } else {
      if (st.type && st.type !== 'all' && r.type !== st.type) return false;
      if (st.chamber && st.chamber !== 'all' && cap(r.chamber) !== st.chamber) return false;
      if (st.party && st.party !== 'all' && cap(r.party).charAt(0) !== st.party) return false;
    }
    return true;
  });
}

export function sortRows(tab, rows, key, asc) {
  const col = COLS[tab].find((c) => c[0] === key) || COLS[tab].find((c) => c[0] === DEFAULT_SORT[tab][0]);
  const f = col[3];
  return [...rows].sort((a, b) => {
    const x = f(a), y = f(b);
    const c = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
    return asc ? c : -c;
  });
}

// The groups shown for a tab: filter trades, group, then filter and sort groups.
// For companies, `byTicker` maps each ticker to its individual purchases.
export function viewGroups(tab, d, st) {
  let groups;
  if (tab === 'insiders') {
    const byTicker = new Map();
    for (const r of d.purchases || []) {
      if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, []);
      byTicker.get(r.ticker).push(r);
    }
    groups = filterRows(tab, d.companies, st).map((g) => ({ ...g, key: `t:${g.ticker}`, items: (byTicker.get(g.ticker) || []).sort(byNewest('date', 'filed')) }));
  } else if (tab === 'purchases') {
    groups = groupPeople(filterRows(tab, d.purchases, st)).filter((g) => !st.min || g.value >= st.min);
  } else groups = groupCongress(filterRows(tab, d.congress, st));
  return sortRows(tab, groups, st.sort, st.asc);
}

// One <tbody> per group: the summary row plus a hidden row with its trades.
// opts: sortable (header buttons), open (Set of expanded keys), cols (column
// keys to show), extraFrom (groups from this index get the xp-extra class).
export function tableHtml(tab, groups, st, limit = PAGE, opts = {}) {
  if (!groups.length) return '<div class="empty">No trades match these filters.</div>';
  const { sortable = true, open = new Set(), cols = null, extraFrom = Infinity } = opts;
  const C = cols ? COLS[tab].filter((c) => cols.includes(c[0])) : COLS[tab];
  const th = C.map(([k, l, c]) => {
    if (!sortable) return `<th class="${c}">${esc(l)}</th>`;
    const on = st.sort === k;
    return `<th class="${c}" aria-sort="${on ? (st.asc ? 'ascending' : 'descending') : 'none'}"><button type="button" class="dv-th${on ? ' on' : ''}" data-sort="${k}">${esc(l)}${on ? (st.asc ? ' ▲' : ' ▼') : ''}</button></th>`;
  }).join('');
  const body = groups
    .slice(0, limit)
    .map((g, i) => {
      const o = open.has(g.key);
      const trades = g.items || [];
      return `<tbody class="gp${i >= extraFrom ? ' xp-extra' : ''}"><tr class="gp-row${o ? ' open' : ''}" data-g="${esc(g.key)}" tabindex="0" aria-expanded="${o}" title="${trades.length ? `Show ${plural(trades.length, 'trade')}` : ''}">${C.map(([, , c, , cell]) => `<td class="${c}">${cell(g)}</td>`).join('')}</tr><tr class="gp-detail"${o ? '' : ' hidden'}><td colspan="${C.length}">${trades.length ? subTable(tab, trades) : '<div class="empty">No individual trades on file.</div>'}</td></tr></tbody>`;
    })
    .join('');
  return `<table class="tr-tbl gp-tbl"><thead><tr>${th}</tr></thead>${body}</table>`;
}

// Click and keyboard handling for a grouped table: a group row toggles its
// trades, a trade row opens the ticker, and links work as links.
export function bindGroups(el, open = new Set()) {
  const toggle = (row) => {
    const det = row.nextElementSibling;
    const on = det.hidden;
    det.hidden = !on;
    row.classList.toggle('open', on);
    row.setAttribute('aria-expanded', String(on));
    if (on) open.add(row.dataset.g);
    else open.delete(row.dataset.g);
  };
  el.addEventListener('click', (e) => {
    if (e.target.closest('a, [data-sort]')) return;
    const row = e.target.closest('tr.gp-row');
    if (row) return toggle(row);
    const tr = e.target.closest('tr[data-t]');
    if (tr) location.hash = `#/t/${encodeURIComponent(tr.dataset.t)}`;
  });
  el.addEventListener('keydown', (e) => {
    const row = e.target.closest && e.target.closest('tr.gp-row');
    if (row && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      toggle(row);
    }
  });
  return open;
}

// Home page Congress table: one row per member, newest disclosure first.
export function homeCongressHtml(rows, show = 10) {
  const groups = groupCongress(rows);
  return { count: groups.length, html: tableHtml('congress', groups, {}, Infinity, { sortable: false, extraFrom: show }) };
}

// ---------- page ----------
const STORE = 'mk:trades:v2';
function loadState() {
  try {
    return JSON.parse(sessionStorage.getItem(STORE)) || {};
  } catch {
    return {};
  }
}
function saveState(all) {
  try {
    sessionStorage.setItem(STORE, JSON.stringify(all));
  } catch {}
}
const freshState = (tab) => ({ q: '', min: 0, csuite: false, cluster: false, type: 'all', chamber: 'all', party: 'all', sort: DEFAULT_SORT[tab][0], asc: DEFAULT_SORT[tab][1] });

export function tabFromHash(hash) {
  const m = String(hash || '').match(/^#\/trades\/(\w+)/);
  return m && TABS[m[1]] ? m[1] : 'insiders';
}

function controls(tab, st) {
  const seg = (k, opts) => `<div class="ev-seg" role="group" data-k="${k}">${opts.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${st[k] === v}">${esc(l)}</button>`).join('')}</div>`;
  const search = `<label class="tr-search"><svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg><input id="trQ" type="search" placeholder="${tab === 'congress' ? 'Ticker or member' : 'Ticker, company or insider'}" value="${esc(st.q)}" autocomplete="off" aria-label="Search trades" /></label>`;
  if (tab === 'congress')
    return `${search}${seg('type', [['all', 'All'], ['buy', 'Buys'], ['sell', 'Sells']])}
      <label class="ev-sel"><span class="small muted">Chamber</span><select data-k="chamber"><option value="all">Both</option>${['House', 'Senate'].map((c) => `<option${st.chamber === c ? ' selected' : ''}>${c}</option>`).join('')}</select></label>
      <label class="ev-sel"><span class="small muted">Party</span><select data-k="party"><option value="all">All</option>${[['D', 'Democrat'], ['R', 'Republican'], ['I', 'Independent']].map(([v, l]) => `<option value="${v}"${st.party === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`;
  return `${search}
    <label class="ev-sel"><span class="small muted">Total bought</span><select data-k="min" data-num="1">${MIN_VALUES.map(([v, l]) => `<option value="${v}"${st.min === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="tr-check"><input type="checkbox" data-k="csuite"${st.csuite ? ' checked' : ''} /> C-suite only</label>
    ${tab === 'insiders' ? `<label class="tr-check"><input type="checkbox" data-k="cluster"${st.cluster ? ' checked' : ''} /> 3+ insiders</label>` : ''}`;
}

const NOUN = { insiders: ['company', 'companies'], purchases: ['insider', 'insiders'], congress: ['member', 'members'] };

export async function renderTrades(app, api) {
  const tab = tabFromHash(location.hash);
  document.title = 'Insider and Congress trades · Mokosveri';
  const hero = `<section class="hero"><h1>Insider and Congress trades</h1><p>Every open market insider purchase made with the insider's own cash (SEC Form 4, code P, at a real price; grants, bonuses, option exercises and RSU conversions are left out) and every Congress trade disclosed under the STOCK Act in the window, one row per company, insider or member. Tap a row to see its trades, a ticker to open its breakdown, or a column to sort.</p>`;
  app.innerHTML = `${hero}</section><div class="loading"><div class="spinner"></div>Loading every insider purchase and Congress trade…</div>`;
  let d;
  try {
    d = await api('/api/trades');
  } catch (e) {
    app.innerHTML = `<div class="err"><h2>Could not load trades</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  if (tabFromHash(location.hash) !== tab) return;
  const all = loadState();
  const st = { ...freshState(tab), ...(all[tab] || {}) };
  let limit = PAGE;
  const open = new Set();
  const span = tab === 'congress' ? `Disclosed in the last ${d.congressDays} days` : `Traded in the last ${d.insiderDays} days`;
  const counts = { insiders: (d.companies || []).length, purchases: groupPeople(d.purchases).length, congress: groupCongress(d.congress).length };
  const total = viewGroups(tab, d, freshState(tab)).length;

  app.innerHTML = `${hero}<div class="meta-line">Updated ${esc(new Date(d.updated).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))} · ${span}</div></section>
    <nav class="tr-tabs" aria-label="Trade lists">${Object.entries(TABS).map(([k, l]) => `<a href="#/trades/${k}"${k === tab ? ' aria-current="page"' : ''}>${esc(l)} <span class="tr-n">${counts[k]}</span></a>`).join('')}</nav>
    <div class="ev-bar tr-bar">${controls(tab, st)}</div>
    <div class="tr-count small muted" id="trCount"></div>
    <div class="card tbl-wrap" id="trTable"></div>
    <div class="tr-more" id="trMore"></div>
    ${tab === 'congress' && (d.congress || []).some((r) => r.older) ? '<p class="small muted">Few members disclosed trades in the window, so older disclosures are included to show more people.</p>' : ''}
    ${tab === 'congress' && d.status && d.status.congress !== 'ok' ? `<p class="small muted">Congressional trade feed is unavailable right now (${esc(d.status.congress)}).</p>` : ''}
    <p class="small muted">${tab === 'congress' ? 'Members of Congress have up to 45 days to disclose a trade, and amounts are reported as ranges. Totals add up the low end of each range.' : 'Sources: our SEC Form 4 store, checked every 10 minutes, plus OpenInsider for filings not yet ingested. A purchase reported on several lines of one filing is shown once with the total.'}</p>`;

  const tableEl = app.querySelector('#trTable');
  const countEl = app.querySelector('#trCount');
  const moreEl = app.querySelector('#trMore');
  const [one, many] = NOUN[tab];
  const paintTable = () => {
    const groups = viewGroups(tab, d, st);
    tableEl.innerHTML = tableHtml(tab, groups, st, limit, { open });
    const shown = Math.min(groups.length, limit);
    const trades = groups.reduce((s, g) => s + (g.items || []).length, 0);
    countEl.textContent = `${groups.length === total ? plural(groups.length, one, many) : `${groups.length} of ${plural(total, one, many)} match`}${trades ? ` · ${plural(trades, 'trade')}` : ''}`;
    moreEl.innerHTML = groups.length > shown ? `<button type="button" class="btn-ghost" id="trMoreBtn">Show ${Math.min(PAGE, groups.length - shown)} more (${shown} of ${groups.length} shown)</button>` : '';
    all[tab] = { ...st };
    saveState(all);
  };
  paintTable();
  bindGroups(tableEl, open);

  const q = app.querySelector('#trQ');
  let tmr;
  q.addEventListener('input', () => {
    clearTimeout(tmr);
    tmr = setTimeout(() => ((st.q = q.value), (limit = PAGE), paintTable()), 120);
  });
  app.querySelector('.tr-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.ev-seg button');
    if (!b) return;
    st[b.parentElement.dataset.k] = b.dataset.v;
    b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    limit = PAGE;
    paintTable();
  });
  app.querySelector('.tr-bar').addEventListener('change', (e) => {
    const el = e.target;
    if (!el.dataset.k) return;
    st[el.dataset.k] = el.type === 'checkbox' ? el.checked : el.dataset.num ? Number(el.value) : el.value;
    limit = PAGE;
    paintTable();
  });
  tableEl.addEventListener('click', (e) => {
    const s = e.target.closest('[data-sort]');
    if (!s) return;
    const k = s.dataset.sort;
    if (st.sort === k) st.asc = !st.asc;
    else {
      st.sort = k;
      st.asc = ['ticker', 'issuer', 'owner', 'member'].includes(k);
    }
    paintTable();
  });
  moreEl.addEventListener('click', (e) => {
    if (!e.target.closest('#trMoreBtn')) return;
    limit += PAGE;
    paintTable();
  });
}
