// Offline test for the Cloudflare cron wiring: the events cron in wrangler.toml
// matches the code, and a scheduled run for it refreshes only the events
// calendar. Run: node test/cron.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[.*\])/m)[1]);
const { default: worker, EVENTS_CRON } = await import('../src/index.js');
assert.ok(crons.includes(EVENTS_CRON), 'events cron is listed in wrangler.toml');
assert.ok(crons.length <= 5, 'Workers Free allows 5 crons per account');

const kv = new Map();
const env = {
  CACHE: { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => kv.set(k, v) },
  DB: null,
};
let fetches = 0;
globalThis.fetch = async () => {
  fetches++;
  return new Response('{}', { status: 503 });
};
const waits = [];
await worker.scheduled({ cron: EVENTS_CRON }, env, { waitUntil: (p) => waits.push(p) });
await Promise.all(waits);
const log = JSON.parse(kv.get('job:events'));
assert.ok(log.events > 0, 'calendar built from official and rule dates even when feeds fail');
assert.ok(log.feeds && log.feeds.econ, 'feed status logged');
assert.ok(fetches <= 45, `stays under the free plan's 50 subrequests (${fetches})`);
assert.ok(!kv.has('job:form4'), 'events cron does not run the Form 4 ingest');
console.log(`cron ok: ${log.events} events, ${fetches} fetches`);
