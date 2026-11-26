// Dividend income calculators on the aristocrats page: one stock (an
// aristocrat or dividend ETF from the list, or any dividend ticker typed in)
// and a mix of several aristocrats and ETFs. Pure helpers are exported for the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const usd = (v, d = 0) => (v == null || !isFinite(v) ? 'n/a' : (v < 0 ? '-$' : '$') + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pc = (v, d = 2) => (v == null || !isFinite(v) ? 'n/a' : `${Number(v).toFixed(d)}%`);

export const YEARS = [1, 3, 5, 10, 15, 20, 25, 30];
export const PAGE = 20;
// Historical dividend growth is used as the default projection, held inside
// these bounds so one odd year (a special dividend, a cut) does not run away.
export const GROWTH_MIN = -10;
export const GROWTH_MAX = 15;
export const clampGrowth = (g) => (g == null || !isFinite(g) ? null : Math.min(GROWTH_MAX, Math.max(GROWTH_MIN, Math.round(g * 10) / 10)));

const num = (v, lo, hi, dflt) => {
  const x = typeof v === 'string' ? parseFloat(v.replace(/[$,\s]/g, '')) : v;
  return typeof x === 'number' && isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt;
};

// Year by year income from `amount` invested at `yieldPct`. The dividend per
// share grows `growthPct` a year; the share price grows `priceGrowthPct` (the
// same as the dividend when left out, which keeps the yield steady). With DRIP
// each year's dividends buy more shares at the year end price.
export function project({ amount, yieldPct, years, growthPct = 0, priceGrowthPct = null, drip = false }) {
  amount = num(amount, 0, 1e12, 0);
  years = Math.round(num(years, 1, 50, 10));
  const g = num(growthPct, -50, 50, 0) / 100;
  const pg = num(priceGrowthPct ?? growthPct, -50, 50, 0) / 100;
  let shares = amount;
  let price = 1;
  let dps = num(yieldPct, 0, 100, 0) / 100;
  let total = 0;
  const rows = [];
  for (let y = 1; y <= years; y++) {
    const income = shares * dps;
    total += income;
    price *= 1 + pg;
    if (drip && price > 0) shares += income / price;
    rows.push({ year: y, income, total, value: shares * price, yoc: amount ? (income / amount) * 100 : 0 });
    dps *= 1 + g;
  }
  const last = rows[rows.length - 1];
  return { amount, years, drip, rows, first: rows[0].income, last: last.income, total, endValue: last.value, endYoc: last.yoc };
}

// Several holdings over the same timeframe. Each holding: {t, amount, yield, growth}.
export function portfolio(holdings, { years, drip, priceGrowthPct = null }) {
  const items = holdings
    .filter((h) => h && num(h.amount, 0, 1e12, 0) > 0)
    .map((h) => ({ ...h, p: project({ amount: h.amount, yieldPct: h.yield || 0, years, growthPct: h.growth || 0, priceGrowthPct, drip }) }));
  const amount = items.reduce((s, h) => s + h.p.amount, 0);
  const n = items.length ? items[0].p.rows.length : Math.round(num(years, 1, 50, 10));
  const rows = [];
  for (let i = 0; i < n; i++) {
    const r = { year: i + 1, income: 0, total: 0, value: 0 };
    for (const h of items) {
      r.income += h.p.rows[i].income;
      r.total += h.p.rows[i].total;
      r.value += h.p.rows[i].value;
    }
    r.yoc = amount ? (r.income / amount) * 100 : 0;
    rows.push(r);
  }
  const last = rows[rows.length - 1] || { income: 0, total: 0, value: 0, yoc: 0 };
  return {
    items,
    amount,
    yield: amount ? items.reduce((s, h) => s + h.p.amount * (h.yield || 0), 0) / amount : 0,
    growth: amount ? items.reduce((s, h) => s + h.p.amount * (h.growth || 0), 0) / amount : 0,
    rows,
    first: rows.length ? rows[0].income : 0,
    last: last.income,
    total: last.total,
    endValue: last.value || amount,
    endYoc: last.yoc,
  };
}

// Aristocrats for the picker, highest yield first (ties by name).
export function byYield(rows) {
  return [...rows].filter((r) => r.yield != null).sort((a, b) => b.yield - a.yield || a.t.localeCompare(b.t));
}

// Picker options: the first `shown` aristocrats, then every dividend ETF.
export function optionsHtml(list, shown, selected, funds = []) {
  const opt = (r, i) => `<option value="${esc(r.t)}"${r.t === selected ? ' selected' : ''}>${i + 1}. ${esc(r.t)}  ${esc(r.name)}  ${r.yield.toFixed(2)}%</option>`;
  const a = list.slice(0, shown).map(opt).join('');
  if (!funds.length) return a;
  return `<optgroup label="Aristocrats, highest yield first">${a}</optgroup><optgroup label="Dividend ETFs, highest yield first">${funds.map(opt).join('')}</optgroup>`;
}

export const isCoveredCall = (r) => !!r && r.sector === 'Covered call income';

// Yearly income bars. One series, so no legend; the year table is the table view.
export function barsHtml(rows) {
  if (!rows.length) return '';
  const w = 600, h = 150, pad = 4;
  const max = Math.max(...rows.map((r) => r.income)) || 1;
  const bw = w / rows.length;
  const gap = Math.min(4, bw * 0.25);
  const bars = rows
    .map((r, i) => {
      const bh = Math.max(1, (r.income / max) * (h - pad));
      const x = i * bw + gap / 2;
      const y = h - bh;
      const rx = Math.min(4, (bw - gap) / 2, bh);
      return `<g class="dc-bar"><rect class="dc-hit" x="${(i * bw).toFixed(1)}" y="0" width="${bw.toFixed(1)}" height="${h}"/><path d="M${x.toFixed(1)},${h} V${(y + rx).toFixed(1)} Q${x.toFixed(1)},${y.toFixed(1)} ${(x + rx).toFixed(1)},${y.toFixed(1)} H${(x + bw - gap - rx).toFixed(1)} Q${(x + bw - gap).toFixed(1)},${y.toFixed(1)} ${(x + bw - gap).toFixed(1)},${(y + rx).toFixed(1)} V${h} Z"/><title>Year ${r.year}: ${usd(r.income)} income, ${usd(r.total)} so far</title></g>`;
    })
    .join('');
  return `<figure class="dc-chart"><figcaption class="small muted">Income each year</figcaption>
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="Yearly dividend income, from ${usd(rows[0].income)} in year 1 to ${usd(rows[rows.length - 1].income)} in year ${rows.length}">${bars}</svg>
    <div class="dc-axis small muted"><span>Year 1</span><span>Year ${rows.length}</span></div></figure>`;
}

export function yearTableHtml(rows, drip) {
  return `<details class="dc-years"><summary class="small">Year by year</summary><div class="tbl-wrap"><table><thead><tr><th>Year</th><th class="num">Income</th><th class="num">Monthly</th><th class="num">Total so far</th><th class="num">Yield on cost</th><th class="num">${drip ? 'Holding value' : 'Shares value'}</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td class="mono">${r.year}</td><td class="num">${usd(r.income)}</td><td class="num">${usd(r.income / 12)}</td><td class="num">${usd(r.total)}</td><td class="num">${pc(r.yoc)}</td><td class="num">${usd(r.value)}</td></tr>`)
    .join('')}</tbody></table></div></details>`;
}

export function resultHtml(p, { years, drip }) {
  const kv = (k, v, sub = '') => `<div class="dc-kpi"><dt>${k}</dt><dd class="mono">${v}</dd>${sub ? `<small class="muted">${sub}</small>` : ''}</div>`;
  return `<dl class="dc-kpis">
      ${kv('Income in year 1', usd(p.first), `${usd(p.first / 12)} a month`)}
      ${kv(`Income in year ${years}`, usd(p.last), `${usd(p.last / 12)} a month · ${pc(p.endYoc, 1)} on cost`)}
      ${kv(`Total over ${years} year${years === 1 ? '' : 's'}`, usd(p.total), drip ? 'all reinvested' : 'paid out in cash')}
      ${kv(drip ? 'Holding value at the end' : 'Shares value at the end', usd(p.endValue), drip ? 'includes reinvested dividends' : `plus ${usd(p.total)} cash received`)}
    </dl>
    ${barsHtml(p.rows)}
    ${yearTableHtml(p.rows, drip)}`;
}

// ---------- page wiring ----------

const KEY = 'dividends:calc';
function load() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function save(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {}
}

const yearsSel = (id, v) => `<label class="ev-sel"><span class="small muted">Timeframe</span><select id="${id}">${YEARS.map((y) => `<option value="${y}"${y === v ? ' selected' : ''}>${y} year${y === 1 ? '' : 's'}</option>`).join('')}</select></label>`;
const dripBox = (id, on) => `<label class="dc-check"><input type="checkbox" id="${id}"${on ? ' checked' : ''}/> <span>Reinvest dividends (DRIP)</span></label>`;

export function mountCalculators(el, rows, api, etfs = []) {
  const list = byYield(rows);
  const funds = byYield(etfs || []);
  const all = [...list, ...funds];
  const saved = load();
  const s = {
    pick: all.some((r) => r.t === saved.pick) ? saved.pick : list[0] && list[0].t,
    mode: saved.mode === 'custom' ? 'custom' : 'list',
    custom: typeof saved.custom === 'string' ? saved.custom : '',
    amount: num(saved.amount, 0, 1e9, 10000),
    years: YEARS.includes(saved.years) ? saved.years : 10,
    drip: saved.drip !== false,
    shown: Math.max(PAGE, Math.min(list.length, saved.shown || PAGE)),
    port: saved.port && typeof saved.port === 'object' ? saved.port : {},
    pYears: YEARS.includes(saved.pYears) ? saved.pYears : 10,
    pDrip: saved.pDrip !== false,
    pGrowth: saved.pGrowth === 'fixed' ? 'fixed' : 'own',
    pFixed: num(saved.pFixed, GROWTH_MIN, GROWTH_MAX, 5),
    pFilter: '',
  };
  if (s.shown < list.length && list.findIndex((r) => r.t === s.pick) >= s.shown) s.shown = Math.min(list.length, Math.ceil((list.findIndex((r) => r.t === s.pick) + 1) / PAGE) * PAGE);
  for (const t of Object.keys(s.port)) if (!all.some((r) => r.t === t)) delete s.port[t];
  const persist = () => save({ pick: s.pick, mode: s.mode, custom: s.custom, amount: s.amount, years: s.years, drip: s.drip, shown: s.shown, port: s.port, pYears: s.pYears, pDrip: s.pDrip, pGrowth: s.pGrowth, pFixed: s.pFixed });

  // Per ticker yield and dividend growth from /api/dividends/calc, fetched once.
  const info = {};
  const pending = {};
  const getInfo = (t) => {
    if (info[t]) return Promise.resolve(info[t]);
    if (!pending[t])
      pending[t] = api(`/api/dividends/calc/${encodeURIComponent(t)}`)
        .then((d) => (info[t] = d))
        .catch((e) => {
          delete pending[t];
          throw e;
        });
    return pending[t];
  };
  const rowOf = (t) => all.find((r) => r.t === t);

  el.innerHTML = `
    <div class="card dc-card" id="dcOne">
      <div class="dc-head"><h3>One stock</h3><p class="small muted">Pick an aristocrat or dividend ETF, or type any dividend ticker, then set how much and for how long.</p></div>
      <div class="ev-seg dc-mode" role="group" aria-label="Choose a stock">
        <button type="button" data-mode="list" aria-pressed="${s.mode === 'list'}">Aristocrat or ETF</button><button type="button" data-mode="custom" aria-pressed="${s.mode === 'custom'}">Other ticker</button>
      </div>
      <div class="dc-row dc-pick-list"${s.mode === 'list' ? '' : ' hidden'}>
        <label class="dc-field dc-grow"><span class="small muted">Aristocrats first, then dividend ETFs</span><select id="dcPick"></select></label>
        <button type="button" class="btn-ghost" id="dcMore"></button>
      </div>
      <form class="dc-row dc-pick-custom" id="dcCustomForm"${s.mode === 'custom' ? '' : ' hidden'}>
        <label class="dc-field dc-grow"><span class="small muted">Ticker (stock or fund)</span><input id="dcCustom" class="mono" autocomplete="off" spellcheck="false" maxlength="10" placeholder="e.g. MO, VZ, JEPI" value="${esc(s.custom)}"/></label>
        <button type="submit" class="btn-primary sm">Get yield</button>
      </form>
      <div class="dc-row">
        <label class="dc-field"><span class="small muted">Amount to invest</span><input id="dcAmount" class="mono" inputmode="decimal" value="${s.amount}"/></label>
        ${yearsSel('dcYears', s.years)}
        <label class="dc-field dc-sm"><span class="small muted">Dividend growth / yr</span><input id="dcGrowth" class="mono" inputmode="decimal" placeholder="%"/></label>
        <label class="dc-field dc-sm"><span class="small muted">Price growth / yr</span><input id="dcPrice" class="mono" inputmode="decimal" placeholder="same"/></label>
        ${dripBox('dcDrip', s.drip)}
      </div>
      <div id="dcInfo" class="dc-info small"></div>
      <div id="dcOut"></div>
    </div>

    <div class="card dc-card" id="dcMix">
      <div class="dc-head"><h3>Several aristocrats and ETFs</h3><p class="small muted">Tick the companies and funds you want, set an amount for each, and see the combined yield and income.</p></div>
      <div class="dc-row">
        <label class="dc-field dc-grow"><span class="small muted">Find</span><input id="dcFilter" placeholder="Ticker, name or sector" autocomplete="off"/></label>
        <label class="dc-field"><span class="small muted">Amount per pick</span><input id="dcEach" class="mono" inputmode="decimal" value="1000"/></label>
      </div>
      <div class="dc-list" id="dcList" role="group" aria-label="Aristocrats and dividend ETFs"></div>
      <div class="dc-row">
        ${yearsSel('dcPYears', s.pYears)}
        <label class="ev-sel"><span class="small muted">Dividend growth</span><select id="dcPGrowth"><option value="own"${s.pGrowth === 'own' ? ' selected' : ''}>Each pick's last 5 years</option><option value="fixed"${s.pGrowth === 'fixed' ? ' selected' : ''}>Same rate for all</option></select></label>
        <label class="dc-field dc-sm" id="dcPFixedWrap"${s.pGrowth === 'fixed' ? '' : ' hidden'}><span class="small muted">Rate / yr</span><input id="dcPFixed" class="mono" inputmode="decimal" value="${s.pFixed}"/></label>
        ${dripBox('dcPDrip', s.pDrip)}
      </div>
      <div id="dcPOut"></div>
    </div>
    <p class="small muted">Projections, not promises. They assume the yield you see today, steady dividend growth at the rate shown, and no taxes or fees. Dividend growth defaults to each company's or fund's change in yearly payouts over the last 5 full years (held between ${GROWTH_MIN}% and ${GROWTH_MAX}%). Price growth defaults to the dividend growth rate, which keeps the yield on new purchases steady; DRIP buys more shares at that price each year end.</p>`;

  const $ = (sel) => el.querySelector(sel);

  // ----- one stock -----
  let cur = null; // {t, name, yield, growth, growthYears, raises, ...}
  let growthTouched = false;

  const paintPicker = () => {
    $('#dcPick').innerHTML = optionsHtml(list, s.shown, s.pick, funds);
    const more = $('#dcMore');
    const left = list.length - s.shown;
    more.hidden = left <= 0;
    more.textContent = `Load ${Math.min(PAGE, left)} more`;
  };

  const paintOne = () => {
    const out = $('#dcOut');
    if (!cur) return;
    if (!cur.yield) {
      out.innerHTML = `<div class="notice">${esc(cur.t)} has not paid a dividend in the last year, so there is no income to project.</div>`;
      return;
    }
    const g = num($('#dcGrowth').value, -50, 50, 0);
    const pRaw = $('#dcPrice').value.trim();
    const p = project({ amount: s.amount, yieldPct: cur.yield, years: s.years, growthPct: g, priceGrowthPct: pRaw === '' ? null : num(pRaw, -50, 50, g), drip: s.drip });
    out.innerHTML = resultHtml(p, { years: s.years, drip: s.drip });
  };

  const paintInfo = (msg) => {
    const box = $('#dcInfo');
    if (msg) return void (box.innerHTML = msg);
    if (!cur) return void (box.innerHTML = '');
    const bits = [`<a class="mono" href="#/t/${encodeURIComponent(cur.t)}"><b>${esc(cur.t)}</b></a> ${esc(cur.name || '')}`, `yield <b class="mono">${pc(cur.yield)}</b>${cur.basis === 'trailing' ? ' (last 12 months)' : ''}`];
    if (cur.price) bits.push(`price ${usd(cur.price, 2)}`);
    if (cur.payments) bits.push(`${cur.payments} payment${cur.payments === 1 ? '' : 's'} a year`);
    if (cur.raises) bits.push(`${cur.raises} years of raises`);
    if (cur.er != null) bits.push(`fee ${pc(cur.er)} a year`);
    if (cur.growth != null) bits.push(`dividends ${cur.growth >= 0 ? 'grew' : 'fell'} ${pc(Math.abs(cur.growth), 1)} a year over ${cur.growthYears} years`);
    else if (cur.loading) bits.push('<span class="muted">loading dividend history…</span>');
    let warn = '';
    if (cur.cc) warn = '<div class="notice small">Covered call fund: much of the payout is option premium, so it moves with market volatility, can shrink, and rarely grows like a dividend. Consider a dividend growth of 0% or less.</div>';
    else if (cur.yield >= 8) warn = `<div class="notice small">A ${pc(cur.yield, 1)} yield is very high. It often means the market expects a cut, or the payout includes option premium or return of capital. Check that it is covered before counting on it.</div>`;
    else if (cur.growth != null && cur.growth < 0) warn = '<div class="notice small">This payout has shrunk over the period, so the default projection has it shrinking too.</div>';
    box.innerHTML = `<div>${bits.join(' · ')}</div>${warn}`;
  };

  const setGrowthDefault = () => {
    if (growthTouched || !cur) return;
    const g = clampGrowth(cur.growth);
    $('#dcGrowth').value = g == null ? (cur.loading ? '' : '0') : String(g);
  };

  const choose = async (t, fromList) => {
    growthTouched = false;
    const r = fromList ? rowOf(t) : null;
    cur = r ? { t, name: r.name, yield: r.yield, raises: r.years, price: r.price, er: r.er, cc: isCoveredCall(r), basis: r.etf ? 'trailing' : 'forward', loading: true } : null;
    if (cur) {
      setGrowthDefault();
      paintInfo();
      paintOne();
    } else {
      $('#dcOut').innerHTML = '';
      paintInfo(`<span class="muted">Looking up ${esc(t)}…</span>`);
    }
    try {
      const d = await getInfo(t);
      if ((s.mode === 'list' ? s.pick : s.custom) !== t) return;
      // Keep the page's live yield for listed tickers so the sections agree.
      cur = { ...d, yield: r && r.yield != null ? r.yield : d.yield, basis: r ? cur.basis : d.basis, er: r ? r.er : null, cc: isCoveredCall(r), loading: false };
    } catch (e) {
      if ((s.mode === 'list' ? s.pick : s.custom) !== t) return;
      if (!cur) {
        paintInfo(`<span class="down">Could not find dividend data for ${esc(t)}.</span> <span class="muted">${esc(e.message)}</span>`);
        return;
      }
      cur.loading = false;
    }
    setGrowthDefault();
    paintInfo();
    paintOne();
  };

  paintPicker();
  $('#dcMore').addEventListener('click', () => {
    s.shown = Math.min(list.length, s.shown + PAGE);
    paintPicker();
    persist();
  });
  $('#dcPick').addEventListener('change', (e) => {
    s.pick = e.target.value;
    persist();
    choose(s.pick, true);
  });
  el.querySelector('.dc-mode').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-mode]');
    if (!b) return;
    s.mode = b.dataset.mode;
    el.querySelectorAll('.dc-mode button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    $('.dc-pick-list').hidden = s.mode !== 'list';
    $('#dcCustomForm').hidden = s.mode !== 'custom';
    persist();
    if (s.mode === 'list') choose(s.pick, true);
    else if (s.custom) choose(s.custom, false);
    else {
      cur = null;
      paintInfo('<span class="muted">Type a ticker and tap Get yield.</span>');
      $('#dcOut').innerHTML = '';
      $('#dcCustom').focus();
    }
  });
  $('#dcCustomForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const t = $('#dcCustom').value.trim().toUpperCase().replace(/^\$/, '');
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(t)) return void paintInfo('<span class="down">Enter a ticker like MO or JEPI.</span>');
    $('#dcCustom').value = t;
    s.custom = t;
    persist();
    choose(t, all.some((r) => r.t === t));
  });
  $('#dcAmount').addEventListener('input', (e) => {
    s.amount = num(e.target.value, 0, 1e9, 0);
    persist();
    paintOne();
  });
  $('#dcYears').addEventListener('change', (e) => {
    s.years = Number(e.target.value);
    persist();
    paintOne();
  });
  $('#dcGrowth').addEventListener('input', () => ((growthTouched = true), paintOne()));
  $('#dcPrice').addEventListener('input', paintOne);
  $('#dcDrip').addEventListener('change', (e) => {
    s.drip = e.target.checked;
    persist();
    paintOne();
  });
  if (s.mode === 'list' && s.pick) choose(s.pick, true);
  else if (s.mode === 'custom' && s.custom) choose(s.custom, all.some((r) => r.t === s.custom));
  else paintInfo('<span class="muted">Type a ticker and tap Get yield.</span>');

  // ----- several aristocrats and ETFs -----
  const paintList = () => {
    const q = s.pFilter.trim().toLowerCase();
    const match = (r) => !q || r.t.toLowerCase().includes(q) || r.name.toLowerCase().includes(q) || (r.sector || '').toLowerCase().includes(q) || (r.etf && 'etf fund'.includes(q));
    const opts = (rs) =>
      rs
        .map((r) => {
          const on = s.port[r.t] != null;
          return `<label class="dc-opt${on ? ' on' : ''}"><input type="checkbox" value="${esc(r.t)}"${on ? ' checked' : ''}/><b class="mono">${esc(r.t)}</b><span class="dc-opt-nm">${esc(r.name)}</span><span class="mono small">${r.yield.toFixed(2)}%</span></label>`;
        })
        .join('');
    const a = list.filter(match);
    const f = funds.filter(match);
    $('#dcList').innerHTML =
      (a.length ? `<div class="dc-grp small muted">Aristocrats</div>${opts(a)}` : '') +
      (f.length ? `<div class="dc-grp small muted">Dividend ETFs</div>${opts(f)}` : '') +
      (a.length || f.length ? '' : '<p class="small muted">Nothing matches that.</p>');
  };

  const growthFor = (t) => (s.pGrowth === 'fixed' ? s.pFixed : info[t] ? clampGrowth(info[t].growth) ?? 0 : null);

  const paintPort = () => {
    const out = $('#dcPOut');
    const picks = Object.keys(s.port).filter((t) => rowOf(t));
    if (!picks.length) return void (out.innerHTML = '<div class="dc-empty small muted">Tick a few aristocrats or ETFs above to build a mix.</div>');
    const waiting = s.pGrowth === 'own' && picks.some((t) => !info[t]);
    const holdings = picks.map((t) => ({ t, amount: s.port[t], yield: rowOf(t).yield, growth: growthFor(t) ?? 0 }));
    const p = portfolio(holdings, { years: s.pYears, drip: s.pDrip });
    const byT = Object.fromEntries(p.items.map((h) => [h.t, h]));
    const rowsHtml = holdings
      .map((h) => {
        const it = byT[h.t];
        const g = growthFor(h.t);
        return `<tr data-t="${esc(h.t)}"><td><a class="mono" href="#/t/${encodeURIComponent(h.t)}"><b>${esc(h.t)}</b></a> <span class="dv-nm">${esc(rowOf(h.t).name)}</span></td>
          <td class="num">${pc(h.yield)}</td>
          <td class="num">${g == null ? '<span class="muted">…</span>' : pc(g, 1)}</td>
          <td class="num"><input class="dc-amt mono" inputmode="decimal" aria-label="Amount in ${esc(h.t)}" value="${h.amount}"/></td>
          <td class="num">${it ? usd(it.p.first) : usd(0)}</td>
          <td class="num">${it ? usd(it.p.total) : usd(0)}</td>
          <td><button type="button" class="btn-ghost sm dc-rm" aria-label="Remove ${esc(h.t)}">Remove</button></td></tr>`;
      })
      .join('');
    out.innerHTML = `<div class="tbl-wrap"><table class="dc-ptbl"><thead><tr><th>Holding</th><th class="num">Yield</th><th class="num">Div growth</th><th class="num">Amount</th><th class="num">Year 1 income</th><th class="num">Total, ${s.pYears} yrs</th><th></th></tr></thead><tbody>${rowsHtml}</tbody>
      <tfoot><tr><th>${p.items.length} holding${p.items.length === 1 ? '' : 's'}</th><th class="num">${pc(p.yield)}</th><th class="num">${pc(p.growth, 1)}</th><th class="num">${usd(p.amount)}</th><th class="num">${usd(p.first)}</th><th class="num">${usd(p.total)}</th><th></th></tr></tfoot></table></div>
      ${waiting ? '<p class="small muted">Loading dividend history for some picks; their growth counts as 0% until it arrives.</p>' : ''}
      <div class="dc-sub small">Combined yield <b class="mono">${pc(p.yield)}</b> on ${usd(p.amount)}</div>
      ${p.amount ? resultHtml(p, { years: s.pYears, drip: s.pDrip }) : ''}`;
  };

  const loadGrowth = (t) =>
    getInfo(t)
      .then(() => paintPort())
      .catch(() => {
        info[t] = { growth: null };
        paintPort();
      });

  paintList();
  paintPort();
  Object.keys(s.port).forEach(loadGrowth);

  $('#dcFilter').addEventListener('input', (e) => ((s.pFilter = e.target.value), paintList()));
  $('#dcList').addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    const t = cb.value;
    if (cb.checked) {
      s.port[t] = num($('#dcEach').value, 0, 1e9, 1000);
      loadGrowth(t);
    } else delete s.port[t];
    cb.closest('.dc-opt').classList.toggle('on', cb.checked);
    persist();
    paintPort();
  });
  // Amounts apply when the field is left or Enter is pressed, so typing is never interrupted.
  $('#dcPOut').addEventListener('change', (e) => {
    const inp = e.target.closest('.dc-amt');
    if (!inp) return;
    s.port[inp.closest('tr').dataset.t] = num(inp.value, 0, 1e9, 0);
    persist();
    paintPort();
  });
  $('#dcPOut').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.closest('.dc-amt')) e.target.blur();
  });
  $('#dcPOut').addEventListener('click', (e) => {
    const b = e.target.closest('.dc-rm');
    if (!b) return;
    delete s.port[b.closest('tr').dataset.t];
    persist();
    paintList();
    paintPort();
  });
  $('#dcPYears').addEventListener('change', (e) => ((s.pYears = Number(e.target.value)), persist(), paintPort()));
  $('#dcPDrip').addEventListener('change', (e) => ((s.pDrip = e.target.checked), persist(), paintPort()));
  $('#dcPGrowth').addEventListener('change', (e) => {
    s.pGrowth = e.target.value;
    $('#dcPFixedWrap').hidden = s.pGrowth !== 'fixed';
    persist();
    paintPort();
  });
  $('#dcPFixed').addEventListener('input', (e) => ((s.pFixed = num(e.target.value, GROWTH_MIN, GROWTH_MAX, 0)), persist(), paintPort()));
}
