// Daily run (P9; design §11.2, §12, §13; plan P9; procedure docs/daily-run.md). The Node steps are here; the run's
// Claude session does the tool steps between them (Artifact publish, ArtifactData reads and batches, git push via
// jobs/commit-daily.js). Nothing is fitted: params, latent, calibration and play-prob are only read.
//   prepare A|B|C [--now ISO] [--n 10000] [--offline --season S [--offline-snapshot none]]   collect, predict, write the day file, archive, run log
//   sensitivity [--n 2000]                                       sensitivity (unverified) for this run's games
//   mark published | mark <field> '<json>'                       record a tool step in the run log
//   report [--chain DIR]                                         report with the pick-log statuses
//   files                                                        the publish file map (JSON) for the Artifact tool
// Picks and EV use the validated input (NBA PDF snapshot only); the design §6.5 ESPN+PDF merge is a parallel record.
import { readFile, writeFile, mkdir, readdir, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { gzipSync, gunzipSync } from 'node:zlib';
import { dirname, join } from 'node:path';
import { loadGames } from './lib/games.js';
import { createCollector } from '../engine/collect.js';
import { liveInputs, fixturesFromScoreboard, PIN30, LATEST } from './lib/live-collect.js';
import { livePlans, simulateRow, mergedInjuries, injuryDiff, RULES_ON } from '../engine/live.js';
import { snapshotInjuries, jobGroup } from '../engine/snapshot.js';
import { resolveStatuses } from '../engine/injury.js';
import { runAt, runCEt, runGames, isFinalRun, searchAtOf, cMorningReport, cPin } from '../engine/trigger-time.js';
import { etParts } from '../engine/time.js';
import { stamp } from '../engine/clock.js';
import { breakeven } from '../engine/picks.js';
import { markets } from '../engine/calibrate.js';
import { sensitivity } from '../engine/sensitivity.js';
import { chemistryFlag, newPlayers } from '../engine/auto-scenario.js';
import { BETMAN_TEAMS } from '../engine/betman-teams.js';
import { TEXT, DAY_SCHEMA, validateDay } from '../engine/dashboard-data.js';
import { reportMarkdown, totalBias } from '../engine/daily-report.js';
import { closure } from '../scripts/p8/closure.mjs';
import { readDir } from './lib/db-files.js';
import { seasonState } from './lib/season-state.js';
import { pdfOutUnmatched, escalate } from '../engine/run-alerts.js';

const argv = process.argv.slice(2);
const arg = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d);
const PRIOR = { '2024-25': '2023-24', '2025-26': '2024-25', '2026-27': '2025-26' };
const OUT = arg('--out', '.');
const at = p => join(OUT, p);
const exists = p => access(p).then(() => true, () => false);
const writeJson = async (p, v, pretty = true) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, JSON.stringify(v, null, pretty ? 1 : 0)); };
const readJson = async p => JSON.parse(await readFile(p, 'utf8'));
const readGz = async p => JSON.parse(gunzipSync(await readFile(p)));
const writeGz = async (p, v) => { await mkdir(dirname(p), { recursive: true }); await writeFile(p, gzipSync(JSON.stringify(v))); };
const etHm = t => { const e = etParts(new Date(t)); return `${String(e.hour).padStart(2, '0')}${String(e.minute).padStart(2, '0')}`; };
const etLabel = t => { const e = etParts(new Date(t)); return `${e.date} ${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')} ET`; };

export const paths = season => ({
  day: 'data/live/today.json', runs: `data/runs/${season}`, preds: `data/predictions/${season}`, reports: `docs/daily/${season}`, pdf: `data/injury-pdf/${season}`,
  // raw ESPN injuries feed per run, under an allowed path (parallel record only)
  espn: `data/injury-pdf/${season}/espn-feed`,
});

const P = await readJson('data/model/params.json');
const LATENT = (await readJson('data/model/latent.json')).latent;
const CAL = await readJson('data/model/calibration.json');

function team(t) {
  const b = BETMAN_TEAMS.find(x => x.espn === t.abbr);
  return { id: t.id, espn: t.abbr, name: b?.name ?? t.abbr, ko: b?.ko ?? '', koVerified: !!b?.koVerified };
}
const trim = (ratings, ids, teams) => ({
  league: ratings.league,
  teams: Object.fromEntries(teams.map(t => [t, ratings.teams[t]])),
  players: Object.fromEntries(ids.filter(id => ratings.players[id]).map(id => [id, ratings.players[id]])),
});

// ---- prepare ----------------------------------------------------------------------------------------------------
async function prepare() {
  const run = argv[1];
  if (!['A', 'B', 'C'].includes(run)) throw new Error('usage: prepare A|B|C');
  const now = new Date(arg('--now') ?? Date.now());
  const n = +arg('--n', 10000);
  const offline = argv.includes('--offline');
  const season = arg('--season', '2026-27');
  const date = arg('--date', etParts(now).date);
  const p = paths(season);
  const runId = `${date}-${run}-${etHm(now)}`;
  const log = { runId, run, date, season, startedAt: stamp(now), steps: [], alerts: [], skipped: [], offline };
  const alert = (code, text, extra = {}) => log.alerts.push({ code, text, ...extra });
  const step = async (name, fn) => {
    const t = Date.now();
    try { const detail = await fn(); log.steps.push({ name, ok: true, ms: Date.now() - t, ...(detail ? { detail } : {}) }); return true; } catch (e) {
      log.steps.push({ name, ok: false, ms: Date.now() - t, error: String(e.message ?? e).slice(0, 2000) });
      return false;
    }
  };
  const env = { ...process.env };
  const node = args => { const r = spawnSync(process.execPath, args, { env, encoding: 'utf8', maxBuffer: 64 << 20 }); if (r.status !== 0) throw new Error(`${args.join(' ')} exit ${r.status}: ${(r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' / ')}`); return (r.stdout || '').trim().split('\n').slice(-2).join(' / '); };

  // 1-2. live schema check and the finished games (run A only; run B uses what run A collected)
  if (!offline) {
    if (!(await step('schema check', () => node(['scripts/check-schema-live.mjs'])))) alert('schema', `ESPN 형식 점검 실패 — ${log.steps.at(-1).error}`);
    // runs A and C collect the finished games (C: the morning before run A; docs/plans/2026-10-27-early-run-plan.md)
    if (run === 'A' || run === 'C') {
      const ok = (await step('collect schedule', () => node(['jobs/build-data.js', 'schedule', season]))) && (await step('normalize play types', () => node(['jobs/normalize-raw.js', season]))) && (await step('collect games', () => node(['jobs/build-data.js', 'games', season])));
      if (!ok) {
        const s = await readJson(`data/schedule/${season}.json`).catch(() => null);
        alert('dataDelay', `데이터 지연 — 마지막 갱신 ${s?.generatedAt ?? '알 수 없음'}(완료 경기 ${s?.scannedThrough ?? '—'}까지). ${log.steps.at(-1).error}`);
      }
    }
  }

  // 3. today's games, the injury report snapshot of this run, the ESPN feed (parallel record only)
  const cutoff = runAt(run, date);
  const searchAt = searchAtOf(run, date, now); // a run before its time uses what was out then (provisional)
  // report edition rule (2026-10-28 user decision 2): run C the cutoff hour's :30 report only, runs A and B the latest
  const reportRule = run === 'C' ? PIN30 : LATEST;
  log.reportRule = reportRule;
  let inputs;
  if (offline) {
    const games = await loadGames([season]);
    const day = games.filter(g => etParts(new Date(g.start)).date === date);
    let pdfRec = await readGz(join(p.pdf, `${date}.json.gz`)).catch(() => null);
    // offline run C of a past season reads the validation snapshot of its cutoff (scripts/c/early-run.mjs)
    // --offline-snapshot none: as if no report had been published (tests)
    if (arg('--offline-snapshot') === 'none') pdfRec = null;
    const cRec = run === 'C' && !pdfRec?.runC && arg('--offline-snapshot') !== 'none' ? await readGz(`data/injury-pdf-c${runCEt(date).hour === 7 ? '0750' : ''}/${season}/${date}.json.gz`).catch(() => null) : null;
    inputs = { fixtures: day.map(g => ({ id: g.id, start: g.start, season: g.season, home: g.home, away: g.away })), skipped: [], snapshot: (run === 'B' ? pdfRec?.runB : run === 'C' ? pdfRec?.runC ?? cRec?.snap : pdfRec?.main) ?? { pdf: null }, espn: null, espnError: 'offline' };
  } else {
    const col = createCollector({});
    if (!(await step('inputs', async () => { inputs = await liveInputs(col, { date, season, searchAt, pin: reportRule === PIN30 ? cPin(date) : null }); return `${inputs.fixtures.length} games, report ${inputs.snapshot.pdf ?? 'none'}`; }))) {
      alert('inputs', `오늘 일정·부상 리포트를 가져오지 못함 — ${log.steps.at(-1).error}`);
      await finishLog(p, log);
      console.log(JSON.stringify({ ok: false, runId, alerts: log.alerts }));
      process.exit(2);
    }
  }
  const snap = inputs.snapshot;
  // ESPN injuries feed as received, every run (2026-10-26 user decision 7): parallel record only, never read by predictions
  if (inputs.espnRaw) {
    const raw = gzipSync(JSON.stringify(inputs.espnRaw));
    await mkdir(at(p.espn), { recursive: true });
    await writeFile(at(join(p.espn, `${runId}.json.gz`)), raw);
    log.espnFeed = { path: join(p.espn, `${runId}.json.gz`), bytes: raw.length, players: inputs.espn?.length ?? null };
  }
  if (snap?.nameFixes) log.pdfNameFixes = snap.nameFixes;
  const usable = snap?.rows && !snap.formatError ? snap : null;
  if (!usable) alert('injuryPdf', snap?.formatError ? `NBA 부상 리포트 형식 오류(${snap.pdf}) — 검증 경로 예측에 부상 미반영` : 'NBA 부상 리포트 없음 — 검증 경로 예측에 부상 미반영');
  // run C: no game-day morning report by the cutoff -> every C prediction provisional, warning and push (condition 6)
  const cReport = run === 'C' ? cMorningReport(snap, date, cutoff) : { ok: true };
  if (run === 'C') log.cReport = { rule: reportRule, ok: cReport.ok, why: cReport.why, pdf: snap?.pdf ?? null, reportTime: snap?.reportTime ?? null, pinMiss: snap?.pinMiss ?? null };
  if (!cReport.ok) alert('cMorningReport', `아침 리포트 기준(C) 리포트 없음 — ${cReport.why}. 이번 C 예측은 모두 예비이고 평가하지 않습니다`);
  if (!inputs.espn && !offline) alert('espnInjuries', `ESPN 부상 피드 없음 — 병행 기록 생략(${inputs.espnError})`);
  const resolved = inputs.espn ? resolveStatuses({ espn: inputs.espn, pdf: usable }) : null;
  log.skipped.push(...inputs.skipped);
  if (!offline) {
    const file = join(p.pdf, `${date}.json.gz`);
    const rec = (await readGz(file).catch(() => null)) ?? { date, cutoff: runAt('A', date).toISOString(), format: '15min', main: null, early: [], runB: null };
    if (now >= cutoff) rec[{ A: 'main', B: 'runB', C: 'runC' }[run]] = snap; else (rec.manual ??= []).push({ runId, at: searchAt.toISOString(), ...snap });
    await writeGz(at(file), rec);
  }

  // 4. predictions of this run's games (not started); run B also carries run A's games
  const history = await loadGames([PRIOR[season], season]);
  const targets = runGames(run, inputs.fixtures).filter(f => new Date(f.start) > now);
  for (const f of inputs.fixtures) {
    if (jobGroup(f.start) === 'pre_job_start') log.skipped.push({ id: f.id, game: `${f.away.abbr}@${f.home.abbr}`, reason: 'starts before 17:50 ET (no run covers it)' });
    else if (!targets.includes(f) && run !== 'B') log.skipped.push({ id: f.id, game: `${f.away.abbr}@${f.home.abbr}`, reason: 'started before the run' });
  }
  const injuriesFor = s => (f, side, players) => snapshotInjuries(s, { team: side ? f.away.abbr : f.home.abbr, home: f.home.abbr, away: f.away.abbr, players });
  const lp = livePlans({ history, fixtures: targets, date, params: P.params, injuriesFor: injuriesFor(usable) });
  log.skipped.push(...lp.skipped);
  // PDF Out rows the exact match missed: a known player under another spelling is a warning (2026-10-26 decision 4)
  const unm = pdfOutUnmatched(lp.rows, usable?.rows);
  if (unm.known.length) alert('pdfUnmatched', `PDF 선수 못 찾음 — ${unm.known.map(k => `${k.game} ${k.team} ${k.player}(Out, 기록 이름 ${k.known})`).join('; ')}. 검증 경로 예측에 이 부상이 빠졌다`, { players: unm.known });
  log.pdfOutNoRecord = unm.noRecord;
  const w = CAL.ensemble.w;
  const games = [];
  const t0 = Date.now();
  for (const row of lp.rows) games.push(await gameEntry({ row, run, runId, now, n, w, usable, resolved, names: lp.names, acc: lp.acc, history, season, date, snap, reportOk: cReport.ok, reportRule }));
  log.simSeconds = (Date.now() - t0) / 1000;
  if (run === 'B') games.push(...(await carryRunA({ p, date, season, history, now, exclude: new Set(games.map(g => g.gameId)) })));
  games.sort((a, b) => Date.parse(a.start.utc) - Date.parse(b.start.utc) || a.gameId.localeCompare(b.gameId));
  if (run === 'B' && !lp.rows.length) log.note = '대상 없음 — 21:00 ET 이후 시작 경기가 없음';

  // warnings seen in the comparable earlier run too go to the dashboard header and a push (2026-10-26 decision 6)
  const esc = escalate(log.alerts, await earlierLogs(p, runId), run);
  log.alerts = esc.alerts;
  if (esc.push.length) log.push = esc.push;
  if (!cReport.ok) (log.push ??= []).push(`[NBA C] ${log.alerts.find(a => a.code === 'cMorningReport').text}`);

  // 5. day file, archive, run log
  const day = {
    schema: DAY_SCHEMA, kind: 'live', date, season, run, runId, generatedAt: stamp(now),
    source: { path: 'validated variant B steps (engine/live.js), NBA PDF snapshot only for picks and EV', ensembleW: w, simulations: n, sensitivity: 2000, parallel: TEXT.parallel },
    games, alerts: log.alerts,
  };
  const errs = validateDay(day);
  if (errs.length) throw new Error(`day file: ${errs.join('; ')}`);
  await writeJson(at(p.day), day, false);
  await writeGz(at(join(p.preds, `${runId}.json.gz`)), archiveOf(day, snap, log));
  log.games = games.map(g => ({ gameId: g.gameId, game: `${g.away.espn}@${g.home.espn}`, group: g.group, run: g.prediction.run, final: g.prediction.final, parallelDiffs: g.parallel?.diffs?.length ?? null }));
  await finishLog(p, log);
  console.log(JSON.stringify({ ok: true, runId, date, games: games.length, final: games.filter(g => g.prediction.final).length, provisional: games.filter(g => !g.prediction.final).length, skipped: log.skipped.length, alerts: log.alerts.map(a => a.text), push: log.push ?? [], simSeconds: log.simSeconds }));
}

async function gameEntry({ row, run, runId, now, n, w, usable, resolved, names, acc, history, season, date, snap, reportOk = true, reportRule = LATEST }) {
  const f = row.fixture;
  const { sim, input } = simulateRow(row, { n, latent: LATENT, w });
  // the report edition this prediction used and the rule that chose it (2026-10-28 user decision 3)
  const prediction = { source: 'base', runId, run, final: isFinalRun(run, f.start, now) && reportOk, report: { rule: reportRule, pdf: usable ? snap.pdf : null, reportTime: usable ? snap.reportTime : null }, sim };
  const ids = [...row.homePlan.players, ...row.awayPlan.players].map(x => x.playerId);
  // parallel record: design §6.5 merge, simulated only where it changes someone's play probability
  let parallel = null;
  if (resolved) {
    const merged = [0, 1].map(side => mergedInjuries(resolved, { team: side ? f.away.abbr : f.home.abbr, players: row.players[side] }));
    const diffs = [0, 1].flatMap(side => injuryDiff(row.injuries[side], merged[side].injuries, names).map(d => ({ side: side ? 'away' : 'home', ...d })));
    parallel = { label: TEXT.parallel, usedForPicks: false, same: !diffs.length, diffs, unmatched: merged.flatMap(m => m.unmatched), conflicts: merged.flatMap(m => m.conflicts) };
    if (diffs.length) {
      const s = simulateRow(row, { n, latent: LATENT, w, plans: row.plansWith(merged.map(m => m.injuries)) }).sim;
      const m = markets(CAL.calibration, s);
      parallel = { ...parallel, margin: s.margin + s.shift, total: s.total, winProbHome: m.ml.home };
    } else parallel.winProbHome = markets(CAL.calibration, sim).ml.home;
  }
  const teamGame = id => history.filter(g => g.season === season && (g.home.id === id || g.away.id === id)).length + 1;
  const autoScenarios = [[f.home, row.homePlan], [f.away, row.awayPlan]].map(([t, plan]) => ({ type: 'chemistry', team: t.abbr, ...chemistryFlag({ plan, newPlayerIds: newPlayers(acc, t.id, date, plan), teamGame: teamGame(t.id), team: t.id }) })).filter(x => x.flagged);
  return {
    gameId: f.id, start: { ...stamp(f.start), et: etLabel(f.start) }, group: row.group, home: team(f.home), away: team(f.away), prediction, seed: +f.id % 2147483647,
    breakeven: breakeven(prediction, CAL.calibration),
    simInput: { ...input, abbr: { home: f.home.abbr, away: f.away.abbr }, ratings: trim(row.ratings, ids, [f.home.id, f.away.id]) },
    names: Object.fromEntries(ids.map(id => [id, names.get(id) ?? id])),
    dataStatus: { run, injurySnapshot: usable ? row.snapshot : null, pdf: snap?.pdf ? { name: snap.pdf, reportTime: snap.reportTime, availableAt: snap.availableAt, lagMin: snap.lagMin } : null },
    parallel, sensitivity: null, autoScenarios,
  };
}

// run B: run A's games of the date as run A published them (plans rebuilt from run A's stored snapshot)
async function carryRunA({ p, date, season, history, now, exclude }) {
  const files = (await readdir(at(p.preds)).catch(() => [])).filter(x => x.startsWith(`${date}-A-`)).sort();
  if (!files.length) return [];
  const a = await readGz(at(join(p.preds, files.at(-1))));
  const keep = a.games.filter(g => !exclude.has(g.gameId));
  if (!keep.length) return [];
  const fixtures = keep.map(g => ({ id: g.gameId, start: g.start.utc, season, home: { id: g.home.id, abbr: g.home.espn }, away: { id: g.away.id, abbr: g.away.espn } }));
  const s = a.snapshot?.rows && !a.snapshot.formatError ? a.snapshot : null;
  const lp = livePlans({ history, fixtures, date, params: P.params, injuriesFor: (f, side, players) => snapshotInjuries(s, { team: side ? f.away.abbr : f.home.abbr, home: f.home.abbr, away: f.away.abbr, players }) });
  return keep.map(g => {
    const r = lp.rows.find(x => x.fixture.id === g.gameId);
    const ids = [...r.homePlan.players, ...r.awayPlan.players].map(x => x.playerId);
    return { ...g, simInput: { ratings: trim(r.ratings, ids, [r.fixture.home.id, r.fixture.away.id]), home: r.fixture.home.id, away: r.fixture.away.id, homePlan: r.homePlan, awayPlan: r.awayPlan, abbr: { home: g.home.espn, away: g.away.espn } }, names: Object.fromEntries(ids.map(id => [id, lp.names.get(id) ?? id])), breakeven: breakeven(g.prediction, CAL.calibration) };
  });
}

const archiveOf = (day, snapshot, log) => ({
  runId: day.runId, run: day.run, date: day.date, season: day.season, generatedAt: day.generatedAt, publishedAt: null, startedAt: log.startedAt,
  snapshot: snapshot?.rows ? snapshot : snapshot ? { ...snapshot, rows: undefined } : null,
  games: day.games.map(({ simInput, names, breakeven: _b, ...g }) => g),
});

// run logs of the season before this one, oldest first
async function earlierLogs(p, runId) {
  const files = (await readdir(at(p.runs)).catch(() => [])).filter(f => f.endsWith('.json') && f !== `${runId}.json`);
  const logs = await Promise.all(files.map(f => readJson(at(join(p.runs, f))).catch(() => null)));
  return logs.filter(l => l?.startedAt?.utc).sort((a, b) => Date.parse(a.startedAt.utc) - Date.parse(b.startedAt.utc));
}

async function finishLog(p, log) { await writeJson(at(join(p.runs, `${log.runId}.json`)), log); }

// ---- helpers for the other subcommands ----------------------------------------------------------------------------
async function current() {
  const day = await readJson(at('data/live/today.json'));
  const p = paths(day.season);
  const logPath = at(join(p.runs, `${day.runId}.json`));
  return { day, p, log: await readJson(logPath), logPath };
}

async function sens() {
  const { day, p, log } = await current();
  const n = +arg('--n', 2000);
  const t0 = Date.now();
  for (const g of day.games.filter(x => x.prediction.runId === day.runId)) {
    const s = sensitivity(g.simInput, { n, seed: g.seed, rules: RULES_ON });
    g.sensitivity = { label: s.label, n: s.n, seed: s.seed, base: s.base, topMargin: s.topMargin.map(({ key, label, dMargin, dTotal }) => ({ key, label, dMargin, dTotal })), topTotal: s.topTotal.map(({ key, label, dMargin, dTotal }) => ({ key, label, dMargin, dTotal })), ms: Math.round(s.ms) };
  }
  await writeJson(at(p.day), day, false);
  const arch = join(p.preds, `${day.runId}.json.gz`);
  const a = await readGz(at(arch));
  for (const g of a.games) g.sensitivity = day.games.find(x => x.gameId === g.gameId)?.sensitivity ?? g.sensitivity;
  await writeGz(at(arch), a);
  log.steps.push({ name: 'sensitivity', ok: true, ms: Date.now() - t0 });
  await finishLog(p, log);
  console.log(JSON.stringify({ ok: true, seconds: (Date.now() - t0) / 1000 }));
}

// mark published | mark <field> '<json>' (ok:false adds an alert to the run log and the day file)
async function mark() {
  const { day, p, log } = await current();
  const field = argv[1];
  if (field === 'published') {
    log.publishedAt = stamp(new Date(arg('--at') ?? Date.now()));
    const arch = join(p.preds, `${day.runId}.json.gz`);
    const a = await readGz(at(arch));
    a.publishedAt ??= log.publishedAt; // the first publication of this run's predictions
    await writeGz(at(arch), a);
  } else {
    const v = JSON.parse(argv[2]);
    v.at = stamp(new Date());
    (log[field] ??= []).push(v);
    if (v.ok === false) {
      const text = `${field === 'db' ? TEXT.writeFailed : `${field} 실패`} — ${v.reason ?? '사유 없음'}${v.markets ? ` (마켓 ${v.markets})` : ''}`;
      log.alerts.push({ code: field, text });
      day.alerts = log.alerts;
      await writeJson(at(p.day), day, false);
    }
  }
  await finishLog(p, log);
  console.log(JSON.stringify({ ok: true, runId: day.runId, field }));
}

async function report() {
  const { day, p, log } = await current();
  const dir = arg('--chain');
  let chain = [], verify = { ok: true, problems: [] };
  if (dir) {
    ({ records: chain, verify } = await readDir(dir));
    // dashboard write failures noted outside the chain (failures/), last 36 hours
    for (const f of (await readdir(join(dir, 'failures')).catch(() => [])).filter(x => x.endsWith('.json')).sort()) {
      const raw = await readJson(join(dir, 'failures', f)).catch(() => null);
      const x = raw?.data && !raw.reason ? raw.data : raw;
      if (x?.at && Date.now() - Date.parse(x.at) < 36 * 3600e3 && !log.alerts.some(a => a.ref === f)) log.alerts.push({ code: 'dashboardWrite', ref: f, text: `대시보드 쓰기 실패 기록(${stamp(x.at).kst.slice(0, 16)} KST): ${x.reason} — 마켓 ${x.markets ?? '—'}` });
    }
  } else log.alerts.push({ code: 'chainRead', text: '픽 로그를 읽지 못함 — 상태는 배당 기록 없이 계산' });
  const { totals } = await seasonState({ season: day.season, root: OUT });
  const anchor = await readJson(at('data/live/anchor.json')).catch(() => null);
  const md = reportMarkdown({ day, cal: CAL.calibration, chain, verify, anchor, run: log, alerts: log.alerts, biasAll: totalBias(totals, new Date()), now: new Date() });
  await mkdir(at(p.reports), { recursive: true });
  await writeFile(at(join(p.reports, `${day.runId}.md`)), md);
  day.alerts = log.alerts;
  await writeJson(at(p.day), day, false);
  await finishLog(p, log);
  console.log(md);
}

async function files() {
  const c = await closure();
  const map = Object.fromEntries([...c.files, 'data/live/today.json', 'data/model/calibration.json', 'data/live/model-status.json', 'data/live/anchor.json'].map(f => [f, f]));
  console.log(JSON.stringify(map));
}

const CMDS = { prepare, sensitivity: sens, mark, report, files };
if (process.argv[1]?.endsWith('daily.js')) {
  const cmd = CMDS[argv[0]];
  if (!cmd) { console.error(`usage: node jobs/daily.js ${Object.keys(CMDS).join('|')}`); process.exit(2); }
  await cmd();
}
