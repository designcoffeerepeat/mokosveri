// Full single-ticker analysis: pulls every source in parallel, scores, and
// returns a UI-ready object.
import { settle, daysBetween, isIndex, INDEX_NAMES } from './util.js';
import { chart, quoteSummary, raw } from './sources/yahoo.js';
import { latestNews, scoreHeadlines } from './sources/news.js';
import { plainSummary } from './analysis/summary.js';
import { companyInsiders, tickerInsiderFromDb } from './sources/sec.js';
import { apeWisdom, stocktwitsTrending, stocktwitsSentiment } from './sources/social.js';
import { congressForTicker } from './sources/congress.js';
import { computeTechnicals } from './analysis/technicals.js';
import { scoreInsider, scoreTechnical, scoreAnalyst, scorePositioning, scoreCongress, scoreSocial, scoreNews, composite, movePotential } from './analysis/score.js';

export async function analyzeTicker(env, ticker, opts = {}) {
  const days = parseInt(env.INSIDER_DAYS || '30', 10);
  const waitUntil = opts.waitUntil || null;
  // Indices (VIX, SPX...) have no insiders, filings, analysts or Congress trades.
  const idx = isIndex(ticker);
  const skip = (p) => (idx ? Promise.resolve({ ok: false, skipped: true, error: 'not applicable to an index' }) : settle(p()));
  const pxP = settle(chart(env, ticker, '1y'));
  const qsP = settle(quoteSummary(env, ticker));
  // News only needs the company name, so start it as soon as the price and
  // summary calls are back instead of waiting on SEC and social feeds.
  const nwP = Promise.all([pxP, qsP]).then(([px, qs]) => {
    const q0 = qs.ok ? qs.value : {};
    const nameGuess = (q0.price && (q0.price.longName || q0.price.shortName)) || (px.ok && px.value.meta.name) || '';
    return settle(latestNews(env, ticker, nameGuess));
  });
  const [px, spy, qs, st, ape, trend, cong, ins, nw] = await Promise.all([
    pxP,
    settle(chart(env, 'SPY', '1y')),
    qsP,
    skip(() => stocktwitsSentiment(env, ticker)),
    skip(() => apeWisdom(env)),
    skip(() => stocktwitsTrending(env)),
    skip(() => congressForTicker(env, ticker)),
    skip(() => companyInsiders(env, ticker, days)),
    nwP,
  ]);

  if (!px.ok || !px.value.bars.length) {
    return { error: `Could not find price data for ${ticker}. Check the symbol and try again.`, status: 404 };
  }
  const sources = {
    price: px.ok,
    benchmark: spy.ok,
    yahooFundamentals: qs.ok,
    news: nw.ok,
    stocktwits: st.ok,
    reddit: ape.ok,
    congress: cong.ok,
    secForm4: ins.ok,
  };
  const errors = {};
  for (const [k, v] of Object.entries({ px, spy, qs, nw, st, ape, cong, ins })) if (!v.ok) errors[k] = v.error;
  if (idx) for (const k of ['stocktwits', 'reddit', 'congress', 'secForm4']) delete sources[k];

  const bars = px.value.bars;
  const tech = computeTechnicals(bars, spy.ok ? spy.value.bars : null);
  const q = qs.ok ? qs.value : {};
  const qt = (q.quoteType && q.quoteType.quoteType) || px.value.meta.instrumentType || 'EQUITY';
  const isIdx = idx || /INDEX/i.test(qt);
  const isETF = !isIdx && /ETF|MUTUALFUND/i.test(qt);

  // Insiders: SEC direct, falling back to our ingested Form 4 store.
  let insider = ins.ok ? ins.value : null;
  if ((!insider || !insider.available) && !isETF && !isIdx && env.DB) {
    try {
      const rows = await tickerInsiderFromDb(env, ticker, days);
      if (rows.length)
        insider = {
          available: true,
          fromStore: true,
          transactions: rows.map((r) => ({
            owner: r.owner,
            title: r.title,
            code: r.code,
            date: r.tx_date,
            filed: r.filed_date,
            shares: r.shares,
            price: r.price,
            value: r.value,
            ownedAfter: r.owned_after,
            plan10b5: !!r.plan_10b5,
            url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(ticker)}&type=4&owner=include&count=40`,
          })),
        };
    } catch {}
  }
  if (isETF) insider = { available: false, reason: 'ETFs do not have insiders. See holdings below.' };
  if (isIdx) insider = { available: false, reason: 'Indices do not have insiders.' };

  // Analysts
  const fd = q.financialData || {};
  const udh = (q.upgradeDowngradeHistory && q.upgradeDowngradeHistory.history) || [];
  const actions = udh
    .map((h) => ({
      date: new Date(h.epochGradeDate * 1000).toISOString().slice(0, 10),
      firm: h.firm,
      action: h.action,
      fromGrade: h.fromGrade,
      toGrade: h.toGrade,
      ptAction: h.priceTargetAction || '',
      target: h.currentPriceTarget || null,
      priorTarget: h.priorPriceTarget || null,
    }))
    .filter((a) => daysBetween(a.date) <= 90)
    .slice(0, 25);
  const rt = (q.recommendationTrend && q.recommendationTrend.trend && q.recommendationTrend.trend[0]) || null;
  const analyst = qs.ok && !isETF && !isIdx
    ? {
        targetMean: raw(fd.targetMeanPrice),
        targetHigh: raw(fd.targetHighPrice),
        targetLow: raw(fd.targetLowPrice),
        recMean: raw(fd.recommendationMean),
        recKey: fd.recommendationKey,
        numAnalysts: raw(fd.numberOfAnalystOpinions),
        trend: rt ? { strongBuy: rt.strongBuy, buy: rt.buy, hold: rt.hold, sell: rt.sell, strongSell: rt.strongSell } : null,
        actions,
      }
    : null;

  // Positioning
  const ks = q.defaultKeyStatistics || {};
  const shares = raw(ks.sharesShort);
  const prior = raw(ks.sharesShortPriorMonth);
  const positioning = qs.ok && !isIdx
    ? {
        shortPctFloat: raw(ks.shortPercentOfFloat),
        sharesShort: shares,
        shortChange: shares && prior ? shares / prior - 1 : null,
        daysToCover: raw(ks.shortRatio),
        asOf: raw(ks.dateShortInterest) ? new Date(raw(ks.dateShortInterest) * 1000).toISOString().slice(0, 10) : null,
        insiderOwnPct: raw(ks.heldPercentInsiders),
        instOwnPct: raw(ks.heldPercentInstitutions),
        floatShares: raw(ks.floatShares),
        beta: raw(ks.beta) ?? raw(q.summaryDetail && q.summaryDetail.beta),
      }
    : null;

  // Social
  const apeRow = ape.ok ? ape.value.find((r) => r.ticker === ticker) : null;
  const trending = trend.ok ? trend.value.some((r) => r.ticker === ticker) : false;
  const social = { ape: apeRow || null, st: st.ok ? st.value : null, trending };

  const newsSent = nw.ok && nw.value.items.length ? await scoreHeadlines(env, ticker, nw.value.items, { waitUntil }) : null;

  const congressTrades = cong.ok ? cong.value : null;

  const components = [
    scoreInsider(insider),
    scoreTechnical(tech),
    scoreAnalyst(analyst, tech && tech.price),
    scorePositioning(positioning, tech),
    scoreCongress(congressTrades),
    scoreSocial(social.ape || social.st || social.trending ? social : null, tech),
    scoreNews(newsSent),
  ].filter(Boolean);

  const comp = composite(components);
  const earnRaw = q.calendarEvents && q.calendarEvents.earnings && q.calendarEvents.earnings.earningsDate && q.calendarEvents.earnings.earningsDate[0];
  const earningsDate = raw(earnRaw) ? new Date(raw(earnRaw) * 1000).toISOString().slice(0, 10) : null;
  const earningsDays = earningsDate ? -daysBetween(earningsDate) : null;
  const buys = insider && insider.transactions ? insider.transactions.filter((t) => t.code === 'P') : [];
  const move = movePotential({ tech, positioning, social, earningsDays, score: comp.score, insiderCluster: new Set(buys.map((b) => b.owner)).size >= 3, newsFlow: newsSent ? newsSent.last48h : 0 });

  const pr = q.price || {};
  const ap = q.assetProfile || {};
  const holdings = isETF && q.topHoldings && q.topHoldings.holdings
    ? q.topHoldings.holdings.map((h) => ({ symbol: h.symbol, name: h.holdingName, pct: raw(h.holdingPercent) }))
    : null;

  let dividend = null;
  if (!isIdx) {
    try {
      dividend = dividendInfo(q, px.value.dividends, tech && tech.price);
    } catch {}
  }

  // Company profile (or fund profile for ETFs) shown at the bottom of the page.
  const sp = q.summaryProfile || {};
  const fp = q.fundProfile || {};
  const desc = ap.longBusinessSummary || sp.longBusinessSummary || null;
  const officers = (ap.companyOfficers || [])
    .filter((o) => o && o.name)
    .slice(0, 5)
    .map((o) => ({ name: o.name, title: o.title || '', age: o.age || null, pay: raw(o.totalPay) }));
  const hq = [ap.city || sp.city, ap.state || sp.state, ap.country || sp.country].filter(Boolean).join(', ');
  const profile = !isIdx && (desc || ap.sector || officers.length || fp.family)
    ? {
        description: desc,
        sector: ap.sector || sp.sector || null,
        industry: ap.industry || sp.industry || null,
        employees: ap.fullTimeEmployees || sp.fullTimeEmployees || null,
        website: ap.website || sp.website || null,
        hq: hq || null,
        officers,
        fundFamily: fp.family || null,
        fundCategory: fp.categoryName || null,
        expenseRatio: raw(fp.feesExpensesInvestment && fp.feesExpensesInvestment.annualReportExpenseRatio),
      }
    : null;

  const result = {
    ticker,
    name: pr.longName || pr.shortName || px.value.meta.name || INDEX_NAMES[ticker] || ticker,
    type: isIdx ? 'Index' : isETF ? 'ETF' : 'Stock',
    exchange: px.value.meta.exchange,
    currency: px.value.meta.currency,
    sector: ap.sector || null,
    industry: ap.industry || null,
    marketCap: raw(pr.marketCap),
    earningsDate,
    asOf: new Date().toISOString(),
    score: comp.score,
    verdict: comp.verdict,
    coverage: comp.coverage,
    move,
    components,
    technicals: tech,
    series: bars.slice(-252).map((b) => [b.t, +b.c.toFixed(4), b.v]),
    insider: insider || { available: false, reason: 'SEC data unavailable right now' },
    insiderDays: days,
    analyst,
    positioning,
    social,
    congress: congressTrades,
    news: newsSent ? newsSent.items : [],
    newsMeta: newsSent ? { method: newsSent.method, last48h: newsSent.last48h, sources: nw.value.sources } : null,
    dividend,
    holdings,
    profile,
    sources,
    errors,
  };
  result.plain = await plainSummary(env, result, { waitUntil });
  return result;
}

// Dividend yield, the headline number for an ETF. Yahoo's quote summary gives
// the fund's yield (summaryDetail.yield for ETFs, dividendYield for stocks);
// the payouts in the last 12 months from the price history back it up and
// give the trailing figure when the summary is missing.
export function dividendInfo(q, divs, price) {
  const sd = (q && q.summaryDetail) || {};
  const ks = (q && q.defaultKeyStatistics) || {};
  const pos = (v) => (typeof v === 'number' && isFinite(v) && v > 0 ? v : null);
  // Yahoo sends epoch seconds, but sometimes an empty object or a date string.
  const day = (v) => {
    const d = typeof v === 'number' ? new Date(v * 1000) : typeof v === 'string' ? new Date(v) : null;
    return d && !isNaN(d) ? d.toISOString().slice(0, 10) : null;
  };
  const cutoff = Date.now() / 1000 - 365 * 86400;
  const clean = (divs || []).filter((d) => d && typeof d.t === 'number' && isFinite(d.t) && pos(d.amount));
  const last12 = clean.filter((d) => d.t >= cutoff);
  const ttmRate = last12.length ? last12.reduce((s, d) => s + d.amount, 0) : null;
  const ttmYield = ttmRate && price ? (ttmRate / price) * 100 : null;
  const quoted = pos(raw(sd.yield)) ?? pos(raw(ks.yield)) ?? pos(raw(sd.dividendYield)) ?? pos(raw(sd.trailingAnnualDividendYield));
  const yieldPct = quoted != null ? quoted * 100 : ttmYield;
  const rate = pos(raw(sd.dividendRate)) ?? pos(raw(sd.trailingAnnualDividendRate)) ?? ttmRate;
  const last = last12.length ? last12[last12.length - 1] : (clean.length ? clean[clean.length - 1] : null);
  if (yieldPct == null && rate == null && !last) return null;
  return {
    yieldPct: yieldPct != null ? +yieldPct.toFixed(2) : null,
    ttmYieldPct: ttmYield != null ? +ttmYield.toFixed(2) : null,
    annualRate: rate != null ? +rate.toFixed(4) : null,
    payments12m: last12.length,
    lastAmount: last ? last.amount : null,
    lastDate: last ? day(last.t) : null,
    exDate: day(raw(sd.exDividendDate)),
  };
}
