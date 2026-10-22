// P5 backtest judgement (design §14.4, §14.4.1; user decisions 2-4 and requests 7, 2026-10-22).
// rows: walk-forward rows with sim summaries { margin, total, marginSD, totalSD, ot, marginHist, totalHist }
//   judged    not pre_job_start and not data-excluded
//   S1        Brier of the calibrated ensemble win probability < Brier of the simple baseline (fixed σ), point
//             estimate; "advantage unconfirmed" when the paired bootstrap interval contains 0
//   S3        simulated margin and total SD within ±10% of the actual residual SD (residual against the
//             ensemble mean for the margin, the simulated mean for the total), point estimate; interval reported
//   S2        per market (승패, 승5패, 핸디캡, 언더오버): pass 0.9-1.1; conditional 0.8-1.2 with the interval
//             containing 1; otherwise fail. Only pass markets are pick-eligible, and only when S1 and S3 pass.
import { markets, marketS2, calibrationSlope, MARGIN_T as MT, survival } from './calibrate.js';
import { winProb } from './predict.js';
import { rng } from './sim.js';

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
const sdOf = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const rms = xs => Math.sqrt(mean(xs.map(x => x * x)));
const r4 = x => +x.toFixed(4);
const MARKETS = ['ml', 'ml5', 'hc', 'ou'];

// ensemble location (user decision 4): w·simulated mean + (1 - w)·baseline; the simulated distribution moves there
export const withShift = (rows, w) => rows.map(r => ({ ...r, sim: { ...r.sim, shift: (1 - w) * (r.base.margin - r.sim.margin) } }));
export const isJudged = r => r.group !== 'pre_job_start' && !r.dataExcluded;

function percentile(xs, q) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; }

export function grade(slope, ci) {
  if (slope >= 0.9 && slope <= 1.1) return 'pass';
  if (slope >= 0.8 && slope <= 1.2 && ci && ci[0] <= 1 && ci[1] >= 1) return 'conditional';
  return 'fail';
}
export const s1Label = s1 => (s1.diff >= 0 ? 'fail' : s1.ci95[1] >= 0 ? 'pass, advantage unconfirmed' : 'pass');

// actions by result (§14.4.1): S1 and S3 are the global gate, S2 grades each market
export function outcome(s1Pass, s3Pass, grades) {
  const gate = s1Pass && s3Pass;
  const pickEligible = gate ? MARKETS.filter(k => grades[k] === 'pass') : [];
  const action = !s1Pass && !s3Pass ? 'S1-and-S3-fail' : !s1Pass ? 'S1-fail' : !s3Pass ? 'S3-fail' : pickEligible.length === MARKETS.length ? 'all-pass' : 'some-markets';
  return {
    action, pickEligible,
    conditional: MARKETS.filter(k => grades[k] === 'conditional'),
    recordOnly: MARKETS.filter(k => !pickEligible.includes(k)),
    noTuningOn: 'the judged season; failed or conditional items are re-checked on accumulating 2026-27 games',
  };
}

// (probability, outcome) pairs per market, with the definitions of engine/calibrate.js marketS2
function marketPairs(rows, m) {
  const acc = { ml: [], ml5: [], hc: [], ou: [] };
  rows.forEach((r, i) => {
    const a = r.actual, x = m[i];
    acc.ml.push([x.ml.home, a.margin > 0 ? 1 : 0]);
    acc.ml5.push([x.ml5.home, a.margin >= 6 ? 1 : 0], [x.ml5.close, Math.abs(a.margin) <= 5 ? 1 : 0], [x.ml5.away, a.margin <= -6 ? 1 : 0]);
    const center = r.sim.margin + (r.sim.shift ?? 0);
    MT.forEach((t, k) => { if (Math.abs(t - center) <= 8.5) acc.hc.push([x.marginSurvival[k], a.margin > t ? 1 : 0]); });
    x.total.lines.forEach((L, k) => { if (Math.abs(L - r.sim.total) <= 8.5) acc.ou.push([x.total.s[k], a.total > L ? 1 : 0]); });
  });
  return acc;
}
const reliability = pairs => Array.from({ length: 10 }, (_, b) => {
  const lo = b / 10, hi = (b + 1) / 10;
  const inBin = pairs.filter(([p]) => p >= lo && (p < hi || (b === 9 && p <= 1)));
  return { lo, hi, n: inBin.length, meanPredicted: inBin.length ? r4(mean(inBin.map(x => x[0]))) : null, observed: inBin.length ? r4(mean(inBin.map(x => x[1]))) : null };
});

export function judge(rows, { cal, sigmaBase, bootstrap = 1000, slopeBootstrap = 1000, seed = 1 }) {
  if (!rows.length) return { n: 0 };
  const y = rows.map(r => (r.actual.margin > 0 ? 1 : 0));
  const m = rows.map(r => markets(cal, r.sim));
  const pModel = m.map(x => x.ml.home), pBase = rows.map(r => winProb(r.base.margin, sigmaBase));
  const se = (p, i) => (p - y[i]) ** 2;
  const bm = pModel.map(se), bb = pBase.map(se);
  const center = rows.map(r => r.sim.margin + (r.sim.shift ?? 0));
  const residM = rows.map((r, i) => r.actual.margin - center[i]), residT = rows.map(r => r.actual.total - r.sim.total);
  const sdM = rows.map(r => r.sim.marginSD), sdT = rows.map(r => r.sim.totalSD);
  const rand = rng(seed);
  const diffs = [], ratioM = [], ratioT = [];
  for (let b = 0; b < bootstrap; b++) {
    const idx = Array.from({ length: rows.length }, () => Math.floor(rand() * rows.length));
    diffs.push(mean(idx.map(j => bm[j] - bb[j])));
    ratioM.push(rms(idx.map(j => sdM[j])) / sdOf(idx.map(j => residM[j])));
    ratioT.push(rms(idx.map(j => sdT[j])) / sdOf(idx.map(j => residT[j])));
  }
  const ci = xs => (xs.length ? [r4(percentile(xs, 0.025)), r4(percentile(xs, 0.975))] : null);
  const S1 = { model: r4(mean(bm)), base: r4(mean(bb)), diff: r4(mean(bm) - mean(bb)), ci95: ci(diffs) };
  S1.pass = S1.diff < 0;
  if (S1.ci95) S1.label = s1Label(S1);
  const S3 = {
    margin: { sim: r4(rms(sdM)), actual: r4(sdOf(residM)), ci95: ci(ratioM) },
    total: { sim: r4(rms(sdT)), actual: r4(sdOf(residT)), ci95: ci(ratioT) },
  };
  for (const k of ['margin', 'total']) { S3[k].ratio = r4(S3[k].sim / S3[k].actual); S3[k].pass = S3[k].ratio >= 0.9 && S3[k].ratio <= 1.1; }
  S3.pass = S3.margin.pass && S3.total.pass;
  // per-market slopes with a game-level bootstrap interval, then grades
  const ms = marketS2(rows, cal);
  const boot = { ml: [], ml5: [], hc: [], ou: [] };
  for (let b = 0; b < slopeBootstrap; b++) {
    const sample = Array.from({ length: rows.length }, () => rows[Math.floor(rand() * rows.length)]);
    const s = marketS2(sample, cal);
    for (const k of MARKETS) boot[k].push(s[k].slope);
  }
  for (const k of MARKETS) { ms[k].ci95 = ci(boot[k]); delete ms[k].pass; ms[k].grade = grade(ms[k].slope, ms[k].ci95); }
  const S2 = { slope: ms.ml.slope, ci95: ms.ml.ci95, grade: ms.ml.grade, pass: ms.ml.grade === 'pass' };
  const res = outcome(S1.pass, S3.pass, Object.fromEntries(MARKETS.map(k => [k, ms[k].grade])));
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
  const pairs = marketPairs(rows, m);
  const brierOf = ps => r4(mean(ps.map(se)));
  const brier = {
    simulatorRaw: brierOf(rows.map(r => survival(r.sim.marginHist, 0))),
    ensembleRaw: brierOf(rows.map(r => survival(r.sim.marginHist, 0, r.sim.shift ?? 0))),
    ensembleCalibrated: S1.model, baseline: S1.base,
  };
  const acc = {
    ensemble: { marginMAE: r4(mean(residM.map(Math.abs))), marginBias: r4(mean(residM)) },
    simulator: { marginMAE: r4(mean(rows.map(r => Math.abs(r.actual.margin - r.sim.margin)))), totalMAE: r4(mean(residT.map(Math.abs))), totalBias: r4(mean(residT)) },
    baseline: { marginMAE: r4(mean(rows.map(r => Math.abs(r.actual.margin - r.base.margin)))), totalMAE: r4(mean(rows.map(r => Math.abs(r.actual.total - r.base.total)))) },
  };
  return {
    n: rows.length, S1, S2, S3, pass: S1.pass && S2.pass && S3.pass, markets: ms, outcome: res, eligibleMarkets: res.pickEligible,
    brier, reliability: Object.fromEntries(MARKETS.map(k => [k, reliability(pairs[k])])),
    close, overtime: { sim: r4(mean(rows.map(r => r.sim.ot))), actual: r4(mean(rows.map(r => (r.overtime ? 1 : 0)))) }, accuracy: acc,
  };
}

const rawWithin = (sim, N) => survival(sim.marginHist, -N - 0.5, sim.shift ?? 0) - survival(sim.marginHist, N + 0.5, sim.shift ?? 0);

// full report: judged set, reference rows, and the splits of design §14.4.1 and user request 7. Decisions use
// `all` only; the splits are descriptive (fewer slope resamples)
export function report(rows, opts, { firstMonthTo = null, splitSlopeBootstrap = 200 } = {}) {
  const judged = rows.filter(isJudged);
  const sub = rs => judge(rs, { ...opts, slopeBootstrap: splitSlopeBootstrap });
  const split = (rs, key) => Object.fromEntries([...new Set(rs.map(key))].sort().map(k => [k, sub(rs.filter(r => key(r) === k))]));
  const out = {
    counts: { rows: rows.length, judged: judged.length, preJobStart: rows.filter(r => r.group === 'pre_job_start').length, dataExcluded: rows.filter(r => r.dataExcluded).length },
    all: judge(judged, opts),
    byPeriod: split(judged, r => r.pdfFormat),
    byPeriodGroup: split(judged, r => `${r.pdfFormat}/${r.group}`),
    byMonth: split(judged, r => r.month),
    preJobStartReference: sub(rows.filter(r => r.group === 'pre_job_start' && !r.dataExcluded)),
  };
  if (rows.some(r => r.snapshot)) {
    const big = r => (r.snapshot.home.top3Absent + r.snapshot.away.top3Absent > 0 ? 'top3OutOrDoubtful' : 'noTop3Absence');
    out.byAbsence = split(judged, big);
  }
  if (firstMonthTo) out.byFirstMonth = split(judged, r => (r.date <= firstMonthTo ? 'firstMonth' : 'rest'));
  return out;
}
