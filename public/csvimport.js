// CSV import for watchlists. Reads a Yahoo Finance export (uses its Symbol
// column), any CSV with a Symbol or Ticker column, or a plain list of tickers
// (one per line, or comma separated), then previews before importing.
import { esc, req } from './session.js';

const MAX = 40;
const valid = (t) => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(t) || /^\^[A-Z0-9.]{1,10}$/.test(t);

// Minimal CSV line splitter that understands "quoted, fields".
function splitLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

export function parseTickers(text) {
  const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return { tickers: [], invalid: [], dupes: [] };
  const head = splitLine(lines[0]).map((h) => h.toLowerCase());
  const col = head.findIndex((h) => h === 'symbol' || h === 'ticker' || h === 'symbols' || h === 'tickers');
  let raw;
  if (col >= 0) raw = lines.slice(1).map((l) => splitLine(l)[col] || '');
  else if (lines.length === 1) raw = splitLine(lines[0]); // "AAPL, MSFT, NVDA"
  else raw = lines.map((l) => splitLine(l)[0] || ''); // one per line
  const seen = new Set();
  const tickers = [];
  const invalid = [];
  const dupes = [];
  for (const r of raw) {
    const t = r.trim().toUpperCase().replace(/^\$(?!\$)/, '');
    if (!t) continue;
    if (!valid(t)) invalid.push(r.trim());
    else if (seen.has(t)) dupes.push(t);
    else {
      seen.add(t);
      tickers.push(t);
    }
  }
  return { tickers, invalid, dupes: [...new Set(dupes)] };
}

const chips = (arr, cls = '') => arr.map((t) => `<span class="imp-chip ${cls}">${esc(t)}</span>`).join('');

// Opens the import panel in `box`. lists: [{id, name, count}], current: list id.
// onDone(listId) runs after a successful import.
export function openImport(box, { lists, current, maxLists = 10, onDone }) {
  // A fresh element per open, so listeners never stack up.
  const root = document.createElement('div');
  box.replaceChildren(root);
  let parsed = null;
  let fileName = '';
  const canCreate = lists.length < maxLists;

  const render = () => {
    const dest = root.querySelector('input[name="impDest"]:checked');
    const mode = dest ? dest.value : 'existing';
    const listSel = root.querySelector('#impList');
    const target = lists.find((l) => l.id === +(listSel ? listSel.value : current));
    const room = mode === 'new' ? MAX : Math.max(0, MAX - (target ? target.count : 0));
    const preview = root.querySelector('.imp-preview');
    if (!parsed) {
      preview.innerHTML = '';
      return;
    }
    const n = parsed.tickers.length;
    preview.innerHTML = n
      ? `<div class="imp-sum"><b>${n} ticker${n === 1 ? '' : 's'}</b> found in ${esc(fileName)}.${mode === 'existing' && target ? ` Tickers already on ${esc(target.name)} are skipped.` : ''}${n > room ? ` <span class="down">Only ${room} more fit${mode === 'new' ? ' in a new list' : ` on ${esc(target ? target.name : 'this list')}`} (${MAX} max), so the last ${n - room} will be left out.</span>` : ''}</div>
        <div class="imp-chips">${chips(parsed.tickers.slice(0, room))}${chips(parsed.tickers.slice(room), 'out')}</div>
        ${parsed.invalid.length ? `<div class="imp-skip muted">Skipped, not a ticker: ${chips(parsed.invalid.slice(0, 20), 'bad')}${parsed.invalid.length > 20 ? ` and ${parsed.invalid.length - 20} more` : ''}</div>` : ''}
        ${parsed.dupes.length ? `<div class="imp-skip muted">Listed more than once (added once): ${chips(parsed.dupes)}</div>` : ''}`
      : '<div class="imp-sum down">No tickers found. Use a Yahoo Finance export, a CSV with a Symbol column, or one ticker per line.</div>';
    root.querySelector('.imp-go').disabled = !n || (mode === 'existing' && room === 0);
  };

  root.innerHTML = `<div class="card imp-card">
    <div class="imp-h"><b>Import tickers from a CSV file</b><button type="button" class="btn-ghost sm imp-close">Close</button></div>
    <p class="muted small imp-help">In Yahoo Finance, open your watchlist or portfolio and choose Export to download a CSV, then pick that file here. A plain list with one ticker per line works too.</p>
    <label class="imp-file"><input type="file" accept=".csv,.txt,text/csv,text/plain" /><span class="btn-ghost">Choose file</span><span class="imp-fname muted small">No file chosen</span></label>
    <div class="imp-preview" role="status"></div>
    <fieldset class="imp-dest">
      <legend class="muted small">Put them in</legend>
      <label><input type="radio" name="impDest" value="existing" checked /> Existing list
        <select id="impList">${lists.map((l) => `<option value="${l.id}"${l.id === current ? ' selected' : ''}>${esc(l.name)} (${l.count})</option>`).join('')}</select></label>
      <label${canCreate ? '' : ' class="muted" title="You already have the maximum number of lists"'}><input type="radio" name="impDest" value="new"${canCreate ? '' : ' disabled'} /> New list named
        <input id="impName" maxlength="40" placeholder="List name"${canCreate ? '' : ' disabled'} /></label>
    </fieldset>
    <div class="auth-err imp-err" role="alert"></div>
    <button type="button" class="btn-primary imp-go" disabled>Import</button>
  </div>`;

  const err = (m) => (root.querySelector('.imp-err').textContent = m || '');
  root.querySelector('.imp-close').addEventListener('click', () => box.replaceChildren());
  root.querySelector('input[type=file]').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    err('');
    if (!f) return;
    if (f.size > 1e6) {
      err('That file is too big. Exports are usually a few KB.');
      return;
    }
    fileName = f.name;
    root.querySelector('.imp-fname').textContent = f.name;
    parsed = parseTickers(await f.text());
    const nm = root.querySelector('#impName');
    if (nm && !nm.value) nm.value = f.name.replace(/\.(csv|txt)$/i, '').replace(/[_-]+/g, ' ').slice(0, 40);
    render();
  });
  root.addEventListener('change', (e) => {
    if (e.target.matches('#impList')) root.querySelector('input[value="existing"]').checked = true;
    render();
  });
  root.addEventListener('input', (e) => {
    if (e.target.matches('#impName')) {
      root.querySelector('input[value="new"]').checked = true;
      render();
    }
  });
  root.querySelector('.imp-go').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const mode = root.querySelector('input[name="impDest"]:checked').value;
    const payload = { tickers: parsed.tickers };
    if (mode === 'new') payload.newName = root.querySelector('#impName').value;
    else payload.list = +root.querySelector('#impList').value;
    btn.disabled = true;
    err('');
    try {
      const d = await req('POST', '/api/watchlist/import', payload);
      const parts = [`Added ${d.added.length} to ${d.list.name}.`];
      const n = (k, one, many) => `${k} ${k === 1 ? one : many}`;
      if (d.already.length) parts.push(`${n(d.already.length, 'was', 'were')} already there.`);
      if (d.overCap.length) parts.push(`${d.overCap.length} did not fit (${d.max} max): ${d.overCap.join(', ')}.`);
      if (d.invalid.length) parts.push(`${n(d.invalid.length, 'was not a ticker', 'were not tickers')}.`);
      root.innerHTML = `<div class="notice imp-done">${esc(parts.join(' '))} <button type="button" class="btn-ghost sm imp-close">OK</button></div>`;
      root.querySelector('.imp-close').addEventListener('click', () => box.replaceChildren());
      if (onDone) onDone(d.list.id);
    } catch (ex) {
      err(ex.message);
      btn.disabled = false;
    }
  });
}
