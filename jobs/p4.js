// P4 checks on the 2024-25 development season (2025-26 stays sealed).
//   mean       rules and latent variables off: simulation mean vs the P3 analytic prediction, every game
//   calibrate  latent variance parameters (shared shooting, team shooting, pace, score effect) so that the
//              simulated spread matches the real residual spread; runs are added to the tuning ledger
//   var        with the calibrated latent: simulated SD vs real residual SD, margin and total
// Usage: node jobs/p4.js <mean|calibrate|var> [--n 10000] [--every 1]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadGames } from './lib/games.js';
import { walkForward } from '../engine/evaluate.js';
import { simulateGame, DEFAULT_LATENT } from '../engine/sim.js';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const writeJson = async (p, v) => { await mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(p, JSON.stringify(v, null, 1)); };
const DEV = { season: '2024-25' };
const LEDGER = 'docs/reports/tuning-ledger.json';
const P = JSON.parse(await readFile('data/model/params.json', 'utf8'));
const games = await loadGames(['2023-24', '2024-25']);
const every = +arg('--every', 1);
let k = 0;
const filter = () => (k++ % every === 0);
const RULES_OFF = { garbageTime: false, clutchFoul: false, overtime: false, latent: false };
const RULES_ON = { garbageTime: true, clutchFoul: true, overtime: true, latent: true };
const t0 = Date.now();
const rms = xs => Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length);

const simMs = [];
async function simRows(n, rules, latent) {
  k = 0;
  return walkForward({
    games, target: DEV, params: P.params, filter,
    onGame: ({ ratings, homePlan, awayPlan, game }) => {
      const t = performance.now();
      const s = simulateGame({ ratings, home: game.home.id, away: game.away.id, homePlan, awayPlan }, { n, seed: +game.id % 2147483647, rules, latent });
      simMs.push(performance.now() - t);
      return { sim: { margin: s.margin.mean, total: s.total.mean, marginSD: s.margin.sd, totalSD: s.total.sd, ot: s.overtimeRate } };
    },
  });
}
// one walk-forward pass; the inputs are kept so that a grid of latent settings reuses them
async function inputs() {
  k = 0;
  const kept = [];
  const rows = await walkForward({ games, target: DEV, params: P.params, filter, onGame: x => { kept.push(x); return {}; } });
  return rows.map((row, i) => ({ row, ...kept[i] }));
}
function simFrom(list, n, rules, latent) {
  return list.map(({ row, ratings, homePlan, awayPlan, game }) => {
    const s = simulateGame({ ratings, home: game.home.id, away: game.away.id, homePlan, awayPlan }, { n, seed: +game.id % 2147483647, rules, latent });
    return { ...row, sim: { margin: s.margin.mean, total: s.total.mean, marginSD: s.margin.sd, totalSD: s.total.sd, ot: s.overtimeRate } };
  });
}
function spread(rows) {
  const resM = rows.map(r => r.actual.margin - r.sim.margin), resT = rows.map(r => r.actual.total - r.sim.total);
  const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const sdOf = xs => { const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
  const simM = rms(rows.map(r => r.sim.marginSD)), simT = rms(rows.map(r => r.sim.totalSD));
  const actM = sdOf(resM), actT = sdOf(resT);
  const simTotal = mean(rows.map(r => r.sim.total)), modelTotal = mean(rows.map(r => r.model.total));
  return {
    games: rows.length, simMarginSD: +simM.toFixed(3), actualMarginResidSD: +actM.toFixed(3), marginRatio: +(simM / actM).toFixed(4), simTotalSD: +simT.toFixed(3), actualTotalResidSD: +actT.toFixed(3), totalRatio: +(simT / actT).toFixed(4), marginBias: +mean(resM).toFixed(3), totalBias: +mean(resT).toFixed(3),
    marginVsAnalytic: +mean(rows.map(r => r.sim.margin - r.model.margin)).toFixed(3), totalVsAnalytic: +(simTotal - modelTotal).toFixed(3), impliedRegPace: +(modelTotal / simTotal).toFixed(5),
    simOtRate: +mean(rows.map(r => r.sim.ot)).toFixed(4), actualOtRate: +mean(rows.map(r => (r.overtime ? 1 : 0))).toFixed(4),
  };
}

const msStats = () => { const a = [...simMs].sort((x, y) => x - y); return { mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), p95: +a[Math.floor(a.length * 0.95)].toFixed(1), max: +a[a.length - 1].toFixed(1) }; };
const [cmd] = process.argv.slice(2);
if (cmd === 'mean') {
  const n = +arg('--n', 10000);
  const rows = await simRows(n, RULES_OFF);
  const dm = rows.map(r => r.sim.margin - r.model.margin), dt = rows.map(r => r.sim.total - r.model.total);
  const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const out = {
    games: rows.length, n, rules: RULES_OFF,
    marginMeanAbsDiff: +avg(dm.map(Math.abs)).toFixed(4), marginMeanDiff: +avg(dm).toFixed(4), marginMaxAbsDiff: +Math.max(...dm.map(Math.abs)).toFixed(3),
    totalMeanAbsDiff: +avg(dt.map(Math.abs)).toFixed(4), totalMeanDiff: +avg(dt).toFixed(4), totalMaxAbsDiff: +Math.max(...dt.map(Math.abs)).toFixed(3),
    limits: { marginMeanAbsDiff: 0.5, totalMeanAbsDiff: 1.0, meanDiff: 0.3 }, seconds: (Date.now() - t0) / 1000,
  };
  out.pass = out.marginMeanAbsDiff <= 0.5 && out.totalMeanAbsDiff <= 1.0 && Math.abs(out.marginMeanDiff) <= 0.3 && Math.abs(out.totalMeanDiff) <= 0.3;
  await writeJson('docs/reports/p4-mean.json', out);
  console.log(JSON.stringify(out, null, 1));
} else if (cmd === 'calibrate') {
  const n = +arg('--n', 2000);
  const results = [];
  // stage 1 (first run, 24 settings) showed kappa >= 0.75 far too strong and gameSD/shootSD only widening
  // totals that were already wide enough; stage 2 refines kappa and pace noise. regPace is then set from the
  // best setting so that the rules-on mean total equals the P3 prediction
  const stage = +arg('--stage', 2);
  const grid = [];
  if (stage === 1) for (const gameSD of [0, 0.03, 0.06]) for (const kappa of [0, 0.75, 1.5, 2.25]) for (const shootSD of [0, 0.02]) grid.push({ gameSD, kappa, shootSD, paceSD: 0.03 });
  else for (const kappa of [0.1, 0.15, 0.2, 0.25, 0.3]) for (const paceSD of [0, 0.03]) grid.push({ gameSD: 0, kappa, shootSD: 0, paceSD, regPace: 1 });
  const list = await inputs();
  for (const lat of grid) {
    const s = spread(simFrom(list, n, RULES_ON, lat));
    results.push({ ...lat, ...s, objective: +(Math.abs(Math.log(s.marginRatio)) + Math.abs(Math.log(s.totalRatio))).toFixed(5) });
    process.stdout.write('.');
  }
  results.sort((a, b) => a.objective - b.objective);
  const best = results[0];
  let ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
  ledger.sessions.push({ at: new Date().toISOString(), window: DEV, what: `P4 latent variance calibration, stage ${stage}`, subsample: `every ${every} dev game, ${n} sims`, runs: results.length, best });
  ledger.totalRuns += results.length;
  await writeJson(LEDGER, ledger);
  await writeJson('data/model/latent.json', { calibratedOn: DEV, chosenAt: new Date().toISOString(), cumulativeTuningRuns: ledger.totalRuns, latent: { shootSD: best.shootSD, gameSD: best.gameSD, paceSD: best.paceSD, kappa: best.kappa, regPace: stage === 1 ? 1 : best.impliedRegPace }, fit: best });
  await writeJson(`docs/reports/p4-calibration${stage === 1 ? '' : '-' + stage}.json`, { stage, results });
  console.log(`\n${results.length} runs, ledger ${ledger.totalRuns}; best`, JSON.stringify(best));
} else if (cmd === 'var') {
  const n = +arg('--n', 10000);
  const L = JSON.parse(await readFile('data/model/latent.json', 'utf8')).latent;
  const rows = await simRows(n, RULES_ON, L);
  const avg = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const vsAnalytic = { marginMeanDiff: +avg(rows.map(r => r.sim.margin - r.model.margin)).toFixed(3), totalMeanDiff: +avg(rows.map(r => r.sim.total - r.model.total)).toFixed(3), overtimeRate: +avg(rows.map(r => r.sim.ot)).toFixed(4) };
  const out = { ...spread(rows), rulesOnVsAnalytic: vsAnalytic, n, latent: L, limits: { ratio: [0.9, 1.1] }, seconds: (Date.now() - t0) / 1000, simMsPerGame: msStats() };
  out.pass = out.marginRatio >= 0.9 && out.marginRatio <= 1.1 && out.totalRatio >= 0.9 && out.totalRatio <= 1.1;
  await writeJson('docs/reports/p4-var.json', out);
  console.log(JSON.stringify(out, null, 1));
} else {
  console.error('usage: node jobs/p4.js <mean|calibrate|var>');
  process.exit(2);
}
