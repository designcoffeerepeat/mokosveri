// Option chain on the ticker page. Nothing loads until the section scrolls
// near the screen, so the rest of the page stays fast. Calls on the left, puts
// on the right, strike in the middle, in the money cells shaded. Tapping a
// contract opens the options calculator with that exact contract filled in.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ok = (v) => v != null && isFinite(v);
const DAY = 864e5;
const RATE = 0.04;

const price = (v) => (ok(v) && v > 0 ? Number(v).toFixed(2) : '-');
const int = (v) => (ok(v) && v > 0 ? Math.round(v).toLocaleString('en-US') : '-');
const ivPct = (v) => (ok(v) && v > 0.0001 ? `${(v * 100).toFixed(1)}%` : '-');
const deltaFmt = (v) => (ok(v) ? v.toFixed(2) : '-');
const strikeFmt = (k) => String(+Number(k).toFixed(2));

// Options expire at the 4 PM New York close, about 21:00 UTC.
export const expClose = (epochSec) => {
  const d = new Date(epochSec * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 21, 0, 0);
};

export const expLabel = (epochSec, now = Date.now()) => {
  const ms = expClose(epochSec);
  const days = Math.max(0, Math.ceil((ms - now) / DAY));
  const d = new Date(ms).toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: new Date(ms).getUTCFullYear() !== new Date(now).getUTCFullYear() ? 'numeric' : undefined });
  return `${d} (${days === 0 ? 'today' : `${days}d`})`;
};

function ncdf(x) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

// Black-Scholes delta from the quoted implied volatility.
export function delta(type, S, K, T, iv, q = 0, r = RATE) {
  if (!(S > 0) || !(K > 0)) return null;
  if (T <= 0 || !(iv > 0.0001)) return type === 'C' ? (S > K ? 1 : 0) : S < K ? -1 : 0;
  const d1 = (Math.log(S / K) + (r - q + (iv * iv) / 2) * T) / (iv * Math.sqrt(T));
  return type === 'C' ? Math.exp(-q * T) * ncdf(d1) : Math.exp(-q * T) * (ncdf(d1) - 1);
}

// Merge calls and puts into one row per strike, keeping only `around` strikes
// on each side of the current price (0 = all strikes).
export function chainRows(chain, around = 10) {
  const by = new Map();
  for (const c of chain.calls || []) by.set(c.strike, { strike: c.strike, call: c, put: null });
  for (const p of chain.puts || []) {
    const r = by.get(p.strike);
    if (r) r.put = p;
    else by.set(p.strike, { strike: p.strike, call: null, put: p });
  }
  const rows = [...by.values()].sort((a, b) => a.strike - b.strike);
  const S = chain.price;
  // Index of the first strike above the price; the price line sits before it.
  let split = rows.findIndex((r) => r.strike > S);
  if (split < 0) split = rows.length;
  if (!around || !ok(S)) return { rows, split };
  const from = Math.max(0, split - around);
  const to = Math.min(rows.length, split + around);
  return { rows: rows.slice(from, to), split: split - from, hidden: rows.length - (to - from) };
}

// Calculator link for one contract. side 1 = buy, -1 = sell.
export function calcHref(ticker, expiration, strike, type, side = 1) {
  const p = new URLSearchParams({ t: ticker, exp: String(expiration), k: String(strike), type, side: String(side) });
  return `#/options?${p.toString()}`;
}

const COLS = [
  ['bid', 'Bid', price],
  ['ask', 'Ask', price],
  ['last', 'Last', price],
  ['vol', 'Volume', int],
  ['oi', 'Open int.', int],
  ['iv', 'IV', ivPct],
  ['delta', 'Delta', deltaFmt],
];

export function chainTableHtml(chain, opts = {}) {
  const { around = 10, view = 'both', side = 1, now = Date.now() } = opts;
  const { rows, split, hidden } = chainRows(chain, around);
  const S = chain.price;
  const T = Math.max(0, (expClose(chain.expiration) - now) / (365 * DAY));
  const q = chain.dividendYield || 0;
  const showC = view !== 'puts';
  const showP = view !== 'calls';
  const cols = COLS;
  const cellsFor = (c, type, itm) => {
    if (!c) return cols.map(() => `<td class="num oc-${type === 'C' ? 'c' : 'p'}${itm ? ' itm' : ''}">-</td>`).join('');
    const d = delta(type, S, c.strike, T, c.iv, q);
    return cols
      .map(([k, , f]) => `<td class="num oc-${type === 'C' ? 'c' : 'p'}${itm ? ' itm' : ''}">${f(k === 'delta' ? d : c[k])}</td>`)
      .join('');
  };
  const verb = side === 1 ? 'Buy' : 'Sell';
  const linkFor = (c, type) =>
    c
      ? `<a class="oc-go" data-type="${type}" href="${esc(calcHref(chain.symbol, chain.expiration, c.strike, type, side))}" aria-label="${verb} the ${strikeFmt(c.strike)} ${type === 'C' ? 'call' : 'put'} in the options calculator" title="Open in the options calculator"><svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><rect x="5" y="3" width="14" height="18" rx="2.5" stroke="currentColor" stroke-width="2" fill="none"/><path d="M9 7h6M9 12h1.5M13.5 12H15M9 16h1.5M13.5 16H15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg></a>`
      : '';
  const colHeads = cols.map(([, l]) => `<th class="num">${l}</th>`).join('');
  // One side only (handy on phones): strike first so it stays in view.
  const single = showC !== showP;
  const head1 = single
    ? `<tr class="oc-h1"><th colspan="${cols.length + 2}" class="oc-side">${showC ? 'Calls' : 'Puts'}</th></tr>`
    : `<tr class="oc-h1"><th colspan="${cols.length + 1}" class="oc-side">Calls</th><th class="oc-k"></th><th colspan="${cols.length + 1}" class="oc-side">Puts</th></tr>`;
  const head2 = single
    ? `<tr><th class="oc-gocol"></th><th class="num oc-k">Strike</th>${colHeads}</tr>`
    : `<tr><th class="oc-gocol"></th>${colHeads}<th class="num oc-k">Strike</th>${colHeads}<th class="oc-gocol"></th></tr>`;
  const span = single ? cols.length + 2 : 2 * cols.length + 3;
  const priceRow = `<tr class="oc-px"><td colspan="${span}"><span>${esc(chain.symbol)} ${price(S)}</span></td></tr>`;
  const body = rows
    .map((r, i) => {
      const cItm = r.strike < S;
      const pItm = r.strike > S;
      const k = `<td class="num oc-k">${strikeFmt(r.strike)}</td>`;
      const cGo = `<td class="oc-gocol${cItm ? ' itm' : ''}">${linkFor(r.call, 'C')}</td>`;
      const pGo = `<td class="oc-gocol${pItm ? ' itm' : ''}">${linkFor(r.put, 'P')}</td>`;
      const row = !single
        ? `<tr>${cGo}${cellsFor(r.call, 'C', cItm)}${k}${cellsFor(r.put, 'P', pItm)}${pGo}</tr>`
        : showC
          ? `<tr>${cGo}${k}${cellsFor(r.call, 'C', cItm)}</tr>`
          : `<tr>${pGo}${k}${cellsFor(r.put, 'P', pItm)}</tr>`;
      return (i === split ? priceRow : '') + row;
    })
    .join('');
  const tail = split >= rows.length ? priceRow : '';
  return { html: `<table class="oc-tbl${showC && showP ? ' both' : ''}"><thead>${head1}${head2}</thead><tbody>${body}${tail}</tbody></table>`, hidden: hidden || 0 };
}

// ---------- mounting ----------
export function mountChain(box, ticker, api) {
  const st = {
    chain: null,
    around: 10,
    view: typeof matchMedia === 'function' && matchMedia('(max-width: 720px)').matches ? 'calls' : 'both',
    side: 1,
    loading: false,
    error: '',
  };

  const seg = (name, items, cur) =>
    `<div class="oc-seg" role="group" aria-label="${esc(name)}">${items.map(([v, l]) => `<button type="button" data-${name}="${v}" class="${String(cur) === String(v) ? 'on' : ''}" aria-pressed="${String(cur) === String(v)}">${l}</button>`).join('')}</div>`;

  function paint() {
    if (!box.isConnected) return;
    const c = st.chain;
    if (st.error && !c) {
      box.innerHTML = `<div class="card oc-card"><p class="muted oc-note">Option chain could not load: ${esc(st.error)} <button type="button" class="oc-retry" data-act="retry">Try again</button></p></div>`;
      return;
    }
    if (!c) {
      box.innerHTML = `<div class="card oc-card"><div class="loading-note"><div class="spinner sm"></div>Loading the option chain…</div></div>`;
      return;
    }
    if (!c.chain || !c.expirations.length) {
      box.innerHTML = `<div class="card oc-card"><p class="muted oc-note">No listed options found for ${esc(ticker)} right now. You can still model a trade with estimated prices in the <a href="${esc(`#/options?t=${encodeURIComponent(ticker)}`)}">options calculator</a>.</p></div>`;
      return;
    }
    const t = chainTableHtml(c, st);
    const opts = c.expirations.map((e) => `<option value="${e}"${e === c.expiration ? ' selected' : ''}>${esc(expLabel(e))}</option>`).join('');
    box.innerHTML = `<div class="card oc-card${st.loading ? ' busy' : ''}">
      <div class="oc-bar">
        <label class="oc-exp"><span>Expiration</span><select data-act="exp">${opts}</select></label>
        ${seg('view', [['both', 'Both'], ['calls', 'Calls'], ['puts', 'Puts']], st.view)}
        ${seg('side', [[1, 'Buy'], [-1, 'Sell']], st.side)}
      </div>
      <div class="tbl-wrap oc-wrap">${t.html}</div>
      <div class="oc-foot">
        <span class="muted">Shaded cells are in the money. Tap a contract to ${st.side === 1 ? 'buy' : 'sell'} it in the options calculator. Delta is estimated from IV. Quotes can be delayed.</span>
        ${t.hidden || st.around === 0 ? `<button type="button" class="oc-more" data-act="more">${st.around === 0 ? 'Show strikes near the price' : `Show all strikes (${t.hidden} more)`}</button>` : ''}
      </div>
    </div>`;
  }

  async function load(date = null) {
    st.loading = true;
    st.error = '';
    paint();
    try {
      const d = await api(`/api/options/${encodeURIComponent(ticker)}${date ? `?date=${date}` : ''}`);
      st.chain = d;
    } catch (e) {
      st.error = e.message || 'Request failed';
    }
    st.loading = false;
    paint();
  }

  box.addEventListener('change', (e) => {
    if (e.target.dataset.act === 'exp') load(e.target.value);
  });
  box.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) {
      if (b.dataset.view) st.view = b.dataset.view;
      else if (b.dataset.side) st.side = +b.dataset.side;
      else if (b.dataset.act === 'more') st.around = st.around === 0 ? 10 : 0;
      else if (b.dataset.act === 'retry') return load(st.chain ? st.chain.expiration : null);
      else return;
      return paint();
    }
    // Tapping anywhere on one side of a row opens that contract.
    if (e.target.closest('a')) return;
    const td = e.target.closest('td.oc-c, td.oc-p');
    if (!td) return;
    const tr = td.closest('tr');
    const type = td.classList.contains('oc-c') ? 'C' : 'P';
    const link = [...tr.querySelectorAll('a.oc-go')].find((a) => a.dataset.type === type);
    if (link) location.hash = link.getAttribute('href');
  });

  paint();
  // Lazy: fetch only once the section is close to the viewport.
  if (typeof IntersectionObserver === 'function') {
    const io = new IntersectionObserver(
      (ents) => {
        if (ents.some((x) => x.isIntersecting)) {
          io.disconnect();
          load();
        }
      },
      { rootMargin: '300px 0px' }
    );
    io.observe(box);
  } else load();
}
