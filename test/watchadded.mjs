// Price at add time from daily bars. Run: node test/watchadded.mjs
import assert from 'node:assert/strict';
import { closeAtAdd } from '../src/watchlist.js';

const day = (iso) => Date.parse(iso) / 1000;
// Daily bars stamped at the 9:30 ET open (14:30 UTC).
const bars = [
  { t: day('2026-11-16T14:30:00Z'), c: 100 },
  { t: day('2026-11-17T14:30:00Z'), c: 102 },
  { t: day('2026-11-18T14:30:00Z'), c: 105 },
];

// Added after the close: that day's close, and final since newer bars exist.
assert.deepEqual(closeAtAdd(bars, Date.parse('2026-11-16T22:00:00Z')), { price: 100, final: true });
// Added before the open: the prior close.
assert.deepEqual(closeAtAdd(bars, Date.parse('2026-11-17T12:00:00Z')), { price: 100, final: true });
// Added during today's session: newest bar, not final yet.
assert.deepEqual(closeAtAdd(bars, Date.parse('2026-11-18T16:00:00Z')), { price: 105, final: false });
// Added before the history starts, or no data.
assert.equal(closeAtAdd(bars, Date.parse('2025-01-01T00:00:00Z')), null);
assert.equal(closeAtAdd([], Date.now()), null);
assert.equal(closeAtAdd(bars, null), null);

console.log('watchadded ok');
