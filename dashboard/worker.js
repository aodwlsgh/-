// Scenario re-runs off the page thread (P8, design §7.4, §11.1): applyScenario on a copy of the published simulator
// input, then simulateGame with the base seed, rules and latent variables (common random numbers with the base).
import { simulateGame } from '../engine/sim.js';
import { applyScenario } from '../engine/scenario.js';

self.onmessage = ({ data }) => {
  const { id, input, scenario, seed, n, rules } = data;
  const t0 = performance.now();
  try {
    const s = applyScenario(input, scenario);
    const res = simulateGame(s, { n, seed, rules: { ...rules, ...s.rules } });
    self.postMessage({ id, ok: true, res: { n: res.n, margin: res.margin, total: res.total, overtimeRate: res.overtimeRate }, notes: s.notes, ms: performance.now() - t0 });
  } catch (e) {
    self.postMessage({ id, ok: false, error: String(e?.message ?? e) });
  }
};
