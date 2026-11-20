// Per-user watchlist. Prices come from the shared chart cache; scores come
// from the last full analysis of each ticker (kept 7 days), then the buzz
// board, then a technicals-only estimate. Cache reads and writes are batched
// so a full watchlist stays inside the Workers Free per-request limits.
import { json, cleanTicker, settle } from './util.js';
import { currentUser, readJson, rateLimit } from './auth.js';
import { fetchChart } from './sources/yahoo.js';
import { computeTechnicals } from './analysis/technicals.js';
import { scoreTechnical, composite } from './analysis/score.js';
import { liveQuotes, refreshSeconds, marketLabel } from './sources/live.js';

export const MAX_WATCH = 40;
const MAX_FETCH_PER_REQUEST = 18; // price fetches per call; the rest load on a retry
const CHART_TTL = 600e3;
export const SCORE_TTL = 7 * 864e5;
const BUZZ_KEY = 'buzz:v1';

// Called after every full analysis so watchlists can show the real score.
export function rememberScore(env, a) {
  const v = JSON.stringify({ score: a.score, verdict: a.verdict, name: a.name, at: Date.now() });
  return env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(`score:${a.ticker}`, v, Date.now() + SCORE_TTL).run();
}

export const MAX_LISTS = 10;

async function listTickers(env, listId) {
  const r = await env.DB.prepare('SELECT ticker, position, added_at FROM watchlist_items WHERE list_id = ? ORDER BY position, added_at').bind(listId).all();
  return r.results || [];
}

// The user's lists, creating "My watchlist" the first time.
async function userLists(env, userId) {
  const q = () =>
    env.DB.prepare('SELECT l.id, l.name, l.position, (SELECT COUNT(*) FROM watchlist_items i WHERE i.list_id = l.id) AS count FROM watchlists l WHERE l.user_id = ? ORDER BY l.position, l.id')
      .bind(userId)
      .all();
  let r = await q();
  if (!r.results || !r.results.length) {
    await env.DB.prepare('INSERT INTO watchlists (user_id, name, position, created_at) VALUES (?, ?, 0, ?)').bind(userId, 'My watchlist', Date.now()).run();
    r = await q();
  }
  return r.results;
}

// Resolves ?list= (or body.list) to one of the user's lists, defaulting to the first.
async function pickList(env, userId, raw) {
  const lists = await userLists(env, userId);
  const id = parseInt(raw, 10);
  return { lists, list: lists.find((l) => l.id === id) || (raw == null || raw === '' ? lists[0] : null) };
}

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);

async function cacheGetMany(env, keys) {
  const out = new Map();
  if (!keys.length) return out;
  const r = await env.DB.prepare(`SELECT k, v FROM cache WHERE exp > ? AND k IN (${keys.map(() => '?').join(',')})`).bind(Date.now(), ...keys).all();
  for (const row of r.results || []) {
    try {
      out.set(row.k, JSON.parse(row.v));
    } catch {}
  }
  return out;
}

// Live price and today's change on top of the chart-based rows.
function overlayLive(rows, live) {
  for (const r of rows) {
    const q = live.get(r.ticker);
    if (!q) continue;
    r.price = q.price;
    if (q.change1d != null) r.change1d = q.change1d;
    r.quoteTime = q.time;
    r.marketState = q.marketState;
    if (!r.name && q.name) r.name = q.name;
    if (r.pending) r.pending = false;
    r.error = null;
  }
  return rows;
}

async function liveMeta(live) {
  return { refreshSec: refreshSeconds(live), market: marketLabel(live), at: Date.now() };
}

async function buildRows(env, items) {
  const tickers = items.map((i) => i.ticker);
  const keys = [...tickers.flatMap((t) => [`chart:${t}:1y`, `score:${t}`]), 'chart:SPY:1y'];
  const [hit, buzz] = await Promise.all([cacheGetMany(env, keys), env.CACHE ? env.CACHE.get(BUZZ_KEY, 'json').catch(() => null) : null]);
  const buzzMap = new Map(((buzz && buzz.all) || []).map((r) => [r.ticker, r]));

  // Fetch missing price histories (capped per request), then store them in one batch.
  const missing = tickers.filter((t) => !hit.has(`chart:${t}:1y`));
  const toFetch = missing.slice(0, MAX_FETCH_PER_REQUEST);
  const needSpy = !hit.has('chart:SPY:1y') && tickers.some((t) => !hit.has(`score:${t}`) && !buzzMap.has(t));
  if (needSpy) toFetch.push('SPY');
  const fetched = await Promise.all(toFetch.map((t) => settle(fetchChart(t, '1y'))));
  const writes = [];
  toFetch.forEach((t, i) => {
    if (!fetched[i].ok) return;
    hit.set(`chart:${t}:1y`, fetched[i].value);
    writes.push(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(`chart:${t}:1y`, JSON.stringify(fetched[i].value), Date.now() + CHART_TTL));
  });
  if (writes.length) await settle(env.DB.batch(writes));
  const failed = new Set(toFetch.filter((t, i) => !fetched[i].ok));
  const spy = hit.get('chart:SPY:1y');

  return items.map((it, idx) => {
    const t = it.ticker;
    const px = hit.get(`chart:${t}:1y`);
    const sc = hit.get(`score:${t}`);
    const bz = buzzMap.get(t);
    const row = { ticker: t, position: idx, addedAt: it.added_at, name: (sc && sc.name) || (bz && bz.name) || null };
    if (!px || !px.bars || px.bars.length < 2) {
      row.pending = !failed.has(t);
      row.error = failed.has(t) ? 'No price data' : null;
      if (sc) Object.assign(row, { score: sc.score, verdict: sc.verdict, scoreSource: 'full', scoredAt: sc.at });
      return row;
    }
    const tech = computeTechnicals(px.bars, spy ? spy.bars : null);
    row.name = row.name || px.meta.name || '';
    row.price = tech ? tech.price : px.bars[px.bars.length - 1].c;
    row.change1d = tech ? tech.change1d : null;
    row.ret1m = tech ? tech.ret1m : null;
    row.ret1y = tech ? tech.ret1y : null;
    row.currency = px.meta.currency || null;
    row.spark = px.bars.slice(-30).map((b) => +b.c.toFixed(2));
    if (sc) Object.assign(row, { score: sc.score, verdict: sc.verdict, scoreSource: 'full', scoredAt: sc.at });
    else if (bz) Object.assign(row, { score: bz.score, verdict: bz.verdict, scoreSource: 'buzz' });
    else if (tech) {
      const c = composite([scoreTechnical(tech)]);
      Object.assign(row, { score: c.score, verdict: c.verdict, scoreSource: 'technicals' });
    }
    return row;
  });
}

export const MAX_PINS = 6;
const parsePins = (raw) => {
  try {
    const a = JSON.parse(raw || '[]');
    return Array.isArray(a) ? [...new Set(a.map(cleanTicker).filter(Boolean))].slice(0, MAX_PINS) : [];
  } catch {
    return [];
  }
};

// Public quotes for the pinned strip (anyone, logged in or not), and the
// logged-in user's saved pins.
export async function handlePins(request, env, path, ip) {
  if (path === '/api/quotes' && request.method === 'GET') {
    if (!(await rateLimit(env, `quotes:${ip}`, 60, 60))) return json({ error: 'Slow down a little.' }, 429);
    const url = new URL(request.url);
    const list = [...new Set((url.searchParams.get('t') || '').split(',').map(cleanTicker).filter(Boolean))].slice(0, MAX_PINS);
    if (!list.length) return json({ items: [] });
    const live = await liveQuotes(env, list);
    const missing = list.filter((t) => !live.has(t));
    const rows = missing.length ? await buildRows(env, missing.map((t) => ({ ticker: t }))) : [];
    const byT = new Map(rows.map((r) => [r.ticker, r]));
    const items = list.map((t) => {
      const q = live.get(t);
      if (q) return { ticker: t, name: q.name, price: q.price, change1d: q.change1d, quoteTime: q.time };
      const r = byT.get(t) || { ticker: t, error: 'No price data' };
      return { ticker: t, name: r.name, price: r.price, change1d: r.change1d, pending: r.pending, error: r.error };
    });
    return json({ items, ...(await liveMeta(live)) });
  }
  if (path !== '/api/pins') return null;
  const u = await currentUser(env, request);
  if (!u) return json({ error: 'Please log in.' }, 401);
  if (request.method === 'GET') {
    const row = await env.DB.prepare('SELECT pins FROM users WHERE id = ?').bind(u.id).first();
    return json({ pins: row && row.pins != null ? parsePins(row.pins) : null });
  }
  if (request.method === 'PUT') {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.pins)) return json({ error: 'Bad request.' }, 400);
    const pins = parsePins(JSON.stringify(body.pins));
    await env.DB.prepare('UPDATE users SET pins = ? WHERE id = ?').bind(JSON.stringify(pins), u.id).run();
    return json({ pins });
  }
  return json({ error: 'Not found' }, 404);
}

// Returns a Response, or null when the path is not a watchlist route.
export async function handleWatchlist(request, env, path) {
  if (!path.startsWith('/api/watchlist')) return null;
  const u = await currentUser(env, request);
  if (!u) return json({ error: 'Please log in to use a watchlist.' }, 401);
  const method = request.method;
  const qs = new URL(request.url).searchParams;
  const notFound = () => json({ error: 'That watchlist was not found.' }, 404);

  // ---------- lists ----------
  if (path === '/api/watchlists' && method === 'GET') {
    return json({ lists: await userLists(env, u.id), maxLists: MAX_LISTS, maxPerList: MAX_WATCH });
  }

  // Every list with its tickers (for the "Add to watchlist" picker).
  if (path === '/api/watchlist/tickers' && method === 'GET') {
    const lists = await userLists(env, u.id);
    const r = await env.DB.prepare('SELECT i.list_id, i.ticker FROM watchlist_items i JOIN watchlists l ON l.id = i.list_id WHERE l.user_id = ? ORDER BY i.position, i.added_at').bind(u.id).all();
    const by = new Map(lists.map((l) => [l.id, []]));
    for (const row of r.results || []) if (by.has(row.list_id)) by.get(row.list_id).push(row.ticker);
    return json({ lists: lists.map((l) => ({ id: l.id, name: l.name, tickers: by.get(l.id) })) });
  }

  if (path === '/api/watchlist' && method === 'GET') {
    const { lists, list } = await pickList(env, u.id, qs.get('list'));
    if (!list) return notFound();
    const items = await listTickers(env, list.id);
    const [rows, live] = await Promise.all([buildRows(env, items), liveQuotes(env, items.map((i) => i.ticker)).catch(() => new Map())]);
    return json({ list, lists, items: overlayLive(rows, live), max: MAX_WATCH, ...(await liveMeta(live)) });
  }

  // Just the live prices, for polling every few seconds.
  if (path === '/api/watchlist/live' && method === 'GET') {
    const { list } = await pickList(env, u.id, qs.get('list'));
    if (!list) return notFound();
    const tickers = (await listTickers(env, list.id)).map((i) => i.ticker);
    const live = await liveQuotes(env, tickers);
    return json({
      items: tickers.filter((t) => live.has(t)).map((t) => ({ ticker: t, price: live.get(t).price, change1d: live.get(t).change1d, quoteTime: live.get(t).time })),
      ...(await liveMeta(live)),
    });
  }

  if (method !== 'GET' && !(await rateLimit(env, `wl:${u.id}`, 120, 60))) return json({ error: 'Slow down a little.' }, 429);

  if (path === '/api/watchlists' && method === 'POST') {
    const body = await readJson(request);
    const name = cleanName(body && body.name);
    if (!name) return json({ error: 'Give the list a name.' }, 400);
    const now = Date.now();
    const r = await env.DB.prepare(
      `INSERT INTO watchlists (user_id, name, position, created_at)
       SELECT ?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM watchlists WHERE user_id = ?1), 0), ?3
       WHERE (SELECT COUNT(*) FROM watchlists WHERE user_id = ?1) < ?4`
    )
      .bind(u.id, name, now, MAX_LISTS)
      .run();
    if (!r.meta.changes) return json({ error: `You can have up to ${MAX_LISTS} watchlists.` }, 400);
    return json({ list: { id: r.meta.last_row_id, name, count: 0 } });
  }

  if (path === '/api/watchlists/order' && method === 'PUT') {
    const body = await readJson(request);
    const ids = Array.isArray(body && body.ids) ? body.ids.map((x) => parseInt(x, 10)).filter(Number.isFinite).slice(0, MAX_LISTS) : null;
    if (!ids) return json({ error: 'Bad request.' }, 400);
    await env.DB.batch(ids.map((id, i) => env.DB.prepare('UPDATE watchlists SET position = ? WHERE id = ? AND user_id = ?').bind(i, id, u.id)));
    return json({ ok: true });
  }

  const lm = path.match(/^\/api\/watchlists\/(\d+)$/);
  if (lm && method === 'PATCH') {
    const body = await readJson(request);
    const name = cleanName(body && body.name);
    if (!name) return json({ error: 'Give the list a name.' }, 400);
    const r = await env.DB.prepare('UPDATE watchlists SET name = ? WHERE id = ? AND user_id = ?').bind(name, parseInt(lm[1], 10), u.id).run();
    if (!r.meta.changes) return notFound();
    return json({ ok: true, name });
  }
  if (lm && method === 'DELETE') {
    const id = parseInt(lm[1], 10);
    const lists = await userLists(env, u.id);
    if (!lists.some((l) => l.id === id)) return notFound();
    if (lists.length <= 1) return json({ error: 'You need at least one watchlist.' }, 400);
    await env.DB.batch([
      env.DB.prepare('DELETE FROM watchlist_items WHERE list_id = ?').bind(id),
      env.DB.prepare('DELETE FROM watchlists WHERE id = ? AND user_id = ?').bind(id, u.id),
    ]);
    return json({ ok: true });
  }

  // ---------- tickers in a list ----------
  if (path === '/api/watchlist' && method === 'POST') {
    const body = await readJson(request);
    const t = cleanTicker(body && body.ticker);
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const { list } = await pickList(env, u.id, body.list);
    if (!list) return notFound();
    const now = Date.now();
    const r = await env.DB.prepare(
      `INSERT OR IGNORE INTO watchlist_items (list_id, ticker, position, added_at)
       SELECT ?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM watchlist_items WHERE list_id = ?1), 0), ?3
       WHERE (SELECT COUNT(*) FROM watchlist_items WHERE list_id = ?1) < ?4`
    )
      .bind(list.id, t, now, MAX_WATCH)
      .run();
    if (!r.meta.changes) {
      const exists = await env.DB.prepare('SELECT 1 AS x FROM watchlist_items WHERE list_id = ? AND ticker = ?').bind(list.id, t).first();
      if (!exists) return json({ error: `That list is full (${MAX_WATCH} tickers).` }, 400);
    }
    return json({ ok: true, ticker: t, list: list.id });
  }

  // Bulk import (CSV upload): into an existing list, or a new list made here.
  if (path === '/api/watchlist/import' && method === 'POST') {
    const body = await readJson(request);
    if (!body || !Array.isArray(body.tickers)) return json({ error: 'Bad request.' }, 400);
    const seen = new Set();
    const invalid = [];
    const tickers = [];
    for (const raw of body.tickers.slice(0, 500)) {
      const t = cleanTicker(raw);
      if (!t) invalid.push(String(raw).slice(0, 16));
      else if (!seen.has(t)) {
        seen.add(t);
        tickers.push(t);
      }
    }
    let list;
    if (body.newName != null) {
      const name = cleanName(body.newName);
      if (!name) return json({ error: 'Give the new list a name.' }, 400);
      const r = await env.DB.prepare(
        `INSERT INTO watchlists (user_id, name, position, created_at)
         SELECT ?1, ?2, COALESCE((SELECT MAX(position) + 1 FROM watchlists WHERE user_id = ?1), 0), ?3
         WHERE (SELECT COUNT(*) FROM watchlists WHERE user_id = ?1) < ?4`
      )
        .bind(u.id, name, Date.now(), MAX_LISTS)
        .run();
      if (!r.meta.changes) return json({ error: `You can have up to ${MAX_LISTS} watchlists.` }, 400);
      list = { id: r.meta.last_row_id, name };
    } else {
      ({ list } = await pickList(env, u.id, body.list));
      if (!list) return notFound();
    }
    const current = await listTickers(env, list.id);
    const existing = new Set(current.map((i) => i.ticker));
    const already = tickers.filter((t) => existing.has(t));
    const fresh = tickers.filter((t) => !existing.has(t));
    const room = Math.max(0, MAX_WATCH - existing.size);
    const add = fresh.slice(0, room);
    const overCap = fresh.slice(room);
    if (add.length) {
      const now = Date.now();
      const start = current.reduce((m, i) => Math.max(m, i.position), -1) + 1;
      await env.DB.batch(add.map((t, i) => env.DB.prepare('INSERT OR IGNORE INTO watchlist_items (list_id, ticker, position, added_at) VALUES (?, ?, ?, ?)').bind(list.id, t, start + i, now + i)));
    }
    return json({ list: { id: list.id, name: list.name }, added: add, already, overCap, invalid, max: MAX_WATCH });
  }

  const one = path.match(/^\/api\/watchlist\/([^/]+)$/);
  if (one && method === 'DELETE') {
    const t = cleanTicker(decodeURIComponent(one[1]));
    if (!t) return json({ error: 'Bad ticker.' }, 400);
    const { list } = await pickList(env, u.id, qs.get('list'));
    if (!list) return notFound();
    await env.DB.prepare('DELETE FROM watchlist_items WHERE list_id = ? AND ticker = ?').bind(list.id, t).run();
    return json({ ok: true });
  }

  if (path === '/api/watchlist/order' && method === 'PUT') {
    const body = await readJson(request);
    const tickers = Array.isArray(body && body.tickers) ? body.tickers.map(cleanTicker).filter(Boolean).slice(0, MAX_WATCH) : null;
    if (!tickers) return json({ error: 'Bad request.' }, 400);
    const { list } = await pickList(env, u.id, body.list);
    if (!list) return notFound();
    await env.DB.batch(tickers.map((t, i) => env.DB.prepare('UPDATE watchlist_items SET position = ? WHERE list_id = ? AND ticker = ?').bind(i, list.id, t)));
    return json({ ok: true });
  }

  return json({ error: 'Not found' }, 404);
}
