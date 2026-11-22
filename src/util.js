// Shared helpers: fetch with timeout, KV caching, dates, JSON responses.

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort('timeout'), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

export async function getJSON(url, opts = {}, ms = 9000) {
  const r = await fetchWithTimeout(url, opts, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${hostOf(url)}`);
  return r.json();
}

export async function getText(url, opts = {}, ms = 9000) {
  const r = await fetchWithTimeout(url, opts, ms);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${hostOf(url)}`);
  return r.text();
}

export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// Read-through cache. Uses a D1 table (generous free write quota) and falls
// back to KV when no database is bound (offline tests). ttl in seconds.
export async function cached(env, key, ttl, fn) {
  const now = Date.now();
  if (env.DB) {
    try {
      const row = await env.DB.prepare('SELECT v, exp FROM cache WHERE k = ?').bind(key).first();
      if (row && row.exp > now) return JSON.parse(row.v);
    } catch {}
  } else if (env.CACHE) {
    try {
      const hit = await env.CACHE.get(key, 'json');
      if (hit !== null && hit !== undefined) return hit;
    } catch {}
  }
  const val = await fn();
  if (val !== undefined && val !== null) {
    try {
      if (env.DB) await env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(key, JSON.stringify(val), now + ttl * 1000).run();
      else if (env.CACHE) await env.CACHE.put(key, JSON.stringify(val), { expirationTtl: Math.max(60, ttl) });
    } catch {}
  }
  return val;
}

export function isoDate(d) {
  return new Date(d).toISOString().slice(0, 10);
}

export function daysAgo(n, from = Date.now()) {
  return isoDate(from - n * 86400000);
}

export function daysBetween(a, b = Date.now()) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

export function clamp(x, lo = -1, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

export function num(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = typeof x === 'number' ? x : parseFloat(String(x).replace(/[$,+%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

export function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extra,
    },
  });
}

// Market indices: the short name people type, mapped to Yahoo's caret code.
export const INDEX_ALIASES = {
  VIX: '^VIX',
  VVIX: '^VVIX',
  VXN: '^VXN',
  SPX: '^GSPC',
  DJI: '^DJI',
  DJIA: '^DJI',
  NDX: '^NDX',
  IXIC: '^IXIC',
  RUT: '^RUT',
  TNX: '^TNX',
  TYX: '^TYX',
  FVX: '^FVX',
  IRX: '^IRX',
};
export const INDEX_NAMES = {
  VIX: 'CBOE Volatility Index',
  VVIX: 'CBOE VIX Volatility Index',
  VXN: 'CBOE Nasdaq 100 Volatility Index',
  SPX: 'S&P 500 Index',
  DJI: 'Dow Jones Industrial Average',
  DJIA: 'Dow Jones Industrial Average',
  NDX: 'Nasdaq 100 Index',
  IXIC: 'Nasdaq Composite',
  RUT: 'Russell 2000 Index',
  TNX: '10 Year Treasury Yield',
  TYX: '30 Year Treasury Yield',
  FVX: '5 Year Treasury Yield',
  IRX: '13 Week Treasury Bill',
};
const INDEX_BACK = Object.fromEntries(Object.entries(INDEX_ALIASES).reverse().map(([k, v]) => [v, k]));

export function cleanTicker(t) {
  if (!t) return null;
  const s = String(t).trim().toUpperCase().replace(/^\$/, '');
  if (s.startsWith('^')) {
    if (INDEX_BACK[s]) return INDEX_BACK[s];
    return /^\^[A-Z0-9.]{1,10}$/.test(s) ? s : null;
  }
  return /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s) ? s : null;
}

export const isIndex = (t) => !!INDEX_ALIASES[t] || String(t || '').startsWith('^');
// The symbol Yahoo expects for one of our cleaned tickers.
export const yahooSymbol = (t) => INDEX_ALIASES[t] || (String(t).startsWith('^') ? t : String(t).replace('.', '-'));

// Run async fn over items with limited concurrency.
export async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = { error: String(e && e.message ? e.message : e) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

export async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// Waits at most `ms` for a slow promise (an AI call, say). On time out it
// resolves to `fallback`, and the work keeps running in the background through
// `waitUntil` when one is given, so its cached result is ready next time.
export function withBudget(promise, ms, fallback = null, waitUntil = null) {
  let timer;
  const late = new Promise((res) => {
    timer = setTimeout(() => {
      if (waitUntil) waitUntil(promise.catch(() => {}));
      res(fallback);
    }, ms);
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), late]);
}
