// Mokosveri: stock and ETF research. Cloudflare Worker entry point.
import { json, cleanTicker, cached, settle, isIndex, INDEX_ALIASES, INDEX_NAMES } from './util.js';
import { analyzeTicker } from './analyze.js';
import { tickerSnapshot } from './snapshot.js';
import { buildBuzz, mergedInsiderBuys } from './buzz.js';
import { ingestForm4, refreshTickerTable, pruneOld } from './sources/sec.js';
import { congressRecent } from './sources/congress.js';
import { searchSymbols } from './sources/yahoo.js';
import { optionChain } from './sources/options.js';
import { priceHistory, RANGES } from './sources/history.js';
import { cryptoLong } from './sources/cryptolong.js';
import { handleAuth } from './auth.js';
import { handleWatchlist, handlePins, rememberScore } from './watchlist.js';
import { buildSentiment } from './market.js';
import { buildEvents } from './events.js';
import { handleLens, LENS_IDS } from './lenses.js';
import { rateLimit } from './auth.js';

const BUZZ_KEY = 'buzz:v1';
// A ticker analysis counts as fresh for 15 minutes and is still shown, while a
// new one is built in the background, for up to 6 hours.
const ANALYZE_FRESH_MS = 15 * 60e3;
const ANALYZE_STALE_MS = 6 * 3600e3;

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

// The market events calendar has its own cron (EVENTS_CRON in wrangler.toml)
// so its feed fetches get a fresh per-invocation subrequest allowance instead
// of sharing one with the Form 4 ingest. It warms the D1 cache that
// /api/events reads, so visitors see a full calendar on the first load.
// 1.2x the per-visit budget is about 35 fetches, well under the free plan's 50.
// It runs at 6 AM, noon and 6 PM New York time on weekdays. Cron is UTC, so it
// fires at both the daylight saving and standard time hours and the handler
// skips the run that is not one of those New York hours.
export const EVENTS_CRON = '5 10,11,16,17,22,23 * * 1-5';
export const EVENTS_HOURS_ET = [6, 12, 18];
export const nyHour = (ms) => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(ms)));
async function runEvents(env) {
  const d = await buildEvents(env, { budgetScale: 1.2 });
  const feeds = Object.fromEntries(Object.entries(d.feeds || {}).map(([k, v]) => [k, v.ok ? v.note || 'ok' : `error: ${v.note}`]));
  await logJob(env, 'events', { events: (d.events || []).length, feeds });
  return feeds;
}

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

  // Quick first paint for the ticker page: price, header and the 1y series.
  const sm = path.match(/^\/api\/snapshot\/([^/]+)$/);
  if (sm) {
    const t = cleanTicker(decodeURIComponent(sm[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const s = await tickerSnapshot(env, t, (p) => ctx.waitUntil(p));
    return s.error ? json(s, s.status || 500) : json(s);
  }

  const m = path.match(/^\/api\/analyze\/([^/]+)$/);
  if (m) {
    const t = cleanTicker(decodeURIComponent(m[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const fresh = url.searchParams.get('fresh') === '1';
    const key = `an:v1:${t}`;
    const now = Date.now();
    const refresh = async () => {
      const a = await analyzeTicker(env, t, { waitUntil: (p) => ctx.waitUntil(p) });
      if (a.error) return a;
      ctx.waitUntil(env.DB.prepare('INSERT OR REPLACE INTO cache (k, v, exp) VALUES (?, ?, ?)').bind(key, JSON.stringify(a), Date.now() + ANALYZE_FRESH_MS).run());
      ctx.waitUntil(rememberScore(env, a).catch(() => {}));
      return a;
    };
    if (!fresh) {
      const hit = await env.DB.prepare('SELECT v, exp FROM cache WHERE k = ?').bind(key).first();
      if (hit && hit.exp > now) return new Response(hit.v, { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
      let old = null;
      try {
        old = hit ? JSON.parse(hit.v) : null;
      } catch {}
      if (old && now - new Date(old.asOf).getTime() < ANALYZE_STALE_MS) {
        // Older than 15 minutes but less than a few hours: answer right away
        // with the old analysis and rebuild it in the background. Pushing the
        // expiry out a couple of minutes stops parallel visits from all
        // rebuilding at once. The page asks again shortly for the new copy.
        await env.DB.prepare('UPDATE cache SET exp = ? WHERE k = ?').bind(now + 120e3, key).run();
        ctx.waitUntil(refresh().catch(() => {}));
        old.stale = true;
        return json(old);
      }
    }
    const a = await refresh();
    return a.error ? json(a, a.status || 500) : json(a);
  }

  // AI lenses: one framework at a time, run when the reader taps it.
  const lm = path.match(/^\/api\/lens\/([^/]+)\/([a-z]+)$/);
  if (lm) {
    const t = cleanTicker(decodeURIComponent(lm[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    if (!LENS_IDS.includes(lm[2])) return json({ error: 'Unknown lens.' }, 404);
    if (isIndex(t)) return json({ error: 'AI lenses are for individual stocks.' }, 400);
    const r = await handleLens(request, env, ctx, url, t, lm[2], rateLimit);
    return json(r.body, r.status || 200);
  }

  const om = path.match(/^\/api\/options\/([^/]+)$/);
  if (om) {
    const t = cleanTicker(decodeURIComponent(om[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const r = await settle(optionChain(env, t, url.searchParams.get('date')));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  const hm = path.match(/^\/api\/chart\/([^/]+)$/);
  if (hm) {
    const t = cleanTicker(decodeURIComponent(hm[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const range = (url.searchParams.get('range') || '1y').toLowerCase();
    if (!RANGES[range]) return json({ error: 'Unknown chart range.' }, 400);
    const r = await settle(priceHistory(env, t, range));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  // Power law and rainbow models for major crypto (BTC-USD, ETH-USD...).
  const cm = path.match(/^\/api\/cryptolong\/([^/]+)$/);
  if (cm) {
    const t = cleanTicker(decodeURIComponent(cm[1]));
    if (!t) return json({ error: 'That does not look like a ticker symbol.' }, 400);
    const r = await settle(cryptoLong(env, t));
    if (!r.ok) return json({ error: r.error }, 502);
    return r.value.error ? json(r.value, r.value.status || 500) : json(r.value);
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

  if (path === '/api/sentiment') {
    const r = await settle(buildSentiment(env));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  // Market events calendar. ?watch=AAPL,MSFT flags (and adds earnings for) the reader's watchlist.
  if (path === '/api/events') {
    const watch = (url.searchParams.get('watch') || '').split(',').map((x) => cleanTicker(x)).filter(Boolean).slice(0, 25);
    const r = await settle(buildEvents(env, { watch }));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  if (path === '/api/congress') {
    const r = await settle(congressRecent(env));
    return json(r.ok ? r.value : { error: r.error }, r.ok ? 200 : 502);
  }

  if (path === '/api/status') {
    const names = ['buzz', 'form4', 'daily', 'tickers', 'events'];
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

  const adm = path.match(/^\/api\/admin\/(buzz|ingest|daily|events)$/);
  if (adm) {
    if (!env.ADMIN_TOKEN || request.headers.get('x-admin-token') !== env.ADMIN_TOKEN) return json({ error: 'Unauthorized' }, 401);
    const job = adm[1];
    const r = await settle(job === 'buzz' ? runBuzz(env).then((b) => b.status) : job === 'ingest' ? runIngest(env) : job === 'events' ? runEvents(env) : runDaily(env));
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
    if (event.cron === EVENTS_CRON) {
      if (!EVENTS_HOURS_ET.includes(nyHour(event.scheduledTime ?? Date.now()))) return;
      ctx.waitUntil(runEvents(env).catch((e) => logJob(env, 'events', { error: String(e && e.message ? e.message : e) })));
      return;
    }
    ctx.waitUntil(runDueJobs(env));
  },
};
