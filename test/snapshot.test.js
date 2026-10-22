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
