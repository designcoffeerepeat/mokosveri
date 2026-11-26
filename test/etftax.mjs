// Offline test for ETF tax status and best account guidance (public/etftax.js)
// and where it shows. Run: node test/etftax.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { etfTax, KNOWN, TAX_TYPES, TAX_DISCLAIMER, taxCardHtml, taxCell, taxLine, taxLegendHtml } from '../public/etftax.js';
import { ETFS, INCOME_FUNDS } from '../src/dividends.js';
import { etfTableHtml } from '../public/dividends.js';
import { COLUMN_KEYS, cleanColumns } from '../public/wlcols.js';
import { statsFrom } from '../src/sources/quotestats.js';

for (const f of ['public/etftax.js', 'public/dividends.js', 'public/divcalc.js', 'public/wltable.js', 'public/wlcols.js', 'public/styles.css']) {
  assert.ok(!readFileSync(new URL('../' + f, import.meta.url), 'utf8').includes('—'), `${f} has no em dash`);
}

// Every type is complete.
for (const [k, v] of Object.entries(TAX_TYPES)) for (const f of ['label', 'short', 'what', 'acct', 'best', 'why']) assert.ok(typeof v[f] === 'string', `${k}.${f}`);
for (const [t, k] of Object.entries(KNOWN)) assert.ok(TAX_TYPES[k.type], `${t} has a real type`);

// Every fund the dividend page and calculator list is on file, not guessed.
for (const f of [...ETFS, ...INCOME_FUNDS]) {
  const x = etfTax(f);
  assert.equal(x.guess, false, `${f.t} is known`);
  assert.notEqual(x.type, 'unknown', `${f.t} classified`);
}

const ty = (t, more) => etfTax({ t, ...more }).type;
assert.equal(ty('SCHD'), 'equity_income');
assert.equal(ty('VOO'), 'equity');
assert.equal(ty('SCHY'), 'foreign');
assert.equal(ty('JEPI'), 'covered_call_ordinary');
assert.equal(ty('QYLD'), 'covered_call_1256');
assert.equal(ty('VNQ'), 'reit');
assert.equal(ty('BND'), 'bond');
assert.equal(ty('SGOV'), 'treasury');
assert.equal(ty('MUB'), 'muni');
assert.equal(ty('USO'), 'commodity_k1');
assert.equal(ty('PDBC'), 'commodity_1099');
assert.equal(ty('GLD'), 'collectible');
assert.equal(ty('IBIT'), 'crypto_spot');
assert.equal(ty('AMLP'), 'mlp_ccorp');
assert.equal(ty('TQQQ'), 'leveraged');
assert.equal(ty('sgov'), 'treasury', 'lower case ticker');
assert.ok(etfTax({ t: 'AMLP' }).notes.length, 'AMLP gets the return of capital note');

// Unknown tickers are classified from the category and name, and marked as a guess.
const g = (category, name = '') => etfTax({ t: 'ZZZZ', category, name });
assert.equal(g('Muni National Interm').type, 'muni');
assert.equal(g('Ultrashort Bond').type, 'bond', 'ultrashort is not leveraged');
assert.equal(g('Trading--Leveraged Equity').type, 'leveraged');
assert.equal(g('Short Government').type, 'treasury');
assert.equal(g('Real Estate').type, 'reit');
assert.equal(g('Preferred Stock').type, 'preferred');
assert.equal(g('Derivative Income').type, 'covered_call');
assert.equal(g('Foreign Large Value').type, 'foreign');
assert.equal(g('Diversified Emerging Mkts').type, 'foreign');
assert.equal(g('Equity Precious Metals', 'VanEck Gold Miners ETF').type, 'equity');
assert.equal(g('Commodities Focused', 'SPDR Gold Shares').type, 'collectible');
assert.equal(g('Digital Assets', 'Some Bitcoin Trust').type, 'crypto_spot');
assert.equal(g('Digital Assets', 'Some Bitcoin Strategy ETF').type, 'commodity_1099');
assert.equal(g('Commodities Broad Basket').type, 'commodity');
assert.equal(g('Large Blend').type, 'equity');
assert.equal(g('Large Value', 'Some Dividend ETF').type, 'equity_income');
assert.equal(g('', 'Global X Something Covered Call ETF').type, 'covered_call', 'Global X is not international');
assert.equal(g('', '').type, 'unknown');
assert.equal(g('Large Blend').guess, true);

// HTML pieces carry the label, the best account and the disclaimer.
const card = taxCardHtml(etfTax({ t: 'MUB' }));
assert.ok(card.includes('Taxable brokerage only'));
assert.ok(card.includes('not tax advice'));
assert.ok(TAX_DISCLAIMER.includes('not tax advice'));
assert.ok(taxCardHtml(g('Large Blend')).includes('category'), 'guess is labelled');
assert.ok(taxCell(etfTax({ t: 'BND' })).includes('Best: IRA / 401(k)'));
assert.ok(taxLine(etfTax({ t: 'JEPI' })).includes('Best account'));
const legend = taxLegendHtml([etfTax({ t: 'SCHD' }), etfTax({ t: 'VYM' }), etfTax({ t: 'JEPI' })]);
assert.equal((legend.match(/<dt>/g) || []).length, 2, 'one legend entry per type');

// The dividend page ETF table has the Taxes column and the guide.
const rows = ETFS.map((e, i) => ({ ...e, yield: 3 + i / 10, ytd: 1, r1y: 2, tr1y: 5, tr5y: 6 }));
const html = etfTableHtml(rows, { min: 0, sort: 'yield', asc: false });
assert.ok(html.includes('>Taxes<'));
assert.ok(html.includes('How these funds are taxed'));
assert.ok(html.includes('Best: Taxable'));

// Watchlist column.
assert.ok(COLUMN_KEYS.has('tax'));
assert.deepEqual(cleanColumns(['name', 'tax']), ['name', 'tax']);
assert.equal(statsFrom({ quoteType: 'ETF' }).etf, true);
assert.equal(statsFrom({ quoteType: 'EQUITY' }).etf, false);

console.log('etftax: all tests passed');
