import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitLogistic, calibrationSlope, logit, sigmoid, survival, MARGIN_T, fitCalibration, marginSurvival, totalSurvival,
  markets, fitEnsembleWeight, IDENTITY,
} from '../engine/calibrate.js';
import { rng } from '../engine/sim.js';

const normal = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const Phi = z => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3)));

test('logistic fit recovers intercept and slope', () => {
  const r = rng(1);
  const x = [], y = [];
  for (let i = 0; i < 20000; i++) { const v = 1.5 * normal(r); x.push(v); y.push(r() < sigmoid(0.3 + 1.2 * v) ? 1 : 0); }
  const [a, b] = fitLogistic(x.map(v => [v]), y);
  assert.ok(Math.abs(a - 0.3) < 0.07, `a ${a}`);
  assert.ok(Math.abs(b - 1.2) < 0.07, `b ${b}`);
});

test('calibration slope: 1 for calibrated probabilities, < 1 for overconfident ones (S2)', () => {
  const r = rng(2);
  const p = [], y = [];
  for (let i = 0; i < 20000; i++) { const q = sigmoid(1.2 * normal(r)); p.push(q); y.push(r() < q ? 1 : 0); }
  assert.ok(Math.abs(calibrationSlope(p, y) - 1) < 0.06);
  assert.ok(Math.abs(calibrationSlope(p.map(q => sigmoid(2 * logit(q))), y) - 0.5) < 0.04);
});

test('survival from an integer histogram with continuity correction and a location shift', () => {
  const hist = { lo: -2, p: [0.1, 0.2, 0, 0.3, 0.4] }; // margins -2,-1,0,1,2 (no ties)
  assert.ok(Math.abs(survival(hist, 0) - 0.7) < 1e-12);
  assert.ok(Math.abs(survival(hist, 1.5) - 0.4) < 1e-12);
  assert.ok(Math.abs(survival(hist, -5) - 1) < 1e-12);
  assert.ok(Math.abs(survival(hist, 1.5, 1) - 0.7) < 1e-12); // shifted up by one point
  assert.ok(Math.abs(survival(hist, 1.25) - (0.4 + 0.3 * 0.25)) < 1e-12);
});

// synthetic games: the truth has extra mass at small margins and a wider spread than the simulator,
// which also overstates the favourite; totals are too narrow in the simulator
function synthetic(seed, n) {
  const r = rng(seed);
  const rows = [];
  for (let i = 0; i < n; i++) {
    const mu = 6 * normal(r);
    let margin = Math.round(mu + 14 * normal(r));
    if (r() < 0.1) margin = (r() < 0.5 ? 1 : -1) * (1 + Math.floor(r() * 4));
    if (margin === 0) margin = r() < 0.5 ? 1 : -1;
    const simMu = 1.15 * mu;
    const p = [];
    for (let k = -60; k <= 60; k++) p.push(k === 0 ? 0 : Phi((k + 0.5 - simMu) / 12.5) - Phi((k - 0.5 - simMu) / 12.5));
    const s = p.reduce((a, b) => a + b, 0);
    const tMu = 225 + 5 * normal(r), tp = [];
    for (let k = 150; k <= 300; k++) tp.push(Phi((k + 0.5 - tMu) / 15) - Phi((k - 0.5 - tMu) / 15));
    rows.push({
      sim: { margin: simMu, total: tMu, marginHist: { lo: -60, p: p.map(x => x / s) }, totalHist: { lo: 150, p: tp } },
      actual: { margin, total: Math.round(tMu + 18 * normal(r)), homeWin: margin > 0 ? 1 : 0 },
    });
  }
  return rows;
}

test('margin calibration: monotone, better out of sample at every market, ML5 sums to 1', () => {
  const fit = synthetic(3, 3000), hold = synthetic(4, 3000);
  const cal = fitCalibration(fit);
  let rawB = 0, calB = 0, n = 0;
  for (const x of hold) {
    const sc = marginSurvival(cal, x.sim), sr = marginSurvival(IDENTITY, x.sim);
    for (let i = 1; i < MARGIN_T.length; i++) assert.ok(sc[i] <= sc[i - 1] + 1e-12);
    MARGIN_T.forEach((t, i) => { const y = x.actual.margin > t ? 1 : 0; rawB += (sr[i] - y) ** 2; calB += (sc[i] - y) ** 2; n++; });
  }
  assert.ok(calB / n < rawB / n - 0.002, `${calB / n} vs ${rawB / n}`);
  const close = rows => rows.reduce((a, x) => a + markets(cal, x.sim).ml5.close, 0) / rows.length;
  const actualClose = hold.filter(x => Math.abs(x.actual.margin) <= 5).length / hold.length;
  const rawClose = hold.reduce((a, x) => a + markets(IDENTITY, x.sim).ml5.close, 0) / hold.length;
  assert.ok(Math.abs(close(hold) - actualClose) < Math.abs(rawClose - actualClose) / 2, `${close(hold)} ${rawClose} ${actualClose}`);
  for (const x of hold.slice(0, 30)) { const m = markets(cal, x.sim).ml5; assert.ok(Math.abs(m.home + m.close + m.away - 1) < 1e-12); }
});

test('total calibration widens a too-narrow simulated total distribution', () => {
  const fit = synthetic(5, 3000), hold = synthetic(6, 3000);
  const cal = fitCalibration(fit);
  let rawB = 0, calB = 0, n = 0;
  for (const x of hold) {
    const { lines, s } = totalSurvival(cal, x.sim), raw = totalSurvival(IDENTITY, x.sim);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] <= s[i - 1] + 1e-12);
    lines.forEach((L, i) => { const y = x.actual.total > L ? 1 : 0; rawB += (raw.s[i] - y) ** 2; calB += (s[i] - y) ** 2; n++; });
  }
  assert.ok(calB / n < rawB / n, `${calB / n} vs ${rawB / n}`);
  assert.ok(cal.total[1] < 0.95, `slope ${cal.total[1]}`); // simulated spread 15 vs true 18: flatter in logit
});

test('identity calibration returns the simulated probabilities', () => {
  const x = synthetic(7, 1)[0];
  const m = markets(IDENTITY, x.sim);
  assert.ok(Math.abs(m.ml.home - survival(x.sim.marginHist, 0)) < 1e-12);
  assert.ok(Math.abs(m.hc(-3.5) - survival(x.sim.marginHist, 3.5)) < 1e-12);
});

test('ensemble weight of model and baseline margins (one parameter)', () => {
  const r = rng(8);
  const rows = [];
  for (let i = 0; i < 5000; i++) {
    const a = 6 * normal(r), b = 6 * normal(r);
    rows.push({ model: { margin: a }, base: { margin: b }, actual: { margin: 0.6 * a + 0.4 * b + 12 * normal(r) } });
  }
  const { w } = fitEnsembleWeight(rows);
  assert.ok(Math.abs(w - 0.6) <= 0.1, `w ${w}`);
});

import { marketS2 } from '../engine/calibrate.js';

// held-out slopes at a few thousand games vary by about ±0.1 from sampling alone, so the structural checks are
// in-sample slopes near 1 and agreement with a dedicated win-only calibration on held-out games
test('per-market S2 slopes: near 1 in sample after calibration, off before; ML matches a dedicated fit', () => {
  const fit = synthetic(9, 3000), hold = synthetic(10, 3000);
  const cal = fitCalibration(fit);
  const inSample = marketS2(fit, cal), before = marketS2(hold, IDENTITY);
  for (const k of ['ml', 'ml5', 'hc', 'ou']) {
    assert.ok(Math.abs(inSample[k].slope - 1) < 0.06, `${k} in sample ${inSample[k].slope}`);
    assert.ok(inSample[k].n > 0);
  }
  assert.ok(before.ml.slope < 0.95, `ml before ${before.ml.slope}`); // simulator overstates the favourite
  assert.ok(before.ou.slope < 0.95, `ou before ${before.ou.slope}`); // simulated totals too narrow
  const ded = fitLogistic(fit.map(x => [logit(survival(x.sim.marginHist, 0))]), fit.map(x => x.actual.homeWin));
  const y = hold.map(x => x.actual.homeWin);
  const pooled = calibrationSlope(hold.map(x => markets(cal, x.sim).ml.home), y);
  const dedicated = calibrationSlope(hold.map(x => sigmoid(ded[0] + ded[1] * logit(survival(x.sim.marginHist, 0)))), y);
  assert.ok(Math.abs(pooled - dedicated) < 0.05, `${pooled} vs ${dedicated}`);
});
