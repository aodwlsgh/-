import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preregistrationProblems } from '../jobs/lib/provenance.js';

const pre = { commit: 'abc', files: { 'data/model/params.json': 'h1', 'data/model/latent.json': 'h2', 'data/model/calibration.json': 'h3' } };
const ok = { dirty: false, ancestor: true, changed: [], files: { ...pre.files } };

test('pre-registration check passes only for a clean tree descending from the registered commit with the same files', () => {
  assert.deepEqual(preregistrationProblems(pre, ok), []);
  assert.match(preregistrationProblems(pre, { ...ok, dirty: true }).join(), /uncommitted/);
  assert.match(preregistrationProblems(pre, { ...ok, ancestor: false }).join(), /not an ancestor/);
  assert.match(preregistrationProblems(pre, { ...ok, changed: ['engine/sim.js'] }).join(), /engine\/sim\.js/);
  assert.match(preregistrationProblems(pre, { ...ok, files: { ...pre.files, 'data/model/calibration.json': 'zz' } }).join(), /calibration/);
  assert.match(preregistrationProblems(null, ok).join(), /no pre-registration/);
});
