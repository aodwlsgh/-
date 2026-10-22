// Which daily run covers a game, and the injury-snapshot cutoff it implies (design §11.2, §14.2).
// Run A 17:50 ET covers games after it; run B 20:50 ET re-runs for games starting 21:00 ET or later;
// games starting at or before 17:50 ET start before any run ("pre_job_start", excluded from S1-S3).
import { etParts, fromEt } from './time.js';
import { normalizeName, teamKey, PLAY_PROB, reportTimeEt } from './injury.js';
import { byEspn } from './teams.js';

export const RUN_A_ET = { hour: 17, minute: 50 };
export const RUN_B_ET = { hour: 20, minute: 50 };
export const LATE_GAME_ET = { hour: 21, minute: 0 };

export function jobGroup(startIso) {
  const start = new Date(startIso);
  const d = etParts(start).date;
  if (start <= fromEt(d, RUN_A_ET.hour, RUN_A_ET.minute)) return 'pre_job_start';
  if (start >= fromEt(d, LATE_GAME_ET.hour, LATE_GAME_ET.minute)) return 'B';
  return 'A';
}

// latest moment whose injury PDF the game may use
export function snapshotCutoff(startIso) {
  const start = new Date(startIso);
  const d = etParts(start).date;
  switch (jobGroup(startIso)) {
    case 'pre_job_start': return new Date(start.getTime() - 60e3);
    case 'B': return fromEt(d, RUN_B_ET.hour, RUN_B_ET.minute);
    default: return fromEt(d, RUN_A_ET.hour, RUN_A_ET.minute);
  }
}

// Backtest (B) plan input for one team of one game: the PDF rows of that game's matchup and team, matched to
// roster players by normalised name; Out = 0, other statuses = design §6.5 play probability.
// players: [{ id, name }], the team's own players first (they win a name clash); team/home/away: ESPN abbreviations
export function snapshotInjuries(snap, { team, home, away, players, statusOf = false }) {
  const out = { injuries: {}, unmatched: [], rows: 0, notSubmitted: false, missing: !snap };
  if (statusOf) out.statuses = [];
  if (!snap) return out;
  const t = byEspn(team), matchup = `${byEspn(away).nba}@${byEspn(home).nba}`;
  out.notSubmitted = (snap.notSubmitted ?? []).some(x => x.matchup === matchup && teamKey(x.team) === t.key);
  const ids = new Map();
  for (const p of players) { const k = normalizeName(p.name ?? ''); if (!ids.has(k)) ids.set(k, p.id); }
  for (const r of snap.rows ?? []) {
    if (r.matchup !== matchup || teamKey(r.team) !== t.key || PLAY_PROB[r.status] === undefined) continue;
    out.rows++;
    const id = ids.get(normalizeName(r.player));
    if (id) { out.injuries[id] = PLAY_PROB[r.status]; out.statuses?.push({ id, status: r.status }); }
    else out.unmatched.push(r.player);
  }
  return out;
}

// When an injury report could first be read: the later of the report time in its title (ET) and the
// server Last-Modified time. File names alone are not enough: before 2025-12-22 "_03PM" holds the 15:30 report.
export function availableAt({ reportTime, lastModified } = {}) {
  const r = reportTimeEt(reportTime);
  const times = [r && fromEt(r.date, r.hour, r.minute), lastModified && new Date(lastModified)].filter(Boolean);
  return times.length ? new Date(Math.max(...times.map(t => t.getTime()))) : null;
}
