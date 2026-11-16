// ESPN "Suspension" (2026-11-13 user decision 8): for the ESPN+PDF parallel record only, a new file maps
// "Suspension" to "Out" when ESPN itself marks the player out (details.fantasyStatus OUT). The mapping is logged;
// any other new value is not mapped and only reported. engine/schema/espn.js (frozen) is not touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { mapEspnStatuses, espnInjuriesMapped } from '../jobs/lib/espn-status-map.js';
import { checkInjuries, SchemaError, assertValid } from '../engine/schema/espn.js';

const base = JSON.parse(gunzipSync(readFileSync('data/injury-pdf/2026-27/espn-feed/2026-11-12-C-0752.json.gz')));
const withStatus = (status, fantasy = 'OUT') => {
  const d = structuredClone(base);
  const x = d.injuries[1].injuries[0];
  x.status = status;
  x.details = { ...(x.details ?? {}), fantasyStatus: fantasy ? { description: fantasy, abbreviation: fantasy } : undefined, type: status };
  return { d, team: d.injuries[1].displayName, player: x.athlete.displayName };
};

test('Suspension with ESPN fantasy OUT maps to Out and is logged; the original document is left as received', () => {
  const { d, team, player } = withStatus('Suspension');
  const before = JSON.stringify(d);
  const m = mapEspnStatuses(d);
  assert.equal(JSON.stringify(d), before, 'input not mutated');
  assert.deepEqual(m.map, [{ team, player, from: 'Suspension', to: 'Out', why: 'ESPN fantasyStatus OUT' }]);
  assert.deepEqual(m.unmapped, []);
  assert.deepEqual(checkInjuries(m.doc), [], 'the mapped copy passes the frozen schema check');
  assert.throws(() => assertValid('injuries', d), SchemaError, 'the received document still fails it');
});

test('not mapped: Suspension without fantasy OUT, and any other new value (reported only)', () => {
  const a = mapEspnStatuses(withStatus('Suspension', null).d);
  assert.deepEqual(a.map, []);
  assert.equal(a.unmapped[0].status, 'Suspension');
  const b = mapEspnStatuses(withStatus('Questionable').d);
  assert.deepEqual(b.map, []);
  assert.equal(b.unmapped[0].status, 'Questionable');
  assert.notDeepEqual(checkInjuries(b.doc), []);
  const c = mapEspnStatuses(structuredClone(base));
  assert.deepEqual([c.map, c.unmapped], [[], []]);
});

const failing = doc => ({ injuries: async () => assertValid('injuries', doc) });

test('collection: a valid feed is used as is; a Suspension feed is fetched raw, mapped, validated and parsed', async () => {
  const ok = await espnInjuriesMapped(failing(structuredClone(base)), async () => { throw new Error('not called'); });
  assert.equal(ok.espnError, null);
  assert.ok(ok.espn.length > 0);
  assert.equal(ok.espnStatusMap, undefined);
  const { d, player } = withStatus('Suspension');
  const r = await espnInjuriesMapped(failing(d), async () => structuredClone(d));
  assert.equal(r.espnError, null);
  assert.equal(r.espn.find(x => x.name === player).status, 'Out');
  assert.equal(r.espnStatusMap.length, 1);
  assert.equal(r.espnRaw.injuries[1].injuries[0].status, 'Suspension', 'the saved feed is the original');
});

test('collection: an unmapped new value leaves the parallel record out, with the reason', async () => {
  const { d } = withStatus('Questionable');
  const r = await espnInjuriesMapped(failing(d), async () => structuredClone(d));
  assert.equal(r.espn, null);
  assert.match(r.espnError, /unexpected value "Questionable"/);
  assert.equal(r.espnUnmapped[0].status, 'Questionable');
  const net = await espnInjuriesMapped({ injuries: async () => { throw new Error('HTTP 500 after 3 retries'); } }, async () => { throw new Error('no'); });
  assert.equal(net.espn, null);
  assert.match(net.espnError, /HTTP 500/);
});
