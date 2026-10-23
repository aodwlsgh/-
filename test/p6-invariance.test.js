// P6 condition 6 (2026-10-23): with the variable engine off, the predictions validated at the 2025-26 opening do
// not move. Breaking any of these must be reported before the change is made.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { predictionHashes } from '../scripts/p5/prediction-hashes.mjs';
import { simulateGame } from '../engine/sim.js';
import { applyScenario } from '../engine/scenario.js';

let now, registered, simBaseline;
before(async () => {
  now = await predictionHashes({ simSample: true, keepSimInputs: true });
  registered = JSON.parse(await readFile(new URL('../docs/reports/p5-hashes-after-2022-23.json', import.meta.url), 'utf8'));
  simBaseline = JSON.parse(await readFile(new URL('./fixtures/p6-sim-baseline.json', import.meta.url), 'utf8')).sims;
});

test('2024-25 and 2025-26 predictions (A and B) and their inputs equal the registered commit 53c88f5', () => {
  assert.deepEqual(now.predictions, registered.predictions);
  assert.deepEqual(now.inputs, registered.inputs);
});

test('simulator output for a fixed sample equals the baseline taken with the registered code', () => {
  assert.deepEqual(now.sims, simBaseline);
});

test('an empty scenario gives a bit-identical simulation', () => {
  for (const sample of Object.values(now.simInputs)) {
    for (const x of sample.slice(0, 3)) {
      const input = { ratings: x.ratings, home: x.game.home.id, away: x.game.away.id, homePlan: x.homePlan, awayPlan: x.awayPlan };
      const base = simulateGame(input, { n: 500, seed: 7 });
      const s = applyScenario(input, {});
      const scen = simulateGame(s, { n: 500, seed: 7, rules: s.rules });
      assert.deepEqual(scen, base);
    }
  }
});
