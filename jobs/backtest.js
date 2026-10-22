// P5 backtest (design §14.2, §14.4; user decisions 2-8, 2026-10-22). Everything is fitted on 2024-25 only.
//   sims <season> <A|B>  walk-forward simulations, rules on, calibrated latent (data/model/latent.json)
//                        -> data/model/sims/{season}-{variant}.json.gz   (2025-26 refused: use `test`)
//   fit                  ensemble weight + calibration from 2024-25 A -> data/model/calibration.json (ledger)
//   rehearsal            2023-24 A and B with every parameter frozen -> docs/reports/p5-rehearsal.json
//   test                 2025-26 A and B, sealed (--open-test, logged once) -> docs/reports/p5-test.json
// Usage: node jobs/backtest.js <cmd> [season variant] [--n 10000]
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { loadGames } from './lib/games.js';
import { openTestSeason } from './lib/seal.js';
import { walkForward } from '../engine/evaluate.js';
import { simulateGame } from '../engine/sim.js';
import { snapshotInjuries } from '../engine/snapshot.js';
import { fitCalibration, fitEnsembleWeight } from '../engine/calibrate.js';
import { report, withShift } from '../engine/backtest.js';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const writeJson = async (p, v) => { await mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(p, JSON.stringify(v, null, 1)); };
const exists = p => access(p).then(() => true, () => false);
const LEDGER = 'docs/reports/tuning-ledger.json';
const PRIOR = { '2023-24': [], '2024-25': ['2023-24'], '2025-26': ['2024-25'], '2026-27': ['2025-26'] };
const simPath = (season, variant) => `data/model/sims/${season}-${variant}.json.gz`;
const t0 = Date.now();

const P = JSON.parse(await readFile('data/model/params.json', 'utf8'));
const LATENT = JSON.parse(await readFile('data/model/latent.json', 'utf8')).latent;
const RULES_ON = { garbageTime: true, clutchFoul: true, overtime: true, latent: true };
const round = (x, d = 6) => +x.toFixed(d);

async function snapshots(season) {
  const files = new Map();
  return async g => {
    const date = g.date;
    if (!files.has(date)) {
      const p = `data/injury-pdf/${season}/${date}.json.gz`;
      files.set(date, (await exists(p)) ? JSON.parse(gunzipSync(await readFile(p))) : null);
    }
    const rec = files.get(date);
    if (!rec) return null;
    const snap = g.group === 'pre_job_start' ? rec.early.find(x => x.id === g.id) : g.group === 'B' ? rec.runB : rec.main;
    return snap && snap.rows && !snap.formatError ? snap : null;
  };
}

async function simulate(season, variant, n) {
  const games = await loadGames([...PRIOR[season], season]);
  // variant B: snapshots are read before the walk (the walk itself is synchronous)
  let injuriesFor = null;
  if (variant === 'B') {
    const get = await snapshots(season);
    const { etParts } = await import('../engine/time.js');
    const { jobGroup } = await import('../engine/snapshot.js');
    const snaps = new Map();
    for (const g of games.filter(x => x.season === season)) snaps.set(g.id, await get({ id: g.id, date: etParts(new Date(g.start)).date, group: jobGroup(g.start) }));
    injuriesFor = (g, side, players) => snapshotInjuries(snaps.get(g.id), { team: side ? g.away.abbr : g.home.abbr, home: g.home.abbr, away: g.away.abbr, players });
  }
  const rows = walkForward({
    games, target: { season }, params: P.params, variant, injuriesFor,
    onGame: ({ ratings, homePlan, awayPlan, game }) => {
      const s = simulateGame({ ratings, home: game.home.id, away: game.away.id, homePlan, awayPlan }, { n, seed: +game.id % 2147483647, rules: RULES_ON, latent: LATENT });
      const hist = (h, lo) => ({ lo, p: h.map(c => round(c / s.n)) });
      return { sim: { margin: round(s.margin.mean, 4), total: round(s.total.mean, 4), marginSD: round(s.margin.sd, 4), totalSD: round(s.total.sd, 4), ot: s.overtimeRate, marginHist: hist(s.margin.hist, -60), totalHist: hist(s.total.hist, 150), n: s.n } };
    },
  });
  const out = { season, variant, n, generatedAt: new Date().toISOString(), params: 'data/model/params.json', latent: LATENT, rows };
  await mkdir('data/model/sims', { recursive: true });
  await writeFile(simPath(season, variant), gzipSync(JSON.stringify(out)));
  console.log(`${season} ${variant}: ${rows.length} games, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return rows;
}
const loadSims = async (season, variant) => JSON.parse(gunzipSync(await readFile(simPath(season, variant)))).rows;

async function judgeSeason(season, opts) {
  const cal = JSON.parse(await readFile('data/model/calibration.json', 'utf8'));
  const jopts = { cal: cal.calibration, sigmaBase: P.sigma.base, seed: 1 };
  const out = { season, generatedAt: new Date().toISOString(), calibration: 'data/model/calibration.json', ensembleW: cal.ensemble.w, variants: {} };
  for (const v of ['A', 'B']) out.variants[v] = report(withShift(await loadSims(season, v), cal.ensemble.w), jopts, opts);
  return out;
}

const [cmd, season, variant] = process.argv.slice(2);
const n = +arg('--n', 10000);
if (cmd === 'sims') {
  if (season === '2025-26') { console.error('2025-26 is sealed: use `node jobs/backtest.js test --open-test`'); process.exit(2); }
  if (!PRIOR[season] || !['A', 'B'].includes(variant)) { console.error('usage: sims <season> <A|B>'); process.exit(2); }
  await simulate(season, variant, n);
} else if (cmd === 'fit') {
  const rows = await loadSims('2024-25', 'A');
  const ens = fitEnsembleWeight(rows.map(r => ({ model: { margin: r.sim.margin }, base: r.base, actual: r.actual })));
  const calibration = fitCalibration(withShift(rows, ens.w));
  const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
  ledger.sessions.push({ at: new Date().toISOString(), window: { season: '2024-25' }, what: 'P5 ensemble weight (0.05 grid, Brier of Φ(m/σ)) and calibration fit (margin survival 8 parameters, total 3 parameters)', runs: ens.grid.length + 1, chosen: { w: ens.w } });
  ledger.totalRuns += ens.grid.length + 1;
  await writeJson(LEDGER, ledger);
  await writeJson('data/model/calibration.json', {
    fittedOn: { season: '2024-25', variant: 'A', games: rows.length, sims: simPath('2024-25', 'A') }, chosenAt: new Date().toISOString(), cumulativeTuningRuns: ledger.totalRuns,
    ensemble: { w: ens.w, sigma: ens.sigma, brier: ens.brier, grid: ens.grid }, calibration,
  });
  console.log(JSON.stringify({ w: ens.w, calibration, ledger: ledger.totalRuns }));
} else if (cmd === 'rehearsal') {
  for (const v of ['A', 'B']) if (!(await exists(simPath('2023-24', v)))) await simulate('2023-24', v, n);
  const rows = await loadSims('2023-24', 'A');
  const first = rows.map(r => r.date).sort()[0];
  const firstMonthTo = new Date(Date.parse(first) + 30 * 86400e3).toISOString().slice(0, 10);
  const out = await judgeSeason('2023-24', { firstMonthTo });
  out.note = 'rehearsal: 2023-24 without a prior season (its first month is shown separately); every parameter fitted on 2024-25 and frozen';
  out.firstMonth = { from: first, to: firstMonthTo };
  await writeJson('docs/reports/p5-rehearsal.json', out);
  console.log(`rehearsal written, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else if (cmd === 'test') {
  await openTestSeason({ by: 'jobs/backtest.js test', details: { params: 'data/model/params.json', latent: 'data/model/latent.json', calibration: 'data/model/calibration.json' } });
  for (const v of ['A', 'B']) await simulate('2025-26', v, n);
  await writeJson('docs/reports/p5-test.json', await judgeSeason('2025-26', {}));
  console.log(`test season judged, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else {
  console.error('usage: node jobs/backtest.js <sims|fit|rehearsal|test>');
  process.exit(2);
}
