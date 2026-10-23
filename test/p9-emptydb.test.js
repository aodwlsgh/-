// P9 empty database (2026-10-23 runs A-0538 and B-0537 stopped at "head version unknown": jobs/lib/db-files.js let
// readChain's default head overwrite the missing head, so the first head could never be created). The empty database
// is the starting state of the real pick log; the first write must work from it on both writers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readDir } from '../jobs/lib/db-files.js';
import { syncStep, syncAsJob, artifactBatch } from '../engine/log-sync.js';
import { pageStore, jobStore, readChain, appendAsPage, chainRecords, HEAD_PATH } from '../engine/log-store.js';
import { fakeDb } from './helpers/fake-db.js';

const tmp = () => mkdtemp(join(tmpdir(), 'p9-empty-'));
const body = (n, by) => Array.from({ length: n }, (_, i) => ({ type: 'odds', by, i }));

test('an empty read (no head file, no blocks) is an empty chain with no head and no version', async () => {
  const d = await tmp();
  const db = await readDir(d);
  assert.equal(db.head, null);
  assert.equal(db.headVersion, null);
  assert.deepEqual(db.records, []);
  assert.equal(db.verify.ok, true);
  await rm(d, { recursive: true });
});

test('a saved head file holds the document only (as ArtifactData out_dir saves it); its version comes from the read result', async () => {
  const d = await tmp();
  const recs = chainRecords(null, body(1, 'j'));
  await mkdir(join(d, 'meta'), { recursive: true });
  await mkdir(join(d, 'blocks'), { recursive: true });
  await writeFile(join(d, 'meta', 'head.json'), JSON.stringify({ blocks: 1, lastSeq: 0, lastHash: recs[0].hash, leaseHolder: null, leaseUntil: null }, null, 2));
  await writeFile(join(d, 'blocks', 'b000000.json'), JSON.stringify({ firstSeq: 0, lastSeq: 0, count: 1, writer: 'job', records: recs }, null, 2));
  const db = await readDir(d, { headVersion: 3 });
  assert.equal(db.head.blocks, 1);
  assert.equal(db.headVersion, 3);
  assert.equal(db.records.length, 1);
  assert.equal(db.verify.ok, true);
  await rm(d, { recursive: true });
});

test('first write from an empty read: the job creates block b000000 and the head, neither pinned (creation)', async () => {
  const d = await tmp();
  const db = await readDir(d);
  const none = await syncStep({ head: db.head, headVersion: db.headVersion, blocks: db.blocks, build: () => ({ bodies: [] }), now: Date.now() });
  assert.equal(none.action, 'none', 'nothing due on an empty chain: no write at all');
  const st = await syncStep({ head: db.head, headVersion: db.headVersion, blocks: db.blocks, build: () => ({ bodies: body(2, 'j') }), now: Date.now() });
  assert.equal(st.action, 'commit');
  const e = artifactBatch(st.writes, p => `/x/${p}.json`);
  assert.deepEqual(e.map(x => [x.op, x.collection, x.doc_id, 'if_version' in x]), [['set', 'blocks', 'b000000', false], ['set', 'meta', 'head', false]]);
  assert.equal(st.records[0].seq, 0);
  assert.equal(st.records[0].prevHash, null);
  await rm(d, { recursive: true });
});

test('picklog plan on an empty read exits 0 with action "none", also without a day file', async () => {
  const d = await tmp();
  const r = spawnSync(process.execPath, ['jobs/picklog.js', 'plan', '--dir', d, '--day', join(d, 'no-day.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(await readFile(join(d, 'plan.json'), 'utf8'));
  assert.equal(plan.action, 'none');
  assert.deepEqual(plan.chain, { count: 0, ok: true });
  await rm(d, { recursive: true });
});

// dashboard first write (fake database with the documented semantics: acquire on a missing document is allowed and
// does not create it, set creates, update needs the document)
test('dashboard first write on an empty database: the lease does not create the head, the write creates it, the chain verifies', async () => {
  const db = fakeDb();
  const lease = await db.doc(HEAD_PATH).acquire({ holder: 't', ttlMs: 30000 });
  assert.equal(lease.acquired, true);
  assert.equal((await db.doc(HEAD_PATH).get()).exists, false, 'acquire alone creates nothing');
  const r = await appendAsPage(pageStore(db), body(3, 'p'), { holder: 't' });
  assert.equal(r.ok, true);
  const head = (await db.doc(HEAD_PATH).get()).data();
  assert.deepEqual([head.blocks, head.lastSeq, head.leaseHolder, head.leaseUntil], [1, 2, null, null]);
  const c = await readChain(pageStore(db));
  assert.equal(c.verify.ok, true);
  assert.equal(c.records[0].prevHash, null);
});

test('either writer can make the first write and the other one continues the same chain', async () => {
  for (const first of ['job', 'page']) {
    const db = fakeDb();
    // like jobBodies: what is due is derived from the stored chain, so a second pass finds nothing to add
    const job = () => syncAsJob(db, chain => ({ bodies: chain.some(r => r.by === `j-${first}`) ? [] : body(1, `j-${first}`) }), { maxAttempts: 2 });
    const page = () => appendAsPage(pageStore(db), body(2, `p-${first}`), { holder: 'tab' });
    if (first === 'job') { assert.equal((await job()).ok, true); assert.equal((await page()).ok, true); } else { assert.equal((await page()).ok, true); }
    const c = await readChain(jobStore(db));
    assert.equal(c.verify.ok, true, first);
    assert.equal(c.records.length, first === 'job' ? 3 : 2);
  }
});
