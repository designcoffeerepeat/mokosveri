// Market events page (#/events): recent and upcoming market moving events with
// an impact rating, actual vs expected for released data, and a plain language
// note on what each could mean. Pure helpers are exported for the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const D = (s) => new Date(s + 'T12:00:00Z');
export const dayDiff = (a, b) => Math.round((D(a) - D(b)) / 864e5);
const IMPACT = { 3: 'High', 2: 'Medium', 1: 'Low' };

export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  if (h === 23 && m === 59) return '11:59 pm ET';
  const ap = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 || 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap} ET`;
}
export function fmtDay(s) {
  return D(s).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
export function relDay(date, today) {
  const n = dayDiff(date, today);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  return n > 0 ? `In ${n} days` : `${-n} days ago`;
}

export const NOT_COVERED = [
  { name: 'Crypto token unlocks and spot crypto ETF decision deadlines', reason: 'No free, reliable feed, and the dates shift often. Token unlock trackers and the SEC\'s rule filings list them.' },
  { name: 'Court and regulatory rulings', reason: 'Most have no fixed date (Supreme Court opinions, antitrust cases, tariff rulings). They are covered only when they show up in the economic calendar.' },
  { name: 'Surprise S&P 500 additions', reason: 'Outside the quarterly rebalance, S&P adds companies with only a few days notice, so they cannot be scheduled ahead.' },
  { name: 'Jackson Hole symposium', reason: 'Held in late August; the Kansas City Fed confirms dates closer to the event. It will appear once it is inside the window.' },
  { name: 'Debt ceiling', reason: 'The July 2025 budget law raised the limit by $5 trillion, so no deadline is expected in this window.' },
  { name: 'Fed speakers beyond the next two weeks', reason: 'Speeches are usually announced only days ahead, so they come from the live economic calendar.' },
];

// Filters: view (upcoming or recent), minimum impact, category, watchlist only.
export function filterEvents(d, st) {
  const today = d.today;
  return d.events.filter((e) => {
    if (st.view === 'upcoming' ? e.date < today : e.date > today) return false;
    if (st.view === 'recent' && e.date === today && e.time && !e.data.some((x) => x.actual) && e.type !== 'holiday') return false;
    if (e.impact < st.min && !(e.watch && st.min < 3)) return false;
    if (st.cat !== 'all' && e.cat !== st.cat) return false;
    if (st.mine && !e.watch) return false;
    return true;
  });
}

export function groupByDay(events, newestFirst = false) {
  const m = new Map();
  for (const e of events) {
    if (!m.has(e.date)) m.set(e.date, []);
    m.get(e.date).push(e);
  }
  const days = [...m.entries()];
  if (newestFirst) days.reverse();
  return days;
}

function dataTable(e) {
  if (!e.data.length) return '';
  const hasPrev = e.data.some((r) => r.previous);
  return `<div class="tbl-wrap"><table class="ev-data"><thead><tr><th>${e.type === 'earnings' ? 'Measure' : 'Indicator'}</th><th class="num">Actual</th><th class="num">Expected</th>${hasPrev ? '<th class="num">Previous</th>' : ''}</tr></thead><tbody>
    ${e.data.map((r) => `<tr><td>${esc(r.label)}</td><td class="num"><b>${r.actual ? esc(r.actual) : '<span class="muted">pending</span>'}</b></td><td class="num">${r.expected ? esc(r.expected) : '<span class="muted">n/a</span>'}</td>${hasPrev ? `<td class="num">${r.previous ? esc(r.previous) : ''}</td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}

export function eventHtml(e, d) {
  const cats = d.cats || {};
  const when = e.session || fmtTime(e.time) || (e.type === 'holiday' ? 'All day' : '');
  const chips = [
    `<span class="chip">${esc(cats[e.cat] || e.cat)}</span>`,
    e.watch ? '<span class="chip ev-watch" title="A ticker on your watchlist">On your watchlist</span>' : '',
    e.tentative ? '<span class="chip ev-tent" title="Estimated or not yet confirmed">Estimated date</span>' : '',
    e.official ? '<span class="chip" title="From the official published calendar">Official calendar</span>' : '',
  ].join('');
  const tickers = e.tickers.length ? ` <span class="ev-tks">${e.tickers.map((t) => `<a href="#/t/${encodeURIComponent(t)}" class="mono">${esc(t)}</a>`).join(' ')}</span>` : '';
  const res = e.result ? `<p class="ev-result ${esc(e.result.tone)}"><b>${e.result.vs === 'above' ? 'Above forecast' : e.result.vs === 'below' ? 'Below forecast' : 'In line'}.</b> ${esc(e.result.text)}</p>` : '';
  return `<article class="ev imp${e.impact}${e.watch ? ' is-watch' : ''}" data-id="${esc(e.id)}">
    <div class="ev-when"><span class="ev-imp" title="${esc(IMPACT[e.impact])} impact">${esc(IMPACT[e.impact])}</span><span class="ev-time">${esc(when)}</span></div>
    <div class="ev-body">
      <h3>${esc(e.title)}${tickers}</h3>
      <div class="ev-chips">${chips}</div>
      ${e.detail ? `<p class="ev-detail">${esc(e.detail)}</p>` : ''}
      ${dataTable(e)}
      ${res}
      <p class="ev-means"><b>What it could mean.</b> ${esc(e.means)}</p>
      <details class="ev-more"><summary>Why ${esc(IMPACT[e.impact].toLowerCase())} impact${e.source ? ' and source' : ''}</summary>
        <p>${esc(e.impactWhy)}</p>
        ${e.source ? `<p>Source: ${e.source.url ? `<a href="${esc(e.source.url)}" target="_blank" rel="noopener">${esc(e.source.name)}</a>` : esc(e.source.name)}${e.official ? ', typed in from the published calendar' : ''}.</p>` : ''}
      </details>
    </div>
  </article>`;
}

export function listHtml(d, st) {
  const list = filterEvents(d, st);
  if (!list.length) return `<div class="card ev-empty"><p class="muted">No events match these filters. Try showing all impact levels or another category.</p></div>`;
  return groupByDay(list, st.view === 'recent')
    .map(([day, evs]) => `<section class="ev-day${day === d.today ? ' today' : ''}"><h3 class="ev-dh"><span>${esc(fmtDay(day))}</span><small>${esc(relDay(day, d.today))}</small></h3>
      <div class="card ev-list">${evs.map((e) => eventHtml(e, d)).join('')}</div></section>`)
    .join('');
}

export function nextUp(d, n = 3) {
  return d.events.filter((e) => e.date >= d.today && e.impact === 3).slice(0, n);
}

function nextHtml(d) {
  const nx = nextUp(d);
  if (!nx.length) return '';
  return `<div class="ev-next">${nx
    .map((e) => `<a class="card ev-nx" href="#/events" data-jump="${esc(e.id)}"><span class="small muted">${esc(relDay(e.date, d.today))} · ${esc(fmtDay(e.date))}${e.time ? ` · ${esc(fmtTime(e.time))}` : ''}</span><b>${esc(e.title)}</b><span class="small">${esc(e.impactWhy)}</span></a>`)
    .join('')}</div>`;
}

const FEED_NAMES = { econ: 'Nasdaq economic calendar (actual vs expected, Fed speakers)', earnings: 'Earnings dates (Nasdaq, Yahoo Finance)', ipo: 'IPO lockups (Nasdaq IPO calendar)', splits: 'Stock splits (Nasdaq)', auctions: 'Treasury auctions (US Treasury Fiscal Data)' };

function footHtml(d) {
  const thru = fmtDay(d.officialThrough);
  return `<h2 class="section">How impact is rated</h2>
    <div class="card ev-legend"><ul>
      <li><span class="ev-imp i3">High</span> Has often moved the whole market by itself: Fed decisions, CPI, the jobs report and results from the very largest companies.</li>
      <li><span class="ev-imp i2">Medium</span> Can move a sector, bonds or the market on a big surprise: PCE, retail sales, ISM, GDP, quad witching, index rebalances, OPEC+, funding deadlines, and earnings from big companies or ones on your watchlist.</li>
      <li><span class="ev-imp i1">Low</span> Usually background noise unless something unusual happens: weekly claims, monthly options expiration, smaller auctions, holidays.</li>
    </ul><p class="small muted">Ratings are a rule of thumb from how markets have typically reacted. Any event can matter more when expectations are finely balanced.</p></div>

    <h2 class="section">Where the dates come from</h2>
    <div class="card ev-src">
      <div class="src">${Object.entries(d.feeds).map(([k, f]) => `<span class="chip ${f.ok ? 'ok' : 'no'}" title="${esc(f.note || '')}">${esc(FEED_NAMES[k] || k)}${f.ok ? '' : ': ' + esc(f.note || 'unavailable')}</span>`).join('')}</div>
      <p class="small">Official calendars typed in by hand because no free API publishes them: Federal Reserve meetings and minutes, BLS (CPI, jobs, PPI, JOLTS), BEA (GDP, PCE), Census (retail sales, durable goods), NYSE holidays and early closes, Russell reconstitution, OPEC+ and the federal funding deadline. These were checked against the official pages on Nov 22, 2026 and run through ${esc(thru)}. 2027 Fed dates are tentative until confirmed.</p>
      <p class="small">Computed from exchange and agency rules: monthly options expiration and quad witching (third Friday), VIX expiration, S&amp;P 500 rebalances and their expected announcement dates, the Nasdaq 100 reconstitution, weekly jobless claims and ISM survey days. IPO lockups assume the standard 180 days.</p>
    </div>

    <h2 class="section">Not included</h2>
    <div class="card mk-na"><ul>${NOT_COVERED.map((n) => `<li><b>${esc(n.name)}.</b> <span class="muted">${esc(n.reason)}</span></li>`).join('')}</ul></div>

    <div class="notice"><b>Educational, not financial advice.</b> The notes describe how markets have often reacted to events like these; they are not forecasts or recommendations to buy or sell. Dates can change, forecasts come from third parties, and data can be delayed or wrong. Check the official source before acting, and consult a licensed professional for advice.</div>`;
}

const PREF = 'events:prefs';
function loadPrefs() {
  try {
    return JSON.parse(localStorage.getItem(PREF)) || {};
  } catch {
    return {};
  }
}
function savePrefs(st) {
  try {
    localStorage.setItem(PREF, JSON.stringify({ view: st.view, min: st.min, cat: st.cat, mine: st.mine }));
  } catch {}
}

async function watchTickers() {
  try {
    const s = await import('/session.js');
    const u = await s.getMe();
    if (!u) return [];
    const d = await s.req('GET', '/api/watchlist/tickers');
    return [...new Set((d.lists || []).flatMap((l) => l.tickers || []))].slice(0, 25);
  } catch {
    return [];
  }
}

export async function renderEvents(app, api) {
  app.innerHTML = `<section class="hero"><h1>Market events</h1><p>Recent and upcoming events that can move the market, with an impact rating and what each could mean.</p></section>
    <div class="loading"><div class="spinner"></div>Gathering calendars, earnings dates and the latest data…</div>`;
  const watch = await watchTickers();
  let d;
  try {
    d = await api(`/api/events${watch.length ? `?watch=${encodeURIComponent(watch.join(','))}` : ''}`);
  } catch (e) {
    app.innerHTML = `<div class="err"><h2>Could not load market events</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  const st = { view: 'upcoming', min: 2, cat: 'all', mine: false, ...loadPrefs() };
  if (!d.watch.length) st.mine = false;
  const counts = { up: d.events.filter((e) => e.date >= d.today).length, rec: d.events.filter((e) => e.date < d.today).length };
  const seg = (name, opts, cur) => `<div class="ev-seg" role="group" data-k="${name}">${opts.map(([v, l]) => `<button type="button" data-v="${esc(v)}" aria-pressed="${String(v) === String(cur)}">${esc(l)}</button>`).join('')}</div>`;
  const paint = () => {
    app.innerHTML = `
      <section class="hero"><h1>Market events</h1>
        <p>Recent and upcoming events that can move the market: Fed meetings, inflation and jobs data, big earnings, options expirations, index rebalances and more. Each has an impact rating and a plain language note on what it could mean.</p>
        <div class="meta-line">Updated ${esc(new Date(d.asOf).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))} · Times are US Eastern${d.watch.length ? ` · Flagging ${d.watch.length} watchlist tickers` : ' · <a href="#/login">Log in</a> to flag your watchlist'}</div></section>
      ${d.partial ? '<div class="notice">Some feeds are still loading in the background. Refresh in a minute for the rest.</div>' : ''}
      <h2 class="section">Next high impact events</h2>
      ${nextHtml(d)}
      <div class="ev-bar">
        ${seg('view', [['upcoming', `Upcoming (${counts.up})`], ['recent', `Recent (${counts.rec})`]], st.view)}
        ${seg('min', [[1, 'All'], [2, 'Medium and high'], [3, 'High only']], st.min)}
        <label class="ev-sel"><span class="small muted">Type</span><select id="evCat"><option value="all">All types</option>${Object.entries(d.cats).map(([k, v]) => `<option value="${esc(k)}"${st.cat === k ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
        ${d.watch.length ? `<label class="ev-mine"><input type="checkbox" id="evMine"${st.mine ? ' checked' : ''}/> My watchlist only</label>` : ''}
      </div>
      <div id="evList">${listHtml(d, st)}</div>
      ${footHtml(d)}`;
    app.querySelectorAll('.ev-seg').forEach((g) =>
      g.addEventListener('click', (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        const k = g.dataset.k;
        st[k] = k === 'min' ? Number(b.dataset.v) : b.dataset.v;
        savePrefs(st);
        paint();
      })
    );
    const cat = app.querySelector('#evCat');
    if (cat) cat.addEventListener('change', () => ((st.cat = cat.value), savePrefs(st), paint()));
    const mine = app.querySelector('#evMine');
    if (mine) mine.addEventListener('change', () => ((st.mine = mine.checked), savePrefs(st), paint()));
    app.querySelectorAll('[data-jump]').forEach((a) =>
      a.addEventListener('click', (ev) => {
        ev.preventDefault();
        const id = a.dataset.jump;
        let el = app.querySelector(`.ev[data-id="${CSS.escape(id)}"]`);
        if (!el) {
          Object.assign(st, { view: 'upcoming', min: 1, cat: 'all', mine: false });
          paint();
          el = app.querySelector(`.ev[data-id="${CSS.escape(id)}"]`);
        }
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          el.classList.add('flash');
          setTimeout(() => el.classList.remove('flash'), 1600);
        }
      })
    );
  };
  paint();
}
