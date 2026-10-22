// P3 evaluation and tuning (plan P3, user conditions 5-8).
//   dev      walk-forward on 2024-25 (development season; hyperparameters are chosen here only)
//   tune     grid search on 2024-25 -> data/model/params.json
//   forward  walk-forward on 2026-27 (accumulating validation games)
//   test     2025-26 is sealed: needs --open-test, and every opening is logged in data/model/test-openings.json
// Usage: node jobs/p3.js <dev|tune|forward|test> [--params data/model/params.json] [--open-test]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadGames } from './lib/games.js';
import { walkForward, metrics, fitSigma } from '../engine/evaluate.js';
import { DEFAULT_PARAMS } from '../engine/model.js';

// development season: all of 2024-25 (2023-24 is loaded as its prior season only, never evaluated)
const DEV = { season: '2024-25' };
const DEV_SEASONS = ['2023-24', '2024-25'];
const LEDGER = 'docs/reports/tuning-ledger.json';
const TEST = { season: '2025-26' };
const FORWARD = { season: '2026-27' };
const arg = k => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const writeJson = async (p, v) => { await mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(p, JSON.stringify(v, null, 1)); };

async function loadParams() {
  const p = arg('--params');
  if (!p) return { params: DEFAULT_PARAMS, sigma: null, source: 'DEFAULT_PARAMS' };
  const j = JSON.parse(await readFile(p, 'utf8'));
  return { params: j.params, sigma: j.sigma, source: p };
}

function evalDev(games, params) {
  const rows = walkForward({ games, target: DEV, params });
  const sigma = { model: fitSigma(rows, 'model'), base: fitSigma(rows, 'base') };
  return { rows, sigma, metrics: metrics(rows, sigma) };
}

const scale = (k, f, keys) => Object.fromEntries(Object.entries(k).map(([n, v]) => [n, keys.includes(n) ? (Array.isArray(v) ? v.map(x => x * f) : v * f) : v]));

const [cmd] = process.argv.slice(2);
const t0 = Date.now();
if (cmd === 'dev') {
  const games = await loadGames(DEV_SEASONS);
  const { params, source } = await loadParams();
  const r = evalDev(games, params);
  await writeJson('docs/reports/p3-dev.json', { generatedAt: new Date().toISOString(), paramsSource: source, window: DEV, sigma: r.sigma, metrics: r.metrics });
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, sigma: r.sigma, all: r.metrics.all }, null, 1));
} else if (cmd === 'tune') {
  // starts from the current params (or defaults); stage 1 grid over carry and the league environment,
  // stage 2 coordinate search over every tuned dimension. All runs are counted in the ledger.
  const games = await loadGames(DEV_SEASONS);
  const start = await loadParams();
  const runs = [];
  const run = c => {
    const r = evalDev(games, build(c));
    const a = r.metrics.all.model;
    process.stdout.write('.');
    const row = { ...c, objective: +(a.marginMAE + a.totalMAE).toFixed(4), ...a, base: r.metrics.all.base, sigma: r.sigma };
    runs.push(row);
    return row;
  };
  const build = c => {
    let k = scale(DEFAULT_PARAMS.k, c.fRate, ['att', 'fta', 'tov', 'ast', 'reb']);
    k = scale(k, c.fFg, ['fg', 'ft']);
    k = scale(k, c.fTeam, ['teamFg', 'teamRate', 'teamReb', 'teamRtg']);
    return { ...DEFAULT_PARAMS, k: { ...k, pace: c.kPace }, halfLifeDays: c.halfLifeDays, carry: c.carry, carryTeam: c.carryTeam ?? null, envDays: c.envDays, envK: c.envK };
  };
  const prevChoice = start.source === 'DEFAULT_PARAMS' ? { fRate: 1, fFg: 1, fTeam: 1, halfLifeDays: null, kPace: 15 } : JSON.parse(await readFile(start.source, 'utf8')).choice;
  const refine = process.argv.includes('--refine');
  const base = refine ? { carryTeam: prevChoice.carry ?? 0.7, ...prevChoice } : { fRate: prevChoice.fRate, fFg: prevChoice.fFg, fTeam: prevChoice.fTeam, halfLifeDays: prevChoice.halfLifeDays, kPace: prevChoice.kPace, carry: 0.7, carryTeam: 0.7, envDays: null, envK: 50 };
  const grid = [];
  if (refine) grid.push(run({ ...base, stage: 2 }));
  else {
    for (const carry of [0.3, 0.5, 0.7, 0.85, 1]) for (const envDays of [null, 14, 21, 30, 45]) for (const envK of [25, 100]) {
      if (envDays === null && envK !== 25) continue;
      grid.push(run({ ...base, stage: 1, carry, carryTeam: carry, envDays, envK }));
    }
  }
  grid.sort((x, y) => x.objective - y.objective);
  const DIMS = {
    fRate: { mult: true }, fFg: { mult: true }, fTeam: { mult: true },
    halfLifeDays: { list: [null, 90, 60, 45, 30, 20] }, kPace: { list: [1, 2, 5, 15, 40] },
    carry: { list: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] }, carryTeam: { list: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1] }, envDays: { list: [null, 7, 14, 21, 30, 45, 60] }, envK: { list: [5, 10, 25, 50, 100, 200] },
  };
  const key = c => JSON.stringify(Object.keys(DIMS).map(d => c[d]));
  const seen = new Map(grid.map(g => [key(g), g]));
  const neighbours = c => Object.entries(DIMS).flatMap(([d, spec]) => spec.mult
    ? [0.5, 2].map(f => ({ ...c, [d]: +(c[d] * f).toFixed(4) }))
    : [-1, 1].map(i => spec.list[spec.list.indexOf(c[d]) + i]).filter(v => v !== undefined).map(v => ({ ...c, [d]: v })));
  let cur = grid[0];
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const c of neighbours(cur)) {
      if (seen.has(key(c))) continue;
      const res = run({ ...Object.fromEntries(Object.keys(DIMS).map(d => [d, c[d]])), stage: 2 });
      seen.set(key(c), res);
      if (res.objective < cur.objective) { cur = res; moved = true; }
    }
    if (!moved) break;
  }
  const best = cur;
  const choice = Object.fromEntries(Object.keys(DIMS).map(d => [d, best[d]]));
  let ledger = { totalRuns: 0, sessions: [] };
  try { ledger = JSON.parse(await readFile(LEDGER, 'utf8')); } catch {}
  ledger.sessions.push({ at: new Date().toISOString(), window: DEV, seasonsLoaded: DEV_SEASONS, runs: runs.length, best: { choice, objective: best.objective } });
  ledger.totalRuns += runs.length;
  await writeJson(LEDGER, ledger);
  await writeJson('data/model/params.json', {
    tunedOn: DEV, priorSeasonData: '2023-24 (prior only, not evaluated)', objective: 'marginMAE + totalMAE (model, walk-forward, variant A)', chosenAt: new Date().toISOString(),
    cumulativeTuningRuns: ledger.totalRuns, note: 'minutes parameters fixed at design values; 2025-26 sealed',
    choice, params: build(choice), sigma: best.sigma,
    devMetrics: { model: { marginMAE: best.marginMAE, totalMAE: best.totalMAE, brier: best.brier, totalBias: best.totalBias }, base: best.base },
  });
  await writeJson('docs/reports/p3-tuning-2.json', { window: DEV, runs: runs.sort((x, y) => x.objective - y.objective) });
  console.log(`\n${runs.length} runs in ${(Date.now() - t0) / 1000}s (ledger total ${ledger.totalRuns}); best`, JSON.stringify(choice), best.objective, JSON.stringify({ m: best.marginMAE, t: best.totalMAE, b: best.brier, tb: best.totalBias, base: best.base }));
} else if (cmd === 'forward' || cmd === 'test') {
  const target = cmd === 'forward' ? FORWARD : TEST;
  if (cmd === 'test') {
    if (!process.argv.includes('--open-test')) { console.error('2025-26 is the sealed test season; pass --open-test to open it (logged).'); process.exit(2); }
    const logPath = 'data/model/test-openings.json';
    let log = [];
    try { log = JSON.parse(await readFile(logPath, 'utf8')); } catch {}
    if (log.length && !process.argv.includes('--reopen')) { console.error(`test season already opened ${log.length}x (${log.map(x => x.at).join(', ')}); pass --reopen to open again (logged).`); process.exit(2); }
    log.push({ at: new Date().toISOString(), params: arg('--params') ?? 'DEFAULT_PARAMS', by: 'jobs/p3.js test' });
    await writeJson(logPath, log);
  }
  const { params, sigma, source } = await loadParams();
  if (!sigma) { console.error('needs --params with frozen sigma from tuning'); process.exit(2); }
  const seasons = target.season === '2026-27' ? ['2024-25', '2025-26', '2026-27'] : ['2024-25', '2025-26'];
  const rows = walkForward({ games: await loadGames(seasons), target, params });
  const out = { generatedAt: new Date().toISOString(), paramsSource: source, target, sigma, metrics: metrics(rows, sigma), byPdfFormat: metrics(rows, sigma, { groupBy: 'pdfFormat' }), byGroup: metrics(rows, sigma, { groupBy: 'group' }), rows };
  await writeJson(`docs/reports/p3-${cmd}.json`, out);
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, n: rows.length, all: out.metrics.all }, null, 1));
} else {
  console.error('usage: node jobs/p3.js <dev|tune|forward|test>');
  process.exit(2);
}
