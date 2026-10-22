// P3 condition 6: the 2025-26 test season cannot be evaluated by accident
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

test('jobs/p3.js test refuses without --open-test and logs nothing', () => {
  const before = existsSync('data/model/test-openings.json');
  const r = spawnSync(process.execPath, ['jobs/p3.js', 'test', '--params', 'data/model/params.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /sealed test season/);
  assert.equal(existsSync('data/model/test-openings.json'), before);
});
