// Full trades page (#/trades/insiders, #/trades/purchases, #/trades/congress):
// every insider purchase and Congress trade in the window, with search,
// filters and sortable columns. Pure helpers are exported for the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const money = (v) => {
  if (v == null || !isFinite(v)) return '';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${Math.round(v)}`;
};
const shortDate = (d) => (d ? new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '');
const qtyFmt = (n) => (n ? Math.round(n).toLocaleString('en-US') : '');
const pxFmt = (n) => (n ? `$${Number(n).toFixed(2)}` : '');
const cap = (s) => (s ? String(s).charAt(0).toUpperCase() + String(s).slice(1).toLowerCase() : '');
export const CSUITE = /CEO|Chief Exec|CFO|Chief Fin|Pres|Chair|COO|Chief Oper/i;

export const TABS = {
  insiders: 'Insider buys by company',
  purchases: 'Every insider purchase',
  congress: 'Congress trades',
};

// [key, label, class, sort value]
export const COLS = {
  insiders: [
    ['ticker', 'Ticker', '', (r) => r.ticker],
    ['issuer', 'Company', '', (r) => (r.issuer || '').toLowerCase()],
    ['buyers', 'Insiders', 'num', (r) => r.buyers],
    ['trades', 'Trades', 'num', (r) => r.trades || 0],
    ['total_value', 'Total bought', 'num', (r) => r.total_value || 0],
    ['csuite', 'C-suite', '', (r) => r.csuite || 0],
    ['last_date', 'Latest', 'num', (r) => r.last_date || ''],
  ],
  purchases: [
    ['ticker', 'Ticker', '', (r) => r.ticker],
    ['owner', 'Insider', '', (r) => (r.owner || '').toLowerCase()],
    ['title', 'Title', '', (r) => (r.title || '').toLowerCase()],
    ['qty', 'Shares', 'num', (r) => r.qty || 0],
    ['price', 'Price', 'num', (r) => r.price || 0],
    ['value', 'Value', 'num', (r) => r.value || 0],
    ['deltaOwn', 'Stake change', 'num', (r) => (r.deltaOwn === 'New' ? 1e9 : parseFloat(String(r.deltaOwn).replace(/[^\d.\-]/g, '')) || 0)],
    ['date', 'Traded', 'num', (r) => r.date || ''],
    ['filed', 'Filed', 'num', (r) => r.filed || ''],
  ],
  congress: [
    ['ticker', 'Ticker', '', (r) => r.ticker],
    ['member', 'Member', '', (r) => (r.member || '').toLowerCase()],
    ['type', 'Type', '', (r) => r.type || ''],
    ['amountMin', 'Amount', 'num', (r) => r.amountMin || 0],
    ['txDate', 'Traded', 'num', (r) => r.txDate || ''],
    ['filedDate', 'Disclosed', 'num', (r) => r.filedDate || ''],
  ],
};

export const DEFAULT_SORT = { insiders: ['buyers', false], purchases: ['date', false], congress: ['filedDate', false] };
export const MIN_VALUES = [[0, 'Any size'], [100e3, '$100K+'], [1e6, '$1M+'], [10e6, '$10M+']];
const PAGE = 200;

const hay = (tab, r) =>
  (tab === 'insiders' ? [r.ticker, r.issuer, r.owners] : tab === 'purchases' ? [r.ticker, r.company, r.owner, r.title] : [r.ticker, r.member]).join(' ').toLowerCase();

export function filterRows(tab, rows, st) {
  const q = (st.q || '').trim().toLowerCase();
  return (rows || []).filter((r) => {
    if (q && !q.split(/\s+/).every((w) => hay(tab, r).includes(w))) return false;
    if (tab === 'insiders') {
      if (st.min && (r.total_value || 0) < st.min) return false;
      if (st.csuite && !r.csuite) return false;
      if (st.cluster && r.buyers < 3) return false;
    } else if (tab === 'purchases') {
      if (st.min && (r.value || 0) < st.min) return false;
      if (st.csuite && !CSUITE.test(r.title || '')) return false;
    } else {
      if (st.type !== 'all' && r.type !== st.type) return false;
      if (st.chamber !== 'all' && cap(r.chamber) !== st.chamber) return false;
      if (st.party !== 'all' && cap(r.party).charAt(0) !== st.party) return false;
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

function cells(tab, r) {
  const tk = `<td class="mono">${esc(r.ticker)}</td>`;
  if (tab === 'insiders')
    return `${tk}<td>${esc(r.issuer || '')}<div class="muted tr-sub" title="${esc(r.owners || '')}">${esc(r.owners || '')}</div></td><td class="num">${r.buyers}</td><td class="num">${r.trades || ''}</td><td class="num">${money(r.total_value)}</td><td>${r.csuite ? '<span class="tag buy">C-suite</span>' : ''}</td><td class="num">${shortDate(r.last_date)}</td>`;
  if (tab === 'purchases')
    return `${tk}<td>${esc(r.owner)}<div class="muted tr-sub">${esc(r.company || '')}</div></td><td class="tr-title">${esc(r.title || '')}</td><td class="num">${qtyFmt(r.qty)}</td><td class="num">${pxFmt(r.price)}</td><td class="num">${money(r.value)}</td><td class="num">${esc(r.deltaOwn || '')}</td><td class="num">${shortDate(r.date)}</td><td class="num">${shortDate(r.filed)}</td>`;
  return `${tk}<td>${esc(r.member)}<div class="muted tr-sub">${esc([cap(r.chamber), cap(r.party)].filter(Boolean).join(' · '))}</div></td><td><span class="tag ${r.type === 'buy' ? 'buy' : r.type === 'sell' ? 'sell' : 'plan'}">${esc(r.type || '')}</span></td><td class="num">${esc(r.amount || '')}</td><td class="num">${shortDate(r.txDate)}</td><td class="num">${shortDate(r.filedDate)}</td>`;
}

export function tableHtml(tab, rows, st, limit = PAGE) {
  if (!rows.length) return '<div class="empty">No trades match these filters.</div>';
  const th = COLS[tab]
    .map(([k, l, c]) => {
      const on = st.sort === k;
      return `<th class="${c}" aria-sort="${on ? (st.asc ? 'ascending' : 'descending') : 'none'}"><button type="button" class="dv-th${on ? ' on' : ''}" data-sort="${k}">${esc(l)}${on ? (st.asc ? ' ▲' : ' ▼') : ''}</button></th>`;
    })
    .join('');
  const body = rows
    .slice(0, limit)
    .map((r) => `<tr class="click" data-t="${esc(r.ticker)}">${cells(tab, r)}</tr>`)
    .join('');
  return `<table class="tr-tbl"><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

const STORE = 'mk:trades';
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
    <label class="ev-sel"><span class="small muted">Size</span><select data-k="min" data-num="1">${MIN_VALUES.map(([v, l]) => `<option value="${v}"${st.min === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
    <label class="tr-check"><input type="checkbox" data-k="csuite"${st.csuite ? ' checked' : ''} /> C-suite only</label>
    ${tab === 'insiders' ? `<label class="tr-check"><input type="checkbox" data-k="cluster"${st.cluster ? ' checked' : ''} /> 3+ insiders</label>` : ''}`;
}

export async function renderTrades(app, api) {
  const tab = tabFromHash(location.hash);
  document.title = 'Insider and Congress trades · Mokosveri';
  const hero = `<section class="hero"><h1>Insider and Congress trades</h1><p>Every open market insider purchase (SEC Form 4, code P) and every Congress trade disclosed under the STOCK Act in the window. Search, filter and tap a column to sort. Tap a row for the full ticker breakdown.</p>`;
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
  const src = { insiders: d.companies, purchases: d.purchases, congress: d.congress }[tab] || [];
  const span = tab === 'congress' ? `Disclosed in the last ${d.congressDays} days` : `Traded in the last ${d.insiderDays} days`;
  const counts = { insiders: (d.companies || []).length, purchases: (d.purchases || []).length, congress: (d.congress || []).length };

  app.innerHTML = `${hero}<div class="meta-line">Updated ${esc(new Date(d.updated).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))} · ${span}</div></section>
    <nav class="tr-tabs" aria-label="Trade lists">${Object.entries(TABS).map(([k, l]) => `<a href="#/trades/${k}"${k === tab ? ' aria-current="page"' : ''}>${esc(l)} <span class="tr-n">${counts[k]}</span></a>`).join('')}</nav>
    <div class="ev-bar tr-bar">${controls(tab, st)}</div>
    <div class="tr-count small muted" id="trCount"></div>
    <div class="card tbl-wrap" id="trTable"></div>
    <div class="tr-more" id="trMore"></div>
    ${tab === 'congress' && d.status && d.status.congress !== 'ok' ? `<p class="small muted">Congressional trade feed is unavailable right now (${esc(d.status.congress)}).</p>` : ''}
    <p class="small muted">${tab === 'congress' ? 'Members of Congress have up to 45 days to disclose a trade, and amounts are reported as ranges. Sorting by amount uses the low end of the range.' : 'Sources: our SEC Form 4 store, checked every 10 minutes, plus OpenInsider for filings not yet ingested. A purchase reported on several lines of one filing is shown once with the total.'}</p>`;

  const tableEl = app.querySelector('#trTable');
  const countEl = app.querySelector('#trCount');
  const moreEl = app.querySelector('#trMore');
  const paintTable = () => {
    const rows = sortRows(tab, filterRows(tab, src, st), st.sort, st.asc);
    tableEl.innerHTML = tableHtml(tab, rows, st, limit);
    const shown = Math.min(rows.length, limit);
    countEl.textContent = rows.length === src.length ? `${rows.length} ${tab === 'insiders' ? 'companies' : 'trades'}` : `${rows.length} of ${src.length} ${tab === 'insiders' ? 'companies' : 'trades'} match`;
    moreEl.innerHTML = rows.length > shown ? `<button type="button" class="btn-ghost" id="trMoreBtn">Show ${Math.min(PAGE, rows.length - shown)} more (${shown} of ${rows.length} shown)</button>` : '';
    all[tab] = { ...st };
    saveState(all);
  };
  paintTable();

  const q = app.querySelector('#trQ');
  let tmr;
  q.addEventListener('input', () => {
    clearTimeout(tmr);
    tmr = setTimeout(() => ((st.q = q.value), (limit = PAGE), paintTable()), 120);
  });
  app.querySelector('.tr-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.ev-seg button');
    if (!b) return;
    const k = b.parentElement.dataset.k;
    st[k] = b.dataset.v;
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
    if (s) {
      const k = s.dataset.sort;
      if (st.sort === k) st.asc = !st.asc;
      else {
        st.sort = k;
        st.asc = ['ticker', 'issuer', 'owner', 'title', 'member', 'type'].includes(k);
      }
      paintTable();
      return;
    }
    const tr = e.target.closest('tr[data-t]');
    if (tr) location.hash = `#/t/${encodeURIComponent(tr.dataset.t)}`;
  });
  moreEl.addEventListener('click', (e) => {
    if (!e.target.closest('#trMoreBtn')) return;
    limit += PAGE;
    paintTable();
  });
}
