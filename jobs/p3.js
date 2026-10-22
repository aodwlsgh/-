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

const DEV = { season: '2024-25', from: '2024-11-01' }; // first ~100 games only build ratings (no 2023-24 prior)
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
  const games = await loadGames(['2024-25']);
  const { params, source } = await loadParams();
  const r = evalDev(games, params);
  await writeJson('docs/reports/p3-dev.json', { generatedAt: new Date().toISOString(), paramsSource: source, window: DEV, sigma: r.sigma, metrics: r.metrics });
  console.log(JSON.stringify({ seconds: (Date.now() - t0) / 1000, sigma: r.sigma, all: r.metrics.all }, null, 1));
} else if (cmd === 'tune') {
  const games = await loadGames(['2024-25']);
  const run = (tag, params) => {
    const r = evalDev(games, params);
    const a = r.metrics.all.model;
    process.stdout.write('.');
    return { ...tag, objective: +(a.marginMAE + a.totalMAE).toFixed(4), ...a, baseMarginMAE: r.metrics.all.base.marginMAE, baseTotalMAE: r.metrics.all.base.totalMAE, sigma: r.sigma, params };
  };
  // stage 1: shrinkage strengths (x design defaults) and recency half-life
  const grid = [];
  for (const fRate of [0.25, 0.5, 1, 2]) for (const fFg of [0.25, 0.5, 1, 2]) for (const fTeam of [0.5, 1, 2]) for (const hl of [null, 60, 30]) {
    let k = scale(DEFAULT_PARAMS.k, fRate, ['att', 'fta', 'tov', 'ast', 'reb']);
    k = scale(k, fFg, ['fg', 'ft']);
    k = scale(k, fTeam, ['teamFg', 'teamRate', 'teamReb', 'teamRtg']);
    grid.push(run({ stage: 1, fRate, fFg, fTeam, halfLifeDays: hl, kPace: DEFAULT_PARAMS.k.pace }, { ...DEFAULT_PARAMS, k, halfLifeDays: hl }));
  }
  grid.sort((x, y) => x.objective - y.objective);
  // stage 2: coordinate search from the stage-1 winner (moves off grid edges), incl. pace shrinkage
  const build = c => {
    let k = scale(DEFAULT_PARAMS.k, c.fRate, ['att', 'fta', 'tov', 'ast', 'reb']);
    k = scale(k, c.fFg, ['fg', 'ft']);
    k = scale(k, c.fTeam, ['teamFg', 'teamRate', 'teamReb', 'teamRtg']);
    return { ...DEFAULT_PARAMS, k: { ...k, pace: c.kPace }, halfLifeDays: c.halfLifeDays };
  };
  const HL = [null, 90, 60, 45, 30, 20];
  const PACE = [1, 2, 5, 15, 40];
  const neighbours = c => [
    ...['fRate', 'fFg', 'fTeam'].flatMap(d => [0.5, 2].map(f => ({ ...c, [d]: +(c[d] * f).toFixed(4) }))),
    ...[-1, 1].map(i => HL[HL.indexOf(c.halfLifeDays) + i]).filter(v => v !== undefined).map(v => ({ ...c, halfLifeDays: v })),
    ...[-1, 1].map(i => PACE[PACE.indexOf(c.kPace) + i]).filter(v => v !== undefined).map(v => ({ ...c, kPace: v })),
  ];
  const key = c => JSON.stringify([c.fRate, c.fFg, c.fTeam, c.halfLifeDays, c.kPace]);
  const seen = new Map(grid.map(g => [key(g), g]));
  let cur = grid[0];
  const stage2 = [];
  for (let pass = 0; pass < 6; pass++) {
    let moved = false;
    for (const c of neighbours(cur)) {
      if (seen.has(key(c))) continue;
      const res = run({ stage: 2, fRate: c.fRate, fFg: c.fFg, fTeam: c.fTeam, halfLifeDays: c.halfLifeDays, kPace: c.kPace }, build(c));
      seen.set(key(c), res); stage2.push(res);
      if (res.objective < cur.objective) { cur = res; moved = true; }
    }
    if (!moved) break;
  }
  stage2.push(cur);
  stage2.sort((x, y) => x.objective - y.objective);
  const best = stage2[0];
  await writeJson('data/model/params.json', {
    tunedOn: DEV, objective: 'marginMAE + totalMAE (model, walk-forward, variant A)', chosenAt: new Date().toISOString(),
    note: 'carry (last-season weight 0.7) and minutes parameters fixed at design values: 2024-25 has no 2023-24 data, so carry cannot be tuned inside 2024-25',
    choice: { fRate: best.fRate, fFg: best.fFg, fTeam: best.fTeam, halfLifeDays: best.halfLifeDays, kPace: best.kPace }, params: best.params, sigma: best.sigma,
    devMetrics: { model: { marginMAE: best.marginMAE, totalMAE: best.totalMAE, brier: best.brier }, base: { marginMAE: best.baseMarginMAE, totalMAE: best.baseTotalMAE } },
  });
  await writeJson('docs/reports/p3-tuning.json', { window: DEV, stage1: grid.map(({ params, ...g }) => g), stage2: stage2.map(({ params, ...g }) => g) });
  console.log(`\n${grid.length + stage2.length} runs in ${(Date.now() - t0) / 1000}s; best`, JSON.stringify({ ...best, params: undefined }));
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
