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

export const runAt = (run, etDate) => fromEt(etDate, RUN_ET[run].hour, RUN_ET[run].minute);

// games a run predicts: run A every game after 17:50 ET (B-group ones provisionally), run B the 21:00 ET+ games
export const runGames = (run, games) => games.filter(g => {
  const grp = jobGroup(g.start.utc ?? g.start);
  return run === 'A' ? grp !== 'pre_job_start' : grp === 'B';
});

export function isFinalRun(run, startIso, now) {
  const start = new Date(startIso), t = new Date(now);
  const grp = jobGroup(start.toISOString());
  if (grp === 'pre_job_start' || grp !== run || t >= start) return false;
  return t >= runAt(run, etParts(start).date);
}
