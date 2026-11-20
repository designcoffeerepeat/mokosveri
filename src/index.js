// Mokosveri: stock and ETF research. Cloudflare Worker entry point.
import { json, cleanTicker, cached, settle, INDEX_ALIASES, INDEX_NAMES } from './util.js';
import { analyzeTicker } from './analyze.js';
import { buildBuzz, mergedInsiderBuys } from './buzz.js';
import { ingestForm4, refreshTickerTable, pruneOld } from './sources/sec.js';
import { congressRecent } from './sources/congress.js';
import { searchSymbols } from './sources/yahoo.js';
import { optionChain } from './sources/options.js';
import { handleAuth } from './auth.js';
import { handleWatchlist, handlePins, rememberScore } from './watchlist.js';

const BUZZ_KEY = 'buzz:v1';

async function logJob(env, name, data) {
  try {
    await env.CACHE.put(`job:${name}`, JSON.stringify({ at: new Date().toISOString(), ...data }), { expirationTtl: 86400 * 3 });
  } catch {}
}

async function runBuzz(env) {
  const b = await buildBuzz(env);
  if (b.all.length) await env.CACHE.put(BUZZ_KEY, JSON.stringify(b));
  await logJob(env, 'buzz', { priced: b.all.length, status: b.status });
  return b;
}

async function runIngest(env) {
  const cnt = await env.DB.prepare('SELECT COUNT(*) AS n FROM tickers').first();
  if (!cnt || !cnt.n) {
    const r = await settle(refreshTickerTable(env));
    await logJob(env, 'tickers', r);
  }
  const log = await ingestForm4(env);
  await logJob(env, 'form4', log);
  return log;
}

async function runDaily(env) {
  const r = await settle(refreshTickerTable(env));
  await pruneOld(env);
  await settle(env.DB.batch([
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at < ?').bind(Date.now()),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(Date.now()),
  ]));
  await logJob(env, 'daily', r);
  return r;
}

// Jobs run from the cron trigger when one is available, and also lazily from
// visitor traffic so the site keeps itself fresh on the Workers Free plan.
const JOB_EVERY = { ingest: 10 * 60e3, buzz: 30 * 60e3, daily: 24 * 3600e3 };
const JOBS = { ingest: runIngest, buzz: runBuzz, daily: runDaily };

async function claimJob(env, name) {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT v FROM kvstate WHERE k = ?').bind(`last:${name}`).first();
  if (row && now - Number(JSON.parse(row.v)) < JOB_EVERY[name]) return false;
  await env.DB.prepare('INSERT OR REPLACE INTO kvstate (k, v) VALUES (?, ?)').bind(`last:${name}`, JSON.stringify(now)).run();
  return true;
}

async function runDueJobs(env, only = null) {
  for (const name of only || Object.keys(JOBS)) {
    try {
      if (await claimJob(env, name)) await JOBS[name](env);
    } catch (e) {
      await logJob(env, name, { error: String(e && e.message ? e.message : e) });
    }
  }
}

async function handleApi(request, env, ctx, url) {
  const path = url.pathname.replace(/\/+$/, '');
  // Account, watchlist and quote routes run on their own so background jobs
  // never eat into their per-request limits.
  const own = (await handleAuth(request, env, path)) || (await handleWatchlist(request, env, path)) || (await handlePins(request, env, path, request.headers.get('cf-connecting-ip') || 'local'));
  if (own) return own;
  if (request.method === 'GET' && !url.pathname.startsWith('/api/admin')) ctx.waitUntil(runDueJobs(env, ['ingest', 'daily']));

  if (path === '/api/buzz') {
    let b = await env.CACHE.get(BUZZ_KEY, 'json');
    if (!b) b = await runBuzz(env);
    else ctx.waitUntil(runDueJobs(env, ['buzz']));
    return json(b);
  }

  const m = path.match(/^\/api\/analyze\/([^/]+)$/);
  if (m) {
    const t = cleanTicker(decodeURIComponent(m[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const fresh = url.searchParams.get('fresh') === '1';
    const key = `an:v1:${t}`;
    if (!fresh) {
      const hit = await env.DB.prepare('SELECT v FROM cache WHERE k = ? AND exp > ?').bind(key, Date.now()).first();
      if (hit) return new Response(hit.v, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
    }
    const a = await analyzeTicker(env, t);
    if (a.error) return json(a, a.status || 500);
    ctx.waitUntil(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(key, JSON.stringify(a), Date.now() + 900e3).run());
    ctx.waitUntil(rememberScore(env, a).catch(() => {}));
    return json(a);
  }

  const om = path.match(/^\/api\/options\/([^/]+)$/);
  if (om) {
    const t = cleanTicker(decodeURIComponent(om[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const r = await settle(optionChain(env, t, url.searchParams.get('date')));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  if (path === '/api/search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json([]);
    const out = [];
    const seen = new Set();
    // Market indices first when the query names one (VIX, SPX, ^GSPC, "volatility"...).
    const qu = q.toUpperCase();
    for (const [sym, name] of Object.entries(INDEX_NAMES)) {
      if (sym === 'DJIA' && qu !== 'DJIA') continue;
      if (sym.startsWith(qu.replace(/^\^/, '')) || INDEX_ALIASES[sym] === qu || (q.length >= 3 && name.toUpperCase().includes(qu))) {
        seen.add(sym);
        out.push({ symbol: sym, name, type: 'INDEX' });
      }
    }
    out.splice(3);
    try {
      const r = await env.DB.prepare('SELECT ticker, name FROM tickers WHERE ticker LIKE ? OR name LIKE ? ORDER BY CASE WHEN ticker = ? THEN 0 WHEN ticker LIKE ? THEN 1 ELSE 2 END, length(ticker) LIMIT 8')
        .bind(`${q.toUpperCase()}%`, `%${q}%`, q.toUpperCase(), `${q.toUpperCase()}%`)
        .all();
      for (const x of r.results || []) {
        seen.add(x.ticker);
        out.push({ symbol: x.ticker, name: x.name, type: 'EQUITY' });
      }
    } catch {}
    if (out.length < 5) {
      const y = await settle(searchSymbols(env, q));
      if (y.ok) for (const x of y.value) if (!seen.has(x.symbol)) out.push(x);
    }
    return json(out.slice(0, 8));
  }

  if (path === '/api/insiders') {
    const days = Math.min(parseInt(url.searchParams.get('days') || env.INSIDER_DAYS || '30', 10), 60);
    const r = await cached(env, `insiders:${days}`, 900, () => mergedInsiderBuys(env, days));
    return json(r);
  }

  if (path === '/api/congress') {
    const r = await settle(congressRecent(env));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  if (path === '/api/status') {
    const names = ['buzz', 'form4', 'daily', 'tickers'];
    const jobs = {};
    for (const n of names) jobs[n] = await env.CACHE.get(`job:${n}`, 'json');
    let counts = null;
    try {
      counts = await env.DB.prepare(
        "SELECT (SELECT COUNT(*) FROM insider_tx) AS insider_rows, (SELECT COUNT(*) FROM insider_tx WHERE code='P') AS buys, (SELECT COUNT(*) FROM processed) AS filings, (SELECT COUNT(*) FROM tickers) AS tickers, (SELECT MAX(filed_date) FROM insider_tx) AS newest"
      ).first();
    } catch (e) {
      counts = { error: String(e.message) };
    }
    return json({
      jobs,
      counts,
      keys: { quiver: !!env.QUIVER_API_KEY, fmp: !!env.FMP_API_KEY },
      secUserAgentSet: !/example\.com/.test(env.SEC_USER_AGENT || 'example.com'),
    });
  }

  const adm = path.match(/^\/api\/admin\/(buzz|ingest|daily)$/);
  if (adm) {
    if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'Unauthorized' }, 401);
    const job = adm[1];
    const r = await settle(job === 'buzz' ? runBuzz(env).then((b) => b.status) : job === 'ingest' ? runIngest(env) : runDaily(env));
    return json(r);
  }

  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, ctx, url);
      } catch (e) {
        return json({ error: 'Something went wrong while fetching data.', detail: String(e && e.message ? e.message : e) }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runDueJobs(env));
  },
};
