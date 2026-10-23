import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeDb } from './helpers/fake-db.js';
import {
  pageStore, jobStore, readChain, appendAsPage, appendAsJob, chainRecords, splitBlocks, blockDoc, blockId, byteSize,
  HEAD_PATH, LEASE_MS,
} from '../engine/log-store.js';
import { roundRecords, evaluationRecords, pendingOdds, pickId } from '../engine/log-records.js';
import {
  TEXT, forbiddenIn, exitView, chainText, anchorCheck, validateDay, gameView, scenarioView, comboProgress, EXAMPLE_SEASON,
} from '../engine/dashboard-data.js';
import { verifyChain, chainAppend, summarize, pickRecord, resultRecord } from '../engine/pick-log.js';
import { marketProbs } from '../engine/markets.js';
import { markets, IDENTITY } from '../engine/calibrate.js';
import { normCdf } from '../engine/predict.js';

// ---------------------------------------------------------------- storage (artifact DB) ----------------------------
const T0 = Date.parse('2026-11-05T05:00:00Z');
function clock(t0 = T0) { let t = t0; return { now: () => t, advance: ms => { t += ms; }, sleep: async ms => { t += ms; } }; }
const bodies = (n, tag = 'x') => Array.from({ length: n }, (_, i) => ({ type: 'note', tag, i }));
const setup = () => { const c = clock(); const db = fakeDb({ now: c.now }); return { c, db, page: pageStore(db), job: jobStore(db) }; };
const pageOpts = (c, holder = 'tab-1') => ({ holder, now: c.now });
const jobOpts = c => ({ now: c.now, sleep: c.sleep });

test('an empty chain is valid with zero records and reads "정상(레코드 0개)"', async () => {
  const { page } = setup();
  const s = await readChain(page);
  assert.equal(s.records.length, 0);
  assert.equal(s.verify.ok, true);
  assert.equal(chainText(s).text, '정상(레코드 0개)');
});

test('first record is seq 0 with prevHash null (design §12); later appends continue the chain', async () => {
  const { c, page, job } = setup();
  assert.equal((await appendAsPage(page, bodies(2, 'p'), pageOpts(c))).ok, true);
  assert.equal((await appendAsJob(job, bodies(3, 'j'), jobOpts(c))).ok, true);
  assert.equal((await appendAsPage(page, bodies(1, 'p2'), pageOpts(c))).ok, true);
  const s = await readChain(page);
  assert.equal(s.records[0].seq, 0);
  assert.equal(s.records[0].prevHash, null);
  assert.deepEqual(s.records.map(r => r.tag), ['p', 'p', 'j', 'j', 'j', 'p2']);
  assert.equal(s.verify.ok, true);
  assert.deepEqual(verifyChain(s.records), { ok: true, brokenAt: null });
  assert.equal(s.head.blocks, 3);
  assert.equal(s.head.leaseUntil, null);
  assert.equal(s.orphans.length, 0);
});

test('the job waits for an active dashboard lease and ignores it once expired', async () => {
  const { c, db, page, job } = setup();
  await appendAsPage(page, bodies(1, 'p'), pageOpts(c));
  // a dashboard tab takes the lease and stops (closed mid-write): the lease fields stay on the head
  const lease = await db.doc(HEAD_PATH).acquire({ holder: 'tab-crashed', ttlMs: LEASE_MS });
  await page.writeHead({ leaseHolder: 'tab-crashed', leaseUntil: lease.expiresAt });
  let committedAt = null;
  db.hooks.push(async op => { if (op === 'batch') committedAt = c.now(); });
  const r = await appendAsJob(job, bodies(1, 'j'), jobOpts(c));
  assert.equal(r.ok, true);
  assert.ok(committedAt >= Date.parse(lease.expiresAt), 'no job write before the lease expired');
  assert.ok(r.waitedMs >= LEASE_MS - 1);
  const s = await readChain(page);
  assert.deepEqual(s.records.map(r => r.tag), ['p', 'j']);
  assert.equal(s.verify.ok, true);
});

test('version conflict: the job re-reads and retries, nothing is overwritten', async () => {
  const { c, db, page, job } = setup();
  await appendAsJob(job, bodies(1, 'j0'), jobOpts(c));
  let fired = false;
  db.hooks.push(async op => {
    if (op === 'batch' && !fired) { fired = true; assert.equal((await appendAsPage(page, bodies(2, 'p'), pageOpts(c))).ok, true); }
  });
  const r = await appendAsJob(job, bodies(1, 'j1'), jobOpts(c));
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 2);
  const s = await readChain(page);
  assert.deepEqual(s.records.map(x => x.tag), ['j0', 'p', 'p', 'j1']);
  assert.equal(s.verify.ok, true);
});

test('the job gives up after its retries without writing anything', async () => {
  const { c, db, page, job } = setup();
  await appendAsJob(job, bodies(1, 'j0'), jobOpts(c));
  const before = JSON.stringify([...db.docs.entries()].filter(([k]) => k.startsWith('blocks/')));
  let n = 0;
  db.hooks.push(async op => { if (op === 'batch') await db.doc(HEAD_PATH).update({ touched: ++n }); });
  const r = await appendAsJob(job, bodies(1, 'j1'), { ...jobOpts(c), maxAttempts: 4 });
  assert.deepEqual([r.ok, r.reason, r.attempts], [false, 'retries exhausted', 4]);
  assert.equal(JSON.stringify([...db.docs.entries()].filter(([k]) => k.startsWith('blocks/'))), before);
  assert.equal((await readChain(page)).records.length, 1);
});

test('a block that does not continue the chain is never overwritten; both writers stop', async () => {
  const { c, db, page, job } = setup();
  await appendAsPage(page, bodies(1, 'p'), pageOpts(c));
  await db.doc(`blocks/${blockId(1)}`).set({ junk: true });
  const j = await appendAsJob(job, bodies(1, 'j'), jobOpts(c));
  const p = await appendAsPage(page, bodies(1, 'p2'), pageOpts(c)); // same tab: its own lease is still live
  assert.deepEqual([j.ok, j.reason], [false, 'conflict']);
  assert.deepEqual([p.ok, p.reason], [false, 'conflict']);
  assert.deepEqual(db.read(`blocks/${blockId(1)}`).data, { junk: true });
  const s = await readChain(page);
  assert.deepEqual(s.orphans, [blockId(1)]);
  assert.equal(s.head.leaseUntil, null, 'the dashboard clears its lease when it stops');
});

test('a block left by a writer that stopped before updating the head is adopted when it continues the chain', async () => {
  const { c, db, page, job } = setup();
  await appendAsPage(page, bodies(2, 'p'), pageOpts(c));
  const s0 = await readChain(page);
  const left = chainRecords({ seq: s0.head.lastSeq, hash: s0.head.lastHash }, bodies(2, 'left'));
  await db.doc(`blocks/${blockId(1)}`).set(blockDoc(left, 'page', c.now()));
  const r = await appendAsJob(job, bodies(1, 'j'), jobOpts(c));
  assert.equal(r.ok, true);
  assert.equal(r.adopted, 1);
  const s = await readChain(page);
  assert.deepEqual(s.records.map(x => x.tag), ['p', 'p', 'left', 'left', 'j']);
  assert.equal(s.verify.ok, true);
});

test('a second dashboard tab cannot write while the first holds the lease', async () => {
  const { c, db, page } = setup();
  await db.doc(HEAD_PATH).acquire({ holder: 'tab-1', ttlMs: LEASE_MS });
  const r = await appendAsPage(page, bodies(1), pageOpts(c, 'tab-2'));
  assert.deepEqual([r.ok, r.reason], [false, 'busy']);
});

test('the dashboard stops before a write its lease would not cover; the job then proceeds after expiry', async () => {
  const { c, db, page, job } = setup();
  await appendAsPage(page, bodies(1, 'p'), pageOpts(c));
  let slowed = false;
  db.hooks.push(async (op, path) => { if (op === 'get' && path === `blocks/${blockId(1)}` && !slowed) { slowed = true; c.advance(LEASE_MS); } });
  const r = await appendAsPage(page, bodies(1, 'late'), pageOpts(c));
  assert.deepEqual([r.ok, r.reason], [false, 'lease expired']);
  assert.equal(db.read(`blocks/${blockId(1)}`).exists, false);
  db.hooks.length = 0;
  assert.equal((await appendAsJob(job, bodies(1, 'j'), jobOpts(c))).ok, true);
  const s = await readChain(page);
  assert.deepEqual(s.records.map(x => x.tag), ['p', 'j']);
  assert.equal(s.verify.ok, true);
});

test('changed or deleted records are detected', async () => {
  const { c, db, page } = setup();
  for (let i = 0; i < 3; i++) await appendAsPage(page, bodies(2, `b${i}`), pageOpts(c));
  const path = `blocks/${blockId(1)}`, d = db.docs.get(path);
  d.data.records[1].i = 99; // edit seq 3 in place
  let s = await readChain(page);
  assert.deepEqual([s.verify.ok, s.verify.brokenAt], [false, 3]);
  assert.match(chainText(s).text, /검증 실패 — seq 3/);
  d.data.records[1].i = 1;
  assert.equal((await readChain(page)).verify.ok, true);
  db.docs.delete(path);
  s = await readChain(page);
  assert.equal(s.verify.ok, false);
  assert.ok(s.verify.problems.some(p => /missing block b000001/.test(p)));
});

test('large appends are split into blocks under the size limit, in order', async () => {
  const { c, page, job } = setup();
  const many = Array.from({ length: 120 }, (_, i) => ({ type: 'note', i, pad: '가'.repeat(60) }));
  const limit = 4096;
  const parts = splitBlocks(chainRecords(null, many), limit);
  assert.ok(parts.length > 3);
  assert.ok(parts.every(p => byteSize(blockDoc(p, 'job', T0)) <= limit));
  assert.equal((await appendAsJob(job, many, { ...jobOpts(c), blockBytes: limit })).ok, true);
  const s = await readChain(page);
  assert.equal(s.records.length, 120);
  assert.deepEqual(s.records.map(r => r.i), many.map(r => r.i));
  assert.equal(s.verify.ok, true);
  assert.ok(s.head.blocks > 3);
});

test('anchor check: the git copy must match the DB chain at its sequence number', async () => {
  const { c, page } = setup();
  await appendAsPage(page, bodies(3), pageOpts(c));
  const s = await readChain(page);
  assert.equal(anchorCheck(s.records, null).status, 'none');
  assert.equal(anchorCheck(s.records, { seq: 1, hash: s.records[1].hash, commit: 'abc' }).status, 'match');
  assert.equal(anchorCheck(s.records, { seq: 1, hash: 'f'.repeat(64), commit: 'abc' }).status, 'mismatch');
  assert.equal(anchorCheck(s.records, { seq: 7, hash: 'f'.repeat(64), commit: 'abc' }).status, 'mismatch');
});

// ---------------------------------------------------------------- records ------------------------------------------
const NOW = '2026-11-05T05:00:00Z';
function basePrediction(gameId, mu, over = {}) {
  const p = [], tp = [];
  for (let k = -60; k <= 60; k++) p.push(normCdf((k + 0.5 - mu) / 13) - normCdf((k - 0.5 - mu) / 13));
  for (let k = 150; k <= 300; k++) tp.push(normCdf((k + 0.5 - 226) / 18) - normCdf((k - 0.5 - 226) / 18));
  return { source: 'base', runId: 'run-A-2026-11-05', run: 'A', final: true, gameId, sim: { margin: mu, total: 226, marginHist: { lo: -60, p }, totalHist: { lo: 150, p: tp }, shift: 0 }, ...over };
}
const team = (espn, ko) => ({ espn, ko, koVerified: false });
const day = (over = {}) => ({
  schema: 1, kind: 'live', date: '2026-11-05', run: 'A',
  games: [
    { gameId: 'g1', home: team('MIA', '마이애미 히트'), away: team('MIN', '미네소타 팀버울브스'), start: { utc: '2026-11-06T00:00:00.000Z' }, group: 'A', prediction: basePrediction('g1', 4) },
    { gameId: 'g2', home: team('BOS', '보스턴 셀틱스'), away: team('NY', '뉴욕 닉스'), start: { utc: '2026-11-06T00:30:00.000Z' }, group: 'A', prediction: basePrediction('g2', -2) },
  ],
  ...over,
});
const mk = (betmanNo, home, away, type, odds, line) => ({ betmanNo, home, away, deadline: '2026-11-06T08:50:00+09:00', type, odds, ...(line != null ? { line } : {}) });
const MIA = ['마이애미 히트', '미네소타 팀버울브스'], BOS = ['보스턴 셀틱스', '뉴욕 닉스'];
const input = (markets, round = 125) => ({ round, capturedAt: '2026-11-05T14:00:00+09:00', source: 'manual', markets });
const chainOf = recs => recs.reduce((log, r) => [...log, chainAppend(log.at(-1), r)], []);

test('example data refuses odds input and pick records', () => {
  assert.throws(() => roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.0, away: 1.8 })]), day: day({ kind: 'example' }), cal: IDENTITY, chain: [], now: NOW }), /example/);
});

test('a round becomes odds, evaluation, pick and 2-fold records; pick ids are the pick-log ids', () => {
  const { records, view } = roundRecords({
    input: input([mk(1, ...MIA, 'ML', { home: 2.0, away: 1.8 }), mk(2, ...BOS, 'ML', { home: 1.75, away: 2.1 }), mk(3, ...BOS, 'ML5', { home: 3.0, close: 3.4, away: 2.6 })]),
    day: day(), cal: IDENTITY, chain: [], now: NOW,
  });
  const by = t => records.filter(r => r.type === t);
  assert.equal(by('odds').length, 3);
  assert.equal(by('evaluation').length, 7);
  assert.ok(by('evaluation').every(r => r.id && r.p > 0 && r.noVig > 0 && r.createdAt.kst.endsWith('+09:00')));
  const picks = by('pick');
  assert.ok(picks.some(p => p.id === '125-1-home') && picks.some(p => p.id === '125-2-away'));
  for (const p of picks) {
    assert.equal(p.id, pickId(p));
    assert.equal(p.ev >= 0.03, true);
    assert.equal(p.recordOnly, true);
    assert.ok(p.gateReasons.some(x => /first month of 2026-27/.test(x)), 'first month 2026-10-20 .. 11-19');
  }
  const combos = by('combo');
  assert.ok(combos.length >= 1 && combos.length <= 3);
  for (const c of combos) {
    assert.ok(c.legs.every(id => picks.some(p => p.id === id)));
    assert.ok(c.oddsProduct >= 2.0);
  }
  assert.equal(view.pass, false);
  const sum = summarize(chainOf(records), { now: NOW });
  assert.equal(sum.singles.n, picks.length);
  assert.equal(sum.combos.n, combos.length);
});

test('the same market entered again is kept as odds only; the first fixed evaluation stays', () => {
  const first = roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.0, away: 1.8 })]), day: day(), cal: IDENTITY, chain: [], now: NOW });
  const chain = chainOf(first.records);
  const again = roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.2, away: 1.6 })]), day: day(), cal: IDENTITY, chain, now: NOW });
  assert.deepEqual(again.records.map(r => r.type), ['odds']);
  assert.deepEqual(again.notes, [{ market: '125-1', note: 'already fixed' }]);
});

test('a game waiting for its final prediction (run B) gets odds only, evaluated later from the latest odds', () => {
  const d = day();
  d.games[0].prediction = basePrediction('g1', 4, { final: false });
  const r = roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.0, away: 1.8 })]), day: d, cal: IDENTITY, chain: [], now: NOW });
  assert.deepEqual(r.records.map(x => x.type), ['odds']);
  assert.deepEqual(r.notes, [{ market: '125-1', note: 'awaiting the final prediction' }]);
  const r2 = roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.1, away: 1.7 })]), day: d, cal: IDENTITY, chain: chainOf(r.records), now: NOW });
  const chain = chainOf([...r.records, ...r2.records]);
  const pending = pendingOdds(chain, { now: NOW });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].odds.home, 2.1, 'latest entry before the deadline');
  const ev = evaluationRecords({ oddsRecs: pending, day: day(), cal: IDENTITY, chain, now: NOW });
  assert.equal(ev.records.filter(x => x.type === 'evaluation').length, 2);
  assert.equal(pendingOdds([...chain, ...chainOf(ev.records)], { now: NOW }).length, 0);
});

test('integer lines are recorded as unsupported and never picked', () => {
  const { records } = roundRecords({ input: input([mk(1, ...MIA, 'OU', { over: 2.5, under: 2.5 }, 226)]), day: day(), cal: IDENTITY, chain: [], now: NOW });
  const ev = records.filter(r => r.type === 'evaluation');
  assert.equal(ev.length, 2);
  assert.ok(ev.every(r => /integer line/.test(r.unsupported) && r.p === undefined));
  assert.equal(records.filter(r => r.type === 'pick').length, 0);
});

test('scenario predictions are refused by the record path', () => {
  const d = day();
  d.games[0].prediction = basePrediction('g1', 4, { label: 'unverified' });
  assert.throws(() => roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.0, away: 1.8 })]), day: d, cal: IDENTITY, chain: [], now: NOW }), /base prediction only/);
});

test('a new leg pairs with an earlier open leg of the same round; the earlier pick is not recorded again', () => {
  const a = roundRecords({ input: input([mk(1, ...MIA, 'ML', { home: 2.0, away: 1.8 })]), day: day(), cal: IDENTITY, chain: [], now: NOW });
  assert.equal(a.records.filter(r => r.type === 'combo').length, 0);
  const b = roundRecords({ input: input([mk(2, ...BOS, 'ML', { home: 1.75, away: 2.1 })]), day: day(), cal: IDENTITY, chain: chainOf(a.records), now: NOW });
  assert.deepEqual(b.records.filter(r => r.type === 'pick').map(r => r.id), ['125-2-away']);
  const combos = b.records.filter(r => r.type === 'combo');
  assert.equal(combos.length, 1);
  assert.deepEqual([...combos[0].legs].sort(), ['125-1-home', '125-2-away']);
});

// ---------------------------------------------------------------- display --------------------------------------------
test('display text never reads as a release or as purchase advice, in any state', () => {
  const texts = Object.values(TEXT);
  const empty = summarize([], { now: NOW }).exit;
  const met = { minPicks: { target: 200, value: 230, met: true }, minWeeks: { target: 8, value: 9.1, met: true }, calibration: { target: 0.05, value: 0.01, met: true }, marketBrier: { model: 0.2, market: 0.21, met: true }, roi: { value: 0.03, ci95: [-0.05, 0.11], met: true }, releaseNeedsUserApproval: true, allMet: true };
  const some = { ...met, minPicks: { target: 200, value: 120, met: false }, allMet: false };
  for (const e of [empty, some, met]) { const v = exitView(e); texts.push(v.overall, ...v.rows.flatMap(r => [r.label, r.status, r.value, r.target])); }
  texts.push(chainText({ verify: { ok: true }, records: [] }).text, chainText({ verify: { ok: false, brokenAt: 4, problems: [] }, records: [] }).text);
  const bad = texts.flatMap(t => forbiddenIn(String(t)));
  assert.deepEqual(bad, []);
  for (const w of ['해제 가능', '구매 추천', '베팅 추천', '구매가능', '추천 픽']) assert.ok(forbiddenIn(`오늘의 ${w}`).length > 0, w);
});

test('exit progress: unmet conditions read 미충족 and keep record-only; all met still needs the user approval', () => {
  const v0 = exitView(summarize([], { now: NOW }).exit);
  assert.equal(v0.overall, TEXT.exitUnmet);
  assert.equal(v0.rows.length, 5);
  assert.ok(v0.rows.every(r => r.status === '미충족'));
  const met = { minPicks: { target: 200, value: 230, met: true }, minWeeks: { target: 8, value: 9.1, met: true }, calibration: { target: 0.05, value: 0.01, met: true }, marketBrier: { model: 0.2, market: 0.21, met: true }, roi: { value: 0.03, ci95: [-0.05, 0.11], met: true }, releaseNeedsUserApproval: true, allMet: true };
  const v1 = exitView(met);
  assert.equal(v1.overall, TEXT.exitAllMet);
  assert.match(v1.overall, /사용자 승인으로만/);
  assert.match(v1.overall, /기록 전용 유지/);
});

test('2-fold progress is counted separately from single picks', () => {
  const mkPick = (round, no, sel, odds) => pickRecord({ round, betmanNo: no, selection: sel, gameId: `g${no}`, market: 'ML', line: null, odds, p: 0.6, pCons: 0.59, ev: 0.1, pConsOld: 0.59, evOld: 0.1, noVig: 0.5, predictionRef: 'r', deadline: { utc: '2026-11-06T00:00:00Z', kst: 'x' } }, { now: NOW });
  const log = chainOf([
    mkPick(1, 1, 'home', 1.8), mkPick(1, 2, 'home', 1.8),
    { type: 'combo', id: '1-1-home+1-2-home', legs: ['1-1-home', '1-2-home'], round: 1, oddsProduct: 3.24, pCons: 0.35, ev: 0.13 },
    resultRecord('g1', 5, 220, { now: NOW }), resultRecord('g2', 3, 210, { now: NOW }),
  ]);
  const cp = comboProgress(log, { now: NOW });
  assert.equal(cp.minPicks.value, 1);
  assert.equal(cp.minPicks.met, false);
  assert.equal(cp.roi.value, 2.24);
  assert.equal(cp.allMet, false);
  assert.equal(exitView(cp).overall, TEXT.exitUnmet);
});

test('chain text: 정상(레코드 0개) when empty, record count and short hash otherwise', () => {
  assert.deepEqual(chainText({ verify: { ok: true }, records: [] }), { ok: true, text: '정상(레코드 0개)' });
  const recs = chainOf(bodies(3));
  const t = chainText({ verify: { ok: true }, records: recs });
  assert.equal(t.text, `정상(레코드 3개, 마지막 seq 2, 해시 ${recs[2].hash.slice(0, 12)})`);
});

// ---------------------------------------------------------------- day file -----------------------------------------
const NOTE = '예시 — 2024-25 과거 경기, 운영 데이터 아님, 보정 구간 표본 내 예측';
const exampleDay = (over = {}) => ({
  schema: 1, kind: 'example', exampleNote: NOTE, date: '2025-01-15', season: EXAMPLE_SEASON, run: null,
  games: [{ ...day().games[0], prediction: basePrediction('g1', 4, { final: true, run: 'B' }), sensitivity: { label: 'unverified', topMargin: [], topTotal: [] } }],
  ...over,
});

test('day file checks: the example note, the 2024-25 season, base predictions and unverified sensitivity', () => {
  assert.equal(TEXT.example, NOTE);
  assert.deepEqual(validateDay(exampleDay()), []);
  assert.ok(validateDay(exampleDay({ exampleNote: '예시' })).some(e => /exampleNote/.test(e)));
  assert.ok(validateDay(exampleDay({ date: '2025-12-01' })).some(e => /2024-25/.test(e)), '2025-26 is never used for the example');
  const scen = exampleDay();
  scen.games[0].prediction = { ...scen.games[0].prediction, label: 'unverified' };
  assert.ok(validateDay(scen).some(e => /base/.test(e)));
  const sens = exampleDay();
  sens.games[0].sensitivity = { topMargin: [] };
  assert.ok(validateDay(sens).some(e => /sensitivity/.test(e)));
  assert.deepEqual(validateDay(day()), []);
});

test('game view: calibrated win probability, ensemble location, 90% interval', () => {
  const g = day().games[0];
  g.prediction.sim.shift = 1.5;
  const v = gameView(g, IDENTITY);
  assert.equal(v.winProbHome, markets(IDENTITY, g.prediction.sim).ml.home);
  assert.equal(v.margin, 5.5);
  assert.ok(v.interval90.margin[0] < 5.5 && v.interval90.margin[1] > 5.5);
  assert.ok(v.interval90.total[0] < 226 && v.interval90.total[1] > 226);
  assert.ok(Math.abs(v.interval90.margin[1] - v.interval90.margin[0] - 2 * 1.645 * 13) < 2);
});

test('scenario view is unverified (back-to-back also approximate) and can never be priced as a pick', () => {
  const g = day().games[0];
  const toRes = (mu, n = 10000) => {
    const hist = [], th = [];
    for (let k = -60; k <= 60; k++) hist.push(Math.round(n * (normCdf((k + 0.5 - mu) / 13) - normCdf((k - 0.5 - mu) / 13))));
    for (let k = 150; k <= 300; k++) th.push(Math.round(n * (normCdf((k + 0.5 - 224) / 18) - normCdf((k - 0.5 - 224) / 18))));
    return { n, margin: { mean: mu, sd: 13, hist }, total: { mean: 224, sd: 18, hist: th } };
  };
  const v = scenarioView(g, toRes(2), IDENTITY, { fatigue: [{ team: 'MIA', b2b: true }] });
  assert.equal(v.label, 'unverified');
  assert.equal(v.approx, true);
  assert.deepEqual(v.badges, ['미검증', '근사']);
  assert.equal(v.delta.margin, 2 - 4);
  assert.equal(scenarioView(g, toRes(3), IDENTITY, { shootingShift: [{ team: 'MIA', fg3: 0.02 }] }).approx, false);
  assert.throws(() => marketProbs(v.prediction, IDENTITY, { type: 'ML' }), /base prediction only/);
});
