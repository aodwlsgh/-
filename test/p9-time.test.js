// P9 time calculations (2026-10-23 P9 plan §7, user conditions: CRON_TZ=America/New_York, DST end 2026-11-01).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RUN_CRON, parseDailyCron, nextFireUtc, runAt, isFinalRun, runGames } from '../engine/trigger-time.js';
import { stamp } from '../engine/clock.js';
import { fromEt } from '../engine/time.js';
import { snapshotCutoff, jobGroup } from '../engine/snapshot.js';
import { injuryPdfName } from '../engine/collect.js';
import { etParts } from '../engine/time.js';

test('the two scheduled runs are New York wall-clock crons', () => {
  assert.equal(RUN_CRON.A, 'CRON_TZ=America/New_York 50 17 * * *');
  assert.equal(RUN_CRON.B, 'CRON_TZ=America/New_York 50 20 * * *');
  assert.deepEqual(parseDailyCron(RUN_CRON.A), { tz: 'America/New_York', hour: 17, minute: 50 });
  assert.throws(() => parseDailyCron('50 17 * * *'), /CRON_TZ/);
  assert.throws(() => parseDailyCron('CRON_TZ=America/New_York 50 17 * * 1-5'), /daily/);
});

test('DST end 2026-11-01: A 21:50Z -> 22:50Z, B 00:50Z -> 01:50Z (KST 06:50/09:50 -> 07:50/10:50)', () => {
  const rows = [
    ['A', '2026-10-31T12:00:00Z', '2026-10-31T21:50:00.000Z', '2026-11-01T06:50:00+09:00'],
    ['B', '2026-10-31T12:00:00Z', '2026-11-01T00:50:00.000Z', '2026-11-01T09:50:00+09:00'],
    ['A', '2026-11-01T12:00:00Z', '2026-11-01T22:50:00.000Z', '2026-11-02T07:50:00+09:00'],
    ['B', '2026-11-01T12:00:00Z', '2026-11-02T01:50:00.000Z', '2026-11-02T10:50:00+09:00'],
  ];
  for (const [run, from, utc, kst] of rows) {
    const t = nextFireUtc(RUN_CRON[run], new Date(from));
    assert.deepEqual(stamp(t), { utc, kst }, `${run} after ${from}`);
  }
});

test('DST start 2027-03-14: A 22:50Z on 03-13, 21:50Z on 03-14', () => {
  assert.equal(nextFireUtc(RUN_CRON.A, new Date('2027-03-13T12:00:00Z')).toISOString(), '2027-03-13T22:50:00.000Z');
  assert.equal(nextFireUtc(RUN_CRON.A, new Date('2027-03-14T12:00:00Z')).toISOString(), '2027-03-14T21:50:00.000Z');
  assert.equal(nextFireUtc(RUN_CRON.B, new Date('2027-03-14T12:00:00Z')).toISOString(), '2027-03-15T00:50:00.000Z');
});

test('next fire is strictly after the given time', () => {
  assert.equal(nextFireUtc(RUN_CRON.A, new Date('2026-10-23T21:50:00Z')).toISOString(), '2026-10-24T21:50:00.000Z');
  assert.equal(nextFireUtc(RUN_CRON.A, new Date('2026-10-23T21:49:59Z')).toISOString(), '2026-10-23T21:50:00.000Z');
  assert.equal(runAt('A', '2026-11-01').toISOString(), '2026-11-01T22:50:00.000Z');
});

test('tip-off ET -> KST across both switches (IANA, not fixed offsets)', () => {
  assert.equal(stamp(fromEt('2026-10-31', 19, 30)).kst, '2026-11-01T08:30:00+09:00');
  assert.equal(stamp(fromEt('2026-11-02', 19, 30)).kst, '2026-11-03T09:30:00+09:00');
  assert.equal(stamp(fromEt('2027-03-13', 19, 30)).kst, '2027-03-14T09:30:00+09:00');
  assert.equal(stamp(fromEt('2027-03-15', 19, 30)).kst, '2027-03-16T08:30:00+09:00');
});

test('the injury report searched by run A is the same ET file name before and after the switch', () => {
  for (const d of ['2026-10-31', '2026-11-02']) {
    const cut = snapshotCutoff(fromEt(d, 19, 0).toISOString());
    const et = etParts(new Date(Math.floor(cut.getTime() / 900e3) * 900e3));
    assert.equal(injuryPdfName(et), `Injury-Report_${d}_05_45PM.pdf`);
  }
});

test('run B covers the same games (21:00 ET or later) before and after the switch', () => {
  for (const d of ['2026-10-31', '2026-11-02']) {
    const games = [[19, 0], [20, 30], [21, 0], [22, 30]].map(([h, m], i) => ({ gameId: String(i), start: { utc: fromEt(d, h, m).toISOString() } }));
    assert.deepEqual(runGames('B', games).map(g => g.gameId), ['2', '3'], d);
    assert.deepEqual(runGames('A', games).map(g => g.gameId), ['0', '1', '2', '3'], d);
  }
});

test('final predictions: only the group run, at or after its run time', () => {
  const d = '2026-11-02';
  const a = fromEt(d, 19, 30).toISOString(), b = fromEt(d, 22, 0).toISOString();
  assert.equal(jobGroup(a), 'A');
  assert.equal(isFinalRun('A', a, fromEt(d, 17, 50)), true);
  assert.equal(isFinalRun('A', a, fromEt(d, 17, 49)), false, 'a manual run before 17:50 ET is provisional');
  assert.equal(isFinalRun('A', b, fromEt(d, 17, 55)), false, 'run A predicts B games provisionally');
  assert.equal(isFinalRun('B', b, fromEt(d, 20, 50)), true);
  assert.equal(isFinalRun('B', b, fromEt(d, 20, 40)), false);
  assert.equal(isFinalRun('A', a, fromEt(d, 19, 31)), false, 'started games are never predicted');
  const pre = fromEt(d, 16, 0).toISOString();
  assert.equal(isFinalRun('A', pre, fromEt(d, 17, 50)), false, 'pre_job_start games have no run');
});
