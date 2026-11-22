// Long-term crypto models on the ticker page: a power law chart (log price vs
// log days since genesis, with fair value, support and resistance) and a
// rainbow chart (nine color bands on a normal time axis), plus a plain-language
// read of where today's price sits. Data and fits come from /api/cryptolong.

const DAY_MS = 86400e3;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const CRYPTO_LONG = /^(BTC|ETH|SOL|XRP|BNB|DOGE|ADA|LTC)-USD$/;

export function money(v) {
  if (v == null || !isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  const d = a >= 100 ? 0 : a >= 1 ? 2 : a >= 0.01 ? 4 : 6;
  return `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

// Short axis label for a price: $0.01, $1, $100, $10K, $1M.
export function axisMoney(v) {
  if (v >= 1e9) return `$${+(v / 1e9).toPrecision(3)}B`;
  if (v >= 1e6) return `$${+(v / 1e6).toPrecision(3)}M`;
  if (v >= 1e3) return `$${+(v / 1e3).toPrecision(3)}K`;
  return `$${+v.toPrecision(3)}`;
}

// Log scale ticks: powers of ten, with 2x and 5x steps added when the range is short.
export function logTicks(lo, hi) {
  const out = [];
  const add = (mults) => {
    out.length = 0;
    for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) for (const m of mults) {
      const v = +(m * 10 ** e).toPrecision(6);
      if (v >= lo && v <= hi) out.push(v);
    }
  };
  add([1]);
  if (out.length < 3) add([1, 2, 5]);
  if (out.length > 8) {
    const keep = out.filter((_, i) => i % 2 === 0);
    out.length = 0;
    out.push(...keep);
  }
  return out;
}

const line = (m, d) => 10 ** (m.a + m.b * Math.log10(d));

function edges(model, d, n) {
  const lo = Math.log10(line(model.support, d));
  const top = Math.max(Math.log10(line(model.resistance, d)), Math.log10(line(model.fair, d)) + model.minTopGap);
  return Array.from({ length: n + 1 }, (_, i) => 10 ** (lo + ((top - lo) * i) / n));
}

const dateOf = (data, d) => new Date(Date.parse(data.genesis) + d * DAY_MS);
const monthYear = (dt) => dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

// Shared frame: scales, gridlines, y labels on the right.
function frame(width, height, xDom, yDom, xMap) {
  const pad = { l: 6, r: 58, t: 10, b: 26 };
  const iw = width - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const [y0, y1] = yDom.map(Math.log10);
  const X = (v) => pad.l + ((xMap(v) - xMap(xDom[0])) / (xMap(xDom[1]) - xMap(xDom[0]))) * iw;
  const Y = (p) => pad.t + ih - ((Math.log10(p) - y0) / (y1 - y0)) * ih;
  let g = '';
  for (const v of logTicks(yDom[0], yDom[1])) {
    const y = Y(v).toFixed(1);
    g += `<line class="grid" x1="${pad.l}" x2="${pad.l + iw}" y1="${y}" y2="${y}"/><text class="ax" x="${pad.l + iw + 6}" y="${(+y + 4).toFixed(1)}">${axisMoney(v)}</text>`;
  }
  return { pad, iw, ih, X, Y, g };
}

const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join('');

// Year ticks on the x axis, kept at least `gap` pixels apart, latest year first.
function yearTicks(data, X, d0, d1, gap, fr) {
  const g0 = Date.parse(data.genesis);
  const yStart = new Date(g0 + d0 * DAY_MS).getUTCFullYear() + 1;
  const yEnd = new Date(g0 + d1 * DAY_MS).getUTCFullYear();
  let out = '';
  let lastX = Infinity;
  for (let yr = yEnd; yr >= yStart; yr--) {
    const d = (Date.UTC(yr, 0, 1) - g0) / DAY_MS;
    if (d <= d0 || d > d1) continue;
    const x = X(d);
    if (lastX - x < gap) continue;
    lastX = x;
    out += `<line class="vgrid" x1="${x.toFixed(1)}" x2="${x.toFixed(1)}" y1="${fr.pad.t}" y2="${fr.pad.t + fr.ih}"/><text class="ax" x="${x.toFixed(1)}" y="${fr.pad.t + fr.ih + 17}" text-anchor="middle">${yr}</text>`;
  }
  return out;
}

function yDomain(data, dEnd, extra) {
  const s = data.series;
  let lo = Infinity;
  let hi = 0;
  for (const [, p] of s) {
    lo = Math.min(lo, p);
    hi = Math.max(hi, p);
  }
  for (const v of extra) {
    if (isFinite(v) && v > 0) {
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
  }
  return [lo / 1.6, hi * 1.6];
}

function powerSvg(data, width) {
  const m = data.model;
  const s = data.series;
  const d0 = Math.max(1, s[0][0]);
  const d1 = data.day + 4 * 365;
  const height = width < 520 ? 290 : 360;
  const yd = yDomain(data, d1, [line(m.support, d0), line(m.fair, d1) * 3]);
  const fr = frame(width, height, [d0, d1], yd, Math.log10);
  const { X, Y } = fr;
  const clampY = (p) => Math.max(fr.pad.t, Math.min(fr.pad.t + fr.ih, Y(p)));
  const N = 140;
  const ds = Array.from({ length: N + 1 }, (_, i) => 10 ** (Math.log10(d0) + ((Math.log10(d1) - Math.log10(d0)) * i) / N));
  const top = (d) => Math.max(line(m.resistance, d), line(m.fair, d) * 10 ** m.minTopGap);
  const sup = ds.map((d) => [X(d), clampY(line(m.support, d))]);
  const res = ds.map((d) => [X(d), clampY(top(d))]);
  const fair = ds.map((d) => [X(d), clampY(line(m.fair, d))]);
  const corridor = `${path(sup)}${path(res.slice().reverse()).replace(/^M/, 'L')}Z`;
  const price = s.filter(([d]) => d >= d0).map(([d, p]) => [X(d), Y(p)]);
  const tx = X(data.day);
  const ty = Y(data.price);
  return {
    height,
    fr,
    X,
    Y,
    svg: `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(data.name)} power law chart: log price against log days since genesis">
      ${fr.g}${yearTicks(data, X, d0, d1, 40, fr)}
      <path class="cl-corr" d="${corridor}"/>
      <path class="cl-sup" d="${path(sup)}"/><path class="cl-res" d="${path(res)}"/><path class="cl-fair" d="${path(fair)}"/>
      <path class="cl-price" d="${path(price)}"/>
      <line class="cl-today" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${fr.pad.t}" y2="${fr.pad.t + fr.ih}"/>
      <circle class="cl-dot" cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="4.5"/>
      <g class="cl-hover" style="display:none"><line class="xh" y1="${fr.pad.t}" y2="${fr.pad.t + fr.ih}"/><circle class="cl-hdot" r="3.5"/></g>
      <rect class="hit" x="${fr.pad.l}" y="${fr.pad.t}" width="${fr.iw}" height="${fr.ih}" fill="transparent"/>
    </svg>`,
  };
}

function rainbowSvg(data, width) {
  const m = data.model;
  const s = data.series;
  const d0 = Math.max(1, s[0][0]);
  const d1 = data.day + 2 * 365;
  const n = data.bands.length;
  const height = width < 520 ? 290 : 360;
  const N = 160;
  const ds = Array.from({ length: N + 1 }, (_, i) => d0 + ((d1 - d0) * i) / N);
  const E = ds.map((d) => edges(m, d, n));
  const yd = yDomain(data, d1, [E[0][0], E[N][n], E[0][n]]);
  const fr = frame(width, height, [d0, d1], yd, (v) => v);
  const { X, Y } = fr;
  const clampY = (p) => Math.max(fr.pad.t, Math.min(fr.pad.t + fr.ih, Y(p)));
  let bands = '';
  for (let b = 0; b < n; b++) {
    const lower = ds.map((d, i) => [X(d), clampY(E[i][b])]);
    const upper = ds.map((d, i) => [X(d), clampY(E[i][b + 1])]).reverse();
    bands += `<path d="${path(lower)}${path(upper).replace(/^M/, 'L')}Z" fill="${data.bands[b].color}" class="cl-band"/>`;
  }
  const price = s.filter(([d]) => d >= d0).map(([d, p]) => [X(d), Y(p)]);
  const tx = X(data.day);
  const ty = Y(data.price);
  return {
    height,
    fr,
    X,
    Y,
    svg: `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(data.name)} rainbow chart with nine valuation bands">
      ${bands}${fr.g}${yearTicks(data, X, d0, d1, 44, fr)}
      <path class="cl-price" d="${path(price)}"/>
      <line class="cl-today" x1="${tx.toFixed(1)}" x2="${tx.toFixed(1)}" y1="${fr.pad.t}" y2="${fr.pad.t + fr.ih}"/>
      <circle class="cl-dot" cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="4.5"/>
      <g class="cl-hover" style="display:none"><line class="xh" y1="${fr.pad.t}" y2="${fr.pad.t + fr.ih}"/><circle class="cl-hdot" r="3.5"/></g>
      <rect class="hit" x="${fr.pad.l}" y="${fr.pad.t}" width="${fr.iw}" height="${fr.ih}" fill="transparent"/>
    </svg>`,
  };
}

function bandOf(data, d, p) {
  const e = edges(data.model, d, data.bands.length);
  for (let i = data.bands.length - 1; i >= 0; i--) if (p >= e[i]) return i;
  return 0;
}

// Hover readout: nearest weekly point to the pointer.
function wireHover(el, data, chart, kind, out) {
  const svg = el.querySelector('svg');
  const hit = svg.querySelector('.hit');
  const g = svg.querySelector('.cl-hover');
  const xs = data.series.map(([d]) => chart.X(d));
  const idle = out.innerHTML;
  const move = (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * svg.viewBox.baseVal.width;
    let i = 0;
    let best = Infinity;
    for (let k = 0; k < xs.length; k++) {
      const dd = Math.abs(xs[k] - px);
      if (dd < best) {
        best = dd;
        i = k;
      }
    }
    const [d, p] = data.series[i];
    const x = xs[i];
    g.style.display = '';
    g.querySelector('line').setAttribute('x1', x);
    g.querySelector('line').setAttribute('x2', x);
    const c = g.querySelector('circle');
    c.setAttribute('cx', x);
    c.setAttribute('cy', chart.Y(p));
    const fair = line(data.model.fair, d);
    const extra = kind === 'power' ? `fair ${money(fair)} · <b>${(p / fair).toFixed(2)}x</b>` : `<span class="cl-sw" style="background:${data.bands[bandOf(data, d, p)].color}"></span>${esc(data.bands[bandOf(data, d, p)].name)}`;
    out.innerHTML = `<span class="muted">${monthYear(dateOf(data, d))}</span> · <b>${money(p)}</b> · ${extra}`;
  };
  const leave = () => {
    g.style.display = 'none';
    out.innerHTML = idle;
  };
  hit.addEventListener('pointermove', move);
  hit.addEventListener('pointerdown', move);
  hit.addEventListener('pointerleave', leave);
}

function factsHtml(d) {
  const mult = d.price / d.fairNow;
  const band = d.bands[d.band.index];
  const fit = `R² ${d.model.fair.r2.toFixed(2)} · ${d.model.years.toFixed(1)} yrs`;
  return `<div class="cl-facts">
    <div><dt>Price</dt><dd>${money(d.price)}</dd></div>
    <div><dt>Power law fair value</dt><dd>${money(d.fairNow)} <small class="${mult < 1 ? 'down' : 'up'}">${mult.toFixed(2)}x</small></dd></div>
    <div><dt>Support</dt><dd>${money(d.supportNow)}</dd></div>
    <div><dt>Resistance</dt><dd>${money(d.resistanceNow)}</dd></div>
    <div><dt>Rainbow band</dt><dd><span class="cl-sw" style="background:${band.color}"></span>${d.band.index + 1} of ${d.bands.length}, ${esc(band.name)}</dd></div>
    <div><dt>Fit</dt><dd class="cl-q cl-q-${esc(d.quality)}">${esc(d.quality[0].toUpperCase() + d.quality.slice(1))} <small>${fit}</small></dd></div>
  </div>`;
}

function legendHtml(kind, d) {
  if (kind === 'power') {
    return `<div class="cl-legend"><span><i class="cl-k price"></i>Price</span><span><i class="cl-k fair"></i>Fair value (trend)</span><span><i class="cl-k sup"></i>Support</span><span><i class="cl-k res"></i>${d.model.resistance.from === 'tops' ? 'Resistance (past cycle tops)' : 'Resistance (upper band)'}</span><span><i class="cl-k today"></i>Today</span></div>`;
  }
  return `<div class="cl-legend cl-bands">${d.bands
    .slice()
    .reverse()
    .map((b, i) => `<span class="${d.bands.length - 1 - i === d.band.index ? 'on' : ''}"><i class="cl-sw" style="background:${b.color}"></i>${esc(b.name)}</span>`)
    .join('')}</div>`;
}

export function mountCryptoLong(box, ticker, api) {
  box.innerHTML = `<div class="card cl-card"><div class="pc-msg">Fitting the long-term models…</div></div>`;
  let data = null;
  let lastW = 0;
  const draw = () => {
    if (!data || !box.isConnected) return;
    const w = Math.max(300, Math.round(box.querySelector('.cl-plot')?.clientWidth || box.clientWidth - 30));
    if (Math.abs(w - lastW) < 4) return;
    lastW = w;
    for (const kind of ['power', 'rainbow']) {
      const el = box.querySelector(`.cl-plot[data-k="${kind}"]`);
      const out = box.querySelector(`.cl-read-line[data-k="${kind}"]`);
      const ch = kind === 'power' ? powerSvg(data, w) : rainbowSvg(data, w);
      el.innerHTML = ch.svg;
      out.innerHTML = out.dataset.idle;
      wireHover(el, data, ch, kind, out);
    }
  };
  api(`/api/cryptolong/${encodeURIComponent(ticker)}`)
    .then((d) => {
      data = d;
      const mult = d.price / d.fairNow;
      const idleP = `<span class="muted">Today</span> · <b>${money(d.price)}</b> · fair ${money(d.fairNow)} · <b>${mult.toFixed(2)}x</b>`;
      const band = d.bands[d.band.index];
      const idleR = `<span class="muted">Today</span> · <b>${money(d.price)}</b> · <span class="cl-sw" style="background:${band.color}"></span>${esc(band.name)}`;
      box.innerHTML = `
        <div class="card plain cl-card">
          <div class="lbl">Where ${esc(d.name)} sits today</div>
          <ul class="cl-read">${d.read.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
          ${factsHtml(d)}
          <div class="muted cl-note">Educational only, not financial advice. Both models are curve fits to past prices, not forecasts. Prices from ${esc(d.source)}, refit with the latest daily close every few hours.</div>
        </div>
        <div class="card cl-card">
          <div class="cl-h"><h3>Power law</h3><span class="muted small">log price vs log days since ${esc(d.base === 'BTC' ? 'the genesis block' : 'launch')} (${esc(d.genesis)})</span></div>
          <div class="cl-read-line" data-k="power" data-idle="${esc(idleP)}"></div>
          <div class="cl-plot pc-plot" data-k="power"></div>
          ${legendHtml('power', d)}
        </div>
        <div class="card cl-card">
          <div class="cl-h"><h3>Rainbow</h3><span class="muted small">nine log regression bands between support and past cycle tops</span></div>
          <div class="cl-read-line" data-k="rainbow" data-idle="${esc(idleR)}"></div>
          <div class="cl-plot pc-plot" data-k="rainbow"></div>
          ${legendHtml('rainbow', d)}
        </div>
        <details class="card cl-card cl-how"><summary>How these models work</summary>
          <p><b>Power law.</b> Plotted on log scales for both price and time since ${esc(d.genesis)}, ${esc(d.name)}'s price has followed a roughly straight line. Fair value is the least squares line through every daily close since ${esc(d.model.start.slice(0, 4))} (price ≈ ${(10 ** d.model.fair.a).toExponential(3)} × days<sup>${d.model.fair.b.toFixed(2)}</sup>). Support is that line shifted down until only about 1% of days closed below it. ${d.model.resistance.from === 'tops' ? `Resistance is a separate line through the ${d.model.resistance.tops} cycle tops (each the highest close within a year either side). It rises more slowly than fair value, which reflects shrinking returns each cycle.` : 'Resistance is the line only about 1% of days closed above.'}</p>
          <p><b>Rainbow.</b> The same fitted lines on a normal time axis. The space between support and resistance is cut into nine equal slices on a log scale, from "Deep value" to "Bubble territory". Every fit is redone from the full history whenever new prices arrive, so the bands are always the latest fit.</p>
          <p><b>Limits.</b> These describe the past. A trend that held for years can bend or break, and fits for coins younger than Bitcoin move a lot as new data arrives.</p>
        </details>`;
      lastW = 0;
      draw();
    })
    .catch((e) => {
      box.innerHTML = `<div class="card cl-card"><div class="pc-msg">The long-term models could not load: ${esc(e.message)}</div></div>`;
    });
  let t;
  const onResize = () => {
    clearTimeout(t);
    t = setTimeout(() => {
      if (!box.isConnected) return window.removeEventListener('resize', onResize);
      draw();
    }, 150);
  };
  window.addEventListener('resize', onResize);
}
