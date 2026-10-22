// P5 backtest (design §14.2, §14.4; user decisions 2-8, 2026-10-22). Everything is fitted on 2024-25 only.
//   sims <season> <A|B>  walk-forward simulations, rules on, calibrated latent (data/model/latent.json)
//                        -> data/model/sims/{season}-{variant}.json.gz   (2025-26 refused: use `test`)
//   fit [B|A]            ensemble weight + calibration from 2024-25 (default B, the judged variant; leak review F8)
//                        -> data/model/calibration.json (ledger)
//   playprob             injury-report status -> share who played, 2024-25 run-time snapshots (design §6.5)
//                        -> data/model/play-prob.json (ledger)
//   rehearsal            2023-24 A and B with every parameter frozen -> docs/reports/p5-rehearsal.json
//   preregister          record HEAD and the hashes of params/latent/calibration -> data/model/preregistration.json
//   test                 2025-26 A and B, sealed: only from the pre-registered commit with unchanged files,
//                        --open-test, logged once -> docs/reports/p5-test.json
// Simulations carry the hashes of the parameter files they used; later steps refuse other files (leak review F6).
// Usage: node jobs/backtest.js <cmd> [season variant] [--n 10000]
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { loadGames } from './lib/games.js';
import { openTestSeason } from './lib/seal.js';
import { walkForward } from '../engine/evaluate.js';
import { simulateGame } from '../engine/sim.js';
import { snapshotInjuries, snapshotCutoff } from '../engine/snapshot.js';
import { fitCalibration, fitEnsembleWeight } from '../engine/calibrate.js';
import { report, withShift } from '../engine/backtest.js';
import { filesHash, gitHead, gitDirty, isAncestor, changedSince, FROZEN, preregistrationProblems } from './lib/provenance.js';

const arg = (k, d) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : d);
const writeJson = async (p, v) => { await mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(p, JSON.stringify(v, null, 1)); };
const exists = p => access(p).then(() => true, () => false);
const LEDGER = 'docs/reports/tuning-ledger.json';
const PRIOR = { '2023-24': [], '2024-25': ['2023-24'], '2025-26': ['2024-25'], '2026-27': ['2025-26'] };
const simPath = (season, variant) => `data/model/sims/${season}-${variant}.json.gz`;
const t0 = Date.now();

const PARAMS = 'data/model/params.json', LATENT_FILE = 'data/model/latent.json', CAL = 'data/model/calibration.json', PREREG = 'data/model/preregistration.json';
const P = JSON.parse(await readFile(PARAMS, 'utf8'));
const LATENT = JSON.parse(await readFile(LATENT_FILE, 'utf8')).latent;
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
    if (!snap || !snap.rows || snap.formatError) return null;
    // checked again at load: the report must have been readable by the game's cutoff (leak review F5)
    if (!snap.availableAt || new Date(snap.availableAt) > snapshotCutoff(g.start)) throw new Error(`snapshot for ${g.id} not available by its cutoff`);
    return snap;
  };
}

// variant B input: the run-time snapshot of every game, read before the (synchronous) walk
async function injuriesForSeason(season, games, statusOf = null) {
  const get = await snapshots(season);
  const { etParts } = await import('../engine/time.js');
  const { jobGroup } = await import('../engine/snapshot.js');
  const snaps = new Map();
  for (const g of games.filter(x => x.season === season)) snaps.set(g.id, await get({ id: g.id, start: g.start, date: etParts(new Date(g.start)).date, group: jobGroup(g.start) }));
  return (g, side, players) => snapshotInjuries(snaps.get(g.id), { team: side ? g.away.abbr : g.home.abbr, home: g.home.abbr, away: g.away.abbr, players, statusOf });
}

async function simulate(season, variant, n) {
  const games = await loadGames([...PRIOR[season], season]);
  const injuriesFor = variant === 'B' ? await injuriesForSeason(season, games) : null;
  const rows = walkForward({
    games, target: { season }, params: P.params, variant, injuriesFor,
    onGame: ({ ratings, homePlan, awayPlan, game }) => {
      const s = simulateGame({ ratings, home: game.home.id, away: game.away.id, homePlan, awayPlan }, { n, seed: +game.id % 2147483647, rules: RULES_ON, latent: LATENT });
      const hist = (h, lo) => ({ lo, p: h.map(c => round(c / s.n)) });
      return { sim: { margin: round(s.margin.mean, 4), total: round(s.total.mean, 4), marginSD: round(s.margin.sd, 4), totalSD: round(s.total.sd, 4), ot: s.overtimeRate, marginHist: hist(s.margin.hist, -60), totalHist: hist(s.total.hist, 150), n: s.n } };
    },
  });
  const out = { season, variant, n, generatedAt: new Date().toISOString(), inputs: { files: await filesHash([PARAMS, LATENT_FILE]), head: gitHead(), dirty: gitDirty() }, latent: LATENT, rows };
  await mkdir('data/model/sims', { recursive: true });
  await writeFile(simPath(season, variant), gzipSync(JSON.stringify(out)));
  console.log(`${season} ${variant}: ${rows.length} games, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  return rows;
}
async function loadSims(season, variant) {
  const d = JSON.parse(gunzipSync(await readFile(simPath(season, variant))));
  const now = await filesHash([PARAMS, LATENT_FILE]);
  for (const [f, h] of Object.entries(now)) if (d.inputs?.files?.[f] !== h) throw new Error(`${simPath(season, variant)} was made with a different ${f}; rerun the simulations`);
  return d.rows;
}

async function judgeSeason(season, opts) {
  const cal = JSON.parse(await readFile(CAL, 'utf8'));
  const jopts = { cal: cal.calibration, sigmaBase: P.sigma.base, seed: 1 };
  const out = { season, generatedAt: new Date().toISOString(), inputs: await filesHash([PARAMS, LATENT_FILE, CAL]), head: gitHead(), ensembleW: cal.ensemble.w, calibrationFittedOn: cal.fittedOn, variants: {} };
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
  const fitVariant = season ?? 'B'; // `fit A` only for comparison
  const rows = await loadSims('2024-25', fitVariant);
  const ens = fitEnsembleWeight(rows.map(r => ({ model: { margin: r.sim.margin }, base: r.base, actual: r.actual })));
  const calibration = fitCalibration(withShift(rows, ens.w));
  const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
  ledger.sessions.push({ at: new Date().toISOString(), window: { season: '2024-25', variant: fitVariant }, what: 'P5 ensemble weight (0.05 grid, Brier of Φ(m/σ)) and calibration fit (margin survival 8 parameters, total 3 parameters)', runs: ens.grid.length + 1, chosen: { w: ens.w } });
  ledger.totalRuns += ens.grid.length + 1;
  await writeJson(LEDGER, ledger);
  await writeJson(arg('--out', CAL), {
    fittedOn: { season: '2024-25', variant: fitVariant, games: rows.length, sims: simPath('2024-25', fitVariant) },
    inputs: await filesHash([PARAMS, LATENT_FILE, simPath('2024-25', fitVariant)]), chosenAt: new Date().toISOString(), cumulativeTuningRuns: ledger.totalRuns,
    ensemble: { w: ens.w, sigma: ens.sigma, brier: ens.brier, grid: ens.grid }, calibration,
  });
  console.log(JSON.stringify({ w: ens.w, calibration, ledger: ledger.totalRuns }));
} else if (cmd === 'playprob') {
  // who played, by the status the run-time report gave them (2024-25 only; Out stays 0 by user decision Q2)
  const games = await loadGames(['2023-24', '2024-25']);
  const listed = new Map(); // gameId -> [{ id, status }]
  const base = await injuriesForSeason('2024-25', games, true);
  const injuriesFor = (g, side, players) => { const r = base(g, side, players); listed.set(`${g.id}|${side}`, r.statuses); return r; };
  walkForward({ games, target: { season: '2024-25' }, params: P.params, variant: 'B', injuriesFor });
  const byId = new Map(games.map(g => [g.id, g]));
  const count = {};
  for (const [key, sts] of listed) {
    const g = byId.get(key.split('|')[0]);
    const played = new Set(g.players.filter(p => !p.dnp && p.sec > 0).map(p => p.id));
    for (const { id, status } of sts) { const c = (count[status] ??= { listed: 0, played: 0 }); c.listed++; if (played.has(id)) c.played++; }
  }
  for (const c of Object.values(count)) { c.rate = +(c.played / c.listed).toFixed(4); const se = Math.sqrt(c.rate * (1 - c.rate) / c.listed); c.ci95 = [+(c.rate - 1.96 * se).toFixed(4), +(c.rate + 1.96 * se).toFixed(4)]; }
  const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
  ledger.sessions.push({ at: new Date().toISOString(), window: { season: '2024-25', variant: 'B' }, what: 'P5 injury-status play probabilities (share of listed players who played)', runs: 1 });
  ledger.totalRuns += 1;
  await writeJson(LEDGER, ledger);
  await writeJson('data/model/play-prob.json', { fittedOn: { season: '2024-25', snapshots: 'run-time (B)' }, chosenAt: new Date().toISOString(), cumulativeTuningRuns: ledger.totalRuns, counts: count, note: 'Out is kept at 0 (user decision Q2); Day-To-Day (ESPN only) has no history and stays 0.55' });
  console.log(JSON.stringify(count));
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
} else if (cmd === 'preregister') {
  if (gitDirty()) { console.error('commit everything first: the registered commit must be the exact code that opens 2025-26'); process.exit(2); }
  const pre = { commit: gitHead(), at: new Date().toISOString(), files: await filesHash([PARAMS, LATENT_FILE, CAL]), criteria: 'docs/design/2026-10-22-nba-sim-design.md §14.4, §14.4.1' };
  await writeJson(PREREG, pre);
  console.log(JSON.stringify(pre));
} else if (cmd === 'test') {
  if (!process.argv.includes('--open-test')) await openTestSeason({ by: 'jobs/backtest.js test' }); // refuses and exits
  let pre = null;
  try { pre = JSON.parse(await readFile(PREREG, 'utf8')); } catch {}
  const problems = preregistrationProblems(pre, pre && { dirty: gitDirty(), ancestor: isAncestor(pre.commit, 'HEAD'), changed: changedSince(pre.commit, FROZEN), files: await filesHash(Object.keys(pre.files)) });
  if (problems.length) { console.error('not opening 2025-26:\n- ' + problems.join('\n- ')); process.exit(2); }
  await openTestSeason({ by: 'jobs/backtest.js test', details: { commit: pre.commit, head: gitHead(), files: pre.files } });
  for (const v of ['A', 'B']) await simulate('2025-26', v, n);
  await writeJson('docs/reports/p5-test.json', await judgeSeason('2025-26', {}));
  console.log(`test season judged, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else {
  console.error('usage: node jobs/backtest.js <sims|fit|rehearsal|test>');
  process.exit(2);
}
