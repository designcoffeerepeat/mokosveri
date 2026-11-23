// Major futures for the home page panel: equity index, energy, metals, rates
// and crypto front month contracts from Yahoo (continuous "=F" symbols), read
// through the shared 15 second live quote cache.
import { liveQuotes, refreshSeconds, marketLabel } from './live.js';

export const FUTURES = [
  { symbol: 'ES', yahoo: 'ES=F', name: 'S&P 500', group: 'Equity index' },
  { symbol: 'NQ', yahoo: 'NQ=F', name: 'Nasdaq 100', group: 'Equity index' },
  { symbol: 'YM', yahoo: 'YM=F', name: 'Dow 30', group: 'Equity index' },
  { symbol: 'RTY', yahoo: 'RTY=F', name: 'Russell 2000', group: 'Equity index' },
  { symbol: 'CL', yahoo: 'CL=F', name: 'Crude oil (WTI)', group: 'Energy' },
  { symbol: 'NG', yahoo: 'NG=F', name: 'Natural gas', group: 'Energy' },
  { symbol: 'GC', yahoo: 'GC=F', name: 'Gold', group: 'Metals' },
  { symbol: 'SI', yahoo: 'SI=F', name: 'Silver', group: 'Metals' },
  { symbol: 'ZN', yahoo: 'ZN=F', name: '10 year T-note', group: 'Rates' },
  { symbol: 'BTC', yahoo: 'BTC=F', name: 'Bitcoin (CME)', group: 'Crypto' },
];

export async function futuresBoard(env) {
  const live = await liveQuotes(env, FUTURES.map((f) => f.yahoo)).catch(() => new Map());
  return {
    items: FUTURES.map((f) => {
      const q = live.get(f.yahoo);
      return {
        ...f,
        price: q ? q.price : null,
        change: q ? q.change : null,
        change1d: q ? q.change1d : null,
        time: q ? q.time : null,
        marketState: q ? q.marketState : null,
      };
    }),
    refreshSec: refreshSeconds(live),
    market: marketLabel(live),
    at: Date.now(),
  };
}
