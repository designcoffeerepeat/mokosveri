// Market sentiment page (#/sentiment): composite bearish to bullish rating,
// each component's contribution, prediction markets and famous investors' 13F moves.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = (v) => {
  if (v == null || !isFinite(v)) return 'n/a';
  const a = Math.abs(v);
  const s = v < 0 ? '-' : '';
  if (a >= 1e9) return `${s}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(0)}K`;
  return `${s}$${a.toFixed(0)}`;
};
const signed = (v, d = 0) => (v == null ? 'n/a' : `${v > 0 ? '+' : ''}${Number(v).toFixed(d)}`);
const tone = (s) => (s == null ? 'flat' : s >= 20 ? 'up' : s <= -20 ? 'down' : 'flat');
const qtr = (d) => {
  if (!d) return 'n/a';
  const dt = new Date(d + 'T12:00:00Z');
  return `Q${Math.floor(dt.getUTCMonth() / 3) + 1} ${dt.getUTCFullYear()}`;
};
const shortDate = (d) => (d ? new Date(d.length === 10 ? d + 'T12:00:00Z' : d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '');

// Half circle dial from -100 to +100.
function dial(score) {
  const s = score == null ? 0 : Math.max(-100, Math.min(100, score));
  const a = Math.PI * (1 - (s + 100) / 200);
  const cx = 110, cy = 104, r = 86;
  const x = (cx + r * Math.cos(a)).toFixed(1);
  const y = (cy - r * Math.sin(a)).toFixed(1);
  const seg = (from, to, cls) => {
    const a1 = Math.PI * (1 - (from + 100) / 200);
    const a2 = Math.PI * (1 - (to + 100) / 200);
    return `<path class="${cls}" d="M${(cx + r * Math.cos(a1)).toFixed(1)} ${(cy - r * Math.sin(a1)).toFixed(1)} A${r} ${r} 0 0 1 ${(cx + r * Math.cos(a2)).toFixed(1)} ${(cy - r * Math.sin(a2)).toFixed(1)}"/>`;
  };
  return `<svg class="mk-dial" viewBox="0 0 220 120" role="img" aria-label="Composite score ${score ?? 'n/a'} on a scale from minus 100 to plus 100">
    ${seg(-100, -61, 'b2')}${seg(-59, -21, 'b1')}${seg(-19, 19, 'n')}${seg(21, 59, 'u1')}${seg(61, 100, 'u2')}
    ${score == null ? '' : `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" class="needle"/><circle cx="${cx}" cy="${cy}" r="5" class="hub"/>`}
  </svg>`;
}

function line(values, cls = '') {
  if (!values || values.length < 2) return '';
  const w = 240, h = 54;
  const min = Math.min(...values), max = Math.max(...values), rng = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 3 - ((v - min) / rng) * (h - 6)).toFixed(1)}`).join(' ');
  return `<svg class="mk-line ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

function compRow(c) {
  if (!c.available) {
    return `<li class="mk-comp off"><div class="mk-comp-top"><span class="nm">${esc(c.name)}<small>${esc(c.group)}</small></span><span class="mk-bar"></span><span class="sc muted">n/a</span></div>
      <details><summary>Unavailable: ${esc(c.error || 'no data')}</summary><p>${esc(c.how)}</p></details></li>`;
  }
  const w = Math.min(50, Math.abs(c.score) / 2);
  const side = c.score >= 0 ? `left:50%;width:${w}%` : `left:${50 - w}%;width:${w}%`;
  return `<li class="mk-comp"><div class="mk-comp-top">
      <span class="nm">${esc(c.name)}<small>${esc(c.group)}</small></span>
      <span class="mk-bar" title="Score ${signed(c.score)}"><i class="${c.score >= 0 ? 'up' : 'down'}" style="${side}"></i></span>
      <span class="sc mono ${tone(c.score)}">${signed(c.score)}</span>
    </div>
    <div class="mk-comp-val">${esc(c.value)}</div>
    <details><summary>Weight ${c.share}% of the rating, adds <b class="mono ${c.contribution >= 0 ? 'up' : 'down'}">${signed(c.contribution, 1)}</b> points</summary>
      <p>${esc(c.how)} Source: ${c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.source)}</a>` : esc(c.source)}.</p></details></li>`;
}

function moveRow(m) {
  const kind = m.kind === 'long' ? '' : ` <span class="chip ${m.kind === 'put' ? 'mk-put' : 'mk-call'}">${m.kind}</span>`;
  const cls = m.action === 'New' || m.action === 'Added' ? (m.kind === 'put' ? 'down' : 'up') : m.kind === 'put' ? 'up' : 'down';
  return `<tr><td><span class="mk-act ${cls}">${esc(m.action)}</span></td><td>${esc(m.name)}${kind}</td>
    <td class="mono r">${m.pct == null ? '' : signed(m.pct) + '%'}</td><td class="mono r ${cls}">${money(m.change)}</td></tr>`;
}

function investorCard(i) {
  const head = `<div class="mk-inv-h"><div><h3>${esc(i.person)}</h3><div class="muted small">${esc(i.fund)} · ${esc(i.style)}</div></div>
    ${i.stance == null ? '<span class="pill flat mk-st">n/a</span>' : `<span class="pill ${tone(i.stance)} mk-st" title="Stance from -100 (bearish) to +100 (bullish)">${signed(i.stance)}</span>`}</div>`;
  if (i.pending) return `<article class="card mk-inv">${head}<p class="muted small mk-pad">${i.error ? `Could not load filings: ${esc(i.error)}` : 'Loading this filing in the background. Refresh in a minute.'}</p></article>`;
  const stale = i.weight < 1 ? `<span class="chip mk-stale" title="Older filings count less in the rating">${i.weight === 0 ? 'Too old to count' : `Counts ${Math.round(i.weight * 100)}%`}</span>` : '';
  const t = i.totals || {};
  const opts = t.puts || t.calls ? ` · puts ${money(t.puts)}, calls ${money(t.calls)}` : '';
  return `<article class="card mk-inv">${head}
    <div class="mk-inv-meta small"><span>${qtr(i.period)} holdings, filed ${esc(shortDate(i.filed))}</span>${stale}</div>
    <div class="mk-inv-stats small"><span>Long book <b class="mono">${money(t.long)}</b>${opts}</span>
      <span>Net buying <b class="mono ${i.flowPct >= 0 ? 'up' : 'down'}">${signed(i.flowPct, 1)}%</b></span>
      ${i.hedgePct ? `<span>Put hedge <b class="mono ${i.hedgePct > 0 ? 'down' : 'up'}">${signed(i.hedgePct, 1)}%</b></span>` : ''}</div>
    ${i.moves.length ? `<div class="tbl-wrap"><table class="mk-moves"><thead><tr><th>Move</th><th>Holding</th><th class="r">Shares</th><th class="r">Est. $</th></tr></thead><tbody>${i.moves.slice(0, 6).map(moveRow).join('')}</tbody></table></div>` : '<p class="muted small mk-pad">No changes of 10% or more since the prior quarter.</p>'}
    ${i.top.length ? `<p class="small muted mk-pad">Top holdings: ${i.top.slice(0, 4).map((h) => `${esc(h.name)} ${h.weight.toFixed(0)}%`).join(', ')}</p>` : ''}
    <p class="small mk-pad"><a href="${esc(i.url)}" target="_blank" rel="noopener">13F filings on SEC EDGAR</a></p>
  </article>`;
}

function marketRow(m) {
  const p = Math.round(m.prob * 100);
  return `<li><a href="${esc(m.url)}" target="_blank" rel="noopener"><span class="q">${esc(m.question)}</span>
    <span class="mk-prob"><i style="width:${p}%"></i></span><b class="mono">${p}%</b></a>
    <small class="muted">${esc(m.source)}${m.volume ? ` · ${money(m.volume)} traded` : ''}${m.ends ? ` · ends ${esc(shortDate(String(m.ends).slice(0, 10)))}` : ''}</small></li>`;
}

export async function renderSentiment(app, api) {
  app.innerHTML = `<section class="hero"><h1>Market sentiment</h1><p>What famous investors, forecasters and the crowd are signaling about the overall market, combined into one transparent rating.</p></section>
    <div class="loading"><div class="spinner"></div>Gathering gauges, prediction markets and 13F filings…</div>`;
  let d;
  try {
    d = await api('/api/sentiment');
  } catch (e) {
    app.innerHTML = `<div class="err"><h2>Could not load market sentiment</h2><p class="muted">${esc(e.message)}</p></div>`;
    return;
  }
  const r = d.rating;
  const groups = [...new Set(r.components.map((c) => c.group))];
  const ranked = [...r.components].sort((a, b) => (b.available - a.available) || Math.abs(b.contribution || 0) - Math.abs(a.contribution || 0));
  const pend = d.investors.filter((i) => i.pending && !i.error).length;
  app.innerHTML = `
    <section class="hero"><h1>Market sentiment</h1>
      <p>What famous investors, forecasters and the crowd are signaling about the overall market, combined into one transparent rating. This reads the mood; it does not predict prices.</p>
      <div class="meta-line">Updated ${esc(new Date(d.asOf).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}</div></section>

    <section class="card mk-score">
      <div class="mk-score-main">
        ${dial(r.score)}
        <div class="mk-score-num mono ${tone(r.score)}">${r.score == null ? 'n/a' : signed(r.score)}</div>
        <div class="mk-score-lbl">${esc(r.label)}</div>
        <div class="mk-scale small muted"><span>Very bearish</span><span>Neutral</span><span>Very bullish</span></div>
        <div class="small muted">${r.used} of ${r.of} components reporting · ${esc(r.confidence)} confidence</div>
      </div>
      <div class="mk-score-side">
        <h3>What is moving the rating</h3>
        <p class="small muted">Each component scores from -100 to +100. Its points are its score times its weight; the points add up to the rating. Missing components drop out and the rest are re-weighted.</p>
        <ul class="mk-contrib">${ranked.filter((c) => c.available).map((c) => `<li><span>${esc(c.name)}</span><b class="mono ${c.contribution >= 0 ? 'up' : 'down'}">${signed(c.contribution, 1)}</b></li>`).join('')}
          <li class="tot"><span>Rating</span><b class="mono ${tone(r.score)}">${r.score == null ? 'n/a' : signed(r.score)}</b></li></ul>
      </div>
    </section>

    ${d.extremes.length ? `<div class="notice mk-extreme"><b>Contrarian flags.</b> ${d.extremes.map(esc).join(' ')}</div>` : ''}

    <h2 class="section">Components <small>open any row to see how it is scored</small></h2>
    <div class="grid2 mk-groups">${groups.map((g) => `<div class="card"><div class="card-h"><h3>${esc(g)}</h3></div><ul class="mk-comps">${r.components.filter((c) => c.group === g).map(compRow).join('')}</ul></div>`).join('')}
      ${d.trendSeries || d.vixSeries ? `<div class="card mk-charts"><div class="card-h"><h3>Context</h3></div>
        ${d.trendSeries ? `<div class="mk-chart"><span class="small muted">S&amp;P 500, 6 months</span>${line(d.trendSeries, d.trendSeries.at(-1) >= d.trendSeries[0] ? 'up' : 'down')}</div>` : ''}
        ${d.vixSeries ? `<div class="mk-chart"><span class="small muted">VIX, 3 months</span>${line(d.vixSeries, 'warn')}</div>` : ''}</div>` : ''}
    </div>

    <h2 class="section">Forecasters and prediction markets <small>real money odds, not scored unless about recession</small></h2>
    <div class="card"><ul class="mk-markets">${d.markets.length ? d.markets.map(marketRow).join('') : '<li class="muted">No prediction market data right now.</li>'}</ul></div>

    <h2 class="section">Famous investors <small>latest 13F vs the quarter before${pend ? ` · ${pend} still loading` : ''}</small></h2>
    <p class="small muted mk-note">13F filings list US stock and option positions at quarter end and arrive up to 45 days later. They omit shorts, cash, bonds and foreign holdings, so they show what a fund bought and sold, not its full view. Burry's Scion stopped filing after it deregistered in late 2025, so its last filing ages out of the rating over time.</p>
    <div class="grid2 mk-invs">${d.investors.map(investorCard).join('')}</div>

    <h2 class="section">Not included</h2>
    <div class="card mk-na"><ul>${d.notAvailable.map((n) => `<li><b>${esc(n.name)}.</b> <span class="muted">${esc(n.reason)}</span></li>`).join('')}</ul></div>

    <div class="notice"><b>Not financial advice.</b> This page summarizes public sentiment data with a simple, rules based model. It is not a forecast or a recommendation to buy or sell anything. Sentiment can stay extreme for a long time, crowds are often most bullish near tops, and famous investors are often early or wrong. Data can be delayed, incomplete or unavailable. Do your own research and consult a licensed professional before investing.</div>
  `;
}
