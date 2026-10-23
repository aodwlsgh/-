// Example day for the dashboard (P8, 2026-10-23 user decision 2): one past 2024-25 day of base predictions,
// shown as "예시 — 2024-25 과거 경기, 운영 데이터 아님, 보정 구간 표본 내 예측" until the daily job (P9) publishes
// real 2026-27 data. No 2025-26 data is read. No odds exist for it, so it carries no picks or EV.
// Day: the 2025-01..03 date with the most games, no game before the 17:50 ET run, none excluded, at least one
// run-B game (ties: earliest). Path: the validated variant B walk-forward (prior 2023-24, params.json, snapshot
// injuries), simulateGame 10,000 runs with the backtest seed, rules and latent; every margin is checked against
// data/model/sims/2024-25-B.json.gz, and the stored validated summary is what the day file carries.
// Also writes data/live/model-status.json (opening result, calibration, ledger).
// CLI: node scripts/p8/example-day.mjs
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadGames } from '../../jobs/lib/games.js';
import { walkForward } from '../../engine/evaluate.js';
import { snapshotInjuries, snapshotCutoff, jobGroup } from '../../engine/snapshot.js';
import { simulateGame } from '../../engine/sim.js';
import { sensitivity } from '../../engine/sensitivity.js';
import { breakeven } from '../../engine/picks.js';
import { stamp } from '../../engine/clock.js';
import { etParts } from '../../engine/time.js';
import { BETMAN_TEAMS } from '../../engine/betman-teams.js';
import { TEXT, DAY_SCHEMA, EXAMPLE_SEASON, validateDay } from '../../engine/dashboard-data.js';

const SEASON = EXAMPLE_SEASON, PRIOR = '2023-24';
const P = JSON.parse(await readFile('data/model/params.json', 'utf8'));
const LATENT = JSON.parse(await readFile('data/model/latent.json', 'utf8')).latent;
const CAL = JSON.parse(await readFile('data/model/calibration.json', 'utf8'));
const RULES_ON = { garbageTime: true, clutchFoul: true, overtime: true, latent: true };
const stored = JSON.parse(gunzipSync(await readFile(`data/model/sims/${SEASON}-B.json.gz`)));
for (const [f, h] of Object.entries(stored.inputs.files)) {
  const { createHash } = await import('node:crypto');
  if (createHash('sha256').update(await readFile(f)).digest('hex') !== h) throw new Error(`${f} changed since the stored simulations`);
}

const byDate = new Map();
for (const r of stored.rows) (byDate.get(r.date) ?? byDate.set(r.date, []).get(r.date)).push(r);
const [date, rows] = [...byDate].filter(([d, rs]) => d >= '2025-01-01' && d <= '2025-03-31' && rs.every(r => r.group !== 'pre_job_start' && !r.dataExcluded) && rs.some(r => r.group === 'B'))
  .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
const rowById = new Map(rows.map(r => [r.id, r]));

// variant B injuries: the snapshot of the game's run, readable before its cutoff (as jobs/backtest.js)
const pdf = JSON.parse(gunzipSync(await readFile(`data/injury-pdf/${SEASON}/${date}.json.gz`)));
const games = await loadGames([PRIOR, SEASON]);
const snapOf = g => {
  const s = jobGroup(g.start) === 'B' ? pdf.runB : pdf.main;
  if (!s || !s.rows || s.formatError) return null;
  if (!s.availableAt || new Date(s.availableAt) > snapshotCutoff(g.start)) throw new Error(`snapshot for ${g.id} not available by its cutoff`);
  return s;
};
const injuriesFor = (g, side, players) => snapshotInjuries(snapOf(g), { team: side ? g.away.abbr : g.home.abbr, home: g.home.abbr, away: g.away.abbr, players });
const names = new Map();
for (const g of games) for (const p of g.players) names.set(p.id, p.n);

const kept = [];
walkForward({ games, target: { season: SEASON, from: date, to: date }, params: P.params, variant: 'B', injuriesFor, onGame: x => { kept.push(x); return {}; } });
if (kept.length !== rows.length) throw new Error(`walk gave ${kept.length} games, stored ${rows.length}`);

const team = (g, side) => {
  const t = side ? g.away : g.home, b = BETMAN_TEAMS.find(x => x.espn === t.abbr);
  return { id: t.id, espn: t.abbr, name: b.name, ko: b.ko, koVerified: b.koVerified };
};
const trim = (ratings, ids, teams) => ({
  league: ratings.league,
  teams: Object.fromEntries(teams.map(t => [t, ratings.teams[t]])),
  players: Object.fromEntries(ids.filter(id => ratings.players[id]).map(id => [id, ratings.players[id]])),
});
const w = CAL.ensemble.w;
const out = [];
const t0 = Date.now();
for (const { ratings, homePlan, awayPlan, game: g } of kept.sort((a, b) => Date.parse(a.game.start) - Date.parse(b.game.start))) {
  const row = rowById.get(g.id);
  const seed = +g.id % 2147483647;
  const input = { ratings, home: g.home.id, away: g.away.id, abbr: { home: g.home.abbr, away: g.away.abbr }, homePlan, awayPlan };
  const s = simulateGame(input, { n: 10000, seed, rules: RULES_ON, latent: LATENT });
  if (+s.margin.mean.toFixed(4) !== row.sim.margin || +s.total.mean.toFixed(4) !== row.sim.total) throw new Error(`${g.id}: re-simulation ${s.margin.mean} differs from the stored ${row.sim.margin}`);
  const prediction = {
    source: 'base', runId: `example-${SEASON}-B-${date}`, run: row.group, final: true,
    sim: { ...row.sim, shift: (1 - w) * (row.base.margin - row.sim.margin) },
  };
  const ids = [...homePlan.players, ...awayPlan.players].map(p => p.playerId);
  const sens = sensitivity(input, { n: 2000, seed, rules: RULES_ON });
  const et = etParts(new Date(g.start));
  out.push({
    gameId: g.id, start: { ...stamp(g.start), et: `${et.date} ${String(et.hour).padStart(2, '0')}:${String(et.minute).padStart(2, '0')} ET` },
    group: row.group, home: team(g, 0), away: team(g, 1), prediction, seed,
    breakeven: breakeven(prediction, CAL.calibration),
    simInput: { ...input, ratings: trim(ratings, ids, [g.home.id, g.away.id]) },
    names: Object.fromEntries(ids.map(id => [id, names.get(id) ?? id])),
    dataStatus: { run: row.group, injurySnapshot: row.snapshot ?? null, pdfFormat: row.pdfFormat },
    sensitivity: { label: sens.label, n: sens.n, seed: sens.seed, base: sens.base, topMargin: sens.topMargin.map(({ key, label, dMargin, dTotal }) => ({ key, label, dMargin, dTotal })), topTotal: sens.topTotal.map(({ key, label, dMargin, dTotal }) => ({ key, label, dMargin, dTotal })), ms: Math.round(sens.ms) },
    autoScenarios: [],
  });
}
const day = {
  schema: DAY_SCHEMA, kind: 'example', exampleNote: TEXT.example, date, season: SEASON, run: null,
  generatedAt: stamp(new Date()),
  source: { path: `variant B walk-forward, data/model/sims/${SEASON}-B.json.gz (validated summaries), calibration fitted on ${CAL.fittedOn.season} ${CAL.fittedOn.variant}`, ensembleW: w, simulations: 10000, sensitivity: 2000 },
  games: out,
};
const errs = validateDay(day);
if (errs.length) throw new Error(`day file: ${errs.join('; ')}`);
await mkdir('data/live', { recursive: true });
await writeFile('data/live/example-day.json', JSON.stringify(day));

const open = JSON.parse(await readFile('docs/reports/p5-open.json', 'utf8'));
const B = open.registeredOutput.content.variants.B.all;
const ledger = JSON.parse(await readFile('docs/reports/tuning-ledger.json', 'utf8'));
await writeFile('data/live/model-status.json', JSON.stringify({
  opening: { season: open.season, at: open.runs[0].at, registeredCommit: open.gate.registered.commit, variant: 'B', n: B.n, S1: B.S1, S2: B.S2, S3: B.S3, markets: B.markets, brier: B.brier, outcome: B.outcome },
  calibration: { fittedOn: CAL.fittedOn, ensembleW: w },
  tuningRuns: ledger.totalRuns,
  regression: { commit: '53c88f5', test: 'test/p6-invariance.test.js' },
}, null, 1));
console.log(JSON.stringify({ date, games: out.length, groupB: out.filter(g => g.group === 'B').length, bytes: JSON.stringify(day).length, seconds: (Date.now() - t0) / 1000 }));
