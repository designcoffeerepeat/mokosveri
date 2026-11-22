// Interactive price chart for the ticker page: timeframes from 1D to Max,
// line or candles, volume, moving averages, RSI and MACD, a hover readout,
// and shaded pre-market and after hours on intraday views.

const RANGES = [
  ['1d', '1D'],
  ['5d', '5D'],
  ['1mo', '1M'],
  ['3mo', '3M'],
  ['6mo', '6M'],
  ['ytd', 'YTD'],
  ['1y', '1Y'],
  ['5y', '5Y'],
  ['max', 'Max'],
];
const RANGE_WORDS = { '1d': 'today', '5d': 'past 5 days', '1mo': 'past month', '3mo': 'past 3 months', '6mo': 'past 6 months', ytd: 'year to date', '1y': 'past year', '5y': 'past 5 years', max: 'all time' };
const INDS = [
  ['vol', 'Volume', 'Trading volume per bar'],
  ['ma', 'Moving averages', 'Simple moving averages of the close'],
  ['rsi', 'RSI', 'Relative Strength Index (14). Above 70 is often called overbought, below 30 oversold.'],
  ['macd', 'MACD', 'MACD (12, 26, 9): momentum from the gap between two exponential averages. The bars show MACD minus its signal line.'],
];
const DEFAULTS = { range: '1y', type: 'line', vol: true, ma: true, rsi: false, macd: false };
const KEY = 'chart.prefs.v1';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v, d = 2) => (v == null || !isFinite(v) ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const fmtVol = (v) => (v >= 1e9 ? `${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : `${Math.round(v)}`);
const priceDigits = (v) => (Math.abs(v) < 1 ? 4 : Math.abs(v) < 10 ? 3 : 2);

function loadPrefs() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {}
}

// ---------- indicator math (full series, warm up included) ----------
export function smaSeries(arr, n) {
  const out = new Array(arr.length).fill(null);
  let s = 0;
  for (let i = 0; i < arr.length; i++) {
    s += arr[i];
    if (i >= n) s -= arr[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

function emaSeries(arr, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = arr[0];
  for (let i = 0; i < arr.length; i++) out.push((e = i === 0 ? arr[0] : arr[i] * k + e * (1 - k)));
  return out;
}

// Wilder RSI, null until there are n changes to average.
export function rsiSeries(closes, n = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= n) return out;
  let ag = 0;
  let al = 0;
  for (let i = 1; i <= n; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) ag += d;
    else al -= d;
  }
  ag /= n;
  al /= n;
  const val = () => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[n] = val();
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (n - 1) + Math.max(d, 0)) / n;
    al = (al * (n - 1) + Math.max(-d, 0)) / n;
    out[i] = val();
  }
  return out;
}

export function macdSeries(closes, fast = 12, slow = 26, sig = 9) {
  const f = emaSeries(closes, fast);
  const s = emaSeries(closes, slow);
  const macd = closes.map((_, i) => f[i] - s[i]);
  const signal = emaSeries(macd, sig);
  const ok = (i) => i >= slow + sig - 2;
  return {
    macd: macd.map((v, i) => (ok(i) ? v : null)),
    signal: signal.map((v, i) => (ok(i) ? v : null)),
    hist: macd.map((v, i) => (ok(i) ? v - signal[i] : null)),
  };
}

// Round numbered axis ticks.
export function niceTicks(min, max, count = 5) {
  const span = max - min || Math.abs(max) || 1;
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// ---------- time labels, in the exchange's own time zone ----------
function local(t, off) {
  return new Date((t + off) * 1000);
}
function timeLabel(d) {
  const h = d.getUTCHours();
  const m = d.getUTCMinutes();
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h < 12 ? 'AM' : 'PM'}`;
}
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (d) => `${MON[d.getUTCMonth()]} ${d.getUTCDate()}`;

function axisLabels(bars, off, range) {
  const key =
    range === '1d'
      ? (d) => d.getUTCHours()
      : range === '5d' || range === '1mo'
        ? (d) => `${d.getUTCMonth()}-${d.getUTCDate()}`
        : range === '5y' || range === 'max'
          ? (d) => d.getUTCFullYear()
          : (d) => `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
  const label =
    range === '1d'
      ? (d) => timeLabel(d)
      : range === '5d' || range === '1mo'
        ? dayLabel
        : range === '5y' || range === 'max'
          ? (d) => String(d.getUTCFullYear())
          : (d) => (d.getUTCMonth() === 0 ? String(d.getUTCFullYear()) : MON[d.getUTCMonth()]);
  const out = [];
  let prev = null;
  bars.forEach((b, i) => {
    const d = local(b.t, off);
    const k = key(d);
    if (k !== prev) {
      if (prev !== null) out.push({ i, text: label(d) });
      prev = k;
    }
  });
  return out;
}

function tipTime(t, off, interval) {
  const d = local(t, off);
  if (interval === '1mo') return `${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  if (interval === '1wk') return `Week of ${dayLabel(d)}, ${d.getUTCFullYear()}`;
  if (/m$|h$/.test(interval)) return `${dayLabel(d)}, ${timeLabel(d)}`;
  return `${dayLabel(d)}, ${d.getUTCFullYear()}`;
}

// ---------- rendering ----------
const PANE = { price: 300, ind: 96, axis: 22, gap: 10 };

function build(data, prefs, width) {
  const all = data.bars;
  const closes = all.map((b) => b.c);
  const S = data.start;
  const bars = all.slice(S);
  const n = bars.length;
  const hasVol = bars.some((b) => b.v > 0);
  const showVol = prefs.vol && hasVol;
  const [ma1n, ma2n] = data.ma || [50, 200];
  const ma1 = prefs.ma ? smaSeries(closes, ma1n).slice(S) : null;
  const ma2 = prefs.ma ? smaSeries(closes, ma2n).slice(S) : null;
  const rsi = prefs.rsi ? rsiSeries(closes).slice(S) : null;
  const md = prefs.macd ? macdSeries(closes) : null;
  const macd = md && { macd: md.macd.slice(S), signal: md.signal.slice(S), hist: md.hist.slice(S) };

  const W = Math.max(280, width);
  const P = { l: 6, r: W < 520 ? 48 : 60 };
  const plotW = W - P.l - P.r;
  const step = plotW / Math.max(n, 1);
  const x = (i) => P.l + step * (i + 0.5);

  // Price pane scale covers what is drawn.
  let lo = Infinity;
  let hi = -Infinity;
  const candles = prefs.type === 'candle';
  bars.forEach((b, i) => {
    lo = Math.min(lo, candles ? b.l : b.c);
    hi = Math.max(hi, candles ? b.h : b.c);
    for (const m of [ma1, ma2]) if (m && m[i] != null) (lo = Math.min(lo, m[i])), (hi = Math.max(hi, m[i]));
  });
  if (data.prevClose != null) (lo = Math.min(lo, data.prevClose)), (hi = Math.max(hi, data.prevClose));
  const pad = (hi - lo) * 0.06 || hi * 0.01 || 1;
  lo -= pad;
  hi += pad;
  const top = 10;
  const volH = showVol ? PANE.price * 0.2 : 0;
  const priceBottom = top + PANE.price - volH - (showVol ? 4 : 0);
  const y = (v) => top + (1 - (v - lo) / (hi - lo)) * (priceBottom - top);

  const panes = [];
  let cursor = top + PANE.price + PANE.gap;
  if (rsi) panes.push({ kind: 'rsi', y0: cursor, y1: (cursor += PANE.ind) }), (cursor += PANE.gap);
  if (macd) panes.push({ kind: 'macd', y0: cursor, y1: (cursor += PANE.ind) }), (cursor += PANE.gap);
  const axisY = cursor - (panes.length ? PANE.gap : 0) + 4;
  const H = axisY + PANE.axis;
  const first = data.prevClose != null ? data.prevClose : bars[0].c;
  const last = bars[n - 1].c;
  const up = last >= first;
  const col = up ? 'var(--up)' : 'var(--down)';

  const path = (arr, yf) => {
    let d = '';
    let pen = false;
    arr.forEach((v, i) => {
      if (v == null || !isFinite(v)) return (pen = false);
      d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${yf(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };
  const mono = 'font-family="JetBrains Mono, monospace" font-size="10.5" fill="var(--muted)"';
  const out = [];

  // Extended hours shading (behind everything).
  if (data.extended) {
    let s = -1;
    for (let i = 0; i <= n; i++) {
      const ext = i < n && bars[i].s;
      if (ext && s < 0) s = i;
      if (!ext && s >= 0) {
        out.push(`<rect class="ext-band" x="${(P.l + step * s).toFixed(1)}" y="${top}" width="${(step * (i - s)).toFixed(1)}" height="${axisY - top - 4}"/>`);
        s = -1;
      }
    }
  }

  // Price grid and labels.
  const pd = priceDigits(hi);
  for (const t of niceTicks(lo, hi, 5)) {
    if (t < lo || t > hi) continue;
    out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${y(t).toFixed(1)}" y2="${y(t).toFixed(1)}" class="grid"/>`);
    out.push(`<text x="${W - P.r + 6}" y="${(y(t) + 3.5).toFixed(1)}" ${mono}>${fmt(t, pd > 2 ? pd : t >= 1000 ? 0 : 2)}</text>`);
  }

  // Volume.
  if (showVol) {
    const vmax = Math.max(...bars.map((b) => b.v)) || 1;
    const vb = top + PANE.price;
    const bw = Math.max(1, step * 0.7);
    bars.forEach((b, i) => {
      if (!b.v) return;
      const h = (b.v / vmax) * volH;
      const upBar = i === 0 ? b.c >= b.o : b.c >= bars[i - 1].c;
      out.push(`<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(vb - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" class="vol ${upBar ? 'vu' : 'vd'}"/>`);
    });
  }

  // Previous close baseline on 1D.
  if (data.prevClose != null) {
    out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${y(data.prevClose).toFixed(1)}" y2="${y(data.prevClose).toFixed(1)}" class="base"/>`);
  }

  // Price.
  if (candles) {
    const bw = Math.max(1, Math.min(12, step * 0.65));
    bars.forEach((b, i) => {
      const c = b.c >= b.o ? 'cu' : 'cd';
      const yo = y(b.o);
      const yc = y(b.c);
      out.push(`<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(b.h).toFixed(1)}" y2="${y(b.l).toFixed(1)}" class="wick ${c}"/>`);
      out.push(`<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, Math.abs(yc - yo)).toFixed(1)}" class="body ${c}"/>`);
    });
  } else {
    const line = path(bars.map((b) => b.c), y);
    const gid = `pg${Math.random().toString(36).slice(2, 8)}`;
    out.push(`<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".2"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>`);
    out.push(`<path d="${line}L${x(n - 1).toFixed(1)},${priceBottom}L${x(0).toFixed(1)},${priceBottom}Z" fill="url(#${gid})"/>`);
    out.push(`<path d="${line}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round"/>`);
  }
  if (ma1) out.push(`<path d="${path(ma1, y)}" class="ma ma1"/>`);
  if (ma2) out.push(`<path d="${path(ma2, y)}" class="ma ma2"/>`);

  // Indicator panes.
  for (const p of panes) {
    out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${p.y0 - PANE.gap / 2}" y2="${p.y0 - PANE.gap / 2}" class="sep"/>`);
    if (p.kind === 'rsi') {
      const yr = (v) => p.y0 + (1 - v / 100) * (p.y1 - p.y0);
      out.push(`<rect x="${P.l}" y="${yr(70)}" width="${plotW}" height="${yr(30) - yr(70)}" class="rsi-band"/>`);
      for (const lv of [30, 70]) {
        out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${yr(lv)}" y2="${yr(lv)}" class="lvl"/>`);
        out.push(`<text x="${W - P.r + 6}" y="${yr(lv) + 3.5}" ${mono}>${lv}</text>`);
      }
      out.push(`<path d="${path(rsi, yr)}" class="ind-line"/>`);
      out.push(`<text x="${P.l + 4}" y="${p.y0 + 11}" class="pane-label">RSI 14</text>`);
      p.y = yr;
    } else {
      const vals = [...macd.macd, ...macd.signal, ...macd.hist].filter((v) => v != null);
      const m = Math.max(...vals.map(Math.abs)) * 1.1 || 1;
      const ym = (v) => p.y0 + (1 - (v + m) / (2 * m)) * (p.y1 - p.y0);
      out.push(`<line x1="${P.l}" x2="${W - P.r}" y1="${ym(0)}" y2="${ym(0)}" class="lvl"/>`);
      out.push(`<text x="${W - P.r + 6}" y="${ym(0) + 3.5}" ${mono}>0</text>`);
      const bw = Math.max(1, step * 0.6);
      macd.hist.forEach((v, i) => {
        if (v == null) return;
        out.push(`<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${Math.min(ym(v), ym(0)).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.5, Math.abs(ym(v) - ym(0))).toFixed(1)}" class="vol ${v >= 0 ? 'vu' : 'vd'}"/>`);
      });
      out.push(`<path d="${path(macd.macd, ym)}" class="ind-line"/>`);
      out.push(`<path d="${path(macd.signal, ym)}" class="sig-line"/>`);
      out.push(`<text x="${P.l + 4}" y="${p.y0 + 11}" class="pane-label">MACD 12, 26, 9</text>`);
      p.y = ym;
    }
  }

  // Time axis, thinned so labels never collide.
  let lastX = -Infinity;
  for (const a of axisLabels(bars, data.gmtoffset || 0, data.range)) {
    const lx = x(a.i);
    if (lx - lastX < 64 || lx > W - P.r - 20) continue;
    lastX = lx;
    out.push(`<line x1="${lx.toFixed(1)}" x2="${lx.toFixed(1)}" y1="${top}" y2="${axisY - 4}" class="vgrid"/>`);
    out.push(`<text x="${lx.toFixed(1)}" y="${axisY + 12}" text-anchor="middle" font-size="10.5" fill="var(--muted)">${esc(a.text)}</text>`);
  }

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Price chart">${out.join('')}
    <g class="hover" visibility="hidden"><line class="xh" y1="${top}" y2="${axisY - 4}"/><line class="yh" x1="${P.l}" x2="${W - P.r}"/><rect class="ytag" width="${P.r - 2}" height="16" rx="3"/><text class="ytxt" ${mono}></text></g>
    <rect class="hit" x="${P.l}" y="0" width="${plotW}" height="${H}" fill="transparent"/></svg>`;

  return { svg, bars, n, x, y, step, P, W, top, priceBottom, ma1, ma2, ma1n, ma2n, rsi, macd, first, last, up };
}

function summaryHtml(m, data) {
  const ch = m.last - m.first;
  const pct = (m.last / m.first - 1) * 100;
  const sign = ch > 0 ? '+' : '';
  const ext = data.extended && m.bars[m.n - 1].s ? ` <span class="muted">(last trade ${m.bars[m.n - 1].s === 'pre' ? 'pre-market' : 'after hours'})</span>` : '';
  return `<span class="${m.up ? 'up' : 'down'}">${sign}${fmt(ch, priceDigits(m.last))} (${sign}${pct.toFixed(2)}%)</span> <span class="muted">${RANGE_WORDS[data.range]}</span>${ext}`;
}

function legendHtml(m, prefs, data) {
  const items = [];
  if (prefs.ma) items.push(`<span><i class="sw ma1"></i>MA ${m.ma1n}</span><span><i class="sw ma2"></i>MA ${m.ma2n}</span>`);
  if (data.extended && m.bars.some((b) => b.s)) items.push('<span><i class="sw ext"></i>Pre-market and after hours</span>');
  if (data.range === '1d' && data.prevClose != null) items.push('<span><i class="sw base"></i>Previous close</span>');
  if (prefs.macd) items.push('<span><i class="sw ind"></i>MACD</span><span><i class="sw sig"></i>Signal</span>');
  const unit = { '5m': '5 minute', '15m': '15 minute', '1h': 'hourly', '1d': 'daily', '1wk': 'weekly', '1mo': 'monthly' }[data.interval] || '';
  items.push(`<span class="muted">${unit} bars${data.intraday ? ', exchange time' : ''}</span>`);
  return items.join('');
}

function tooltipHtml(m, i, data) {
  const b = m.bars[i];
  const prev = i > 0 ? m.bars[i - 1].c : data.range === '1d' && data.prevClose != null ? data.prevClose : null;
  const chg = prev ? (b.c / prev - 1) * 100 : null;
  const d = priceDigits(b.c);
  const rows = [
    ['Open', fmt(b.o, d)],
    ['High', fmt(b.h, d)],
    ['Low', fmt(b.l, d)],
    ['Close', `${fmt(b.c, d)}${chg != null ? ` <span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>` : ''}`],
  ];
  if (b.v) rows.push(['Volume', fmtVol(b.v)]);
  if (m.ma1 && m.ma1[i] != null) rows.push([`MA ${m.ma1n}`, fmt(m.ma1[i], d)]);
  if (m.ma2 && m.ma2[i] != null) rows.push([`MA ${m.ma2n}`, fmt(m.ma2[i], d)]);
  if (m.rsi && m.rsi[i] != null) rows.push(['RSI', fmt(m.rsi[i], 1)]);
  if (m.macd && m.macd.macd[i] != null) rows.push(['MACD', `${fmt(m.macd.macd[i], 3)} / ${fmt(m.macd.signal[i], 3)}`]);
  const sess = b.s ? `<span class="ext-tag ext-${b.s}">${b.s === 'pre' ? 'Pre-market' : 'After hours'}</span>` : '';
  return `<div class="tt-head">${esc(tipTime(b.t, data.gmtoffset || 0, data.interval))}${sess}</div>${rows.map(([k, v]) => `<div class="tt-row"><span>${k}</span><b>${v}</b></div>`).join('')}`;
}

export function mountChart(box, ticker, api) {
  const prefs = loadPrefs();
  const cache = new Map();
  let data = null;
  let model = null;
  let timer = null;
  let seq = 0;

  box.innerHTML = `
    <div class="pc-head">
      <div class="pc-ranges" role="tablist" aria-label="Time frame">${RANGES.map(([k, l]) => `<button type="button" role="tab" data-r="${k}">${l}</button>`).join('')}</div>
      <div class="pc-type" role="group" aria-label="Chart type"><button type="button" data-ty="line" title="Line chart">Line</button><button type="button" data-ty="candle" title="Candlestick chart">Candles</button></div>
    </div>
    <div class="pc-inds">${INDS.map(([k, l, tip]) => `<label title="${esc(tip)}"><input type="checkbox" data-i="${k}"> ${l}</label>`).join('')}</div>
    <div class="pc-sum" aria-live="polite"></div>
    <div class="pc-plot"><div class="pc-msg">Loading chart…</div></div>
    <div class="pc-tip" hidden></div>
    <div class="pc-legend"></div>`;
  const plot = box.querySelector('.pc-plot');
  const tip = box.querySelector('.pc-tip');
  const sum = box.querySelector('.pc-sum');
  const legend = box.querySelector('.pc-legend');

  const syncControls = () => {
    box.querySelectorAll('[data-r]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.r === prefs.range)));
    box.querySelectorAll('[data-ty]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.ty === prefs.type)));
    box.querySelectorAll('[data-i]').forEach((c) => (c.checked = !!prefs[c.dataset.i]));
  };

  const draw = () => {
    if (!data || !data.bars || data.bars.length - data.start < 2) {
      if (data) plot.innerHTML = '<div class="pc-msg">Not enough price data for this time frame.</div>';
      return;
    }
    model = build(data, prefs, plot.clientWidth || 800);
    plot.innerHTML = model.svg;
    sum.innerHTML = summaryHtml(model, data);
    legend.innerHTML = legendHtml(model, prefs, data);
    wireHover();
  };

  const wireHover = () => {
    const svg = plot.querySelector('svg');
    const g = svg.querySelector('.hover');
    const hit = svg.querySelector('.hit');
    const xh = g.querySelector('.xh');
    const yh = g.querySelector('.yh');
    const ytag = g.querySelector('.ytag');
    const ytxt = g.querySelector('.ytxt');
    const move = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ev.clientX - r.left;
      const i = Math.max(0, Math.min(model.n - 1, Math.floor((px - model.P.l) / model.step)));
      const b = model.bars[i];
      const cx = model.x(i);
      const cy = model.y(b.c);
      xh.setAttribute('x1', cx);
      xh.setAttribute('x2', cx);
      yh.setAttribute('y1', cy);
      yh.setAttribute('y2', cy);
      ytag.setAttribute('x', model.W - model.P.r + 1);
      ytag.setAttribute('y', cy - 8);
      ytxt.setAttribute('x', model.W - model.P.r + 5);
      ytxt.setAttribute('y', cy + 3.5);
      ytxt.textContent = fmt(b.c, priceDigits(b.c));
      g.setAttribute('visibility', 'visible');
      tip.innerHTML = tooltipHtml(model, i, data);
      tip.hidden = false;
      const br = box.getBoundingClientRect();
      const left = r.left - br.left + cx;
      const tw = tip.offsetWidth;
      tip.style.left = `${left + 14 + tw > br.width ? left - 14 - tw : left + 14}px`;
      tip.style.top = `${r.top - br.top + 8}px`;
    };
    const leave = () => {
      g.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    hit.addEventListener('pointermove', move);
    hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', leave);
  };

  const load = async (quiet = false) => {
    const my = ++seq;
    const range = prefs.range;
    const hit = cache.get(range);
    if (hit && Date.now() - hit.at < 60e3 && !quiet) {
      data = hit.data;
      return draw();
    }
    if (!quiet) {
      plot.classList.add('busy');
      if (!data) plot.innerHTML = '<div class="pc-msg">Loading chart…</div>';
    }
    try {
      const d = await api(`/api/chart/${encodeURIComponent(ticker)}?range=${range}`);
      if (my !== seq) return;
      cache.set(range, { at: Date.now(), data: d });
      data = d;
      draw();
    } catch (e) {
      if (my !== seq || quiet) return;
      data = null;
      sum.innerHTML = '';
      legend.innerHTML = '';
      plot.innerHTML = `<div class="pc-msg">Could not load the chart: ${esc(e.message)}</div>`;
    } finally {
      if (my === seq) plot.classList.remove('busy');
    }
  };

  // Keep the 1D view fresh while the page is open and visible.
  const tick = () => {
    if (!box.isConnected) return clearInterval(timer);
    if (prefs.range === '1d' && document.visibilityState === 'visible') load(true);
  };
  timer = setInterval(tick, 60e3);

  box.addEventListener('click', (ev) => {
    const r = ev.target.closest('[data-r]');
    const ty = ev.target.closest('[data-ty]');
    if (r && r.dataset.r !== prefs.range) {
      prefs.range = r.dataset.r;
      savePrefs(prefs);
      syncControls();
      load();
    } else if (ty && ty.dataset.ty !== prefs.type) {
      prefs.type = ty.dataset.ty;
      savePrefs(prefs);
      syncControls();
      draw();
    }
  });
  box.addEventListener('change', (ev) => {
    const c = ev.target.closest('[data-i]');
    if (!c) return;
    prefs[c.dataset.i] = c.checked;
    savePrefs(prefs);
    draw();
  });

  let lastW = 0;
  const ro = new ResizeObserver(() => {
    if (!box.isConnected) return ro.disconnect();
    const w = plot.clientWidth;
    if (Math.abs(w - lastW) < 4) return;
    lastW = w;
    draw();
  });
  ro.observe(plot);

  syncControls();
  load();
}
