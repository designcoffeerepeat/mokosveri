// Offline tests for the options calculator math and chain parsing.
// Run: node test/options.mjs
import assert from 'node:assert/strict';
import { parseChain } from '../src/sources/options.js';
import { bs, impliedVol } from '../public/options.js';

// Black-Scholes reference values (S=100, K=100, T=1, r=5%, sigma=20%)
assert.ok(Math.abs(bs('C', 100, 100, 1, 0.05, 0, 0.2) - 10.4506) < 0.01, 'call price');
assert.ok(Math.abs(bs('P', 100, 100, 1, 0.05, 0, 0.2) - 5.5735) < 0.01, 'put price');
// Put-call parity
const c = bs('C', 120, 110, 0.4, 0.04, 0.01, 0.35);
const p = bs('P', 120, 110, 0.4, 0.04, 0.01, 0.35);
assert.ok(Math.abs(c - p - (120 * Math.exp(-0.01 * 0.4) - 110 * Math.exp(-0.04 * 0.4))) < 1e-3, 'parity');
// At expiration: intrinsic
assert.equal(bs('C', 105, 100, 0, 0.05, 0, 0.2), 5);
assert.equal(bs('P', 105, 100, 0, 0.05, 0, 0.2), 0);
// Implied vol round trip
const iv = impliedVol('C', bs('C', 50, 55, 0.25, 0.03, 0, 0.42), 50, 55, 0.25, 0.03, 0);
assert.ok(Math.abs(iv - 0.42) < 1e-4, 'implied vol');
assert.equal(impliedVol('C', 0, 50, 55, 0.25, 0.03, 0), null);

// Yahoo chain parsing
const chain = parseChain({
  optionChain: {
    result: [
      {
        underlyingSymbol: 'AAPL',
        expirationDates: [1766102400, 1766707200],
        strikes: [190, 195],
        quote: { symbol: 'AAPL', longName: 'Apple Inc.', regularMarketPrice: 192.5, trailingAnnualDividendYield: 0.005 },
        options: [
          {
            expirationDate: 1766102400,
            calls: [{ strike: 190, bid: 4.1, ask: 4.3, lastPrice: 4.2, impliedVolatility: 0.25, openInterest: 100, volume: 5 }],
            puts: [{ strike: 195, bid: 3.9, ask: 4.0, lastPrice: 3.95, impliedVolatility: 0.24 }, { strike: null }],
          },
        ],
      },
    ],
  },
});
assert.equal(chain.symbol, 'AAPL');
assert.equal(chain.price, 192.5);
assert.equal(chain.expiration, 1766102400);
assert.equal(chain.calls.length, 1);
assert.equal(chain.puts.length, 1);
assert.equal(chain.calls[0].iv, 0.25);
assert.throws(() => parseChain({ optionChain: { result: [] } }));

console.log('options tests passed');

// Custom stock price bounds for the P/L table and chart
import { priceBounds } from '../public/options.js';
const auto = priceBounds(100, 0.3, 0.25);
assert.ok(auto.lo < 100 && auto.hi > 100 && !auto.custom);
assert.equal(priceBounds(100, 0.3, 0.25, 20).hi, 120, 'slider percent');
const up = priceBounds(100, 0.3, 0.25, 0, '', '400');
assert.equal(up.hi, 400, 'typed high price');
assert.ok(up.custom && up.lo < 100);
assert.deepEqual([priceBounds(100, 0.3, 0.25, 0, '150', '300').lo, priceBounds(100, 0.3, 0.25, 0, '150', '300').hi], [150, 300]);
const swapped = priceBounds(100, 0.3, 0.25, 0, '300', '150');
assert.ok(swapped.lo === 150 && swapped.hi === 300, 'low and high typed backwards');
const lowOnly = priceBounds(100, 0.3, 0.25, 0, '250', '');
assert.ok(lowOnly.hi > 250, 'low above the price still gets a window');
console.log('price bounds tests passed');
