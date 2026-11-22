// AI lenses on the ticker page. Six analysis frameworks shown as tiles; tapping
// one asks /api/lens for a structured read built from this stock's real data
// (SEC filings, valuation, estimates, the chart). Nothing loads until a tile
// is tapped, and answers are kept for the visit so switching back is instant.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const ok = (v) => v != null && isFinite(v);
const pct = (v, d = 1, sign = false) => (ok(v) ? `${sign && v > 0 ? '+' : ''}${Number(v).toFixed(d)}%` : 'n/a');
const mult = (v, d = 1) => (ok(v) ? `${Number(v).toFixed(d)}x` : 'n/a');
const money = (v) => {
  if (!ok(v)) return 'n/a';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${Math.round(v).toLocaleString()}`;
};
const qLabel = (d) => {
  if (!d) return '';
  const dt = new Date(`${d}T12:00:00Z`);
  return `${dt.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })} ${String(dt.getUTCFullYear()).slice(2)}`;
};
const ago = (iso) => {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} hr ago` : `${Math.round(h / 24)} days ago`;
};

const I = (d) => `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;

export const LENSES = [
  {
    id: 'devil',
    title: 'Stress test my thesis',
    q: 'What could prove me wrong?',
    icon: I('<path d="M12 3l8 4v5c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V7z"/><path d="M12 8v5M12 16.5v.5"/>'),
    loading: 'Building the strongest case against you',
    pointsLabel: 'Strongest arguments against you',
    watchLabel: 'What would prove you wrong',
    badge: (ai) => ({ strong: 'down', moderate: 'warn', weak: 'up' })[ai.rating.toLowerCase()],
    ratingLabel: (r) => `Counter case: ${r}`,
  },
  {
    id: 'margins',
    title: 'Margin trends',
    q: 'Are growth and margins speeding up or slipping?',
    icon: I('<path d="M4 19h16"/><path d="M5 15l4-4 3 3 7-7"/><path d="M15 7h4v4"/>'),
    loading: 'Reading 12 quarters of SEC filings and peer multiples',
    pointsLabel: 'What changed and why',
    watchLabel: 'Check next quarter',
    badge: (ai) => ({ improving: 'up', stable: 'flat', deteriorating: 'down' })[ai.rating.toLowerCase()],
  },
  {
    id: 'earnings',
    title: 'Earnings quality',
    q: 'Was the last report as good as the headline?',
    icon: I('<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h3"/>'),
    loading: 'Reading the latest earnings release and estimate changes',
    pointsLabel: 'Quality of the numbers',
    watchLabel: 'Red flags',
    badge: (ai) => ({ high: 'up', mixed: 'warn', low: 'down' })[ai.rating.toLowerCase()],
    ratingLabel: (r) => `Quality: ${r}`,
  },
  {
    id: 'convergence',
    title: 'Chart vs fundamentals',
    q: 'Do the chart and the numbers agree?',
    icon: I('<circle cx="9" cy="12" r="5"/><circle cx="15" cy="12" r="5"/>'),
    loading: 'Lining up the chart against the fundamentals',
    pointsLabel: 'The read',
    watchLabel: 'Levels and data to watch',
  },
  {
    id: 'macro',
    title: 'Macro stress test',
    q: 'Who handles rates, oil or a recession better?',
    icon: I('<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.5 2.5 2.5 13.5 0 16M12 4c-2.5 2.5-2.5 13.5 0 16"/>'),
    loading: 'Comparing balance sheets, pricing power and exposure',
    pointsLabel: 'Head to head',
    watchLabel: 'What to monitor',
  },
  {
    id: 'moat',
    title: 'Moat check',
    q: 'How durable is its competitive edge?',
    icon: I('<path d="M4 20V9l4-3 4 3 4-3 4 3v11"/><path d="M4 20h16M10 20v-4h4v4"/>'),
    loading: 'Weighing the moat against emerging threats',
    pointsLabel: 'Moat and evidence',
    watchLabel: 'Threats that could erode it',
    badge: (ai) => ({ strong: 'up', moderate: 'warn', weak: 'down' })[ai.rating.toLowerCase()],
    ratingLabel: (r) => `Durability: ${r}`,
  },
];

export const MACRO_EVENTS = [
  ['rates_high', 'High rates'],
  ['rate_cuts', 'Rate cuts'],
  ['oil_up', 'Oil spike'],
  ['recession', 'Recession'],
  ['inflation', 'Hot inflation'],
  ['dollar_up', 'Strong dollar'],
  ['tariffs', 'Tariffs'],
];

const toneCls = (t) => ({ positive: 'up', negative: 'down', mixed: 'warn' })[t] || 'flat';

export function badgeFor(lens, ai) {
  const l = LENSES.find((x) => x.id === lens);
  return (l && l.badge && ai.rating && l.badge(ai)) || toneCls(ai.tone);
}

// ---------- data panels (the numbers behind each read) ----------

function spark(vals, cls = '') {
  const v = vals.filter(ok);
  if (v.length < 3) return '';
  const w = 96;
  const h = 26;
  const min = Math.min(...v);
  const max = Math.max(...v);
  const rng = max - min || 1;
  let i = -1;
  const pts = vals
    .map((y) => {
      i++;
      return ok(y) ? `${((i / (vals.length - 1)) * w).toFixed(1)},${(h - 3 - ((y - min) / rng) * (h - 6)).toFixed(1)}` : null;
    })
    .filter(Boolean)
    .join(' ');
  return `<svg class="ln-spark ${cls}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><polyline points="${pts}"/></svg>`;
}

const flagCls = (dir) => (/accel|expand/.test(dir) ? 'up' : /decel|contract/.test(dir) ? 'down' : 'flat');

function flagChips(flags) {
  if (!flags || !flags.length) return '';
  return `<div class="ln-flags">${flags
    .map((f) => `<span class="ln-flag ${flagCls(f.dir)}"><b>${esc(f.metric)}</b> ${esc(f.dir)} <span class="mono">${pct(f.before)} to ${pct(f.now)}</span></span>`)
    .join('')}</div>`;
}

function valTable(rows, cols) {
  return `<div class="ln-tbl"><table><thead><tr><th></th>${cols.map(([l]) => `<th class="num">${esc(l)}</th>`).join('')}</tr></thead><tbody>${rows
    .map((r, i) => `<tr${i === 0 ? ' class="me"' : ''}><td class="mono">${esc(r.ticker)}</td>${cols.map(([, k, fmt]) => `<td class="num">${fmt(r[k])}</td>`).join('')}</tr>`)
    .join('')}</tbody></table></div>`;
}

const VAL_COLS = [
  ['P/E', 'pe', (v) => mult(v)],
  ['Fwd P/E', 'forwardPe', (v) => mult(v)],
  ['P/S', 'ps', (v) => mult(v)],
  ['EV/EBITDA', 'evEbitda', (v) => mult(v)],
  ['Gross margin', 'grossMargin', (v) => pct(v)],
  ['Op margin', 'opMargin', (v) => pct(v)],
  ['Rev growth', 'revGrowth', (v) => pct(v, 1, true)],
];

function kv(pairs) {
  const items = pairs.filter(([, v]) => v != null && v !== 'n/a');
  return items.length ? `<dl class="ln-kv">${items.map(([k, v, c]) => `<div><dt>${esc(k)}</dt><dd class="${c || ''}">${v}</dd></div>`).join('')}</dl>` : '';
}

const valKv = (v) =>
  v
    ? kv([
        ['P/E', mult(v.pe)],
        ['Forward P/E', mult(v.forwardPe)],
        ['P/S', mult(v.ps)],
        ['EV/EBITDA', mult(v.evEbitda)],
        ['FCF yield', pct(v.fcfYield)],
        ['Debt/equity', mult(v.debtToEquity, 2)],
        ['Gross margin', pct(v.grossMargin)],
        ['Rev growth', pct(v.revGrowth, 1, true), v.revGrowth > 0 ? 'up' : v.revGrowth < 0 ? 'down' : ''],
      ])
    : '';

const PANELS = {
  devil(d) {
    return `${flagChips(d.flags)}${valKv(d.valuation)}`;
  },
  margins(d) {
    const q = d.quarters || [];
    const trend = q.length
      ? `<div class="ln-trends">${[
          ['Revenue growth', 'revGrowth', true],
          ['Gross margin', 'grossMargin', false],
          ['Operating margin', 'opMargin', false],
        ]
          .map(([l, k, s]) => {
            const vals = q.map((r) => r[k]);
            const last = [...vals].reverse().find(ok);
            const first = vals.find(ok);
            return `<div class="ln-trend"><div class="k">${l}</div><div class="v mono">${pct(last, 1, s)}</div>${spark(vals, ok(last) && ok(first) ? (last >= first ? 'up' : 'down') : '')}</div>`;
          })
          .join('')}</div>`
      : '<p class="muted small">Quarterly SEC figures are not available for this company.</p>';
    const table = q.length
      ? `<details class="ln-more"><summary>All ${q.length} quarters</summary><div class="ln-tbl"><table><thead><tr><th>Quarter</th><th class="num">Revenue</th><th class="num">Growth</th><th class="num">Gross</th><th class="num">Operating</th></tr></thead><tbody>${q
          .slice()
          .reverse()
          .map((r) => `<tr><td>${qLabel(r.end)}${r.derived ? ' <span class="muted" title="Q4 worked out from the annual report">*</span>' : ''}</td><td class="num">${money(r.revenue)}</td><td class="num ${r.revGrowth > 0 ? 'up' : r.revGrowth < 0 ? 'down' : ''}">${pct(r.revGrowth, 1, true)}</td><td class="num">${pct(r.grossMargin)}</td><td class="num">${pct(r.opMargin)}</td></tr>`)
          .join('')}</tbody></table></div></details>`
      : '';
    const peers = d.valuation ? valTable([{ ...d.valuation }, ...(d.peers || [])], VAL_COLS) : '';
    return `${trend}${flagChips(d.flags)}${table}${peers ? `<div class="ln-sub">Valuation vs closest competitors</div>${peers}` : ''}`;
  },
  earnings(d) {
    const h = d.history || [];
    const hist = h.length
      ? `<div class="ln-sub">EPS vs estimate, last ${h.length} quarters</div><div class="ln-beats">${h
          .map((x) => {
            const beat = ok(x.surprisePct) ? x.surprisePct >= 0 : x.actual >= x.estimate;
            return `<div class="ln-beat ${beat ? 'up' : 'down'}"><div class="k">${qLabel(x.quarter)}</div><div class="v mono">${ok(x.actual) ? x.actual.toFixed(2) : 'n/a'}</div><div class="s">${beat ? 'Beat' : 'Miss'} ${pct(x.surprisePct, 1, true)}</div></div>`;
          })
          .join('')}</div>`
      : '';
    const tr = (d.trend || []).filter((r) => ok(r.eps));
    const trend = tr.length
      ? `<div class="ln-sub">Analyst estimates since the report</div><div class="ln-tbl"><table><thead><tr><th>Period</th><th class="num">EPS est.</th><th class="num">30 day change</th><th class="num">Revisions up / down</th></tr></thead><tbody>${tr
          .map((r) => `<tr><td>${esc(r.period)}</td><td class="num">${r.eps.toFixed(2)}</td><td class="num ${r.change30 > 0 ? 'up' : r.change30 < 0 ? 'down' : ''}">${pct(r.change30, 1, true)}</td><td class="num">${r.up30 ?? 'n/a'} / ${r.down30 ?? 'n/a'}</td></tr>`)
          .join('')}</tbody></table></div>`
      : '';
    const rel = d.release ? `<p class="small ln-src">Read from the <a href="${esc(d.release.url)}" target="_blank" rel="noopener">earnings press release</a> filed with the SEC on ${esc(d.release.filed)}. Call transcripts are not available, so commentary comes from the release.</p>` : '<p class="small muted ln-src">The earnings press release could not be fetched, so this read leans on the numbers above.</p>';
    return `${hist}${trend}${rel}`;
  },
  convergence(d) {
    const r = d.read || {};
    const col = (title, stance, list) => `<div class="ln-side"><div class="ln-side-h"><span>${title}</span><b class="${/bull|attract/.test(stance) ? 'up' : /bear|stretch/.test(stance) ? 'down' : ''}">${esc(stance || 'n/a')}</b></div><ul>${(list || [])
      .map((s) => `<li><i class="${s.s > 0 ? 'up' : s.s < 0 ? 'down' : ''}"></i><span>${esc(s.label)}</span><span class="mono">${esc(s.value)}</span>${s.note ? `<small>${esc(s.note)}</small>` : ''}</li>`)
      .join('')}</ul></div>`;
    return `<div class="ln-vs">${col('The chart says', r.techStance, r.tech)}<div class="ln-align"><span>${esc(r.alignment || '')}</span></div>${col('The numbers say', r.fundStance, r.fund)}</div>`;
  },
  macro(d) {
    if (!d.b) return '<p class="muted small">No comparison company found. Type one above.</p>';
    const a = { ...(d.a.valuation || {}), ticker: d.ticker };
    const b = { ...(d.b.valuation || {}), ticker: d.b.ticker };
    const rows = [
      ['Debt/equity', 'debtToEquity', (v) => mult(v, 2), -1],
      ['Current ratio', 'currentRatio', (v) => (ok(v) ? v.toFixed(2) : 'n/a'), 1],
      ['Cash', 'totalCash', money, 1],
      ['Gross margin', 'grossMargin', (v) => pct(v), 1],
      ['Operating margin', 'opMargin', (v) => pct(v), 1],
      ['Revenue growth', 'revGrowth', (v) => pct(v, 1, true), 1],
      ['Beta', 'beta', (v) => (ok(v) ? v.toFixed(2) : 'n/a'), -1],
      ['Forward P/E', 'forwardPe', (v) => mult(v), -1],
    ];
    const better = (x, y, dir) => (ok(x) && ok(y) && x !== y ? ((x - y) * dir > 0 ? 'a' : 'b') : '');
    return `<div class="ln-tbl"><table class="ln-cmp"><thead><tr><th></th><th class="num">${esc(a.ticker || 'This stock')}</th><th class="num">${esc(b.ticker)}</th></tr></thead><tbody>${rows
      .map(([l, k, fmt, dir]) => {
        const w = better(a[k], b[k], dir);
        return `<tr><td>${l}</td><td class="num ${w === 'a' ? 'win' : ''}">${fmt(a[k])}</td><td class="num ${w === 'b' ? 'win' : ''}">${fmt(b[k])}</td></tr>`;
      })
      .join('')}</tbody></table></div><p class="small muted ln-src">Highlighted cells are the stronger number. Geographic revenue mix comes from the AI's general knowledge, not this data.</p>`;
  },
  moat(d) {
    const s = d.stability || {};
    return `${kv([
      ['Gross margin range', ok(s.grossMin) ? `${pct(s.grossMin)} to ${pct(s.grossMax)}` : null],
      ['Op margin range', ok(s.opMin) ? `${pct(s.opMin)} to ${pct(s.opMax)}` : null],
      ['Return on equity', d.valuation ? pct(d.valuation.roe) : null],
      ['Rev growth', d.valuation ? pct(d.valuation.revGrowth, 1, true) : null],
      ['Market cap', d.valuation ? money(d.valuation.marketCap) : null],
    ])}${(d.peers || []).length ? `<p class="small muted ln-src">Compared with ${d.peers.map((p) => esc(p.ticker)).join(', ')}. Margin ranges cover the last ${s.quarters || 0} quarters from SEC filings.</p>` : ''}`;
  },
};

// ---------- result ----------

export function resultHtml(r, lens) {
  const l = LENSES.find((x) => x.id === lens);
  const ai = r.ai;
  const panel = PANELS[lens] ? PANELS[lens]({ ...r.data, ticker: r.ticker }) : '';
  const head = ai
    ? `<div class="ln-head"><span class="ln-badge ${badgeFor(lens, ai)}">${esc(ai.verdict || ai.rating)}</span>${ai.rating && l.ratingLabel && !String(ai.verdict).toLowerCase().includes(ai.rating.toLowerCase()) ? `<span class="ln-rating">${esc(l.ratingLabel(ai.rating.toLowerCase()))}</span>` : ''}<p class="ln-headline">${esc(ai.headline)}</p></div>`
    : `<div class="ln-head"><span class="ln-badge flat">No AI read</span><p class="ln-headline muted">${esc(r.aiError || 'The AI read is unavailable right now.')} The numbers below are still current.</p></div>`;
  const pts = ai && ai.points.length
    ? `<div class="ln-label">${esc(l.pointsLabel)}</div><ol class="ln-points">${ai.points.map((p) => `<li>${p.tag ? `<span class="ln-tag">${esc(p.tag)}</span>` : ''}<b>${esc(p.title)}</b><p>${esc(p.detail)}</p></li>`).join('')}</ol>`
    : '';
  const watch = ai && ai.watch.length ? `<div class="ln-watch"><div class="ln-label">${esc(l.watchLabel)}</div><ul>${ai.watch.map((w) => `<li>${esc(w)}</li>`).join('')}</ul></div>` : '';
  return `${head}
    <div class="ln-body">
      <div class="ln-main">${pts}${watch}</div>
      <div class="ln-data"><div class="ln-label">The numbers behind this</div>${panel || '<p class="muted small">No data panel for this lens.</p>'}</div>
    </div>
    <div class="ln-foot">
      <span>${ai ? 'AI read built from the data shown' : 'Data only'}, ${esc(ago(r.asOf))}. Not financial advice.</span>
      <button type="button" class="ln-link" data-act="refresh">Run again</button>
      <details class="ln-q"><summary>The question asked</summary><p>${esc(r.prompt)}</p><button type="button" class="ln-link" data-act="copy">Copy question</button></details>
    </div>`;
}

// ---------- mount ----------

export function mountLenses(el, ticker, api) {
  const memo = new Map();
  let active = null;
  let seq = 0;
  const state = { side: 'bullish', event: 'rates_high', vs: '' };

  el.innerHTML = `<div class="ln-grid" role="tablist" aria-label="AI lenses">${LENSES.map(
    (l) => `<button type="button" class="ln-tile" role="tab" aria-selected="false" data-lens="${l.id}"><span class="ln-ic">${l.icon}</span><span class="ln-t">${esc(l.title)}</span><span class="ln-qq">${esc(l.q)}</span></button>`
  ).join('')}</div><div class="card ln-panel" id="lnPanel" role="tabpanel" hidden></div>`;
  const panel = el.querySelector('#lnPanel');

  const query = (lens, fresh) => {
    const p = new URLSearchParams();
    if (lens === 'devil') p.set('side', state.side);
    if (lens === 'macro') {
      p.set('event', state.event);
      if (state.vs) p.set('vs', state.vs);
    }
    if (fresh) p.set('fresh', '1');
    const s = p.toString();
    return `/api/lens/${encodeURIComponent(ticker)}/${lens}${s ? `?${s}` : ''}`;
  };

  const controls = (lens) => {
    if (lens === 'devil')
      return `<div class="ln-ctl"><span class="ln-ctl-l">My view on ${esc(ticker)}</span><div class="ln-seg" role="group">${['bullish', 'bearish']
        .map((s) => `<button type="button" data-side="${s}" aria-pressed="${state.side === s}" class="${state.side === s ? 'on' : ''}">I'm ${s}</button>`)
        .join('')}</div></div>`;
    if (lens === 'macro')
      return `<div class="ln-ctl"><span class="ln-ctl-l">Scenario</span><div class="ln-seg wrap" role="group">${MACRO_EVENTS.map(
        ([k, label]) => `<button type="button" data-event="${k}" aria-pressed="${state.event === k}" class="${state.event === k ? 'on' : ''}">${label}</button>`
      ).join('')}</div></div>
      <form class="ln-ctl ln-vs-form"><label class="ln-ctl-l" for="lnVs">Compare with</label><input id="lnVs" type="text" placeholder="closest competitor" value="${esc(state.vs)}" spellcheck="false" autocomplete="off" /><button type="submit">Compare</button></form>`;
    return '';
  };

  const load = async (lens, fresh = false) => {
    const my = ++seq;
    const l = LENSES.find((x) => x.id === lens);
    const url = query(lens, fresh);
    panel.hidden = false;
    panel.innerHTML = `<div class="ln-top"><h3>${esc(l.title)}</h3>${controls(lens)}</div><div class="ln-out" aria-busy="true"><div class="loading-note"><div class="spinner sm"></div>${esc(l.loading)}… this can take 10 to 20 seconds.</div><div class="skel" style="width:70%"></div><div class="skel" style="width:92%"></div><div class="skel" style="width:84%"></div><div class="skel" style="width:60%"></div></div>`;
    wire(lens);
    let r = !fresh && memo.get(url);
    if (!r) {
      try {
        r = await api(url);
        memo.set(url, r);
        if (r.params && lens === 'macro' && r.params.vs && !state.vs) {
          state.vs = r.params.vs;
          memo.set(query(lens), r);
        }
      } catch (e) {
        if (my !== seq) return;
        panel.querySelector('.ln-out').innerHTML = `<div class="err" style="padding:12px 0"><p>${esc(e.message)}</p><button type="button" class="ln-link" data-act="retry">Try again</button></div>`;
        panel.querySelector('[data-act="retry"]').addEventListener('click', () => load(lens));
        return;
      }
    }
    if (my !== seq) return;
    panel.innerHTML = `<div class="ln-top"><h3>${esc(l.title)}</h3>${controls(lens)}</div><div class="ln-out">${resultHtml(r, lens)}</div>`;
    wire(lens, r);
  };

  const wire = (lens, r) => {
    panel.querySelectorAll('[data-side]').forEach((b) =>
      b.addEventListener('click', () => {
        if (state.side === b.dataset.side) return;
        state.side = b.dataset.side;
        load(lens);
      })
    );
    panel.querySelectorAll('[data-event]').forEach((b) =>
      b.addEventListener('click', () => {
        if (state.event === b.dataset.event) return;
        state.event = b.dataset.event;
        load(lens);
      })
    );
    const f = panel.querySelector('.ln-vs-form');
    if (f)
      f.addEventListener('submit', (e) => {
        e.preventDefault();
        const v = f.querySelector('input').value.trim().toUpperCase().replace(/^\$/, '');
        if (v === state.vs) return;
        state.vs = v;
        load(lens);
      });
    const rf = panel.querySelector('[data-act="refresh"]');
    if (rf) rf.addEventListener('click', () => load(lens, true));
    const cp = panel.querySelector('[data-act="copy"]');
    if (cp && r)
      cp.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(r.prompt);
          cp.textContent = 'Copied';
        } catch {
          cp.textContent = 'Copy failed';
        }
      });
  };

  el.querySelectorAll('.ln-tile').forEach((b) =>
    b.addEventListener('click', () => {
      const lens = b.dataset.lens;
      el.querySelectorAll('.ln-tile').forEach((x) => {
        x.classList.toggle('on', x === b);
        x.setAttribute('aria-selected', String(x === b));
      });
      if (active === lens && !panel.hidden) return;
      active = lens;
      load(lens);
      if (matchMedia('(max-width: 720px)').matches) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    })
  );
}
