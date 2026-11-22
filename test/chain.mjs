// Offline tests for the ticker page option chain and the calculator deep link.
// Run: node test/chain.mjs
import assert from 'node:assert/strict';
import { chainRows, chainTableHtml, calcHref, delta, expClose } from '../public/chain.js';
import { parsePreset } from '../public/options.js';

const exp = 1766102400;
const mk = (k, extra = {}) => ({ strike: k, bid: 1, ask: 1.2, last: 1.1, iv: 0.3, oi: 500, vol: 20, ...extra });
const strikes = Array.from({ length: 41 }, (_, i) => 80 + i * 2.5); // 80 .. 180
const chain = { symbol: 'TEST', price: 131.2, dividendYield: 0, expiration: exp, expirations: [exp], calls: strikes.map((k) => mk(k)), puts: strikes.filter((k) => k !== 180).map((k) => mk(k)), chain: true };

// Rows merge by strike and center on the price
const all = chainRows(chain, 0);
assert.equal(all.rows.length, 41);
assert.equal(all.rows[all.rows.length - 1].put, null, 'call only strike keeps an empty put side');
const near = chainRows(chain, 5);
assert.equal(near.rows.length, 10);
assert.equal(near.hidden, 31);
assert.ok(near.rows[near.split - 1].strike < 131.2 && near.rows[near.split].strike > 131.2, 'price line sits between strikes');

// Delta sanity: deep ITM call near 1, put delta = call delta - 1 (no dividend)
const T = 0.25;
assert.ok(delta('C', 200, 100, T, 0.3) > 0.99);
assert.ok(Math.abs(delta('C', 100, 100, T, 0.3) - delta('P', 100, 100, T, 0.3) - 1) < 1e-9);
assert.ok(Math.abs(delta('C', 100, 100, T, 0.3) - 0.56) < 0.03, 'ATM call delta a bit above 0.5');
assert.equal(delta('C', 110, 100, 0, 0.3), 1, 'expired ITM call');

// Table: ITM shading on the correct side, links to the calculator
const { html } = chainTableHtml(chain, { around: 5, now: expClose(exp) - 30 * 864e5 });
assert.ok(html.includes('class="oc-px"'), 'price line row');
const rows = html.split('<tr>').slice(2);
const low = rows.find((r) => r.includes('>127.5</td>'));
const high = rows.find((r) => r.includes('>132.5</td>'));
assert.ok(/oc-c itm/.test(low) && !/oc-p itm/.test(low), 'lower strike: call ITM, put OTM');
assert.ok(/oc-p itm/.test(high) && !/oc-c itm/.test(high), 'higher strike: put ITM, call OTM');
assert.ok(html.includes('#/options?t=TEST&amp;exp=1766102400&amp;k=127.5&amp;type=C&amp;side=1'));
assert.ok(!html.includes('\u2014'), 'no em dashes in UI copy');
const putsOnly = chainTableHtml(chain, { around: 5, view: 'puts', side: -1 }).html;
assert.ok(!putsOnly.includes('oc-c'), 'puts view hides calls');
assert.ok(putsOnly.includes('side=-1'), 'sell links');

// Calculator deep link round trip
const href = calcHref('BRK-B', exp, 412.5, 'P', -1);
const p = parsePreset(href);
assert.deepEqual(p, { exp: String(exp), strike: 412.5, type: 'P', side: -1, strat: 'short_put' });
assert.equal(parsePreset(calcHref('AAPL', exp, 190, 'C')).strat, 'long_call');
assert.equal(parsePreset('#/options?t=AAPL'), null, 'plain ticker link is not a preset');
assert.equal(parsePreset('#/options?t=AAPL&exp=abc&k=190&type=C'), null);

console.log('chain tests passed');
