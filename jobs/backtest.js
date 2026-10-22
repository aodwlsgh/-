// P5 backtest (design §14.2, §14.4; user decisions 2-8, 2026-10-22). Everything is fitted on 2024-25 only.
//   sims <season> <A|B>  walk-forward simulations, rules on, calibrated latent (data/model/latent.json)
//                        -> data/model/sims/{season}-{variant}.json.gz   (2025-26 refused: use `test`)
//   fit [B|A]            ensemble weight + calibration from 2024-25 (default B, the judged variant; leak review F8)
//                        -> data/model/calibration.json (ledger)
//   playprob             injury-report status -> share who played, 2024-25 run-time snapshots (design §6.5)
//                        -> data/model/play-prob.json (ledger)
//   rehearsal            2023-24 A and B with every parameter frozen, 2022-23 as its prior season only
//                        (user decision 1) -> docs/reports/p5-rehearsal-2.json (--out to change)
//   fit B --seasons 2023-24,2024-25 --keep-w   the single allowed refit of the calibration layer on both
//                        seasons (user decision 1c, only if the rehearsal grades 승패 S2 as fail)
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
// one prior season each; 2022-23 is loaded only for the 2023-24 rehearsal (user decision 1a)
const PRIOR = { '2023-24': ['2022-23'], '2024-25': ['2023-24'], '2025-26': ['2024-25'], '2026-27': ['2025-26'] };
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
  const started = { head: gitHead(), dirty: gitDirty() }; // provenance at the start of the run
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
  const out = { season, variant, n, generatedAt: new Date().toISOString(), inputs: { files: await filesHash([PARAMS, LATENT_FILE]), ...started }, latent: LATENT, rows };
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

// the season's first month (prior-season influence), shown separately (user requests 5 and 7)
const firstMonth = rows => { const from = rows.map(r => r.date).sort()[0]; return { from, to: new Date(Date.parse(from) + 30 * 86400e3).toISOString().slice(0, 10) }; };

async function judgeSeason(season, opts) {
  const cal = JSON.parse(await readFile(CAL, 'utf8'));
  const jopts = { cal: cal.calibration, sigmaBase: P.sigma.base, seed: 1, bootstrap: 1000, slopeBootstrap: 1000 }; // §14.4.1
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
  const seasons = arg('--seasons', '2024-25').split(',');
  const keepW = process.argv.includes('--keep-w');
  const rows = (await Promise.all(seasons.map(s => loadSims(s, fitVariant)))).flat();
  const prev = keepW ? JSON.parse(await readFile(CAL, 'utf8')) : null;
  const ens = keepW ? prev.ensemble : fitEnsembleWeight(rows.map(r => ({ model: { margin: r.sim.margin }, base: r.base, actual: r.actual })));
  const calibration = fitCalibration(withShift(rows, ens.w));
  const runs = keepW ? 1 : ens.grid.length + 1;
  const ledger = JSON.parse(await readFile(LEDGER, 'utf8'));
  ledger.sessions.push({ at: new Date().toISOString(), window: { seasons, variant: fitVariant }, what: keepW ? 'P5 calibration refit on the listed seasons, ensemble weight kept (user decision 1c)' : 'P5 ensemble weight (0.05 grid, Brier of Φ(m/σ)) and calibration fit (margin survival 8 parameters, total 2 parameters)', runs, chosen: { w: ens.w } });
  ledger.totalRuns += runs;
  await writeJson(LEDGER, ledger);
  await writeJson(arg('--out', CAL), {
    fittedOn: { seasons, variant: fitVariant, games: rows.length, sims: seasons.map(s => simPath(s, fitVariant)), ensembleWeightFrom: keepW ? prev.fittedOn : 'this fit' },
    inputs: await filesHash([PARAMS, LATENT_FILE, ...seasons.map(s => simPath(s, fitVariant))]), chosenAt: new Date().toISOString(), cumulativeTuningRuns: ledger.totalRuns,
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
  // rotation players (at least 15 minutes on average over their last five appearances before the game) measure
  // injury absence; fringe players also sit by coach's decision, which the minutes model already covers
  const apps = new Map();
  for (const g of games) for (const p of g.players) if (!p.dnp && p.sec > 0) (apps.get(p.id) ?? apps.set(p.id, []).get(p.id)).push([Date.parse(g.start), p.sec / 60]);
  const rotation = (id, start) => { const a = (apps.get(id) ?? []).filter(x => x[0] < start).slice(-5); return a.length > 0 && a.reduce((s, x) => s + x[1], 0) / a.length >= 15; };
  const count = {};
  for (const [key, sts] of listed) {
    const g = byId.get(key.split('|')[0]);
    const played = new Set(g.players.filter(p => !p.dnp && p.sec > 0).map(p => p.id));
    for (const { id, status } of sts) {
      for (const k of [status, `${status}|${rotation(id, Date.parse(g.start)) ? 'rotation' : 'fringe'}`]) { const c = (count[k] ??= { listed: 0, played: 0 }); c.listed++; if (played.has(id)) c.played++; }
    }
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
  const fm = firstMonth(await loadSims('2023-24', 'A'));
  const out = await judgeSeason('2023-24', { firstMonthTo: fm.to });
  out.note = 'rehearsal: 2023-24 with 2022-23 as its prior season only; every parameter fitted on 2024-25 and frozen';
  out.firstMonth = fm;
  await writeJson(arg('--out', 'docs/reports/p5-rehearsal-2.json'), out);
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
  const fm = firstMonth(await loadSims('2025-26', 'A'));
  const out = await judgeSeason('2025-26', { firstMonthTo: fm.to });
  out.firstMonth = fm;
  await writeJson('docs/reports/p5-test.json', out);
  console.log(`test season judged, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
} else {
  console.error('usage: node jobs/backtest.js <sims|fit|rehearsal|test>');
  process.exit(2);
}
