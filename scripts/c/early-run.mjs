// Early run C validation (docs/plans/2026-10-27-early-run-plan.md §3, approved 2026-10-27). Nothing here is fitted:
// the registered walk-forward (variant B), simulator, latent, ensemble weight and calibration are used as they are;
// only the injury-report snapshot changes, from the run-time cutoff (17:50 / 20:50 ET) to 08:50 ET of the game day.
// 2025-26 is never read (opened once on 2026-10-23).
//   pdf <season>     C snapshots -> data/injury-pdf-c/<season>/<date>.json.gz (separate from the registered
//                    data/injury-pdf, whose directory hash is part of the 53c88f5 regression test)
//   sims <season>    walk-forward with the C snapshots -> data/model/sims-c/<season>-B.json.gz. A game whose
//                    minutes plans equal the registered run's gets the registered simulation (same seed, same
//                    input); a fixed sample of such games is simulated again to prove they are identical.
//   report           paired comparison against data/model/sims/<season>-B.json.gz -> docs/reports/c-validation.json
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createCollector } from '../../engine/collect.js';
import { snapshotInjuries, snapshotCutoff, jobGroup } from '../../engine/snapshot.js';
import { walkForward } from '../../engine/evaluate.js';
import { simulateGame } from '../../engine/sim.js';
import { report, withShift, isJudged } from '../../engine/backtest.js';
import { markets } from '../../engine/calibrate.js';
import { etParts, fromEt } from '../../engine/time.js';
import { loadGames } from '../../jobs/lib/games.js';
import { pickSnapshot, parsePdf } from '../../jobs/lib/live-collect.js';

export const C_ET = { hour: 8, minute: 50 };
export const CRITERIA = { brier: 0.001, logLoss: 0.003, marginMAE: 0.3, totalMAE: 0.3, slope: 0.10, coverage: 0.95 };
const SEASONS = ['2024-25', '2023-24'];
const PRIOR = { '2023-24': ['2022-23'], '2024-25': ['2023-24'] };
const exists = p => access(p).then(() => true, () => false);
const readGz = async p => JSON.parse(gunzipSync(await readFile(p)));
const writeGz = async (p, v) => { await mkdir(p.split('/').slice(0, -1).join('/'), { recursive: true }); await writeFile(p, gzipSync(JSON.stringify(v))); };
const round = (x, d = 6) => +x.toFixed(d);
const P = JSON.parse(await readFile('data/model/params.json', 'utf8'));
const LATENT = JSON.parse(await readFile('data/model/latent.json', 'utf8')).latent;
const CAL = JSON.parse(await readFile('data/model/calibration.json', 'utf8'));
const RULES_ON = { garbageTime: true, clutchFoul: true, overtime: true, latent: true };
const guard = season => { if (!SEASONS.includes(season)) { console.error(`season must be one of ${SEASONS.join(', ')} (2025-26 is not read)`); process.exit(2); } };

// ---- pdf -------------------------------------------------------------------------------------------------------
async function pdf(season) {
  const sched = JSON.parse(await readFile(`data/schedule/${season}.json`, 'utf8'));
  const dates = [...new Set(sched.list.map(g => etParts(new Date(g.start)).date))].sort();
  const col = createCollector({});
  let done = 0;
  for (const date of dates) {
    const path = `data/injury-pdf-c/${season}/${date}.json.gz`;
    if (!(await exists(path))) {
      const cutoff = fromEt(date, C_ET.hour, C_ET.minute);
      const snap = await pickSnapshot(col.injuryPdfsBefore(cutoff, { maxSteps: 16 }), { at: cutoff, gameDate: date, parse: parsePdf });
      await writeGz(path, { date, cutoff: cutoff.toISOString(), snap });
    }
    if (++done % 20 === 0) console.log(`${season} ${done}/${dates.length}`);
  }
  console.log(JSON.stringify(await coverage(season)));
}

async function coverage(season) {
  const sched = JSON.parse(await readFile(`data/schedule/${season}.json`, 'utf8'));
  let games = 0, ok = 0, formatErrors = 0;
  const lags = [];
  const reports = {};
  for (const g of sched.list) {
    const date = etParts(new Date(g.start)).date;
    const rec = await readGz(`data/injury-pdf-c/${season}/${date}.json.gz`).catch(() => null);
    games++;
    const s = rec?.snap;
    if (s?.formatError) formatErrors++;
    if (s?.rows && !s.formatError && new Date(s.availableAt) <= new Date(rec.cutoff)) { ok++; lags.push(s.lagMin); reports[s.reportTime?.slice(9) ?? '?'] = (reports[s.reportTime?.slice(9) ?? '?'] ?? 0) + 1; }
  }
  lags.sort((a, b) => a - b);
  return { season, games, withSnapshot: ok, coverage: round(ok / games, 4), formatErrors, lagMinMedian: lags[lags.length >> 1] ?? null, lagMinMax: lags.at(-1) ?? null, reportTimes: reports };
}

// ---- sims ------------------------------------------------------------------------------------------------------
async function snapshotSource(season, games, which) {
  const snaps = new Map(), files = new Map();
  for (const g of games.filter(x => x.season === season)) {
    const date = etParts(new Date(g.start)).date;
    if (which === 'C') {
      if (!files.has(date)) files.set(date, await readGz(`data/injury-pdf-c/${season}/${date}.json.gz`).catch(() => null));
      const rec = files.get(date), s = rec?.snap;
      const ok = s?.rows && !s.formatError && new Date(s.availableAt) <= new Date(rec.cutoff);
      if (ok && new Date(rec.cutoff) > snapshotCutoff(g.start)) throw new Error(`C cutoff after the game cutoff for ${g.id}`);
      snaps.set(g.id, ok ? s : null);
    } else {
      // the registered input, read as jobs/backtest.js reads it
      if (!files.has(date)) files.set(date, await readGz(`data/injury-pdf/${season}/${date}.json.gz`).catch(() => null));
      const rec = files.get(date), group = jobGroup(g.start);
      const s = !rec ? null : group === 'pre_job_start' ? rec.early.find(x => x.id === g.id) : group === 'B' ? rec.runB : rec.main;
      snaps.set(g.id, s && s.rows && !s.formatError ? s : null);
    }
  }
  return (g, side, players) => snapshotInjuries(snaps.get(g.id), { team: side ? g.away.abbr : g.home.abbr, home: g.home.abbr, away: g.away.abbr, players });
}

const simulate = ({ ratings, homePlan, awayPlan, game }, n) => {
  const s = simulateGame({ ratings, home: game.home.id, away: game.away.id, homePlan, awayPlan }, { n, seed: +game.id % 2147483647, rules: RULES_ON, latent: LATENT });
  const hist = (h, lo) => ({ lo, p: h.map(c => round(c / s.n)) });
  return { margin: round(s.margin.mean, 4), total: round(s.total.mean, 4), marginSD: round(s.margin.sd, 4), totalSD: round(s.total.sd, 4), ot: s.overtimeRate, marginHist: hist(s.margin.hist, -60), totalHist: hist(s.total.hist, 150), n: s.n };
};
const planKey = x => JSON.stringify([x.homePlan, x.awayPlan]);

async function sims(season, n) {
  const reg = await readGz(`data/model/sims/${season}-B.json.gz`);
  if (reg.n !== n) throw new Error(`registered sims use n=${reg.n}`);
  const regSim = new Map(reg.rows.map(r => [r.id, r.sim]));
  const games = await loadGames([...PRIOR[season], season]);
  // registered plans (no simulation): the walk is deterministic
  const regPlans = new Map();
  walkForward({ games, target: { season }, params: P.params, variant: 'B', injuriesFor: await snapshotSource(season, games, 'R'), onGame: x => { regPlans.set(x.game.id, planKey(x)); return {}; } });
  const injuriesFor = await snapshotSource(season, games, 'C');
  let reused = 0, simulated = 0, checked = 0;
  const t0 = Date.now();
  const rows = walkForward({
    games, target: { season }, params: P.params, variant: 'B', injuriesFor,
    onGame: x => {
      const same = regPlans.get(x.game.id) === planKey(x);
      if (same && regSim.has(x.game.id)) {
        reused++;
        // determinism check on every 50th reused game: simulating again must give the registered output
        if (reused % 50 === 1) { checked++; if (JSON.stringify(simulate(x, n)) !== JSON.stringify(regSim.get(x.game.id))) throw new Error(`reused simulation differs for ${x.game.id}`); }
        return { sim: regSim.get(x.game.id), changed: false };
      }
      simulated++;
      if (simulated % 25 === 0) console.log(`${season} simulated ${simulated}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      return { sim: simulate(x, n), changed: true };
    },
  });
  await writeGz(`data/model/sims-c/${season}-B.json.gz`, { season, variant: 'B', cutoffEt: C_ET, n, generatedAt: new Date().toISOString(), counts: { rows: rows.length, reused, simulated, determinismChecked: checked }, rows });
  console.log(JSON.stringify({ season, rows: rows.length, reused, simulated, determinismChecked: checked, seconds: Math.round((Date.now() - t0) / 1000) }));
}

// ---- report ----------------------------------------------------------------------------------------------------
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const clip = p => Math.min(1 - 1e-6, Math.max(1e-6, p));
function perGame(rows) {
  return new Map(withShift(rows, CAL.ensemble.w).filter(isJudged).map(r => {
    const p = markets(CAL.calibration, r.sim).ml.home, y = r.actual.margin > 0 ? 1 : 0;
    return [r.id, { p, y, brier: (p - y) ** 2, logLoss: -(y * Math.log(clip(p)) + (1 - y) * Math.log(clip(1 - p))), marginAE: Math.abs(r.actual.margin - (r.sim.margin + r.sim.shift)), totalAE: Math.abs(r.actual.total - r.sim.total) }];
  }));
}
function bootstrapCI(diffs, B = 1000, seed = 1) {
  let s = seed >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const means = [];
  for (let b = 0; b < B; b++) { let t = 0; for (let i = 0; i < diffs.length; i++) t += diffs[Math.floor(rnd() * diffs.length)]; means.push(t / diffs.length); }
  means.sort((a, b) => a - b);
  return [round(means[Math.floor(0.025 * B)]), round(means[Math.floor(0.975 * B) - 1])];
}
async function compare(season) {
  const reg = (await readGz(`data/model/sims/${season}-B.json.gz`)).rows;
  const c = await readGz(`data/model/sims-c/${season}-B.json.gz`);
  const R = perGame(reg), C = perGame(c.rows);
  const ids = [...R.keys()].filter(id => C.has(id));
  const changed = new Set(c.rows.filter(r => r.changed).map(r => r.id));
  const diff = k => ids.map(id => C.get(id)[k] - R.get(id)[k]);
  const metric = k => ({ registered: round(mean(ids.map(id => R.get(id)[k]))), c: round(mean(ids.map(id => C.get(id)[k]))), diff: round(mean(diff(k))), ci95: bootstrapCI(diff(k)) });
  const opts = { cal: CAL.calibration, sigmaBase: P.sigma.base, seed: 1, bootstrap: 200, slopeBootstrap: 200 };
  const slope = rows => report(withShift(rows, CAL.ensemble.w), opts).all.S2.slope;
  const out = {
    season, judged: ids.length, changedGames: ids.filter(id => changed.has(id)).length, counts: c.counts, coverage: await coverage(season),
    brier: metric('brier'), logLoss: metric('logLoss'), marginMAE: metric('marginAE'), totalMAE: metric('totalAE'),
    slope: { registered: round(slope(reg), 4), c: round(slope(c.rows), 4) },
    changedOnly: ids.some(id => changed.has(id)) ? { games: ids.filter(id => changed.has(id)).length, brierDiff: round(mean(ids.filter(id => changed.has(id)).map(id => C.get(id).brier - R.get(id).brier))) } : null,
  };
  out.slope.diff = round(out.slope.c - out.slope.registered, 4);
  out.checks = {
    coverage: out.coverage.coverage >= CRITERIA.coverage,
    brier: out.brier.diff <= CRITERIA.brier, logLoss: out.logLoss.diff <= CRITERIA.logLoss,
    marginMAE: out.marginMAE.diff <= CRITERIA.marginMAE, totalMAE: out.totalMAE.diff <= CRITERIA.totalMAE, slope: Math.abs(out.slope.diff) <= CRITERIA.slope,
  };
  out.pass = Object.values(out.checks).every(Boolean);
  return out;
}

const [cmd, season] = process.argv.slice(2);
if (cmd === 'pdf') { guard(season); await pdf(season); }
else if (cmd === 'coverage') { guard(season); console.log(JSON.stringify(await coverage(season))); }
else if (cmd === 'sims') { guard(season); await sims(season, +(process.argv.includes('--n') ? process.argv[process.argv.indexOf('--n') + 1] : 10000)); }
else if (cmd === 'report') {
  const out = { generatedAt: new Date().toISOString(), plan: 'docs/plans/2026-10-27-early-run-plan.md', cutoffEt: C_ET, criteria: CRITERIA, ensembleW: CAL.ensemble.w, seasons: {} };
  for (const s of SEASONS) out.seasons[s] = await compare(s);
  out.primaryPass = out.seasons['2024-25'].pass;
  await writeFile('docs/reports/c-validation.json', JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
} else { console.error('usage: node scripts/c/early-run.mjs pdf|coverage|sims <season> | report'); process.exit(2); }
