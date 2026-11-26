// Dividend aristocrats page (#/dividends): S&P 500 companies with 25+ years of
// dividend raises, filtered to the higher yielders and ranked by how they have
// performed, plus what r/dividends is talking about. Pure helpers are exported
// for the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v, d = 1, sign = true) => (v == null ? '<span class="muted">n/a</span>' : `${sign && v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const tone = (v) => (v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '');
const shortDate = (s) => (s ? new Date(s.length === 10 ? s + 'T12:00:00Z' : s).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

export const SORTS = {
  tr1y: '1 year total return',
  tr5y: '5 year total return, per year',
  ytd: 'Year to date',
  yield: 'Dividend yield',
  years: 'Years of raises',
};
export const MIN_YIELDS = [
  [2, '2%+'],
  [3, '3%+'],
  [4, '4%+'],
  [0, 'All'],
];

// Rows at or above the minimum yield, in the chosen sector, sorted best first.
// Rows with no figure for the sort key go last.
export function pickRows(rows, st) {
  const out = rows.filter((r) => (st.min ? r.yield != null && r.yield >= st.min : true) && (st.sector === 'all' || r.sector === st.sector));
  const k = st.sort;
  return out.sort((a, b) => {
    const x = a[k];
    const y = b[k];
    if (x == null && y == null) return a.t.localeCompare(b.t);
    if (x == null) return 1;
    if (y == null) return -1;
    return st.asc ? x - y : y - x;
  });
}

function spark(values) {
  const v = (values || []).filter((x) => x != null);
  if (v.length < 2) return '';
  const w = 120, h = 32;
  const min = Math.min(...v), max = Math.max(...v), rng = max - min || 1;
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${(h - 2 - ((x - min) / rng) * (h - 4)).toFixed(1)}`).join(' ');
  return `<svg class="dv-spark ${v[v.length - 1] >= v[0] ? 'up' : 'down'}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

const flagChips = (r) =>
  (r.flags || [])
    .map((f) => `<span class="chip dv-f-${esc(f.k)}" title="${esc(f.text)}">${({ trap: 'Check the payout', high: 'Very high yield', king: 'Dividend King', cc: 'Covered calls' })[f.k] || f.k}</span>`)
    .join('');

export function leaderCards(rows, sortKey) {
  if (!rows.length) return '<div class="card dv-empty">No aristocrats match these filters right now.</div>';
  return `<div class="dv-lead">${rows
    .slice(0, 6)
    .map(
      (r, i) => `<a class="card dv-card" href="#/t/${encodeURIComponent(r.t)}">
      <div class="dv-card-h"><span class="dv-rank">${i + 1}</span><b class="mono">${esc(r.t)}</b><span class="muted small">${esc(r.name)}</span></div>
      <div class="dv-card-k"><span class="dv-yield">${pct(r.yield, 2, false)}</span><small>yield</small></div>
      ${spark(r.spark)}
      <dl class="dv-kv">
        <div><dt>1y total</dt><dd class="mono ${tone(r.tr1y)}">${pct(r.tr1y)}</dd></div>
        <div><dt>5y total/yr</dt><dd class="mono ${tone(r.tr5y)}">${pct(r.tr5y)}</dd></div>
        <div><dt>YTD price</dt><dd class="mono ${tone(r.ytd)}">${pct(r.ytd)}</dd></div>
        <div><dt>Raises</dt><dd class="mono">${r.years ?? 'n/a'} yrs</dd></div>
      </dl>
      <div class="dv-flags">${flagChips(r)}</div>
      <div class="small muted">Ranked by ${esc(SORTS[sortKey].toLowerCase())}</div>
    </a>`
    )
    .join('')}</div>`;
}

const COLS = [
  ['t', 'Company', ''],
  ['years', 'Raises', 'num'],
  ['yield', 'Yield', 'num'],
  ['ytd', 'YTD', 'num'],
  ['r1y', '1y price', 'num'],
  ['tr1y', '1y total', 'num'],
  ['tr5y', '5y total/yr', 'num'],
  ['exDiv', 'Ex-div', 'num'],
];

export function tableHtml(rows, st) {
  if (!rows.length) return '';
  const th = COLS.map(([k, l, c]) => {
    const on = st.sort === k;
    const sortable = k !== 't' && k !== 'exDiv';
    return `<th class="${c}">${sortable ? `<button type="button" data-sort="${k}" class="dv-th${on ? ' on' : ''}">${esc(l)}${on ? (st.asc ? ' ▲' : ' ▼') : ''}</button>` : esc(l)}</th>`;
  }).join('');
  return `<div class="card tbl-wrap"><table class="dv-tbl"><thead><tr>${th}</tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr>
        <td><a href="#/t/${encodeURIComponent(r.t)}" class="mono"><b>${esc(r.t)}</b></a> <span class="dv-nm">${esc(r.name)}</span><div class="small muted">${esc(r.sector)} ${flagChips(r)}</div></td>
        <td class="num mono">${r.years ?? ''}</td>
        <td class="num mono"><b>${pct(r.yield, 2, false)}</b>${r.yieldSrc !== 'live' && r.yield != null ? `<div class="small muted" title="Live yield unavailable, showing the figure checked on ${esc(r.yieldSrc)}">${esc(r.yieldSrc)}</div>` : ''}</td>
        <td class="num mono ${tone(r.ytd)}">${pct(r.ytd)}</td>
        <td class="num mono ${tone(r.r1y)}">${pct(r.r1y)}</td>
        <td class="num mono ${tone(r.tr1y)}">${pct(r.tr1y)}</td>
        <td class="num mono ${tone(r.tr5y)}">${pct(r.tr5y)}</td>
        <td class="num mono small">${r.exDiv ? esc(shortDate(r.exDiv)) : ''}</td>
      </tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

const ETF_COLS = [
  ['t', 'Fund', ''],
  ['er', 'Fee', 'num'],
  ['yield', 'Yield', 'num'],
  ['ytd', 'YTD', 'num'],
  ['r1y', '1y price', 'num'],
  ['tr1y', '1y total', 'num'],
  ['tr5y', '5y total/yr', 'num'],
];

// Dividend ETFs: same minimum yield and ranking as the stocks, every strategy.
export function etfTableHtml(etfs, st) {
  const sortKey = st.sort === 'years' ? 'yield' : st.sort;
  const rows = pickRows(etfs || [], { min: st.min, sort: sortKey, asc: st.asc, sector: 'all' });
  if (!rows.length) return '<div class="card dv-empty">No dividend ETFs match this minimum yield right now.</div>';
  const th = ETF_COLS.map(([k, l, c]) => `<th class="${c}">${k === sortKey ? `<b>${esc(l)}</b>` : esc(l)}</th>`).join('');
  return `<div class="card tbl-wrap"><table class="dv-tbl dv-etf"><thead><tr>${th}</tr></thead><tbody>
    ${rows
      .map(
        (r) => `<tr>
        <td><a href="#/t/${encodeURIComponent(r.t)}" class="mono"><b>${esc(r.t)}</b></a> <span class="dv-nm">${esc(r.name)}</span><div class="small muted">${esc(r.sector)} ${flagChips(r)}</div></td>
        <td class="num mono small">${r.er != null ? r.er.toFixed(2) + '%' : ''}</td>
        <td class="num mono"><b>${pct(r.yield, 2, false)}</b></td>
        <td class="num mono ${tone(r.ytd)}">${pct(r.ytd)}</td>
        <td class="num mono ${tone(r.r1y)}">${pct(r.r1y)}</td>
        <td class="num mono ${tone(r.tr1y)}">${pct(r.tr1y)}</td>
        <td class="num mono ${tone(r.tr5y)}">${pct(r.tr5y)}</td>
      </tr>`
      )
      .join('')}
  </tbody></table></div>`;
}

const tk = (t, byT) => {
  const r = byT[t];
  return `<a class="chip dv-tk" href="#/t/${encodeURIComponent(t)}"><b class="mono">${esc(t)}</b>${r && r.yield != null ? ` ${r.yield.toFixed(1)}%` : ''}</a>`;
};

export function redditHtml(d, byT) {
  const rd = d.reddit || {};
  const live = rd.ok
    ? `<div class="card dv-rd">
        <div class="dv-rd-h"><b>Most mentioned aristocrats on r/dividends</b><span class="small muted">${rd.scanned} recent top posts scanned · ${esc(shortDate(rd.asOf))}</span></div>
        ${rd.tickers.length ? `<div class="dv-rd-tks">${rd.tickers.map((x) => `<span class="dv-rd-tk">${tk(x.t, byT)}<small>${x.posts} post${x.posts === 1 ? '' : 's'}</small></span>`).join('')}</div>` : '<p class="muted small">No aristocrats named in the posts scanned.</p>'}
        ${rd.posts.length ? `<ul class="dv-rd-posts">${rd.posts.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a> <span class="small muted">${p.score} upvotes · ${p.comments} comments · ${p.tickers.map(esc).join(', ')}</span></li>`).join('')}</ul>` : ''}
      </div>`
    : `<div class="notice small">Live Reddit mention counts are unavailable right now (${esc(rd.error || 'no answer')}). Reddit often refuses requests from cloud servers. The themes below still apply.</div>`;
  const themes = (d.community && d.community.themes) || [];
  return `${live}
    <div class="dv-themes">${themes
      .map((th) => `<div class="card dv-theme"><h3>${esc(th.title)}</h3><p>${esc(th.body)}</p>${th.tickers.length ? `<div class="dv-tks">${th.tickers.map((t) => tk(t, byT)).join('')}</div>` : ''}</div>`)
      .join('')}</div>
    <p class="small muted">Themes are Mokosveri's summary of long running r/dividends discussions (reviewed ${esc(d.community.reviewed)}), paraphrased, not quotes. Community opinion is not research, and popular picks can still fall.</p>`;
}

export function researchHtml(d, byT) {
  const ms = d.research.morningstar;
  const ld = d.research.leaders;
  return `<div class="dv-res">
    <div class="card dv-res-c"><h3>${esc(ms.title)}</h3><p class="small muted">${esc(ms.note)} Data as of ${esc(shortDate(ms.asOf))}.</p>
      <ul>${ms.picks
        .map(([t, pfv, moat]) => {
          const r = byT[t];
          const hi = r && r.yield != null && r.yield >= 2;
          return `<li class="${hi ? '' : 'dim'}">${tk(t, byT)} <span class="small">${esc(r ? r.name : '')}</span> <span class="small muted">[${pfv.toFixed(2)}] ${esc(moat)}${hi ? '' : ' · yield under 2%'}</span></li>`;
        })
        .join('')}</ul>
      <a class="small" href="${esc(ms.url)}" target="_blank" rel="noopener">Source</a></div>
    <div class="card dv-res-c"><h3>${esc(ld.title)}</h3><p class="small muted">${esc(ld.note)}</p>
      <ul>${ld.rows.map(([t, r]) => `<li>${tk(t, byT)} <span class="mono up">+${r.toFixed(1)}%</span></li>`).join('')}</ul>
      <a class="small" href="${esc(ld.url)}" target="_blank" rel="noopener">Source</a></div>
  </div>
  <p class="small muted">${esc(d.research.longRun)}</p>`;
}

const PREF = 'dividends:prefs';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF)) || {};
  } catch {
    return {};
  }
}
function savePrefs(st) {
  try {
    localStorage.setItem(PREF, JSON.stringify(st));
  } catch {}
}

export async function renderDividends(app, api) {
  const hero = `<section class="hero"><h1>Dividend aristocrats</h1><p>S&amp;P 500 companies that have raised their dividend every year for at least 25 years. Filtered to yields above 2% and ranked by how they have actually performed, alongside the popular dividend ETFs, what r/dividends is saying about them, and a calculator for the income they could pay you.</p>`;
  app.innerHTML = `${hero}</section><div class="loading"><div class="spinner"></div>Loading yields, returns and Reddit chatter…</div>`;
  let d;
  try {
    d = await api('/api/dividends');
  } catch (e) {
    app.innerHTML = `<div class="err"><h2>Could not load dividend aristocrats</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  const byT = Object.fromEntries([...(d.etfs || []), ...d.rows].map((r) => [r.t, r]));
  const sectors = [...new Set(d.rows.map((r) => r.sector))].sort();
  const st = { min: 2, sort: 'tr1y', asc: false, sector: 'all', ...loadPrefs() };
  if (!SORTS[st.sort] && st.sort !== 'r1y') st.sort = 'tr1y';
  const above2 = d.rows.filter((r) => r.yield != null && r.yield >= 2).length;

  // The page is laid out once; only the filtered lists repaint, so the
  // income calculators below keep what the reader typed.
  app.innerHTML = `${hero}
      <div class="meta-line">Updated ${esc(new Date(d.asOf).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))} · ${d.count} aristocrats, ${above2} yield 2% or more · Average yield ${d.avgYield != null ? d.avgYield.toFixed(2) + '%' : 'n/a'} · <a href="#dvCalcH" data-jump="dvCalcH">Income calculator</a></div></section>
    ${!d.quotesOk ? '<div class="notice small">Live yields are unavailable right now, so yields show the last hand checked figures (Oct 23, 2026).</div>' : ''}
    <div id="dvLists"></div>

    <h2 class="section" id="dvCalcH">Dividend income calculator</h2>
    <div id="dvCalc" class="dc-wrap"></div>

    <h2 class="section">What r/dividends is saying</h2>
    ${redditHtml(d, byT)}

    <h2 class="section">Research notes</h2>
    ${researchHtml(d, byT)}

    <h2 class="section">How to read this</h2>
    <div class="card dv-how"><ul>
      <li><b>Yield</b> is the forward annual dividend divided by today's price. A yield well above a company's normal level usually means the price fell, so check why.</li>
      <li><b>Check the payout</b> marks a 5%+ yield after a 15%+ price drop over a year, a common shape of a dividend at risk.</li>
      <li><b>Dividend King</b> means 50 or more straight years of raises.</li>
      <li>Membership (69 companies, no changes at S&amp;P's January 2026 review) and streaks were checked on ${esc(shortDate(d.listChecked))}. Prices, yields and returns are live from Yahoo Finance and refresh every 3 hours.</li>
    </ul></div>
    <div class="notice"><b>Educational, not financial advice.</b> A long dividend streak is not a promise: past aristocrats like AT&amp;T, VF Corp, Walgreens and Leggett &amp; Platt cut their dividends. Reddit opinions and analyst picks can be wrong. Do your own research and consult a licensed professional before investing.</div>`;
  const lists = app.querySelector('#dvLists');
  app.querySelector('[data-jump]').addEventListener('click', (e) => {
    e.preventDefault();
    app.querySelector('#dvCalcH').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  import('/divcalc.js')
    .then((m) => m.mountCalculators(app.querySelector('#dvCalc'), d.rows, api))
    .catch((e) => (app.querySelector('#dvCalc').innerHTML = `<div class="notice small">The calculator could not load (${esc(e.message)}).</div>`));

  const paint = () => {
    const rows = pickRows(d.rows, st);
    const sortKey = SORTS[st.sort] ? st.sort : 'tr1y';
    lists.innerHTML = `
      <div class="ev-bar dv-bar">
        <div class="ev-seg" role="group" aria-label="Minimum yield" data-k="min">${MIN_YIELDS.map(([v, l]) => `<button type="button" data-v="${v}" aria-pressed="${v === st.min}">${esc(l)}</button>`).join('')}</div>
        <label class="ev-sel"><span class="small muted">Rank by</span><select id="dvSort">${Object.entries(SORTS).map(([k, v]) => `<option value="${k}"${st.sort === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        <label class="ev-sel"><span class="small muted">Sector</span><select id="dvSector"><option value="all">All sectors</option>${sectors.map((s) => `<option${st.sector === s ? ' selected' : ''}>${esc(s)}</option>`).join('')}</select></label>
      </div>
      <h2 class="section">Best performers ${st.min ? `yielding ${st.min}% or more` : ''}</h2>
      ${leaderCards(rows, sortKey)}
      <h2 class="section">All ${rows.length} matching aristocrats</h2>
      ${tableHtml(rows, st)}
      <p class="small muted">Total returns are approximate: price return plus the trailing 12 month dividend yield (per year for 5 years). Reinvested dividends would add a little more. Tap a column to sort.</p>

      <h2 class="section">Dividend ETFs ${st.min ? `yielding ${st.min}% or more` : ''}</h2>
      ${etfTableHtml(d.etfs, st)}
      <p class="small muted">Same yield filter and ranking as the stocks above. Yield is the last 12 months of distributions divided by today's price. Fee is the fund's yearly expense ratio, already taken out of its returns. Covered call funds pay more now by selling away part of the upside, so their payouts can shrink and rarely grow.</p>`;

    lists.querySelectorAll('.ev-seg').forEach((g) =>
      g.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        st.min = Number(b.dataset.v);
        savePrefs(st);
        paint();
      })
    );
    const so = lists.querySelector('#dvSort');
    so.addEventListener('change', () => ((st.sort = so.value), (st.asc = false), savePrefs(st), paint()));
    const se = lists.querySelector('#dvSector');
    se.addEventListener('change', () => ((st.sector = se.value), savePrefs(st), paint()));
    lists.querySelectorAll('[data-sort]').forEach((b) =>
      b.addEventListener('click', () => {
        const k = b.dataset.sort;
        if (st.sort === k) st.asc = !st.asc;
        else Object.assign(st, { sort: k, asc: false });
        savePrefs(st);
        paint();
      })
    );
  };
  paint();
}
