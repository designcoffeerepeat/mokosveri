// Offline test for the Cloudflare cron wiring: the events cron in wrangler.toml
// matches the code, and a scheduled run for it refreshes only the events
// calendar. Run: node test/cron.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const toml = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
const crons = JSON.parse(toml.match(/^crons\s*=\s*(\[.*\])/m)[1]);
const { default: worker, EVENTS_CRON, nyHour } = await import('../src/index.js');
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
// Daylight time (EDT, UTC-4): 10:05 UTC is 6:05 AM, 11:05 UTC is 7:05 AM.
assert.equal(nyHour(Date.parse('2026-06-15T10:05:00Z')), 6);
assert.equal(nyHour(Date.parse('2026-06-15T22:05:00Z')), 18);
// Standard time (EST, UTC-5): 11:05 UTC is 6:05 AM, 23:05 UTC is 6:05 PM.
assert.equal(nyHour(Date.parse('2026-11-23T11:05:00Z')), 6);
assert.equal(nyHour(Date.parse('2026-11-23T23:05:00Z')), 18);
// Each UTC hour in the cron lands on 6, 12 or 18 in New York in one season.
const utcHours = EVENTS_CRON.split(' ')[1].split(',').map(Number);
for (const iso of ['2026-06-15', '2026-11-23']) {
  const hits = utcHours.map((h) => nyHour(Date.parse(`${iso}T${String(h).padStart(2, '0')}:05:00Z`))).filter((h) => [6, 12, 18].includes(h));
  assert.deepEqual(hits, [6, 12, 18], `three runs a day on ${iso}`);
}

// The off hour does nothing.
await worker.scheduled({ cron: EVENTS_CRON, scheduledTime: Date.parse('2026-11-23T10:05:00Z') }, env, { waitUntil: (p) => waits.push(p) });
await Promise.all(waits);
assert.equal(fetches, 0, 'off hour skips the refresh');
assert.ok(!kv.has('job:events'));

await worker.scheduled({ cron: EVENTS_CRON, scheduledTime: Date.parse('2026-11-23T11:05:00Z') }, env, { waitUntil: (p) => waits.push(p) });
await Promise.all(waits);
const log = JSON.parse(kv.get('job:events'));
assert.ok(log.events > 0, 'calendar built from official and rule dates even when feeds fail');
assert.ok(log.feeds && log.feeds.econ, 'feed status logged');
assert.ok(fetches <= 45, `stays under the free plan's 50 subrequests (${fetches})`);
assert.ok(!kv.has('job:form4'), 'events cron does not run the Form 4 ingest');
console.log(`cron ok: ${log.events} events, ${fetches} fetches`);
