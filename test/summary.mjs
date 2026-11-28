// The Read summary must never print NaN, "consensus none" or HTML entities.
// Run: node test/summary.mjs
import assert from 'node:assert/strict';
import { buildPlainFacts, templateParagraph, cleanCopy, decodeEntities } from '../src/analysis/summary.js';
import { composite, movePotential, scoreTechnical } from '../src/analysis/score.js';
import { computeTechnicals } from '../src/analysis/technicals.js';

const base = { ticker: 'ACME', type: 'Stock', technicals: {}, insider: { available: false, transactions: [] } };

// 1. A NaN score and NaN move value fall back to plain words.
{
  const f = buildPlainFacts({ ...base, score: NaN, coverage: 0.6, move: { value: NaN, level: 'Normal', why: [] } });
  assert.ok(!/NaN/.test(f.bottom), f.bottom);
  assert.equal(f.bottom, 'Score unavailable (60% data coverage).');
  const f2 = buildPlainFacts({ ...base, score: undefined, coverage: undefined, move: undefined });
  assert.equal(f2.bottom, 'Score unavailable.');
}

// 2. Real numbers render as before.
{
  const f = buildPlainFacts({ ...base, score: 22, coverage: 0.81, move: { value: 41, level: 'Elevated', why: [], typicalMonthMovePct: 7.2 } });
  assert.equal(f.bottom, 'Leaning bullish at +22 of ±100, 81% data coverage. Big move odds elevated (41/100), typical month ±7.2%.');
  const f0 = buildPlainFacts({ ...base, score: 0, coverage: 0.5, move: { value: 0, level: 'Normal', why: [] } });
  assert.equal(f0.bottom, 'Neutral at 0 of ±100, 50% data coverage. Big move odds normal (0/100).');
}

// 3. Composite ignores a component whose score is NaN.
{
  const c = composite([
    { score: NaN, weight: 0.12, confidence: 1 },
    { score: 0.5, weight: 0.22, confidence: 1 },
  ]);
  assert.equal(c.score, 50);
  assert.ok(Number.isFinite(c.coverage));
  assert.equal(composite([{ score: NaN, weight: 0.1, confidence: 1 }]).score, 0);
}

// 4. movePotential stays numeric with bad inputs.
{
  const m = movePotential({ tech: { vol20: NaN, relVolume5: NaN }, positioning: { shortPctFloat: NaN }, social: { ape: { mentions: 10, mentions24hAgo: undefined, rank: 50 } }, earningsDays: null, score: NaN });
  assert.ok(Number.isFinite(m.value), String(m.value));
  assert.equal(m.typicalMonthMovePct, null);
}

// 5. A zero or missing close in the price bars does not poison technicals.
{
  const bars = [];
  for (let i = 0; i < 260; i++) {
    const c = 50 + i * 0.1;
    bars.push({ t: i, o: c, h: c + 1, l: c - 1, c: i === 250 ? 0 : c, v: 1e6 });
  }
  const t = computeTechnicals(bars);
  assert.ok(t.vol20 === null || Number.isFinite(t.vol20));
  const m = movePotential({ tech: t, score: 0 });
  assert.ok(Number.isFinite(m.value));
  const st = scoreTechnical(t);
  const c = composite([st]);
  assert.ok(Number.isFinite(c.score));
}

// 6. Yahoo's "none" consensus is not printed; real ones are.
{
  const tech = { price: 100 };
  const none = buildPlainFacts({ ...base, score: 10, technicals: tech, analyst: { targetMean: 130, numAnalysts: 4, recKey: 'none' } });
  assert.ok(none.good.length && !/consensus/.test(none.good.join(' ')), none.good.join(' | '));
  const buy = buildPlainFacts({ ...base, score: 10, technicals: tech, analyst: { targetMean: 130, numAnalysts: 4, recKey: 'strong_buy' } });
  assert.ok(/consensus strong buy/.test(buy.good.join(' ')));
}

// 7. HTML entities (single and double encoded) become plain characters.
{
  assert.equal(decodeEntities('S&amp;P 500'), 'S&P 500');
  assert.equal(decodeEntities('S&amp;amp;P 500'), 'S&P 500');
  assert.equal(decodeEntities('Johnson &#38; Johnson &#x27;24'), "Johnson & Johnson '24");
  assert.equal(cleanCopy('Lagging the S&amp;P 500 &amp; peers'), 'Lagging the S&P 500 & peers');
  assert.equal(decodeEntities('AT&T &unknown; stays'), 'AT&T &unknown; stays');
  const p = templateParagraph({ bottom: 'Neutral at 0 of ±100.', good: ['Upgrade at Morgan Stanley &amp; Co.'], bad: [], watch: [] });
  assert.ok(!/&amp;/.test(p) && /&/.test(p), p);
}

console.log('summary tests passed');
