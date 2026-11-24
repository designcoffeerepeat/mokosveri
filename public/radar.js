// Under the radar page (#/radar): small and mid caps where insiders, Congress
// or a growing crowd are buying before the price moves. Pure helpers are
// exported for the offline tests.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (v, d = 1) => (v == null ? '<span class="muted">n/a</span>' : `<span class="${v > 0 ? 'up' : v < 0 ? 'down' : ''}">${v > 0 ? '+' : ''}${Number(v).toFixed(d)}%</span>`);
const px = (v) => (v == null ? 'n/a' : `$${Number(v).toFixed(v < 10 ? 2 : 2)}`);

export const money = (v) => {
  if (v == null) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(a >= 1e10 ? 0 : 1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${(v / 1e3).toFixed(0)}K`;
};

export const capLabel = (c) => (c == null ? '' : c < 300e6 ? 'Micro cap' : c < 2e9 ? 'Small cap' : c < 10e9 ? 'Mid cap' : 'Large cap');

// Price line for the last ~90 sessions with the breakout trigger drawn across.
export function spark(values, trigger) {
  const v = (values || []).filter((x) => x != null);
  if (v.length < 2) return '';
  const w = 240, h = 56;
  const all = trigger ? [...v, trigger] : v;
  const min = Math.min(...all), max = Math.max(...all), rng = max - min || 1;
  const y = (x) => (h - 3 - ((x - min) / rng) * (h - 6)).toFixed(1);
  const pts = v.map((x, i) => `${((i / (v.length - 1)) * w).toFixed(1)},${y(x)}`).join(' ');
  const line = trigger ? `<line class="rd-trig" x1="0" x2="${w}" y1="${y(trigger)}" y2="${y(trigger)}"/>` : '';
  return `<svg class="rd-spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">${line}<polyline points="${pts}"/></svg>`;
}

const meter = (s) => `<div class="rd-meter" role="img" aria-label="Breakout score ${s} of 99"><i style="width:${Math.max(4, Math.min(99, s))}%"></i></div>`;

export function pickCard(p, i) {
  const lv = p.levels;
  return `<article class="card rd-card rd-${esc((p.conviction || '').toLowerCase())}">
    <a class="rd-head" href="#/t/${encodeURIComponent(p.ticker)}">
      <span class="rd-rank">${i + 1}</span>
      <span class="rd-id"><b class="mono">${esc(p.ticker)}</b><span class="muted small">${esc(p.name)}</span></span>
      <span class="rd-score"><b>${p.score}</b><small>${esc(p.conviction)}</small></span>
    </a>
    ${meter(p.score)}
    <div class="rd-sub small muted">${px(p.price)} ${pct(p.change1d)} today · ${money(p.marketCap)} ${esc(capLabel(p.marketCap).toLowerCase())}</div>
    ${spark(p.spark, lv && !lv.breaking ? lv.trigger : null)}
    <p class="rd-thesis">${esc(p.thesis)}</p>
    <div class="rd-tags">${(p.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</div>
    ${
      lv
        ? `<dl class="rd-lv">
      <div><dt>${lv.breaking ? 'Breaking out at' : 'Buy trigger'}</dt><dd>${px(lv.trigger)}</dd></div>
      <div><dt>Target</dt><dd class="up">${px(lv.target)} <small>+${lv.upside}%</small></dd></div>
      <div><dt>Wrong below</dt><dd>${px(lv.fails)}</dd></div>
    </dl>`
        : ''
    }
    <dl class="rd-kv small">
      <div><dt>1 month</dt><dd>${pct(p.ret1m)}</dd></div>
      <div><dt>3 months</dt><dd>${pct(p.ret3m)}</dd></div>
      <div><dt>From 52w high</dt><dd>${pct(p.fromHigh, 0)}</dd></div>
      <div><dt>RSI</dt><dd>${p.rsi == null ? 'n/a' : p.rsi.toFixed(0)}</dd></div>
    </dl>
    <details class="rd-why"><summary>Why it made the list</summary><ul>${(p.why || []).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>
      ${p.headline && p.headline.link ? `<p class="small"><a href="${esc(p.headline.link)}" target="_blank" rel="noopener">Read the latest headline</a></p>` : ''}
      <p class="small muted">Score parts: insiders ${Math.round(p.parts.insider.pts)}, Congress ${Math.round(p.parts.congress.pts)}, buzz ${Math.round(p.parts.social.pts)}, chart setup ${Math.round(p.parts.setup.pts)}, under the radar ${Math.round(p.parts.radar.pts)}${p.parts.news.pts ? `, news ${p.parts.news.pts > 0 ? '+' : ''}${Math.round(p.parts.news.pts)}` : ''}</p>
    </details>
  </article>`;
}

export function benchTable(rows) {
  if (!rows || !rows.length) return '';
  return `<div class="card tbl-wrap"><table class="tbl rd-tbl"><thead><tr><th>Ticker</th><th>Score</th><th class="hide-sm">Size</th><th>3 months</th><th>Trigger</th><th class="hide-sm">Signals</th></tr></thead><tbody>${rows
    .map(
      (p) => `<tr><td><a href="#/t/${encodeURIComponent(p.ticker)}"><b class="mono">${esc(p.ticker)}</b> <span class="muted small rd-nm">${esc(p.name)}</span></a></td>
      <td><b>${p.score}</b></td><td class="hide-sm">${money(p.marketCap)}</td><td>${pct(p.ret3m)}</td><td>${p.levels ? px(p.levels.trigger) : 'n/a'}</td>
      <td class="hide-sm">${(p.tags || []).slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}</td></tr>`
    )
    .join('')}</tbody></table></div>`;
}

export function ranHtml(rows) {
  if (!rows || !rows.length) return '';
  return `<h2 class="section">Had the signals, already ran <small class="muted">left off the list</small></h2>
  <div class="rd-ran">${rows.map((r) => `<a class="chip" href="#/t/${encodeURIComponent(r.ticker)}" title="${esc(r.name)}"><b class="mono">${esc(r.ticker)}</b> ${esc(r.why)}</a>`).join('')}</div>`;
}

const METHOD = `<h2 class="section">How the picks are made</h2>
<div class="card rd-method"><ol>
  <li><b>Find the money moving in early.</b> Every open market insider purchase from the last 30 days (SEC Form 4 and OpenInsider), congressional buys disclosed in the last 45 days, Reddit names whose mentions are climbing fast from a low base, and StockTwits trending names.</li>
  <li><b>Keep it under the radar.</b> Stocks only, $30M to $15B market cap, priced over $1, at least $250K traded a day. The 15 most talked about names on Reddit are dropped: everyone already knows them.</li>
  <li><b>Skip what already ran.</b> Anything up 20% or more over 1 or 3 months, or 15% in a week, is out.</li>
  <li><b>Score the setup.</b> Insider buys count more when several insiders or top executives buy, and when the buy is big next to the size of the company. The chart scores higher when it is coiled tight just under its 60 day high, volatility has squeezed, and volume shows quiet accumulation. Fresh headlines nudge the score up or down.</li>
  <li><b>Call the levels.</b> The trigger is the 60 day high. The target adds the height of the base on top of it. The idea is wrong if price closes under the nearest support (the base low or the 50 day average).</li>
</ol></div>`;

export async function renderRadar(app, api) {
  const hero = `<section class="hero"><h1>Under the radar</h1><p>Small and mid caps where insiders, Congress or a growing crowd are buying in while the price has barely moved. Ranked by how likely each one looks to break out next, with the price that confirms it and where it could run.</p>`;
  app.innerHTML = `${hero}</section><div class="loading"><div class="spinner"></div>Scanning insider buys, Congress trades, social buzz and charts…</div>`;
  let d;
  try {
    d = await api('/api/radar');
  } catch (e) {
    app.innerHTML = `${hero}</section><div class="err"><h2>Could not build the radar</h2><p class="muted">${esc(e.message)}</p><p><a href="#/radar" onclick="location.reload();return false">Try again</a></p></div>`;
    return;
  }
  const s = d.stats || {};
  const down = Object.entries(d.status || {}).filter(([, v]) => v !== 'ok').map(([k]) => k);
  app.innerHTML = `${hero}
    <div class="meta-line">Updated ${esc(new Date(d.asOf).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }))}${d.refreshing ? ', refreshing now' : ''} · ${s.candidates || 0} names scanned, ${s.screened || 0} passed the size and liquidity screen, ${s.charted || 0} charted</div></section>
    ${down.length ? `<div class="notice small">Some sources did not answer this time (${esc(down.join(', '))}), so the list leans on the rest.</div>` : ''}
    <h2 class="section">Top picks</h2>
    ${d.picks && d.picks.length ? `<div class="rd-grid">${d.picks.map(pickCard).join('')}</div>` : '<div class="card rd-empty">Nothing passed every filter this run. Check back after the next refresh.</div>'}
    ${d.bench && d.bench.length ? `<h2 class="section">Next on the radar</h2>${benchTable(d.bench)}` : ''}
    ${ranHtml(d.alreadyRan)}
    ${METHOD}`;
}
