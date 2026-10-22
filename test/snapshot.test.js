import { test } from 'node:test';
import assert from 'node:assert/strict';
import { jobGroup, snapshotCutoff, RUN_A_ET, RUN_B_ET } from '../engine/snapshot.js';
import { fromEt } from '../engine/time.js';

const at = (d, h, m) => fromEt(d, h, m).toISOString();

test('job groups by ET tip-off: pre_job_start <= 17:50 < A < 21:00 <= B', () => {
  assert.equal(jobGroup(at('2026-01-10', 15, 30)), 'pre_job_start');
  assert.equal(jobGroup(at('2026-01-10', 17, 50)), 'pre_job_start');
  assert.equal(jobGroup(at('2026-01-10', 18, 0)), 'A');
  assert.equal(jobGroup(at('2026-01-10', 20, 30)), 'A');
  assert.equal(jobGroup(at('2026-01-10', 21, 0)), 'B');
  assert.equal(jobGroup(at('2026-01-10', 22, 30)), 'B');
});

test('groups hold across the DST switch (same ET wall clock)', () => {
  for (const d of ['2026-10-31', '2026-11-02', '2027-03-13', '2027-03-15']) {
    assert.equal(jobGroup(at(d, 19, 30)), 'A', d);
    assert.equal(jobGroup(at(d, 22, 0)), 'B', d);
  }
});

test('snapshot cutoff: A at 17:50 ET, B at 20:50 ET, pre_job_start one minute before tip', () => {
  assert.equal(RUN_A_ET.hour * 60 + RUN_A_ET.minute, 17 * 60 + 50);
  assert.equal(RUN_B_ET.hour * 60 + RUN_B_ET.minute, 20 * 60 + 50);
  assert.equal(snapshotCutoff(at('2025-12-01', 19, 0)).toISOString(), at('2025-12-01', 17, 50));
  assert.equal(snapshotCutoff(at('2025-12-01', 22, 0)).toISOString(), at('2025-12-01', 20, 50));
  assert.equal(snapshotCutoff(at('2025-12-01', 15, 30)).toISOString(), at('2025-12-01', 15, 29));
});

import { snapshotInjuries } from '../engine/snapshot.js';

const row = (team, player, status, matchup = 'BKN@CHA') => ({ gameDate: '10/22/2025', gameTime: '07:00 (ET)', matchup, team, player, status, reason: 'x' });
const snap = {
  rows: [
    row('Brooklyn Nets', 'Highsmith, Haywood', 'Out'),
    row('Brooklyn Nets', 'Thomas, Cam', 'Questionable'),
    row('Brooklyn Nets', 'Claxton, Nic', 'Probable'),
    row('Brooklyn Nets', 'Nobody, Unknown', 'Out'),
    row('Charlotte Hornets', 'Green, Josh', 'Out'),
    row('Brooklyn Nets', 'Porter Jr., Michael', 'Doubtful', 'BKN@MIL'), // another game: ignored
  ],
  notSubmitted: [],
};
const players = [{ id: '1', name: 'Haywood Highsmith' }, { id: '2', name: 'Cam Thomas' }, { id: '3', name: 'Nic Claxton' }, { id: '4', name: 'Michael Porter Jr.' }];

test('PDF snapshot to play probabilities for one team of one game (design §14.2 B)', () => {
  const r = snapshotInjuries(snap, { team: 'BKN', home: 'CHA', away: 'BKN', players });
  assert.deepEqual(r.injuries, { 1: 0, 2: 0.55, 3: 0.9 });
  assert.deepEqual(r.unmatched, ['Nobody, Unknown']);
  assert.equal(r.notSubmitted, false);
  assert.equal(r.rows, 4);
});

test('team marked NOT YET SUBMITTED: no information, flagged', () => {
  const r = snapshotInjuries({ rows: [], notSubmitted: [{ matchup: 'BKN@CHA', team: 'Brooklyn Nets' }] }, { team: 'BKN', home: 'CHA', away: 'BKN', players });
  assert.deepEqual(r.injuries, {});
  assert.equal(r.notSubmitted, true);
});

test('missing snapshot: no information', () => {
  const r = snapshotInjuries(null, { team: 'BKN', home: 'CHA', away: 'BKN', players });
  assert.deepEqual(r.injuries, {});
  assert.equal(r.missing, true);
});

test('team players take precedence over league-wide players with the same name', () => {
  const s = { rows: [row('Brooklyn Nets', 'Thomas, Cam', 'Out')], notSubmitted: [] };
  const r = snapshotInjuries(s, { team: 'BKN', home: 'CHA', away: 'BKN', players: [{ id: '2', name: 'Cam Thomas' }, { id: '99', name: 'Cam Thomas' }] });
  assert.deepEqual(r.injuries, { 2: 0 });
});

import { availableAt } from '../engine/snapshot.js';

test('a PDF is available from the later of its title time and its Last-Modified time (leak review F1/F2)', () => {
  // hourly era: file "_03PM" holds the 15:30 report, posted 15:30:03
  const pdf = { reportTime: '01/10/24 03:30 PM', lastModified: '2024-01-10T20:30:03Z' };
  assert.equal(availableAt(pdf).toISOString(), '2024-01-10T20:30:03.000Z');
  assert.ok(availableAt(pdf) > fromEt('2024-01-10', 15, 29)); // too late for a 15:30 tip
  // title only (no header recorded)
  assert.equal(availableAt({ reportTime: '12/22/25 05:45 PM' }).toISOString(), fromEt('2025-12-22', 17, 45).toISOString());
  assert.equal(availableAt({}), null);
});

test('statuses of matched players on request (play-probability calibration)', () => {
  const r = snapshotInjuries(snap, { team: 'BKN', home: 'CHA', away: 'BKN', players, statusOf: true });
  assert.deepEqual(r.statuses, [{ id: '1', status: 'Out' }, { id: '2', status: 'Questionable' }, { id: '3', status: 'Probable' }]);
  assert.equal(snapshotInjuries(snap, { team: 'BKN', home: 'CHA', away: 'BKN', players }).statuses, undefined);
});
