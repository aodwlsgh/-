// Early run C (2026-10-27 approval): run time and finality, the evaluation path of a market, one evaluation per market
// across C and A·B, predictionRun required on new evaluation and pick records (schema 2), exit progress per path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAt, runGames, isFinalRun, evalPath, canEvaluate, RUN_C_ET, runCEt, searchAtOf, cMorningReport } from '../engine/trigger-time.js';
import { createCollector } from '../engine/collect.js';
import { pickSnapshot } from '../jobs/lib/live-collect.js';
import { fromEt } from '../engine/time.js';
import { evaluationRecords } from '../engine/log-records.js';
import { jobBodies } from '../engine/log-sync.js';
import { classifyInput, unevaluatedRecords } from '../engine/day-status.js';
import { pickRecord, summarizeByPath, RECORD_SCHEMA } from '../engine/pick-log.js';
import { inputGapSummary, notSubmittedSummary } from '../engine/daily-report.js';
import { IDENTITY } from '../engine/calibrate.js';
import { normCdf } from '../engine/predict.js';
import { stamp } from '../engine/clock.js';

const prediction = (run, final, mu = 4) => {
  const p = [], tp = [];
  for (let k = -60; k <= 60; k++) p.push(normCdf((k + 0.5 - mu) / 13) - normCdf((k - 0.5 - mu) / 13));
  for (let k = 150; k <= 300; k++) tp.push(normCdf((k + 0.5 - 226) / 18) - normCdf((k - 0.5 - 226) / 18));
  return { source: 'base', runId: `2026-10-28-${run}-x`, run, final, sim: { margin: mu, total: 226, marginHist: { lo: -60, p }, totalHist: { lo: 150, p: tp }, shift: 0 } };
};
// 2026-10-28 ET (daylight time): BOS 19:00 ET (group A), LAL 22:00 ET (group B)
const START_A = '2026-10-28T23:00:00.000Z', START_B = '2026-10-29T02:00:00.000Z';
const game = (id, start, pred, home, away) => ({ gameId: id, start: stamp(start), group: start === START_A ? 'A' : 'B', home: { espn: home, ko: '' }, away: { espn: away, ko: '' }, prediction: pred });
const dayOf = run => ({ kind: 'live', run, games: [game('gA', START_A, prediction(run, true), 'BOS', 'NY'), game('gB', START_B, prediction(run, true), 'LAL', 'LAC')] });
const PREV_NIGHT = '2026-10-28T23:00:00+09:00'; // Betman deadline 23:00 KST = 10:00 EDT on game day
const odds = (no, gameId, deadline, home, away) => ({ type: 'odds', seq: no, round: 128, betmanNo: no, source: 'screenshot', capturedAt: stamp('2026-10-28T12:00:00Z'), deadline: stamp(deadline), home, away, homeKo: '', awayKo: '', market: 'ML', line: null, lineKind: null, odds: { home: 1.9, away: 2.1 }, implied: { home: 1 / 1.9, away: 1 / 2.1 }, overround: 1 / 1.9 + 1 / 2.1, noVig: { home: 0.525, away: 0.475 }, gameId });

test('run C: 08:50 ET through 10-31, 07:50 ET from 11-01; predicts A- and B-group games; final only at or after the cutoff and before the start', () => {
  assert.deepEqual(RUN_C_ET, { hour: 8, minute: 50 });
  assert.equal(runAt('C', '2026-10-28').toISOString(), '2026-10-28T12:50:00.000Z', '21:50 KST while New York is on daylight time');
  assert.equal(runAt('C', '2026-11-02').toISOString(), '2026-11-02T12:50:00.000Z', '07:50 EST = 21:50 KST after 2026-11-01');
  const gs = [{ start: '2026-10-28T19:00:00Z' }, { start: START_A }, { start: START_B }]; // 15:00 ET is pre_job_start
  assert.deepEqual(runGames('C', gs).map(g => g.start), [START_A, START_B]);
  assert.equal(isFinalRun('C', START_A, '2026-10-28T12:50:00Z'), true);
  assert.equal(isFinalRun('C', START_B, '2026-10-28T12:51:00Z'), true, 'C covers B-group games too');
  assert.equal(isFinalRun('C', START_A, '2026-10-28T12:49:00Z'), false);
  assert.equal(isFinalRun('C', '2026-11-03T00:00:00Z', '2026-11-02T12:50:00Z'), true, '21:50 KST after 11-01 is 07:50 EST: the cutoff, final');
  assert.equal(isFinalRun('C', '2026-11-03T00:00:00Z', '2026-11-02T12:49:00Z'), false);
  assert.equal(isFinalRun('C', '2026-10-28T19:00:00Z', '2026-10-28T13:00:00Z'), false, 'pre_job_start games: no run');
});

test('evaluation path: deadline not after the A/B final time -> C, otherwise A·B; no path for pre_job_start', () => {
  assert.equal(evalPath(stamp(PREV_NIGHT).utc, START_A), 'C');
  assert.equal(evalPath(stamp(PREV_NIGHT).utc, START_B), 'C');
  assert.equal(evalPath(START_A, START_A), 'AB', 'deadline at tip-off');
  assert.equal(evalPath('2026-10-28T21:50:00Z', START_A), 'C', 'exactly the run A time counts as C');
  assert.equal(evalPath('2026-10-28T21:51:00Z', START_A), 'AB');
  assert.equal(evalPath(START_A, '2026-10-28T19:00:00Z'), null);
  const o = odds(1, 'gA', PREV_NIGHT, 'BOS', 'NY');
  assert.equal(canEvaluate(o, dayOf('C').games[0]), true);
  assert.equal(canEvaluate(o, dayOf('A').games[0]), false, 'run A never evaluates a C market');
  assert.equal(canEvaluate({ ...o, deadline: stamp(START_A) }, dayOf('C').games[0]), false, 'run C never evaluates an A·B market');
});

test('one evaluation per market: the C market by run C, the A·B market by run A, never both', () => {
  const mC = odds(1, 'gA', PREV_NIGHT, 'BOS', 'NY'), mAB = odds(2, 'gA', START_A, 'BOS', 'NY');
  // run C day, 21:55 KST: only the C market is evaluated
  const c = evaluationRecords({ oddsRecs: [mC, mAB], day: dayOf('C'), cal: IDENTITY, chain: [], now: new Date('2026-10-28T12:55:00Z') });
  const evC = c.records.filter(r => r.type === 'evaluation');
  assert.deepEqual([...new Set(evC.map(r => r.betmanNo))], [1]);
  assert.ok(evC.every(r => r.predictionRun === 'C' && r.schema === RECORD_SCHEMA));
  assert.deepEqual(c.notes, [{ market: '128-2', note: 'awaiting the final prediction' }]);
  // run A day, next morning: the C market is closed, the A·B market is evaluated with run A
  const chain = [mC, mAB, ...c.records];
  const a = evaluationRecords({ oddsRecs: [mC, mAB], day: dayOf('A'), cal: IDENTITY, chain, now: new Date('2026-10-28T21:55:00Z') });
  const evA = a.records.filter(r => r.type === 'evaluation');
  assert.deepEqual([...new Set(evA.map(r => r.betmanNo))], [2]);
  assert.ok(evA.every(r => r.predictionRun === 'A'));
  assert.deepEqual(a.notes, [{ market: '128-1', note: 'already fixed' }]);
  const all = [...evC, ...evA];
  for (const no of [1, 2]) assert.equal(new Set(all.filter(r => r.betmanNo === no).map(r => r.predictionRun)).size, 1, `market ${no} has one evaluating run`);
  // a C market still open on a run A day is not taken by run A
  const late = evaluationRecords({ oddsRecs: [mC], day: dayOf('A'), cal: IDENTITY, chain: [], now: new Date('2026-10-28T12:00:00Z') });
  assert.deepEqual(late.records, []);
  assert.deepEqual(late.notes, [{ market: '128-1', note: 'awaiting run C' }]);
});

test('the daily job takes only markets of its own path; a C market missed by run C is unevaluated against the C final', () => {
  const mC = odds(1, 'gA', PREV_NIGHT, 'BOS', 'NY'), mAB = odds(2, 'gB', START_B, 'LAL', 'LAC');
  const body = jobBodies({ chain: [mC, mAB], day: dayOf('C'), cal: IDENTITY, now: new Date('2026-10-28T12:55:00Z') });
  assert.deepEqual([...new Set(body.bodies.filter(r => r.type === 'evaluation').map(r => r.betmanNo))], [1]);
  // after the deadline with no evaluation: the reason uses the C final for a C market and the A·B final otherwise
  const finals = new Map([['gA', { at: '2026-10-28T21:51:00Z', runId: 'A', start: START_A }]]);
  const finalsC = new Map([['gA', { at: '2026-10-28T12:51:00Z', runId: 'C', start: START_A }]]);
  const un = unevaluatedRecords({ chain: [mC], finals, finalsC, now: new Date('2026-10-28T15:00:00Z') });
  assert.equal(un[0].reason, 'not written before deadline', 'C final 12:51Z came before the 14:00Z deadline');
  const noC = unevaluatedRecords({ chain: [mC], finals, now: new Date('2026-10-28T15:00:00Z') })[0];
  assert.equal(noC.reason, 'no C prediction', 'no C final: the A·B final is not borrowed');
  assert.match(noC.note, /아침 리포트 기준\(C\) 예측 없음/);
  // no final at all yet (B-group game at run A): the tip-off from any archived prediction still gives the path
  const mB = odds(3, 'gB', PREV_NIGHT, 'LAL', 'LAC');
  assert.equal(unevaluatedRecords({ chain: [mB], starts: new Map([['gB', START_B]]), now: new Date('2026-10-28T15:00:00Z') })[0].reason, 'no C prediction');
  assert.equal(unevaluatedRecords({ chain: [mB], now: new Date('2026-10-28T15:00:00Z') })[0].reason, 'no final prediction', 'tip-off unknown');
});

test('predictionRun is required on new evaluation and pick records', () => {
  const noRun = { ...dayOf('A'), games: dayOf('A').games.map(g => ({ ...g, prediction: { ...g.prediction, run: undefined } })) };
  assert.throws(() => evaluationRecords({ oddsRecs: [odds(2, 'gA', START_A, 'BOS', 'NY')], day: noRun, cal: IDENTITY, chain: [], now: new Date('2026-10-28T21:55:00Z') }), /predictionRun missing/);
  const leg = { round: 1, betmanNo: 1, selection: 'home', gameId: 'g', market: 'ML', line: null, odds: 2, p: 0.6, pCons: 0.59, ev: 0.1, deadline: { utc: '2026-11-06T00:00:00Z' } };
  assert.throws(() => pickRecord(leg, { now: '2026-11-05T00:00:00Z' }), /predictionRun missing/);
  const r = pickRecord({ ...leg, predictionRun: 'C' }, { now: '2026-11-05T00:00:00Z' });
  assert.deepEqual([r.schema, r.predictionRun], [RECORD_SCHEMA, 'C']);
});

test('exit progress is counted per path; schema 1 records count as A·B', () => {
  const pick = (id, run, gameId) => ({ type: 'pick', id, gameId, market: 'ML', selection: 'home', line: null, odds: 2, p: 0.6, pCons: 0.59, ev: 0.1, createdAt: stamp('2026-11-01T00:00:00Z'), ...(run ? { predictionRun: run } : {}) });
  const log = [pick('1-1-home', 'C', 'g1'), pick('1-2-home', 'A', 'g2'), pick('1-3-home', null, 'g3'),
    { type: 'combo', id: '1-1-home+1-2-home', legs: ['1-1-home', '1-2-home'], oddsProduct: 4, pCons: 0.3, ev: 0.2 },
    ...['g1', 'g2', 'g3'].map(g => ({ type: 'result', gameId: g, margin: 5, total: 220 }))];
  const s = summarizeByPath(log, { now: new Date('2026-11-02T00:00:00Z') });
  assert.equal(s.C.singles.n, 1);
  assert.equal(s.AB.singles.n, 2);
  assert.equal(s.mixedCombos, 1);
  assert.equal(s.C.exit.minPicks.value + s.AB.exit.minPicks.value, 3);
});

test('confirmation screen: a C market is fixed on the C day, waits for C on an A day; an A·B market waits on the C day', () => {
  const now = new Date('2026-10-28T12:55:00Z');
  const mk = (betmanNo, home, away, deadline) => ({ betmanNo, home, away, deadline, type: 'ML', odds: { home: 1.9, away: 2.1 } });
  const input = { round: 128, capturedAt: '2026-10-28T21:52:00+09:00', source: 'screenshot', markets: [mk(1, '보스턴 셀틱스', '뉴욕 닉스', PREV_NIGHT), mk(2, 'LA 레이커스', 'LA 클리퍼스', '2026-10-29T11:00:00+09:00')] };
  const c = classifyInput({ input, day: dayOf('C'), chain: [], now });
  assert.deepEqual(c.rows.map(r => r.handling), ['fixC', 'oddsOnlyAwaitingB']);
  // the confirmation screen shows each market's deadline with the path it decides (2026-10-28 item 5)
  assert.deepEqual(c.rows.map(r => [r.deadline.kst.slice(0, 16), r.path]), [['2026-10-28T23:00', 'C'], ['2026-10-29T11:00', 'AB']]);
  const provisionalA = { ...dayOf('A'), games: dayOf('A').games.map(g => ({ ...g, prediction: { ...g.prediction, final: false } })) };
  assert.deepEqual(classifyInput({ input: { ...input, markets: [input.markets[0]] }, day: provisionalA, chain: [], now }).rows.map(r => r.handling), ['oddsOnlyAwaitingC']);
});

test('prepare C (offline): every non-early game predicted by run C, final after 08:50 ET', () => {
  const out = mkdtempSync(join(tmpdir(), 'p9c-'));
  const r = spawnSync(process.execPath, ['jobs/daily.js', 'prepare', 'C', '--offline', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-12T14:00:00Z', '--n', '200', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const day = JSON.parse(readFileSync(join(out, 'data/live/today.json'), 'utf8'));
  assert.equal(day.run, 'C');
  assert.ok(day.games.length > 0);
  assert.ok(day.games.every(g => g.prediction.run === 'C' && g.prediction.final === true));
});

test('prepare C (offline) with no morning report: every C prediction provisional, a warning and a push', () => {
  const out = mkdtempSync(join(tmpdir(), 'p9c-'));
  const r = spawnSync(process.execPath, ['jobs/daily.js', 'prepare', 'C', '--offline', '--offline-snapshot', 'none', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-12T14:00:00Z', '--n', '200', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(r.stdout.trim().split('\n').at(-1));
  const day = JSON.parse(readFileSync(join(out, 'data/live/today.json'), 'utf8'));
  assert.ok(day.games.length > 0 && day.games.every(g => g.prediction.run === 'C' && g.prediction.final === false));
  assert.ok(res.alerts.some(t => t.startsWith('아침 리포트 기준(C) 리포트 없음')), res.alerts.join(' | '));
  assert.ok(res.push.some(t => t.startsWith('[NBA C] 아침 리포트 기준(C) 리포트 없음')), JSON.stringify(res.push));
});

test('evaluation records carry the odds input time and the minutes to the evaluation; the report gives the distribution per path', () => {
  const mC = { ...odds(1, 'gA', PREV_NIGHT, 'BOS', 'NY'), createdAt: stamp('2026-10-27T06:38:54Z') };
  const mAB = { ...odds(2, 'gA', START_A, 'BOS', 'NY'), createdAt: stamp('2026-10-28T21:40:00Z') };
  const c = evaluationRecords({ oddsRecs: [mC], day: dayOf('C'), cal: IDENTITY, chain: [], now: new Date('2026-10-28T12:55:00Z') });
  const evC = c.records.filter(r => r.type === 'evaluation');
  assert.ok(evC.length && evC.every(r => r.oddsInputAt === '2026-10-27T06:38:54.000Z' && r.inputToEvalMin === 1816), JSON.stringify(evC[0]));
  const a = evaluationRecords({ oddsRecs: [mAB], day: dayOf('A'), cal: IDENTITY, chain: [], now: new Date('2026-10-28T21:55:00Z') });
  const evA = a.records.filter(r => r.type === 'evaluation');
  assert.ok(evA.every(r => r.inputToEvalMin === 15));
  const g = inputGapSummary([...evC, ...evA, { type: 'evaluation', round: 128, betmanNo: 9, predictionRun: 'A' }]);
  assert.deepEqual(g.C, { n: 1, min: 1816, median: 1816, p90: 1816, max: 1816, sameRun: 0 });
  assert.deepEqual(g.AB, { n: 1, min: 15, median: 15, p90: 15, max: 15, sameRun: 0 });
  assert.equal(g.missing, 1, 'one value per market; a record without the field is counted as missing');
});

test('exit progress: path C fills its own 200 picks and 8 weeks; nothing is pooled with path A·B', () => {
  const pick = (i, run, day) => ({ type: 'pick', id: `128-${i}-home`, gameId: `g${i}`, market: 'ML', selection: 'home', line: null, odds: 2, pCons: 0.5, ev: 0, createdAt: stamp(`2026-${day}T12:00:00Z`), predictionRun: run });
  const res = i => ({ type: 'result', gameId: `g${i}`, margin: 3, total: 220 });
  const log = [];
  for (let i = 0; i < 150; i++) log.push(pick(i, 'A', i < 75 ? '11-01' : '12-31'), res(i));
  for (let i = 150; i < 300; i++) log.push(pick(i, 'C', i < 225 ? '11-01' : '12-31'), res(i));
  const s = summarizeByPath(log, { now: new Date('2027-01-01T00:00:00Z') });
  for (const k of ['AB', 'C']) {
    assert.deepEqual(s[k].exit.minPicks, { target: 200, value: 150, met: false }, `${k}: 150 of its own, not 300`);
    assert.equal(s[k].exit.minWeeks.met, true);
  }
});

test('report: share of games with a team not yet submitted on the injury report', () => {
  const g = (h, a) => ({ dataStatus: { injurySnapshot: { home: { notSubmitted: h }, away: { notSubmitted: a } } } });
  assert.deepEqual(notSubmittedSummary({ games: [g(true, false), g(true, true), g(false, false), { dataStatus: { injurySnapshot: null } }] }), { games: 2, of: 4, oneTeam: 1, bothTeams: 1, share: 0.5 });
});

// 2026-10-28 condition 6: the cutoff switch at the daylight-time boundary, and the report a scheduled 21:50 KST run reads
test('run C at 21:50 KST around 2026-11-01: 08:50 EDT on 10-30/10-31, 07:50 EST from 11-01; the report time searched is the validated cutoff', () => {
  const cases = [
    ['2026-10-30T12:50:40Z', '2026-10-30', '2026-10-30T12:50:00.000Z', 8],
    ['2026-10-31T12:50:40Z', '2026-10-31', '2026-10-31T12:50:00.000Z', 8],
    ['2026-11-01T12:50:40Z', '2026-11-01', '2026-11-01T12:50:00.000Z', 7],
    ['2026-11-02T12:51:30Z', '2026-11-02', '2026-11-02T12:50:00.000Z', 7],
  ];
  for (const [now, date, at, hour] of cases) {
    assert.equal(runCEt(date).hour, hour, date);
    assert.equal(searchAtOf('C', date, now).toISOString(), at, `${date}: reads the report as of ${hour}:50 ET`);
    assert.equal(searchAtOf('C', date, now).getTime(), fromEt(date, hour, 50).getTime(), 'the cutoff of scripts/c/early-run.mjs for that date (--cutoff 0850 / 0750)');
    assert.equal(isFinalRun('C', fromEt(date, 19, 0).toISOString(), now), true, `${date}: final`);
  }
  // a run started before the cutoff (scheduler early or manual) reads what was out then and stays provisional
  assert.equal(searchAtOf('C', '2026-11-01', '2026-11-01T12:40:00Z').toISOString(), '2026-11-01T12:40:00.000Z');
  assert.equal(isFinalRun('C', fromEt('2026-11-01', 19, 0).toISOString(), '2026-11-01T12:40:00Z'), false);
});

test('run C reads the latest game-day report available by 07:50 ET (same search as the validation); none -> no previous-evening substitute', async () => {
  const date = '2026-11-01';
  const pdfs = { // name -> Last-Modified (UTC); 07:50 EST = 12:50Z
    [`Injury-Report_${date}_07_45AM.pdf`]: '2026-11-01T12:52:00Z', // out after the cutoff: skipped
    [`Injury-Report_${date}_07_30AM.pdf`]: '2026-11-01T12:31:00Z',
    'Injury-Report_2026-10-31_11_30PM.pdf': '2026-11-01T04:31:00Z', // previous evening, outside the 4-hour search
  };
  const fetch = async url => {
    const name = url.split('/').pop(), lm = pdfs[name];
    return lm ? { ok: true, status: 200, headers: { get: h => ({ 'content-type': 'application/pdf', 'last-modified': new Date(lm).toUTCString() })[h] ?? null }, arrayBuffer: async () => new TextEncoder().encode(name).buffer }
      : { ok: false, status: 404, headers: { get: () => 'application/xml' } };
  };
  const parse = async bytes => { const name = new TextDecoder().decode(bytes); const m = name.match(/_(\d{2})_(\d{2})(AM|PM)/); return { reportTime: `${date.slice(5, 7)}/${date.slice(8)}/${date.slice(2, 4)} ${m[1]}:${m[2]} ${m[3]}`, rows: [], notSubmitted: [], issues: [] }; };
  const col = () => createCollector({ fetch, sleep: async () => {}, perSecond: 1e6 });
  const at = searchAtOf('C', date, '2026-11-01T12:50:40Z');
  const snap = await pickSnapshot(col().injuryPdfsBefore(at, { maxSteps: 16 }), { at, gameDate: date, parse });
  assert.equal(snap.pdf, `Injury-Report_${date}_07_30AM.pdf`);
  assert.deepEqual(cMorningReport(snap, date, at), { ok: true, why: null });
  // the validation's own call with its cutoff gives the same file
  const v = await pickSnapshot(col().injuryPdfsBefore(fromEt(date, 7, 50), { maxSteps: 16 }), { at: fromEt(date, 7, 50), gameDate: date, parse });
  assert.equal(v.pdf, snap.pdf);
  // no morning report: nothing within the window, the previous evening's file is never picked; C is provisional
  delete pdfs[`Injury-Report_${date}_07_30AM.pdf`];
  const none = await pickSnapshot(col().injuryPdfsBefore(at, { maxSteps: 16 }), { at, gameDate: date, parse });
  assert.equal(none.pdf, null);
  assert.equal(cMorningReport(none, date, at).ok, false);
  assert.equal(cMorningReport({ pdf: 'Injury-Report_2026-10-31_11_30PM.pdf', rows: [], availableAt: '2026-11-01T04:31:00Z' }, date, at).ok, false, 'a previous-evening report never counts');
  assert.equal(cMorningReport({ pdf: `Injury-Report_${date}_07_30AM.pdf`, formatError: 'x' }, date, at).ok, false);
});
