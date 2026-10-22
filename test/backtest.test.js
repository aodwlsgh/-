import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judge, report, withShift, isJudged } from '../engine/backtest.js';
import { IDENTITY, survival } from '../engine/calibrate.js';
import { winProb } from '../engine/predict.js';
import { rng } from '../engine/sim.js';

const normal = r => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
const Phi = z => 0.5 * (1 + Math.tanh(0.7978845608 * (z + 0.044715 * z ** 3)));

function rows(seed, n, simSD = 14) {
  const r = rng(seed);
  const out = [];
  for (let i = 0; i < n; i++) {
    const mu = 6 * normal(r);
    let margin = Math.round(mu + 14 * normal(r)) || 1;
    const p = [];
    for (let k = -60; k <= 60; k++) p.push(k === 0 ? 0 : Phi((k + 0.5 - mu) / simSD) - Phi((k - 0.5 - mu) / simSD));
    const s = p.reduce((a, b) => a + b, 0);
    const tp = [];
    for (let k = 150; k <= 300; k++) tp.push(Phi((k + 0.5 - 225) / 18) - Phi((k - 0.5 - 225) / 18));
    out.push({
      id: `g${i}`, date: `2023-${i < n / 2 ? '11' : '12'}-01`, month: i < n / 2 ? '2023-11' : '2023-12', group: i % 10 === 0 ? 'pre_job_start' : i % 3 ? 'A' : 'B',
      pdfFormat: 'hourly', dataExcluded: i === 5, overtime: false,
      snapshot: { home: { top3Absent: i % 4 === 0 ? 1 : 0 }, away: { top3Absent: 0 } },
      actual: { margin, total: Math.round(225 + 18 * normal(r)), homeWin: margin > 0 ? 1 : 0 },
      base: { margin: mu + 3 * normal(r), total: 225 },
      sim: { margin: mu, total: 225, marginSD: simSD, totalSD: 18, ot: 0, marginHist: { lo: -60, p: p.map(x => x / s) }, totalHist: { lo: 150, p: tp } },
    });
  }
  return out;
}

test('judged set leaves out pre_job_start and data-excluded games', () => {
  const rs = rows(1, 200);
  const rep = report(rs, { cal: IDENTITY, sigmaBase: 14.2, bootstrap: 100, slopeBootstrap: 10 });
  assert.equal(rep.counts.judged, rs.filter(isJudged).length);
  assert.equal(rep.counts.preJobStart, 20);
  assert.equal(rep.counts.dataExcluded, 1);
  assert.equal(rep.all.n, rep.counts.judged);
  assert.ok(rep.byAbsence.top3OutOrDoubtful.n > 0 && rep.byAbsence.noTop3Absence.n > 0);
  assert.deepEqual(Object.keys(rep.byMonth), ['2023-11', '2023-12']);
});

test('S1 compares the calibrated ensemble with the simple baseline; S3 uses the ensemble mean', () => {
  const rs = rows(2, 1500).filter(isJudged);
  const j = judge(rs, { cal: IDENTITY, sigmaBase: 14.2, bootstrap: 200, slopeBootstrap: 10 });
  const y = rs.map(r => (r.actual.margin > 0 ? 1 : 0));
  const base = rs.reduce((a, r, i) => a + (winProb(r.base.margin, 14.2) - y[i]) ** 2, 0) / rs.length;
  const model = rs.reduce((a, r, i) => a + (survival(r.sim.marginHist, 0) - y[i]) ** 2, 0) / rs.length;
  assert.ok(Math.abs(j.S1.base - base) < 1e-4 && Math.abs(j.S1.model - model) < 1e-4);
  assert.equal(j.S1.pass, model < base);
  assert.ok(j.S1.ci95[0] <= j.S1.diff && j.S1.diff <= j.S1.ci95[1]);
  assert.ok(Math.abs(j.S3.margin.ratio - 1) < 0.08, `${j.S3.margin.ratio}`); // simulated SD 14 = true SD 14
  assert.equal(j.pass, j.S1.pass && j.S2.pass && j.S3.pass);
  // the ensemble shift moves the residual centre
  const shifted = judge(withShift(rs, 0), { cal: IDENTITY, sigmaBase: 14.2, bootstrap: 50, slopeBootstrap: 0 });
  assert.notEqual(shifted.accuracy.ensemble.marginMAE, j.accuracy.ensemble.marginMAE);
});

test('a market is eligible only when S1 and S3 pass and its own slope is within 0.9-1.1', () => {
  const rs = rows(3, 1500, 9).filter(isJudged); // simulated SD far too narrow: S3 fails
  const j = judge(rs, { cal: IDENTITY, sigmaBase: 14.2, bootstrap: 50, slopeBootstrap: 0 });
  assert.equal(j.S3.pass, false);
  assert.deepEqual(j.eligibleMarkets, []);
});
