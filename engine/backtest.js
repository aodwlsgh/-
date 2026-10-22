// P5 backtest judgement (design §14.4, user decisions 2-4 and request 7, 2026-10-22).
// rows: walk-forward rows with sim summaries { margin, total, marginSD, totalSD, ot, marginHist, totalHist }
//   judged    not pre_job_start and not data-excluded
//   S1        Brier of the calibrated ensemble win probability < Brier of the simple baseline (fixed σ)
//   S2        calibration slope of that win probability within 0.9-1.1
//   S3        simulated margin and total SD within ±10% of the actual residual SD (residual against the
//             ensemble mean for the margin, the simulated mean for the total)
//   markets   per-market S2 (engine/calibrate.js marketS2); a market is pick-eligible only when S1 and S3 pass
//             and its own slope is within 0.9-1.1; other markets stay record-only
import { markets, marketS2, calibrationSlope, MARGIN_T as MT, survival } from './calibrate.js';
import { winProb } from './predict.js';
import { rng } from './sim.js';

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sdOf = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const rms = xs => Math.sqrt(mean(xs.map(x => x * x)));
const r4 = x => +x.toFixed(4);

// ensemble location (user decision 4): w·simulated mean + (1 - w)·baseline; the simulated distribution moves there
export const withShift = (rows, w) => rows.map(r => ({ ...r, sim: { ...r.sim, shift: (1 - w) * (r.base.margin - r.sim.margin) } }));
export const isJudged = r => r.group !== 'pre_job_start' && !r.dataExcluded;

function percentile(xs, q) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

export function judge(rows, { cal, sigmaBase, bootstrap = 1000, slopeBootstrap = 200, seed = 1 }) {
  if (!rows.length) return { n: 0 };
  const y = rows.map(r => (r.actual.margin > 0 ? 1 : 0));
  const m = rows.map(r => markets(cal, r.sim));
  const pModel = m.map(x => x.ml.home), pBase = rows.map(r => winProb(r.base.margin, sigmaBase));
  const se = (p, i) => (p - y[i]) ** 2;
  const bm = pModel.map(se), bb = pBase.map(se);
  const rand = rng(seed);
  const diffs = [];
  for (let b = 0; b < bootstrap; b++) {
    let d = 0;
    for (let i = 0; i < rows.length; i++) { const j = Math.floor(rand() * rows.length); d += bm[j] - bb[j]; }
    diffs.push(d / rows.length);
  }
  const S1 = { model: r4(mean(bm)), base: r4(mean(bb)), diff: r4(mean(bm) - mean(bb)), ci95: [r4(percentile(diffs, 0.025)), r4(percentile(diffs, 0.975))] };
  S1.pass = S1.model < S1.base;
  const slope = calibrationSlope(pModel, y);
  const center = rows.map(r => r.sim.margin + (r.sim.shift ?? 0));
  const S3 = {
    margin: { sim: r4(rms(rows.map(r => r.sim.marginSD))), actual: r4(sdOf(rows.map((r, i) => r.actual.margin - center[i]))) },
    total: { sim: r4(rms(rows.map(r => r.sim.totalSD))), actual: r4(sdOf(rows.map(r => r.actual.total - r.sim.total))) },
  };
  for (const k of ['margin', 'total']) { S3[k].ratio = r4(S3[k].sim / S3[k].actual); S3[k].pass = S3[k].ratio >= 0.9 && S3[k].ratio <= 1.1; }
  S3.pass = S3.margin.pass && S3.total.pass;
  // per-market slopes with a game-level bootstrap interval
  const ms = marketS2(rows, cal);
  const boot = { ml: [], ml5: [], hc: [], ou: [] };
  for (let b = 0; b < slopeBootstrap; b++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(rand() * rows.length)]);
    const s = marketS2(sample, cal);
    for (const k of Object.keys(boot)) boot[k].push(s[k].slope);
  }
  for (const k of Object.keys(ms)) ms[k].ci95 = slopeBootstrap ? [r4(percentile(boot[k], 0.025)), r4(percentile(boot[k], 0.975))] : null;
  const S2 = { slope: r4(slope), ci95: ms.ml.ci95, pass: slope >= 0.9 && slope <= 1.1 };
  // close finishes and overtime (P4 finding): calibrated vs raw simulated vs actual
  const close = {};
  const bins = { all: () => true, 'exp<3': i => Math.abs(center[i]) < 3, 'exp3-8': i => Math.abs(center[i]) >= 3 && Math.abs(center[i]) < 8, 'exp>=8': i => Math.abs(center[i]) >= 8 };
  const within = (s, N) => s.marginSurvival[MT.indexOf(-N - 0.5)] - s.marginSurvival[MT.indexOf(N + 0.5)];
  for (const [b, f] of Object.entries(bins)) {
    const idx = rows.map((_, i) => i).filter(f);
    close[b] = { games: idx.length };
    for (const N of [1, 3, 5, 7, 10]) {
      close[b][`le${N}`] = {
        calibrated: r4(mean(idx.map(i => within(m[i], N)))),
        raw: r4(mean(idx.map(i => rawWithin(rows[i].sim, N)))),
        actual: r4(mean(idx.map(i => (Math.abs(rows[i].actual.margin) <= N ? 1 : 0)))),
      };
    }
  }
  const acc = {
    ensemble: { marginMAE: r4(mean(rows.map((r, i) => Math.abs(r.actual.margin - center[i])))), marginBias: r4(mean(rows.map((r, i) => r.actual.margin - center[i]))) },
    simulator: { marginMAE: r4(mean(rows.map(r => Math.abs(r.actual.margin - r.sim.margin)))), totalMAE: r4(mean(rows.map(r => Math.abs(r.actual.total - r.sim.total)))), totalBias: r4(mean(rows.map(r => r.actual.total - r.sim.total))) },
    baseline: { marginMAE: r4(mean(rows.map(r => Math.abs(r.actual.margin - r.base.margin)))), totalMAE: r4(mean(rows.map(r => Math.abs(r.actual.total - r.base.total)))) },
  };
  const eligible = S1.pass && S3.pass ? Object.entries(ms).filter(([, v]) => v.pass).map(([k]) => k) : [];
  return {
    n: rows.length, S1, S2, S3, pass: S1.pass && S2.pass && S3.pass, markets: ms, eligibleMarkets: eligible,
    close, overtime: { sim: r4(mean(rows.map(r => r.sim.ot))), actual: r4(mean(rows.map(r => (r.overtime ? 1 : 0)))) }, accuracy: acc,
  };
}

const rawWithin = (sim, N) => survival(sim.marginHist, -N - 0.5, sim.shift ?? 0) - survival(sim.marginHist, N + 0.5, sim.shift ?? 0);

// full report: judged set, reference rows, and the splits of design §14.4 and user request 7
export function report(rows, opts, { firstMonthTo = null } = {}) {
  const judged = rows.filter(isJudged);
  const split = (rs, key) => Object.fromEntries([...new Set(rs.map(key))].sort().map(k => [k, judge(rs.filter(r => key(r) === k), { ...opts, slopeBootstrap: 0, bootstrap: 300 })]));
  const out = {
    counts: { rows: rows.length, judged: judged.length, preJobStart: rows.filter(r => r.group === 'pre_job_start').length, dataExcluded: rows.filter(r => r.dataExcluded).length },
    all: judge(judged, opts),
    byPeriodGroup: split(judged, r => `${r.pdfFormat}/${r.group}`),
    byMonth: split(judged, r => r.month),
    preJobStartReference: judge(rows.filter(r => r.group === 'pre_job_start' && !r.dataExcluded), { ...opts, slopeBootstrap: 0, bootstrap: 300 }),
  };
  if (rows.some(r => r.snapshot)) {
    const big = r => (r.snapshot.home.top3Absent + r.snapshot.away.top3Absent > 0 ? 'top3OutOrDoubtful' : 'noTop3Absence');
    out.byAbsence = split(judged, big);
  }
  if (firstMonthTo) out.byFirstMonth = split(judged, r => (r.date <= firstMonthTo ? 'firstMonth' : 'rest'));
  return out;
}
