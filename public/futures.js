// Home page sidebar: major futures (equity index, energy, metals, rates,
// crypto) with price and today's change, refreshed while the page is open.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const fmt = (v) => (v == null || !isFinite(v) ? '' : Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: Math.abs(v) < 10 ? 3 : 2 }));
const pct = (v) => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${v.toFixed(2)}%`);
const chg = (v) => (v == null || !isFinite(v) ? '' : `${v > 0 ? '+' : ''}${fmt(v)}`);
const cls = (v) => (v > 0 ? 'up' : v < 0 ? 'down' : '');

export async function mountFutures(el) {
  const prev = new Map(); // symbol -> last price, to flash moves
  let timer = null;
  el.innerHTML = `<div class="side-card card fut-card">
    <div class="side-h"><span>Futures</span><span class="side-live muted" role="status"></span></div>
    <div class="side-body fut-body"><p class="side-empty muted">Loading futures...</p></div>
  </div>`;
  const body = el.querySelector('.fut-body');
  const live = el.querySelector('.side-live');

  function paint(d) {
    let group = null;
    const rows = d.items
      .map((f) => {
        const head = f.group !== group ? `<tr class="fut-group"><th colspan="3" scope="rowgroup">${esc((group = f.group))}</th></tr>` : '';
        const was = prev.get(f.symbol);
        const flash = was != null && f.price != null && was !== f.price ? (f.price > was ? ' flash-up' : ' flash-down') : '';
        if (f.price != null) prev.set(f.symbol, f.price);
        const tip = f.price != null ? ` title="${esc(`${f.name} futures (${f.yahoo}): ${fmt(f.price)}, ${chg(f.change)} today${f.time ? `, as of ${new Date(f.time).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`)}"` : '';
        return `${head}<tr${tip}><td><span class="fut-name">${esc(f.name)}</span><span class="fut-sym mono muted">${esc(f.symbol)}</span></td>
          <td class="num mono${flash}">${f.price != null ? fmt(f.price) : '<span class="muted">n/a</span>'}</td>
          <td class="num mono${flash}"><span class="${cls(f.change1d)}">${pct(f.change1d)}</span></td></tr>`;
      })
      .join('');
    body.innerHTML = `<table class="side-tbl fut-tbl"><thead><tr><th>Contract</th><th class="num">Price</th><th class="num">Chg</th></tr></thead><tbody>${rows}</tbody></table>`;
    const on = d.market === 'open';
    live.innerHTML = d.market ? `<span class="live-dot${on ? ' on' : ''}"></span>${on ? 'Live' : esc(d.market)}` : '';
    live.title = `Updated ${new Date(d.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' })}. Front month contracts from Yahoo Finance, some may be delayed.`;
  }

  async function refresh() {
    clearTimeout(timer);
    if (!el.isConnected) return;
    let d = null;
    if (document.visibilityState !== 'hidden') {
      try {
        const r = await fetch('/api/futures');
        if (r.ok) d = await r.json();
      } catch {}
      if (d && d.items && d.items.some((f) => f.price != null)) paint(d);
      else if (!prev.size) body.innerHTML = '<p class="side-empty muted">Futures prices are unavailable right now.</p>';
    }
    if (el.isConnected) timer = setTimeout(refresh, ((d && d.refreshSec) || 60) * 1000);
  }

  const onVisible = () => {
    if (!el.isConnected) return document.removeEventListener('visibilitychange', onVisible);
    if (document.visibilityState === 'visible') refresh();
  };
  document.addEventListener('visibilitychange', onVisible);
  refresh();
}
