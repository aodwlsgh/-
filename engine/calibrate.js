// Calibration layer (P5, design §14.2/§14.4): fitted once on 2024-25 walk-forward simulations, frozen,
// then applied unchanged to the rehearsal (2023-24), the test season (2025-26) and live predictions.
// User decision 2 (2026-10-22): the whole margin distribution is calibrated, not only the 승5패 middle:
//   margin  survival P(margin > t) at t = -15.5..-1.5, 0, 1.5..15.5 (t = ±0.5 is the win event, no ties);
//           logistic on logit(simulated survival) with an intercept that varies by threshold
//           (piecewise linear, knots -15.5, -5.5, 0, 5.5, 15.5) and a slope piecewise linear in |t| (knots 0,
//           5.5, 15.5, so the win event has its own slope); 8 parameters.
//           Per game the calibrated survival is made non-increasing (pool adjacent violators).
//   total   survival P(total > L) at lines floor(mean) + 0.5 + k, k = -15..14; logistic with intercept,
//           slope and a term linear in (L - mean); 3 parameters.
// All markets (승패, 승5패, 핸디캡, 언더오버) are read from these two calibrated distributions.
// User decision 4: one ensemble weight w (fitted on 2024-25) moves the simulated margin distribution to
// w·model + (1 - w)·baseline; scenarios keep their simulated change on top of that location (engine/scenario.js).
export const logit = p => { const q = Math.min(1 - 1e-4, Math.max(1e-4, p)); return Math.log(q / (1 - q)); };
export const sigmoid = z => 1 / (1 + Math.exp(-z));

// x: feature rows, y: 0/1; Newton-Raphson with a tiny ridge for stability
export function fitLogistic(x, y, { intercept = true, iters = 60, ridge = 1e-6 } = {}) {
  const rows = intercept ? x.map(f => [1, ...f]) : x;
  const k = rows[0].length;
  const w = new Array(k).fill(0);
  for (let it = 0; it < iters; it++) {
    const g = new Array(k).fill(0), H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < rows.length; i++) {
      const f = rows[i];
      const p = sigmoid(f.reduce((a, v, j) => a + v * w[j], 0));
      for (let j = 0; j < k; j++) {
        g[j] += (y[i] - p) * f[j];
        for (let l = 0; l < k; l++) H[j][l] += p * (1 - p) * f[j] * f[l];
      }
    }
    for (let j = 0; j < k; j++) { H[j][j] += ridge; g[j] -= ridge * w[j]; }
    const step = solve(H, g);
    for (let j = 0; j < k; j++) w[j] += step[j];
    if (Math.max(...step.map(Math.abs)) < 1e-10) break;
  }
  return w;
}

function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}

// S2: slope of the actual outcome regressed on logit(p)
export const calibrationSlope = (p, y) => fitLogistic(p.map(q => [logit(q)]), y)[1];

// P(X + shift > t) for an integer histogram { lo, p } spread uniformly over [k - 0.5, k + 0.5]
export function survival(hist, t, shift = 0) {
  const u = t - shift;
  let s = 0;
  for (let i = 0; i < hist.p.length; i++) {
    const k = hist.lo + i;
    if (k - 0.5 >= u) s += hist.p[i];
    else if (k + 0.5 > u) s += hist.p[i] * (k + 0.5 - u);
  }
  return s;
}

export const MARGIN_T = [...Array.from({ length: 15 }, (_, i) => -15.5 + i), 0, ...Array.from({ length: 15 }, (_, i) => 1.5 + i)];
const hats = knots => t => knots.map((k, j) => {
  const lo = knots[j - 1], hi = knots[j + 1];
  if (t === k) return 1;
  if (lo !== undefined && t > lo && t < k) return (t - lo) / (k - lo);
  if (hi !== undefined && t > k && t < hi) return (hi - t) / (hi - k);
  return 0;
});
const interceptBasis = hats([-15.5, -5.5, 0, 5.5, 15.5]), slopeBasis = hats([0, 5.5, 15.5]);
const marginFeatures = (t, z) => [...interceptBasis(t), ...slopeBasis(Math.abs(t)).map(b => b * z)];
const totalLines = mean => Array.from({ length: 30 }, (_, i) => Math.floor(mean) + 0.5 + (i - 15));
const totalFeatures = (r, z) => [1, z, r / 15];

export const IDENTITY = { margin: [0, 0, 0, 0, 0, 1, 1, 1], total: [0, 1, 0] };

// non-increasing least-squares fit (pool adjacent violators)
function monotoneDown(v) {
  const blocks = [];
  for (const x of v) {
    blocks.push({ s: x, n: 1 });
    while (blocks.length > 1 && blocks.at(-2).s / blocks.at(-2).n < blocks.at(-1).s / blocks.at(-1).n) {
      const b = blocks.pop();
      blocks.at(-1).s += b.s; blocks.at(-1).n += b.n;
    }
  }
  return blocks.flatMap(b => new Array(b.n).fill(b.s / b.n));
}

const dot = (a, b) => a.reduce((s, v, i) => s + v * b[i], 0);

// sim: { marginHist, totalHist, total (mean), shift (ensemble location shift, default 0) }
export function marginSurvival(cal, sim) {
  return monotoneDown(MARGIN_T.map(t => sigmoid(dot(cal.margin, marginFeatures(t, logit(survival(sim.marginHist, t, sim.shift ?? 0)))))));
}
export function totalSurvival(cal, sim) {
  const lines = totalLines(sim.total);
  return { lines, s: monotoneDown(lines.map(L => sigmoid(dot(cal.total, totalFeatures(L - sim.total, logit(survival(sim.totalHist, L))))))) };
}

// rows: [{ sim, actual: { margin, total } }]
export function fitCalibration(rows) {
  const mx = [], my = [], tx = [], ty = [];
  for (const r of rows) {
    for (const t of MARGIN_T) {
      mx.push(marginFeatures(t, logit(survival(r.sim.marginHist, t, r.sim.shift ?? 0))));
      my.push(r.actual.margin > t ? 1 : 0);
    }
    for (const L of totalLines(r.sim.total)) {
      tx.push(totalFeatures(L - r.sim.total, logit(survival(r.sim.totalHist, L))));
      ty.push(r.actual.total > L ? 1 : 0);
    }
  }
  return { margin: fitLogistic(mx, my, { intercept: false }), total: fitLogistic(tx.map(f => f.slice(1)), ty), games: rows.length };
}

// market probabilities from the calibrated distributions; hc(H): home + H beats away; ou(L): total over L.
// Lines outside the calibrated range return null (no pick, design §14.4).
export function markets(cal, sim) {
  const s = marginSurvival(cal, sim);
  const at = t => { const i = MARGIN_T.indexOf(Math.abs(t) === 0.5 ? 0 : t); return i < 0 ? null : s[i]; };
  const tot = totalSurvival(cal, sim);
  return {
    ml: { home: at(0), away: 1 - at(0) },
    ml5: { home: at(5.5), close: at(-5.5) - at(5.5), away: 1 - at(-5.5) },
    hc: H => at(-H),
    ou: L => { const i = tot.lines.indexOf(L); return i < 0 ? null : tot.s[i]; },
    marginSurvival: s, total: tot,
  };
}

// one weight w on the model margin, 1 - w on the baseline margin; chosen by Brier of Φ(m / σ_w) with σ_w the
// RMSE of the blended margin, on a 0.05 grid (21 runs for the tuning ledger)
export function fitEnsembleWeight(rows) {
  const Phi = z => 0.5 * (1 + erf(z / Math.SQRT2));
  const grid = [];
  for (let i = 0; i <= 20; i++) {
    const w = i / 20;
    const m = rows.map(r => w * r.model.margin + (1 - w) * r.base.margin);
    const sigma = Math.sqrt(rows.reduce((a, r, j) => a + (r.actual.margin - m[j]) ** 2, 0) / rows.length);
    const brier = rows.reduce((a, r, j) => a + (Phi(m[j] / sigma) - (r.actual.margin > 0 ? 1 : 0)) ** 2, 0) / rows.length;
    grid.push({ w, sigma, brier });
  }
  const best = grid.reduce((a, b) => (b.brier < a.brier ? b : a));
  return { w: best.w, sigma: best.sigma, brier: best.brier, grid };
}

function erf(x) { // Abramowitz-Stegun 7.1.26
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a));
}

// Per-market S2 (user decision 2, design §14.4): slope of outcome on logit(calibrated probability), pooled
//   ml   home win
//   ml5  the three outcomes (home 6+, within 5, away 6+)
//   hc   handicap events margin > t for grid thresholds within 8.5 points of the expected margin
//   ou   over events total > L for lines within 8.5 points of the expected total
// rows: [{ sim, actual }]; sim.margin is the simulated mean margin before the ensemble shift
export function marketS2(rows, cal) {
  const acc = { ml: [[], []], ml5: [[], []], hc: [[], []], ou: [[], []] };
  const push = (k, p, y) => { acc[k][0].push(p); acc[k][1].push(y); };
  for (const r of rows) {
    const m = markets(cal, r.sim), a = r.actual;
    push('ml', m.ml.home, a.margin > 0 ? 1 : 0);
    push('ml5', m.ml5.home, a.margin >= 6 ? 1 : 0);
    push('ml5', m.ml5.close, Math.abs(a.margin) <= 5 ? 1 : 0);
    push('ml5', m.ml5.away, a.margin <= -6 ? 1 : 0);
    const center = r.sim.margin + (r.sim.shift ?? 0);
    MARGIN_T.forEach((t, i) => { if (Math.abs(t - center) <= 8.5) push('hc', m.marginSurvival[i], a.margin > t ? 1 : 0); });
    m.total.lines.forEach((L, i) => { if (Math.abs(L - r.sim.total) <= 8.5) push('ou', m.total.s[i], a.total > L ? 1 : 0); });
  }
  return Object.fromEntries(Object.entries(acc).map(([k, [p, y]]) => [k, { n: p.length, slope: +calibrationSlope(p, y).toFixed(4), pass: Math.abs(calibrationSlope(p, y) - 1) <= 0.1 }]));
}
