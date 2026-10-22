import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createCollector, DomainBlockedError, FetchError, injuryPdfName } from '../engine/collect.js';
import { SchemaError } from '../engine/schema/espn.js';
import { etParts } from '../engine/time.js';

const fx = name => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url))));
const json = (body, status = 200) => ({ ok: status < 400, status, headers: new Map([['content-type', 'application/json']]), json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(0) });
const html = (body, status) => ({ ok: false, status, headers: new Map([['content-type', 'text/html']]), text: async () => body, json: async () => { throw new Error('html'); } });
const xml = status => ({ ok: false, status, headers: new Map([['content-type', 'application/xml']]), text: async () => '<Error><Code>AccessDenied</Code></Error>' });
const pdf = () => ({ ok: true, status: 200, headers: new Map([['content-type', 'application/pdf']]), arrayBuffer: async () => new Uint8Array([37, 80, 68, 70]).buffer });

function memCache() {
  const m = new Map();
  return { m, get: async k => m.get(k), set: async (k, v) => { m.set(k, v); } };
}
function harness(responder) {
  const calls = [], sleeps = [];
  let now = 0;
  const c = createCollector({
    fetch: async url => { calls.push(url); return responder(url, calls.length); },
    cache: memCache(),
    sleep: async ms => { sleeps.push(ms); now += ms; },
    now: () => now,
  });
  return { c, calls, sleeps };
}

test('schedule: validated and parsed', async () => {
  const { c, calls } = harness(() => json(fx('scoreboard_20261021.json.gz')));
  const sb = await c.schedule('20261021');
  assert.equal(sb.events.length, 11);
  assert.match(calls[0], /scoreboard\?dates=20261021$/);
});

test('schema drift raises SchemaError instead of returning data', async () => {
  const bad = fx('scoreboard_20261021.json.gz');
  delete bad.events[0].season;
  const { c } = harness(() => json(bad));
  await assert.rejects(c.schedule('20261021'), SchemaError);
});

test('final game summaries are cached; second call does not hit the network', async () => {
  const { c, calls } = harness(() => json(fx('summary_401909834.json.gz')));
  await c.game('401909834');
  await c.game('401909834');
  assert.equal(calls.length, 1);
});

test('rate limit: at most 2 requests per second', async () => {
  const { c, sleeps } = harness(() => json(fx('injuries_20261022.json.gz')));
  await c.injuries(); await c.injuries(); await c.injuries();
  assert.ok(sleeps.reduce((a, b) => a + b, 0) >= 1000, `slept ${sleeps}`);
});

test('5xx is retried with backoff, then succeeds', async () => {
  const { c, calls } = harness((url, n) => (n < 3 ? json({}, 503) : json(fx('injuries_20261022.json.gz'))));
  const d = await c.injuries();
  assert.equal(calls.length, 3);
  assert.ok(d.injuries.length > 0);
});

test('5xx gives up after 3 retries with FetchError', async () => {
  const { c, calls } = harness(() => json({}, 502));
  await assert.rejects(c.injuries(), FetchError);
  assert.equal(calls.length, 4);
});

test('Akamai "Access Denied" is a blocked domain: no retry, names the host', async () => {
  const { c, calls } = harness(() => html('<TITLE>Access Denied</TITLE>', 403));
  await assert.rejects(c.injuries(), err => err instanceof DomainBlockedError && err.host === 'site.api.espn.com');
  assert.equal(calls.length, 1);
});

test('injury PDF names: 15-minute format from 2025-12-22, hourly before', () => {
  assert.equal(injuryPdfName({ date: '2025-12-21', hour: 18, minute: 0 }), 'Injury-Report_2025-12-21_06PM.pdf');
  assert.equal(injuryPdfName({ date: '2025-12-22', hour: 18, minute: 0 }), 'Injury-Report_2025-12-22_06_00PM.pdf');
  assert.equal(injuryPdfName({ date: '2026-10-21', hour: 17, minute: 15 }), 'Injury-Report_2026-10-21_05_15PM.pdf');
  assert.equal(injuryPdfName({ date: '2026-10-22', hour: 0, minute: 0 }), 'Injury-Report_2026-10-22_12_00AM.pdf');
  assert.equal(injuryPdfName({ date: '2026-10-21', hour: 12, minute: 30 }), 'Injury-Report_2026-10-21_12_30PM.pdf');
  assert.equal(injuryPdfName({ date: '2025-04-01', hour: 17, minute: 0 }), 'Injury-Report_2025-04-01_05PM.pdf');
});

test('ET conversion follows US daylight saving (ends 2026-11-01)', () => {
  // 19:30 ET tip-off: EDT on Oct 31 (UTC-4), EST on Nov 2 (UTC-5)
  assert.deepEqual(etParts(new Date('2026-10-31T23:30:00Z')), { date: '2026-10-31', hour: 19, minute: 30 });
  assert.deepEqual(etParts(new Date('2026-11-03T00:30:00Z')), { date: '2026-11-02', hour: 19, minute: 30 });
});

test('latest injury PDF: walks back in 15-minute steps (ET) to the newest published file', async () => {
  // 2026-10-22 07:12 UTC = 03:12 EDT -> try 03:00 (missing) then 02:45 (exists)
  const { c, calls } = harness(url => (/_02_45AM\.pdf$/.test(url) ? pdf() : xml(403)));
  const r = await c.latestInjuryPdf(new Date('2026-10-22T07:12:00Z'));
  assert.equal(r.name, 'Injury-Report_2026-10-22_02_45AM.pdf');
  assert.ok(r.bytes.byteLength > 0);
  assert.equal(calls.length, 2);
});

test('latest injury PDF: gives up with null after the search window', async () => {
  const { c } = harness(() => xml(403));
  assert.equal(await c.latestInjuryPdf(new Date('2026-10-22T07:12:00Z'), { maxSteps: 4 }), null);
});
