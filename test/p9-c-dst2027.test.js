// Run C across the 2027-03-14 DST start (2026-10-28 approval, option "다": 07:50 ET in every season). The KST-fixed
// task stays at 21:50 KST, which is 07:50 EST before the change and 08:50 EDT after it. The cutoff stays at 07:50 ET,
// the report searched is cut at the cutoff and the pinned edition is 07:30. Test file only; no code changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAt, runCEt, searchAtOf, cPin, isFinalRun, RUN_C_ET_0750 } from '../engine/trigger-time.js';
import { fromEt } from '../engine/time.js';
import { runEarly } from '../engine/run-alerts.js';

const kst2150 = d => new Date(`${d}T21:50:40+09:00`); // the scheduled C run (40 s after the minute)

test('C cutoff stays 07:50 ET on 2027-03-13, 03-14 and 03-15 (no return to 08:50)', () => {
  for (const d of ['2027-03-13', '2027-03-14', '2027-03-15', '2027-06-01', '2027-10-31']) assert.deepEqual(runCEt(d), RUN_C_ET_0750, d);
  assert.equal(runAt('C', '2027-03-13').toISOString(), '2027-03-13T12:50:00.000Z', '07:50 EST');
  assert.equal(runAt('C', '2027-03-14').toISOString(), '2027-03-14T11:50:00.000Z', '07:50 EDT (the change is 02:00 ET)');
  assert.equal(runAt('C', '2027-03-15').toISOString(), '2027-03-15T11:50:00.000Z', '07:50 EDT');
});

test('21:50 KST around 2027-03-14: on time before the change, an hour late after it; search cut at the cutoff, pin 07:30', () => {
  const cases = [
    ['2027-03-13', '2027-03-13T12:50:00.000Z', 0], // 07:50 EST (40 s after: search cut at the cutoff)
    ['2027-03-14', '2027-03-14T11:50:00.000Z', 60], // 08:50 EDT, searched up to 07:50 EDT
    ['2027-03-15', '2027-03-15T11:50:00.000Z', 60],
  ];
  for (const [d, search, lateMin] of cases) {
    const now = kst2150(d);
    assert.equal(searchAtOf('C', d, now).toISOString(), search, d);
    assert.equal(Math.floor((now - runAt('C', d)) / 60000), lateMin, d);
    assert.deepEqual(cPin(d), { date: d, hour: 7, minute: 30 }, d);
    assert.equal(runEarly({ run: 'C', date: d, startedAt: now }), null, `${d}: a late start is not runEarly`);
  }
});

test('C predictions after 2027-03-14 are final for games after 17:50 ET, not for a run before the cutoff', () => {
  const d = '2027-03-15';
  const game = fromEt(d, 19, 30).toISOString();
  assert.equal(isFinalRun('C', game, kst2150(d)), true);
  assert.equal(isFinalRun('C', game, new Date('2027-03-15T11:40:00Z')), false, '07:40 EDT is before the cutoff');
  assert.equal(searchAtOf('C', d, '2027-03-15T11:40:00Z').toISOString(), '2027-03-15T11:40:00.000Z');
});
