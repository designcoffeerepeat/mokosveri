// Earnings calendar on the Market events page: a Monday to Friday month grid
// with the most important companies reporting each day, and a day view with
// timing, estimates and last year's results. Pure helpers are exported for
// the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const D = (s) => new Date(s + 'T12:00:00Z');
const PER_CELL = 5;
const TABLE_ROWS = 25;

export const WHEN = { bmo: 'Before the open', amc: 'After the close' };

export function capTxt(v) {
  if (v == null || !Number.isFinite(v)) return '';
  if (v >= 1e12) return `$${(v / 1e12).toFixed(v >= 1e13 ? 0 : 1)}T`;
  if (v >= 1e9) return `$${(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)}B`;
  if (v >= 1e6) return `$${Math.round(v / 1e6)}M`;
  return `$${Math.round(v).toLocaleString('en-US')}`;
}
// Nasdaq writes negative EPS in accounting style: ($0.12).
export function epsTxt(s) {
  if (s == null || s === '') return '';
  const t = String(s).trim();
  const m = t.match(/^\((.*)\)$/);
  return m ? `-${m[1]}` : t;
}
export const epsNum = (s) => {
  const t = epsTxt(s).replace(/[$,]/g, '');
  const n = parseFloat(t);
  return Number.isFinite(n) ? n : null;
};
export function pctTxt(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;
}
const usd = (v) => (v == null ? '' : `${v < 0 ? '-' : ''}$${Math.abs(v).toFixed(2)}`);

export function monthTitle(m) {
  return D(`${m}-01`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
export function longDay(s) {
  return D(s).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

// Weeks of a month as rows of five weekday slots (null outside the month).
export function monthWeeks(m) {
  const weeks = [];
  let week = null;
  for (let d = D(`${m}-01`); d.toISOString().slice(0, 7) === m; d = new Date(d.getTime() + 864e5)) {
    const wd = d.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    if (!week || wd === 1) {
      week = [null, null, null, null, null];
      weeks.push(week);
    }
    week[wd - 1] = d.toISOString().slice(0, 10);
  }
  return weeks;
}

function tickChip(x) {
  const cls = ['ec-tk', x.when || 'tns', x.watch ? 'w' : ''].filter(Boolean).join(' ');
  const tip = `${x.n || x.t}${x.cap ? `, ${capTxt(x.cap)}` : ''}${x.when ? `, ${WHEN[x.when].toLowerCase()}` : ''}`;
  return `<span class="${cls}" title="${esc(tip)}">${esc(x.t)}</span>`;
}

export function cellHtml(day, info, st) {
  if (!day) return '<div class="ec-cell ec-out" aria-hidden="true"></div>';
  const num = Number(day.slice(8));
  const cls = ['ec-cell', day === st.today ? 'today' : '', day < st.today ? 'past' : '', day === st.sel ? 'sel' : ''].filter(Boolean).join(' ');
  const head = `<span class="ec-num">${num}</span><span class="ec-wdm">${D(day).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span>`;
  if (!info) {
    const failed = st.failed.includes(day);
    return `<div class="${cls} ec-wait"><div class="ec-ch">${head}</div><span class="small muted">${failed ? 'Not available' : 'Loading…'}</span></div>`;
  }
  if (info.closed) return `<div class="${cls} ec-closed"><div class="ec-ch">${head}</div><span class="small muted">${esc(info.closed)}</span></div>`;
  if (!info.count) return `<div class="${cls} ec-none"><div class="ec-ch">${head}</div><span class="small muted">No reports listed</span></div>`;
  const shown = info.top.slice(0, PER_CELL);
  const more = info.count - shown.length;
  return `<button type="button" class="${cls}" data-day="${esc(day)}" aria-pressed="${day === st.sel}" aria-label="${esc(`${longDay(day)}: ${info.count} companies report, including ${shown.map((x) => x.t).join(', ')}`)}">
    <div class="ec-ch">${head}<span class="ec-count" title="Companies reporting">${info.count} reports</span></div>
    <div class="ec-tks">${shown.map(tickChip).join('')}</div>
    ${more > 0 ? `<span class="ec-more">+${more} more</span>` : ''}
  </button>`;
}

export function gridHtml(d, st) {
  const weeks = monthWeeks(d.month);
  return `<div class="ec-grid" role="grid" aria-label="Earnings in ${esc(monthTitle(d.month))}">
    ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((w) => `<div class="ec-wd" role="columnheader">${w}</div>`).join('')}
    ${weeks.map((w) => w.map((day) => cellHtml(day, d.days[day], st)).join('')).join('')}
  </div>`;
}

function rangeTxt(lo, hi, fmt) {
  if (lo == null || hi == null) return '';
  return `${fmt(lo)} to ${fmt(hi)}`;
}
function growthTxt(g) {
  if (g == null) return '';
  return pctTxt(g * 100);
}

function historyDots(h) {
  if (!h || !h.length) return '';
  return `<div class="ec-hist" title="Last ${h.length} quarters: reported EPS vs the estimate">${h
    .map((x) => {
      const beat = x.act > x.est ? 'beat' : x.act < x.est ? 'miss' : 'met';
      return `<span class="ec-dot ${beat}" title="${esc(`${x.q || ''}: ${usd(x.act)} vs ${usd(x.est)} expected`)}"></span>`;
    })
    .join('')}<span class="small muted">${h.filter((x) => x.act > x.est).length} of ${h.length} beats</span></div>`;
}

export function spotlightHtml(r, c, past) {
  const est = epsTxt(r.est);
  const resLine = past && r.act ? surpriseLine(r) : '';
  return `<article class="card ec-spot${r.watch ? ' w' : ''}">
    <header><a class="mono ec-sym" href="#/t/${encodeURIComponent(r.t)}">${esc(r.t)}</a><span class="ec-when ${esc(r.when || 'tns')}">${esc(r.when ? WHEN[r.when] : 'Time not set')}</span></header>
    <p class="ec-name">${esc(r.n || '')}${r.cap ? ` <span class="muted">· ${esc(capTxt(r.cap))}</span>` : ''}</p>
    <dl>
      <div><dt>EPS estimate</dt><dd><b>${esc(c && c.eps.avg != null ? usd(c.eps.avg) : est || 'n/a')}</b>${c && c.eps.low != null ? `<small>${esc(rangeTxt(c.eps.low, c.eps.high, usd))}</small>` : ''}${c && c.eps.growth != null ? `<small>${esc(growthTxt(c.eps.growth))} vs a year ago</small>` : r.ly ? `<small>Year ago ${esc(epsTxt(r.ly))}</small>` : ''}</dd></div>
      ${c && c.rev.avg != null ? `<div><dt>Revenue estimate</dt><dd><b>${esc(capTxt(c.rev.avg))}</b><small>${esc(rangeTxt(c.rev.low, c.rev.high, capTxt))}</small>${c.rev.growth != null ? `<small>${esc(growthTxt(c.rev.growth))} vs a year ago</small>` : ''}</dd></div>` : ''}
      <div><dt>Analysts</dt><dd><b>${esc(String((c && (c.eps.analysts || c.rev.analysts)) || r.ests || 'n/a'))}</b>${r.q ? `<small>Quarter ending ${esc(r.q)}</small>` : ''}</dd></div>
    </dl>
    ${resLine}
    ${historyDots(c && c.history)}
  </article>`;
}

function surpriseLine(r) {
  const a = epsNum(r.act);
  const e = epsNum(r.est);
  const tone = a == null || e == null ? '' : a > e ? 'up' : a < e ? 'down' : '';
  const word = tone === 'up' ? 'Beat' : tone === 'down' ? 'Missed' : 'Reported';
  const s = r.sur && Number.isFinite(parseFloat(r.sur)) ? ` (${pctTxt(parseFloat(r.sur))})` : '';
  return `<p class="ec-res ${tone}"><b>${word}.</b> Reported EPS ${esc(epsTxt(r.act))}${e != null ? ` vs ${esc(epsTxt(r.est))} expected` : ''}${esc(s)}</p>`;
}

export function filterRows(rows, f) {
  const q = (f.q || '').trim().toUpperCase();
  return rows.filter((r) => {
    if (f.when !== 'all' && (r.when || 'tns') !== f.when) return false;
    if (q && !r.t.includes(q) && !(r.n || '').toUpperCase().includes(q)) return false;
    return true;
  });
}

export function tableHtml(d, f) {
  const past = d.date < d.today;
  const list = filterRows(d.rows, f);
  const rows = f.all ? list : list.slice(0, TABLE_ROWS);
  if (!list.length) return '<p class="muted ec-emptyt">No companies match.</p>';
  return `<div class="tbl-wrap"><table class="ec-table"><thead><tr>
      <th>Company</th><th>Time</th><th class="num">Market value</th><th>Quarter</th><th class="num">EPS estimate</th><th class="num">Analysts</th><th class="num">Last year</th>${past ? '<th class="num">Reported</th><th class="num">Surprise</th>' : ''}
    </tr></thead><tbody>
    ${rows
      .map((r) => {
        const sur = r.sur && Number.isFinite(parseFloat(r.sur)) ? parseFloat(r.sur) : null;
        return `<tr${r.watch ? ' class="w"' : ''}>
        <td><a class="mono" href="#/t/${encodeURIComponent(r.t)}">${esc(r.t)}</a> <span class="ec-cn">${esc(r.n || '')}</span></td>
        <td><span class="ec-when ${esc(r.when || 'tns')}">${esc(r.when ? WHEN[r.when] : 'Not set')}</span></td>
        <td class="num">${esc(capTxt(r.cap))}</td>
        <td>${esc(r.q || '')}</td>
        <td class="num">${esc(epsTxt(r.est))}</td>
        <td class="num">${r.ests ?? ''}</td>
        <td class="num" title="${esc(r.lyDate ? `Reported ${r.lyDate}` : '')}">${esc(epsTxt(r.ly))}</td>
        ${past ? `<td class="num"><b>${esc(epsTxt(r.act))}</b></td><td class="num ${sur == null ? '' : sur > 0 ? 'up' : sur < 0 ? 'down' : ''}">${sur == null ? '' : esc(pctTxt(sur))}</td>` : ''}
      </tr>`;
      })
      .join('')}
    </tbody></table></div>
    ${!f.all && list.length > TABLE_ROWS ? `<button type="button" class="ec-all">Show all ${list.length} companies</button>` : ''}`;
}

export function dayHtml(d, f) {
  if (d.closed) return `<div class="card ec-day"><h3>${esc(longDay(d.date))}</h3><p class="muted">${esc(d.closed)}. No earnings reports.</p></div>`;
  const past = d.date < d.today;
  const bmo = d.rows.filter((r) => r.when === 'bmo').length;
  const amc = d.rows.filter((r) => r.when === 'amc').length;
  const spot = d.rows.slice(0, 8);
  const seg = [['all', `All (${d.rows.length})`], ['bmo', `Before the open (${bmo})`], ['amc', `After the close (${amc})`], ['tns', `Time not set (${d.rows.length - bmo - amc})`]];
  return `<div class="ec-day">
    <div class="ec-dhead"><h3>${esc(longDay(d.date))}</h3><span class="muted small">${d.count} ${d.count === 1 ? 'company reports' : 'companies report'}${d.half ? ` · Early close at 1:00 pm ET (${esc(d.half)})` : ''}</span><button type="button" class="ec-x" aria-label="Close day details">Close</button></div>
    ${d.rows.length ? `<h4 class="ec-sub">${past ? 'Biggest reports' : 'Biggest reports to watch'}</h4><div class="ec-spots">${spot.map((r) => spotlightHtml(r, d.consensus[r.t], past)).join('')}</div>
    <h4 class="ec-sub">Every company that day</h4>
    <div class="ec-tbar"><div class="ev-seg" role="group" data-k="when">${seg.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${f.when === v}">${esc(l)}</button>`).join('')}</div>
      <input type="search" class="ec-q" placeholder="Find a ticker or company" value="${esc(f.q)}" aria-label="Find a ticker or company"/></div>
    <div class="card ec-tcard">${tableHtml(d, f)}</div>` : '<p class="muted">No companies are listed for this day yet. Companies often confirm dates two to four weeks ahead.</p>'}
    <p class="small muted ec-src">Dates, times and EPS estimates: <a href="${esc(d.source.url)}" target="_blank" rel="noopener">${esc(d.source.name)}</a>. Revenue and EPS ranges and the beat record: Yahoo Finance consensus, for the largest companies on upcoming days.</p>
  </div>`;
}

function shellHtml(d, st) {
  const loaded = Object.keys(d.days).length;
  return `<div class="ec-top">
      <div class="ec-nav">
        <button type="button" class="ec-btn" data-go="${esc(d.prev || '')}" ${d.prev ? '' : 'disabled'} aria-label="Previous month">‹</button>
        <h3 class="ec-title">${esc(monthTitle(d.month))}</h3>
        <button type="button" class="ec-btn" data-go="${esc(d.next || '')}" ${d.next ? '' : 'disabled'} aria-label="Next month">›</button>
        ${d.month !== d.today.slice(0, 7) ? `<button type="button" class="ec-btn ec-today" data-go="${esc(d.today.slice(0, 7))}">This month</button>` : ''}
      </div>
      <div class="ec-legend small"><span><i class="ec-sw bmo"></i>Before the open</span><span><i class="ec-sw amc"></i>After the close</span><span><i class="ec-sw tns"></i>Time not set</span>${st.watch.length ? '<span><i class="ec-sw w"></i>On your watchlist</span>' : ''}</div>
    </div>
    ${d.partial && loaded ? '<p class="small muted ec-partial">Some days are still loading. They fill in on the next visit.</p>' : ''}
    ${gridHtml(d, st)}
    <p class="small muted ec-note">Each day lists the largest companies reporting, by market value, with your watchlist first. Click a day for times, estimates and the full list. Dates further out fill in as companies confirm them.</p>
    <div class="ec-detail" id="ecDetail"></div>`;
}

// Mounts the calendar into a persistent element so the events page can repaint
// around it without losing the selected month or day.
export function createCalendar(api, watch = []) {
  const el = document.createElement('section');
  el.className = 'ec';
  const wq = watch.length ? `&watch=${encodeURIComponent(watch.join(','))}` : '';
  const st = { month: null, sel: null, today: '', failed: [], watch, data: null, day: null, f: { when: 'all', q: '', all: false } };
  const months = new Map();

  const paintDay = () => {
    const box = el.querySelector('#ecDetail');
    if (!box) return;
    if (!st.sel) {
      box.innerHTML = '';
      return;
    }
    if (!st.day || st.day.date !== st.sel) {
      box.innerHTML = `<div class="loading"><div class="spinner"></div>Loading ${esc(longDay(st.sel))}…</div>`;
      return;
    }
    if (st.day.error) {
      box.innerHTML = `<div class="err"><p class="muted">Could not load ${esc(longDay(st.sel))}: ${esc(st.day.error)}</p></div>`;
      return;
    }
    box.innerHTML = dayHtml(st.day, st.f);
  };
  const paint = () => {
    if (!st.data) {
      el.innerHTML = `<div class="loading"><div class="spinner"></div>Loading the earnings calendar…</div>`;
      return;
    }
    el.innerHTML = shellHtml(st.data, st);
    paintDay();
  };

  const loadMonth = async (m) => {
    st.month = m;
    if (months.has(m)) st.data = months.get(m);
    else {
      st.data = null;
      paint();
      try {
        const d = await api(`/api/earnings/month?month=${encodeURIComponent(m || '')}${wq}`);
        months.set(d.month, d);
        if (m) months.set(m, d);
        if (st.month !== m) return;
        st.data = d;
      } catch (e) {
        el.innerHTML = `<div class="err"><p class="muted">Could not load the earnings calendar: ${esc(e.message)}</p></div>`;
        return;
      }
    }
    st.today = st.data.today;
    st.failed = st.data.failed || [];
    paint();
  };

  const openDay = async (day) => {
    st.sel = day;
    st.f = { when: 'all', q: '', all: false };
    paint();
    if (st.day && st.day.date === day) return;
    st.day = null;
    let d;
    try {
      d = await api(`/api/earnings/day?date=${encodeURIComponent(day)}${wq}`);
    } catch (e) {
      d = { date: day, error: e.message };
    }
    if (st.sel !== day) return;
    st.day = d;
    paintDay();
    const box = el.querySelector('#ecDetail');
    if (box && box.getBoundingClientRect().top > window.innerHeight * 0.8) box.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  el.addEventListener('click', (ev) => {
    const go = ev.target.closest('[data-go]');
    if (go && go.dataset.go) {
      st.sel = null;
      loadMonth(go.dataset.go);
      return;
    }
    const cell = ev.target.closest('button.ec-cell[data-day]');
    if (cell) {
      if (st.sel === cell.dataset.day) {
        st.sel = null;
        paint();
      } else openDay(cell.dataset.day);
      return;
    }
    if (ev.target.closest('.ec-x')) {
      st.sel = null;
      paint();
      return;
    }
    if (ev.target.closest('.ec-all')) {
      st.f.all = true;
      paintDay();
      return;
    }
    const segB = ev.target.closest('.ec-day .ev-seg button');
    if (segB) {
      st.f.when = segB.dataset.v;
      paintDay();
    }
  });
  el.addEventListener('input', (ev) => {
    if (!ev.target.matches('.ec-q')) return;
    st.f.q = ev.target.value;
    const card = el.querySelector('.ec-tcard');
    if (card && st.day) card.innerHTML = tableHtml(st.day, st.f);
  });

  loadMonth('');
  return el;
}
