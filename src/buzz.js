// Builds the market-wide "buzz" board: the tickers people and insiders are
// most active in right now, each with a quick directional score.
import { settle, pool, cleanTicker } from './util.js';
import { chart } from './sources/yahoo.js';
import { apeWisdom, stocktwitsTrending } from './sources/social.js';
import { recentInsiderBuys } from './sources/sec.js';
import { openInsiderPurchases, aggregatePurchases } from './sources/openinsider.js';
import { congressRecent } from './sources/congress.js';
import { computeTechnicals } from './analysis/technicals.js';
import { scoreInsider, scoreTechnical, scoreCongress, scoreSocial, composite, movePotential } from './analysis/score.js';

export const SKIP = new Set(['SPY', 'QQQ', 'IWM', 'DIA', 'VOO', 'VTI', 'USD', 'CEO', 'DD', 'YOLO', 'ATH', 'IPO', 'ETF', 'AI', 'GDP', 'FOMC']);

export async function mergedInsiderBuys(env, days) {
  const [db, oi] = await Promise.all([settle(env.DB ? recentInsiderBuys(env, days, 40) : Promise.resolve([])), settle(openInsiderPurchases(days))]);
  const map = new Map();
  const add = (r) => {
    const t = cleanTicker(r.ticker);
    if (!t) return;
    const prev = map.get(t);
    // Prefer the record with more buyers; the two sources describe the same filings.
    if (!prev || r.buyers > prev.buyers || (r.buyers === prev.buyers && r.total_value > prev.total_value)) map.set(t, { ...r, ticker: t });
  };
  if (db.ok) db.value.forEach(add);
  if (oi.ok) aggregatePurchases(oi.value).forEach(add);
  const list = [...map.values()].sort((a, b) => b.buyers - a.buyers || b.total_value - a.total_value);
  return { list, status: { secStore: db.ok ? db.value.length : db.error, openInsider: oi.ok ? oi.value.length : oi.error } };
}

function fakeInsiderTx(agg) {
  const owners = String(agg.owners || '').split(/,(?![^()]*\))/).map((s) => s.trim()).filter(Boolean);
  const n = Math.max(owners.length, agg.buyers || 1);
  return {
    available: true,
    transactions: Array.from({ length: n }, (_, i) => ({
      owner: owners[i] || `Insider ${i + 1}`,
      title: i < (agg.csuite || 0) ? 'CEO' : '',
      code: 'P',
      date: agg.last_date,
      value: (agg.total_value || 0) / n,
    })),
  };
}

export async function buildBuzz(env) {
  const days = parseInt(env.INSIDER_DAYS || '30', 10);
  const max = parseInt(env.BUZZ_MAX_TICKERS || '36', 10);
  const [ape, st, ins, cong, spy] = await Promise.all([
    settle(apeWisdom(env)),
    settle(stocktwitsTrending(env)),
    settle(mergedInsiderBuys(env, days)),
    settle(congressRecent(env)),
    settle(chart(env, 'SPY', '1y')),
  ]);

  const apeMap = new Map(ape.ok ? ape.value.map((r) => [r.ticker, r]) : []);
  const stSet = new Set(st.ok ? st.value.map((r) => r.ticker) : []);
  const insList = ins.ok ? ins.value.list : [];
  const insMap = new Map(insList.map((r) => [r.ticker, r]));
  const congList = cong.ok ? cong.value : [];

  const reasons = new Map();
  const addCand = (t, why) => {
    t = cleanTicker(t);
    if (!t || SKIP.has(t)) return;
    if (!reasons.has(t)) reasons.set(t, []);
    if (why && !reasons.get(t).includes(why)) reasons.get(t).push(why);
  };

  const quota = Math.ceil(max / 4);
  (ape.ok ? ape.value : []).slice(0, quota + 4).forEach((r) => addCand(r.ticker, `Reddit #${r.rank}`));
  (st.ok ? st.value : []).slice(0, quota).forEach((r) => addCand(r.ticker, 'Trending on StockTwits'));
  insList.slice(0, quota).forEach((r) => addCand(r.ticker, r.buyers >= 3 ? `Insider cluster buy (${r.buyers})` : 'Insider buying'));
  const congCount = new Map();
  for (const t of congList) congCount.set(t.ticker, (congCount.get(t.ticker) || 0) + 1);
  [...congCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.ceil(quota / 2)).forEach(([t]) => {
    const tr = congList.filter((x) => x.ticker === t);
    const b = tr.filter((x) => x.type === 'buy').length;
    const s = tr.filter((x) => x.type === 'sell').length;
    addCand(t, b >= s ? 'Congress buying' : 'Congress selling');
  });
  // Tag secondary reasons for any candidate
  for (const t of reasons.keys()) {
    if (apeMap.has(t)) addCand(t, `Reddit #${apeMap.get(t).rank}`);
    if (stSet.has(t)) addCand(t, 'Trending on StockTwits');
    if (insMap.has(t)) addCand(t, insMap.get(t).buyers >= 3 ? `Insider cluster buy (${insMap.get(t).buyers})` : 'Insider buying');
  }

  const tickers = [...reasons.keys()].slice(0, max);
  const rows = await pool(tickers, 6, async (t) => {
    const px = await chart(env, t, '1y');
    const tech = computeTechnicals(px.bars, spy.ok ? spy.value.bars : null);
    if (!tech) return null;
    const apeRow = apeMap.get(t) || null;
    const ct = congList.filter((x) => x.ticker === t);
    const insAgg = insMap.get(t);
    const social = apeRow || stSet.has(t) ? { ape: apeRow, st: null, trending: stSet.has(t) } : null;
    const comps = [
      insAgg ? scoreInsider(fakeInsiderTx(insAgg)) : null,
      scoreTechnical(tech),
      ct.length ? scoreCongress(ct) : null,
      social ? scoreSocial(social, tech) : null,
    ].filter(Boolean);
    const c = composite(comps);
    const mv = movePotential({ tech, positioning: null, social, earningsDays: null, score: c.score, insiderCluster: insAgg && insAgg.buyers >= 3 });
    return {
      ticker: t,
      name: (apeRow && apeRow.name) || (insAgg && insAgg.issuer) || px.meta.name || '',
      type: /ETF/i.test(px.meta.instrumentType || '') ? 'ETF' : 'Stock',
      price: tech.price,
      change1d: tech.change1d,
      ret1m: tech.ret1m,
      rsi: tech.rsi14,
      relVolume: tech.relVolume,
      score: c.score,
      verdict: c.verdict,
      move: mv.level,
      reasons: reasons.get(t),
      mentions: apeRow ? apeRow.mentions : null,
      mentionsChange: apeRow ? apeRow.mentions - apeRow.mentions24hAgo : null,
      spark: px.bars.slice(-30).map((b) => +b.c.toFixed(2)),
      top: comps.flatMap((x) => x.signals.filter((s) => s.impact !== 0)).slice(0, 2).map((s) => s.text),
    };
  });

  const all = rows.filter((r) => r && !r.error);
  const positive = all.filter((r) => r.score > 0).sort((a, b) => b.score - a.score).slice(0, 12);
  const negative = all.filter((r) => r.score < 0).sort((a, b) => a.score - b.score).slice(0, 12);
  const mostTalked = all.filter((r) => r.mentions != null).sort((a, b) => b.mentions - a.mentions).slice(0, 10);

  return {
    updated: new Date().toISOString(),
    insiderDays: days,
    positive,
    negative,
    mostTalked,
    all,
    insiderBuys: insList.slice(0, 25),
    // Enough trades for the home page to group them by member.
    congress: congList.sort((a, b) => (b.filedDate || '').localeCompare(a.filedDate || '')).slice(0, 300),
    status: {
      reddit: ape.ok ? 'ok' : ape.error,
      stocktwits: st.ok ? 'ok' : st.error,
      insiders: ins.ok ? ins.value.status : ins.error,
      congress: cong.ok ? 'ok' : cong.error,
      priced: all.length,
      failed: rows.filter((r) => r && r.error).length,
    },
  };
}
