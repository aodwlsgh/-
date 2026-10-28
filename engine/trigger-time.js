// Run times of the two daily scheduled tasks (P9, design §11.2): New York wall-clock crons, so their UTC and KST
// times move with US daylight saving (ends 2026-11-01, starts 2027-03-14). A prediction is final only when it
// comes from its group's run (A for games before 21:00 ET, B for later ones) at or after that run's time; any
// earlier run (a manual one) publishes it as provisional, and games already started are never predicted.
import { etParts, fromEt } from './time.js';
import { jobGroup, RUN_A_ET, RUN_B_ET } from './snapshot.js';

export const RUN_ET = { A: RUN_A_ET, B: RUN_B_ET };
export const RUN_CRON = Object.fromEntries(Object.entries(RUN_ET).map(([k, t]) => [k, `CRON_TZ=America/New_York ${t.minute} ${t.hour} * * *`]));

// only the daily form "CRON_TZ=America/New_York M H * * *"
export function parseDailyCron(expr) {
  const m = /^CRON_TZ=(\S+)\s+(\d{1,2})\s+(\d{1,2})\s+(\S+)\s+(\S+)\s+(\S+)$/.exec(String(expr).trim());
  if (!m) throw new Error(`expected CRON_TZ=<zone> M H * * *: ${expr}`);
  if (m[1] !== 'America/New_York') throw new Error(`time zone ${m[1]} (expected America/New_York)`);
  if (m[4] !== '*' || m[5] !== '*' || m[6] !== '*') throw new Error(`not a daily schedule: ${expr}`);
  return { tz: m[1], hour: +m[3], minute: +m[2] };
}

const addDays = (date, n) => new Date(Date.parse(`${date}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// first firing strictly after `from`
export function nextFireUtc(expr, from) {
  const { hour, minute } = parseDailyCron(expr);
  const day = etParts(new Date(from)).date;
  for (let i = 0; i < 3; i++) {
    const t = fromEt(addDays(day, i), hour, minute);
    if (t > new Date(from)) return t;
  }
  throw new Error('no firing within three days');
}

// Early run C (docs/plans/2026-10-27-early-run-plan.md), scheduled at 21:50 KST (08:50 EDT, 07:50 EST): the injury report
// as of 08:50 ET for game dates through 2026-10-31 (validated in docs/reports/c-validation.md, approved 2026-10-27) and
// as of 07:50 ET from 2026-11-01 (plan §8, option 다, criteria 4298179, passed 2026-10-28 in
// docs/reports/c-validation-0750.json; the 08:50 cutoff stays until then by the user's condition).
export const RUN_C_ET = { hour: 8, minute: 50 };
export const RUN_C_ET_0750 = { hour: 7, minute: 50 };
export const RUN_C_0750_FROM = '2026-11-01'; // ET game date
export const runCEt = etDate => (etDate >= RUN_C_0750_FROM ? RUN_C_ET_0750 : RUN_C_ET);
const runEt = (run, etDate) => (run === 'C' ? runCEt(etDate) : RUN_ET[run]);
export const runAt = (run, etDate) => fromEt(etDate, runEt(run, etDate).hour, runEt(run, etDate).minute);
// the moment a run reads the injury report at: its cutoff, or now for a run before its time (provisional)
export const searchAtOf = (run, etDate, now) => { const c = runAt(run, etDate); return new Date(now) < c ? new Date(now) : c; };
// run C uses its predictions as final only on a report of the game date available by the cutoff, without a format
// error (the coverage definition of plan §8); otherwise they are provisional, with a warning and a push (2026-10-28
// user condition 6). The search window (16 steps of 15 minutes) never reaches the previous evening.
// With the pin30 rule (2026-10-28 user decision 2) only the cutoff hour's :30 report counts (cPin).
export const cPin = etDate => ({ date: etDate, hour: runCEt(etDate).hour, minute: 30 });
const PIN_MISS = { missing: ':30판 없음', late: ':30판이 기준 시각 뒤에 나옴', 'format error': ':30판 형식 오류' };
export function cMorningReport(snap, etDate, cutoff) {
  if (snap?.pinMiss) return { ok: false, why: `${PIN_MISS[snap.pinMiss] ?? snap.pinMiss}${snap.late ? `(${snap.late.pdf}, 가용 ${snap.late.availableAt})` : snap.pdf ? `(${snap.pdf})` : ''}` };
  if (!snap?.pdf) return { ok: false, why: '리포트 없음' };
  if (snap.formatError) return { ok: false, why: `형식 오류(${snap.pdf})` };
  if (!snap.pdf.startsWith(`Injury-Report_${etDate}_`)) return { ok: false, why: `경기 당일 리포트가 아님(${snap.pdf})` };
  if (!snap.availableAt || new Date(snap.availableAt) > new Date(cutoff)) return { ok: false, why: `기준 시각 뒤 리포트(${snap.pdf})` };
  return { ok: true, why: null };
}

// games a run predicts: runs A and C every game after 17:50 ET (run A the B-group ones provisionally), run B the
// 21:00 ET+ games
export const runGames = (run, games) => games.filter(g => {
  const grp = jobGroup(g.start.utc ?? g.start);
  return run === 'B' ? grp === 'B' : grp !== 'pre_job_start';
});

export function isFinalRun(run, startIso, now) {
  const start = new Date(startIso), t = new Date(now);
  const grp = jobGroup(start.toISOString());
  if (grp === 'pre_job_start' || (run !== 'C' && grp !== run) || t >= start) return false;
  return t >= runAt(run, etParts(start).date);
}

// A market is evaluated by exactly one path: "C" when its Betman deadline is not after the final time of the game's
// own run (A 17:50 / B 20:50 ET), "AB" otherwise. Each path uses only its own final predictions.
export function evalPath(deadlineUtc, startUtc) {
  const start = new Date(startUtc), grp = jobGroup(start.toISOString());
  if (grp === 'pre_job_start') return null; // no run covers it
  return Date.parse(deadlineUtc) <= runAt(grp, etParts(start).date).getTime() ? 'C' : 'AB';
}
export const pathOfRun = run => (run === 'C' ? 'C' : 'AB');
// may this game's published prediction evaluate this odds record?
export const canEvaluate = (odds, game) => !!game?.prediction?.final && pathOfRun(game.prediction.run) === evalPath(odds.deadline.utc, game.start.utc);
