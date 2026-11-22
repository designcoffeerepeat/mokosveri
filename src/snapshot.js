// Fast first paint for the ticker page: price and header facts from the cached
// Yahoo chart call, plus company facts when the cached quote
// summary answers quickly. The slow sources (SEC, news, social, AI) come later
// from /api/analyze.
import { settle, withBudget, isIndex, INDEX_NAMES } from './util.js';
import { chart, quoteSummary, raw } from './sources/yahoo.js';
import { computeTechnicals } from './analysis/technicals.js';

export async function tickerSnapshot(env, ticker, waitUntil = null) {
  const qsP = settle(quoteSummary(env, ticker));
  const px = await settle(chart(env, ticker, '1y'));
  if (!px.ok || !px.value.bars.length) {
    return { error: `Could not find price data for ${ticker}. Check the symbol and try again.`, status: 404 };
  }
  // The quote summary is cached for 30 minutes, so this is usually instant.
  // When it is not, skip it rather than hold up the price.
  const qs = await withBudget(qsP, 1200, { ok: false }, waitUntil);
  const q = qs.ok ? qs.value : {};
  const pr = q.price || {};
  const ap = q.assetProfile || {};
  const qt = (q.quoteType && q.quoteType.quoteType) || px.value.meta.instrumentType || 'EQUITY';
  const isIdx = isIndex(ticker) || /INDEX/i.test(qt);
  const isETF = !isIdx && /ETF|MUTUALFUND/i.test(qt);
  const bars = px.value.bars;
  const t = computeTechnicals(bars, null) || {};
  return {
    ticker,
    name: pr.longName || pr.shortName || px.value.meta.name || INDEX_NAMES[ticker] || ticker,
    type: isIdx ? 'Index' : isETF ? 'ETF' : 'Stock',
    exchange: px.value.meta.exchange,
    currency: px.value.meta.currency,
    sector: ap.sector || null,
    industry: ap.industry || null,
    marketCap: raw(pr.marketCap),
    price: t.price ?? null,
    change1d: t.change1d ?? null,
    ret1m: t.ret1m ?? null,
    ret1y: t.ret1y ?? null,
    asOf: new Date().toISOString(),
  };
}
