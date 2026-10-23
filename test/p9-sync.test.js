// P9 pick-log writes from the daily job and the daily git copy (2026-10-23 P9 approvals 6, 8, 10), fake database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './helpers/fake-db.js';
import { canon, sameHash, jobBodies, syncStep, syncAsJob, artifactBatch, copyText, copyCheck, anchorOf } from '../engine/log-sync.js';
import { chainRecords, readChain, jobStore, HEAD_PATH, blockId } from '../engine/log-store.js';
import { chainAppend } from '../engine/pick-log.js';
import { anchorCheck } from '../engine/dashboard-data.js';
import { stamp } from '../engine/clock.js';
import { IDENTITY } from '../engine/calibrate.js';

const clock = (t0 = Date.parse('2026-11-02T21:50:00Z')) => { let t = t0; return { now: () => t, set: v => { t = v; }, add: ms => { t += ms; } }; };
const odds = (betmanNo, gameId, o, at, deadline) => {
  const inv = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, 1 / v])), s = Object.values(inv).reduce((a, b) => a + b, 0);
  return { type: 'odds', round: 3, betmanNo, gameId, market: 'ML', line: null, odds: o, capturedAt: stamp(at), deadline: stamp(deadline), implied: inv, overround: s, noVig: Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v / s])), home: 'BOS', away: 'NY' };
};
const norm = (lo, n, c) => { const w = Array.from({ length: n }, (_, i) => Math.exp(-0.5 * ((lo + i - c) / 12) ** 2)), s = w.reduce((a, b) => a + b, 0); return { lo, p: w.map(x => x / s) }; };
const day = (final = true) => ({ kind: 'live', games: [{ gameId: 'g1', start: stamp('2026-11-03T02:00:00Z'), group: 'B', home: { espn: 'BOS' }, away: { espn: 'NY' },
  prediction: { source: 'base', runId: 'B-1', run: 'B', final, sim: { margin: 9, total: 220, marginHist: norm(-60, 121, 9), totalHist: norm(150, 151, 220), shift: 0 } } }] });
// a database holding the chain `recs` as one block written by the dashboard
function seeded(recs, c) {
  const db = fakeDb({ now: c.now });
  if (recs.length) {
    db.docs.set(`blocks/${blockId(0)}`, { data: { firstSeq: 0, lastSeq: recs.at(-1).seq, count: recs.length, writer: 'page', writtenAt: stamp(c.now()), records: recs }, version: 1 });
    db.docs.set(HEAD_PATH, { data: { blocks: 1, lastSeq: recs.at(-1).seq, lastHash: recs.at(-1).hash, leaseHolder: null, leaseUntil: null }, version: 3 });
  }
  return db;
}
const build = (opts = {}) => (chain, now) => jobBodies({ chain, day: day(), cal: IDENTITY, now: new Date(now), ...opts });

test('canonical JSON here is the one the chain hashes', () => {
  let prev = null;
  for (const body of [{ type: 'odds', b: 2, a: { z: [1, { y: null, x: 'k' }], w: undefined } }, { type: 'pick', ko: '보스턴', n: 1.5e-7 }]) {
    prev = chainAppend(prev, body);
    assert.equal(sameHash(prev), true);
  }
  assert.equal(canon({ b: 1, a: [2, { d: 1, c: 2 }] }), '{"a":[2,{"c":2,"d":1}],"b":1}');
});

test('pending odds of a game with its final prediction are evaluated once by the job; nothing to do afterwards', async () => {
  const c = clock();
  const db = seeded(chainRecords(null, [odds(1, 'g1', { home: 1.6, away: 2.4 }, '2026-11-02T20:00:00Z', '2026-11-03T02:00:00Z')]), c);
  const r = await syncAsJob(db, build(), { now: c.now, sleep: async ms => c.add(ms) });
  assert.equal(r.ok, true);
  const chain = (await readChain(jobStore(db))).records;
  assert.equal(chain.filter(x => x.type === 'evaluation').length, 2);
  assert.ok(chain.filter(x => x.type === 'pick').length >= 1);
  const again = await syncAsJob(db, build(), { now: c.now });
  assert.equal(again.ok, true);
  assert.equal(again.attempts, 0);
});

test('a version conflict is retried with records rebuilt at the retry time: past its deadline, the evaluation is not written late and the market is recorded as unevaluated', async () => {
  const c = clock(Date.parse('2026-11-03T01:59:00Z'));
  const db = seeded(chainRecords(null, [odds(1, 'g1', { home: 1.6, away: 2.4 }, '2026-11-02T20:00:00Z', '2026-11-03T02:00:00Z')]), c);
  let first = true;
  db.hooks.push(async op => {
    if (op !== 'batch' || !first) return;
    first = false;
    const h = db.docs.get(HEAD_PATH); db.docs.set(HEAD_PATH, { ...h, version: h.version + 1 }); // another writer touched the head
    c.add(2 * 60e3); // the retry happens after the deadline
  });
  const finals = new Map([['g1', { at: '2026-11-03T01:51:00Z', runId: 'B-1' }]]);
  const r = await syncAsJob(db, build({ finals }), { now: c.now, sleep: async ms => c.add(ms) });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  const chain = (await readChain(jobStore(db))).records;
  assert.equal(chain.filter(x => x.type === 'evaluation' || x.type === 'pick').length, 0, 'no late evaluation');
  const un = chain.filter(x => x.type === 'unevaluated');
  assert.equal(un.length, 1);
  assert.equal(un[0].reason, 'not written before deadline');
  assert.equal((await readChain(jobStore(db))).verify.ok, true);
});

test('an active dashboard lease makes the job wait; past the wait limit it reports busy and writes nothing', async () => {
  const c = clock();
  const recs = chainRecords(null, [odds(1, 'g1', { home: 1.6, away: 2.4 }, '2026-11-02T20:00:00Z', '2026-11-03T02:00:00Z')]);
  const db = seeded(recs, c);
  const h = db.docs.get(HEAD_PATH);
  db.docs.set(HEAD_PATH, { ...h, data: { ...h.data, leaseHolder: 'page-x', leaseUntil: new Date(c.now() + 20000).toISOString() } });
  const ok = await syncAsJob(db, build(), { now: c.now, sleep: async ms => c.add(ms) });
  assert.equal(ok.ok, true);
  assert.ok(ok.waitedMs >= 20000);
  const db2 = seeded(recs, c);
  const h2 = db2.docs.get(HEAD_PATH);
  db2.docs.set(HEAD_PATH, { ...h2, data: { ...h2.data, leaseHolder: 'page-x', leaseUntil: new Date(c.now() + 600000).toISOString() } });
  const busy = await syncAsJob(db2, build(), { now: c.now, sleep: async ms => c.add(ms), maxWaitMs: 90000 });
  assert.equal(busy.ok, false);
  assert.equal(busy.reason, 'busy');
  assert.equal((await readChain(jobStore(db2))).records.length, 1);
});

test('a changed stored record stops the job before any write', async () => {
  const c = clock();
  const db = seeded(chainRecords(null, [odds(1, 'g1', { home: 1.6, away: 2.4 }, '2026-11-02T20:00:00Z', '2026-11-03T02:00:00Z')]), c);
  db.docs.get('blocks/b000000').data.records[0].odds.home = 9.9;
  const r = await syncAsJob(db, build(), { now: c.now });
  assert.deepEqual([r.ok, r.reason, r.attempts], [false, 'chain check failed', 0]);
});

test('results are added once for games in the log; the head version must be known', async () => {
  const c = clock();
  const recs = chainRecords(null, [odds(1, 'g1', { home: 1.6, away: 2.4 }, '2026-11-02T20:00:00Z', '2026-11-03T02:00:00Z')]);
  const results = new Map([['g1', { margin: 4, total: 221 }], ['g9', { margin: 1, total: 200 }]]);
  const b = jobBodies({ chain: recs, results, now: new Date('2026-11-03T22:00:00Z') });
  assert.deepEqual(b.bodies.filter(x => x.type === 'result').map(x => [x.gameId, x.margin, x.total]), [['g1', 4, 221]]);
  const withResult = chainRecords(null, [...recs.map(({ seq, prevHash, hash, ...x }) => x), ...b.bodies]);
  assert.equal(jobBodies({ chain: withResult, results, now: new Date('2026-11-04T22:00:00Z') }).bodies.filter(x => x.type === 'result').length, 0);
  const st = await syncStep({ head: { blocks: 1, lastSeq: 0, lastHash: recs[0].hash }, headVersion: null, blocks: [{ id: 'b000000', data: { firstSeq: 0, lastSeq: 0, records: recs } }], build: () => ({ bodies: [] }), now: c.now() });
  assert.deepEqual([st.action, st.reason], ['stop', 'head version unknown']);
});

test('ArtifactData batch entries point at files and pin existing documents', () => {
  const e = artifactBatch([{ op: 'set', path: 'blocks/b000001', data: {} }, { op: 'update', path: 'meta/head', data: {}, ifVersion: 7 }], p => `/tmp/x/${p}.json`);
  assert.deepEqual(e, [
    { op: 'set', collection: 'blocks', doc_id: 'b000001', file_path: '/tmp/x/blocks/b000001.json' },
    { op: 'update', collection: 'meta', doc_id: 'head', file_path: '/tmp/x/meta/head.json', if_version: 7 },
  ]);
});

test('git copy: committed only when the chain verifies and the committed copy is its exact prefix', () => {
  const recs = chainRecords(null, [{ type: 'odds', a: 1 }, { type: 'odds', a: 2 }, { type: 'odds', a: 3 }]);
  const prev = copyText(recs.slice(0, 2));
  const ok = copyCheck(prev, recs);
  assert.deepEqual([ok.ok, ok.added], [true, 1]);
  assert.equal(copyCheck('', []).ok, true, 'empty chain');
  const reordered = recs.map(r => Object.fromEntries(Object.entries(r).reverse())); // a database may reorder keys
  assert.equal(copyCheck(prev, reordered).ok, true);
  const changed = chainRecords(null, [{ type: 'odds', a: 1 }, { type: 'odds', a: 9 }, { type: 'odds', a: 3 }]);
  assert.match(copyCheck(prev, changed).reason, /committed record 1 differs/);
  assert.match(copyCheck(prev, recs.slice(0, 1)).reason, /longer than the database chain/);
  const broken = structuredClone(recs); broken[1].a = 5;
  assert.match(copyCheck(prev, broken).reason, /chain check failed at seq 1/);
});

test('anchor: an empty committed chain reads as matching with 0 records', () => {
  assert.deepEqual(anchorOf([], 'abc1234def'), { count: 0, seq: null, hash: null, commit: 'abc1234def' });
  assert.equal(anchorCheck([], anchorOf([], 'abc1234def')).status, 'match');
  assert.match(anchorCheck([], anchorOf([], 'abc1234def')).text, /레코드 0개/);
  const recs = chainRecords(null, [{ type: 'odds', a: 1 }]);
  assert.equal(anchorCheck(recs, anchorOf([], 'abc1234')).status, 'match', 'records added after the commit');
  assert.equal(anchorCheck(recs, anchorOf(recs, 'abc1234')).status, 'match');
  assert.equal(anchorCheck(recs, { ...anchorOf(recs, 'abc1234'), hash: 'x' }).status, 'mismatch');
});
