// Breakout watch: six panels at the top of the home page, each a stock whose
// insider, Congress, social and news signals line up while the price has not
// run yet. Data from /api/breakout. Pure helpers are exported for the tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v, d = 2) => (v == null || !isFinite(v) ? 'n/a' : Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }));
const pct = (v, d = 1) => (v == null || !isFinite(v) ? 'n/a' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%`);
const tone = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (!isFinite(m)) return '';
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} hr ago`;
};

const PARTS = [
  ['insider', 'Insiders', 35],
  ['chart', 'Chart', 25],
  ['congress', 'Congress', 15],
  ['social', 'Social', 15],
  ['news', 'News', 10],
];

// Three month price line with a dashed line at the breakout level.
export function sparkWithTrigger(values, trigger, w = 260, h = 56) {
  const v = (values || []).filter((x) => x != null && isFinite(x));
  if (v.length < 2) return '';
  const lo = Math.min(...v, trigger || Infinity);
  const hi = Math.max(...v, trigger || -Infinity);
  const rng = hi - lo || 1;
  const y = (x) => (h - 3 - ((x - lo) / rng) * (h - 6)).toFixed(1);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${y(x)}`).join(' ');
  const line = trigger ? `<line x1="0" x2="${w}" y1="${y(trigger)}" y2="${y(trigger)}" class="bo-trig"/>` : '';
  return `<svg class="bo-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${line}<polyline points="${pts}" fill="none" stroke="var(--up)" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/></svg>`;
}

export function pickCard(p, i) {
  const bars = PARTS.filter(([k]) => p.breakdown && p.breakdown[k] > 0)
    .map(([k, label, max]) => `<span class="bo-part" title="${esc(label)}: ${p.breakdown[k]} of ${max}"><i style="width:${Math.round((p.breakdown[k] / max) * 100)}%"></i>${esc(label)}</span>`)
    .join('');
  const tags = (p.tags || []).map((t) => `<span class="chip ins">${esc(t)}</span>`).join('');
  const cats = (p.catalysts || []).length ? `<div class="bo-cat muted">In the news: ${esc(p.catalysts.join(', '))}</div>` : '';
  return `<a class="bo-card card" href="#/t/${encodeURIComponent(p.ticker)}">
    <div class="bo-top">
      <span class="bo-rank">${i + 1}</span>
      <div class="bo-id"><div class="bo-tk">${esc(p.ticker)}</div><div class="bo-nm">${esc(p.name || '')}</div></div>
      <div class="bo-score" title="Setup score out of 100"><b>${p.score}</b><small>${esc(p.label)}</small></div>
    </div>
    <div class="bo-px"><span class="mono">${num(p.price)}</span><span class="${tone(p.change1d)} mono">${pct(p.change1d)}</span><span class="muted">today</span></div>
    ${sparkWithTrigger(p.spark, p.trigger)}
    <div class="bo-stats">
      <div><small>1 month</small><span class="${tone(p.ret1m)}">${pct(p.ret1m)}</span></div>
      <div><small>3 months</small><span class="${tone(p.ret3m)}">${pct(p.ret3m)}</span></div>
      <div><small>Breaks out over</small><span>${num(p.trigger)}${p.toTrigger != null && p.toTrigger > 0 ? ` <em class="muted">${pct(p.toTrigger)}</em>` : ''}</span></div>
    </div>
    <div class="chips bo-tags">${tags}</div>
    <ul class="bo-why">${(p.reasons || []).map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    ${cats}
    <div class="bo-parts">${bars}</div>
  </a>`;
}

export function breakoutHtml(d) {
  const picks = (d && d.picks) || [];
  const head = `<div class="bo-head"><h2>Breakout watch</h2><p class="muted">The ${picks.length || 6} stocks where insider buying, Congress trades, social chatter and the chart line up best, and that have not run ${d && d.rules ? d.rules.maxRunPct : 20}% or more in the last 1 to 3 months. Dashed line: the 3 month high to clear.${d && d.updated ? ` Updated ${ago(d.updated)}.` : ''}</p></div>`;
  if (!picks.length) return `${head}<div class="card empty">No stock passes the filters right now. The list rebuilds every hour.</div>`;
  return `${head}<div class="bo-grid">${picks.map(pickCard).join('')}</div>`;
}

export async function mountBreakout(el) {
  el.innerHTML = `<div class="bo-head"><h2>Breakout watch</h2><p class="muted">Scanning insider filings, Congress trades, social buzz and charts…</p></div><div class="bo-grid">${'<div class="bo-card card bo-ghost"></div>'.repeat(6)}</div>`;
  try {
    const r = await fetch('/api/breakout');
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `Request failed (${r.status})`);
    el.innerHTML = breakoutHtml(d);
  } catch (e) {
    el.innerHTML = `<div class="bo-head"><h2>Breakout watch</h2></div><div class="card empty">Could not load breakout picks: ${esc(e.message)}</div>`;
  }
}
