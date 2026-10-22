// Turns an ESPN game summary into possessions, stints and shot zones (design §6.1, §6.2).
// Pure functions: browser and Node. Input must already pass engine/schema/espn.js.
import { PLAY_TYPES } from './schema/espn-play-types.js';
import { NO_COORD } from './schema/espn.js';

export const HOOP = { x: 25, y: 1 }; // ESPN court feet; fitted to "N-foot" text distances in P0
const RA_FT = 4;
const PAINT_HALF_WIDTH = 8;
const PAINT_DEPTH_FROM_HOOP = 13.75; // 19 ft from baseline, hoop centre 5.25 ft from baseline
const CORNER_DEPTH_FROM_HOOP = 8.75; // straight part of the 3pt line, 14 ft from baseline

export const category = pl => PLAY_TYPES[pl.type?.id]?.[1] ?? 'unknown';
export const periodSeconds = period => (period <= 4 ? 720 : 300);

export function clockSec(s) {
  if (s.includes(':')) { const [m, x] = s.split(':'); return +m * 60 + +x; }
  return +s;
}

const isTechnical = pl => /Technical/i.test(pl.type.text) || /technical/i.test(pl.text ?? '');
const isFlagrant = pl => /Flagrant/i.test(pl.type.text);
function ftOf(pl) {
  const m = pl.type.text.match(/(\d) of (\d)/);
  return m ? { k: +m[1], n: +m[2] } : { k: 1, n: 1 };
}

export function teamsOf(s) {
  const cs = s.header.competitions[0].competitors;
  const home = cs.find(c => c.homeAway === 'home'), away = cs.find(c => c.homeAway === 'away');
  return { home: home.team.id, away: away.team.id, final: { [home.team.id]: +home.score, [away.team.id]: +away.score } };
}

// nearest earlier play that can explain a rebound (skips subs, timeouts, fouls, reviews)
function prevRelevant(plays, i) {
  for (let j = i - 1; j >= 0; j--) {
    const c = category(plays[j]);
    if (!['sub', 'timeout', 'foul', 'other'].includes(c)) return plays[j];
  }
  return null;
}
// a rebound right after a missed non-final free throw is a dead-ball team rebound
function isDeadBallRebound(plays, i) {
  const prev = prevRelevant(plays, i);
  if (!prev || category(prev) !== 'ft' || prev.scoringPlay || isTechnical(prev)) return false;
  const { k, n } = ftOf(prev);
  return k < n;
}

// and-one: a made basket followed, at the same clock, by a 1-of-1 free throw for the same team
function isAndOne(plays, i) {
  const shot = plays[i];
  for (let j = i + 1; j < plays.length; j++) {
    const q = plays[j];
    if (q.period.number !== shot.period.number || q.clock.displayValue !== shot.clock.displayValue) return false;
    const c = category(q);
    if (c === 'ft') {
      if (isTechnical(q)) continue; // a technical can sit between basket and and-one
      return q.team?.id === shot.team?.id && /1 of 1/.test(q.type.text);
    }
    if ((c === 'oreb' || c === 'dreb') && !(q.participants || []).length) continue; // dead-ball team rebound
    if (['fga', 'heave', 'tov', 'oreb', 'dreb'].includes(c)) return false;
  }
  return false;
}

// ---- possessions ----------------------------------------------------------------
// A possession opens with the first event of the team holding the ball (or its defensive
// rebound) and ends on: made FG (not and-one), defensive rebound, turnover, final made free
// throw (not flagrant), end of period, or an unrecorded change (the other team acts).
export function toPossessions(s) {
  const plays = s.plays;
  const possessions = [];
  const count = {};
  const techPoints = {};
  let cur = null;
  let period = 0;

  const close = (endType, pl) => {
    if (!cur) return;
    cur.end = pl ? clockSec(pl.clock.displayValue) : 0;
    cur.endType = endType;
    possessions.push(cur);
    count[cur.team] = (count[cur.team] || 0) + 1;
    cur = null;
  };
  const open = (team, pl) => {
    if (cur && cur.team === team) return;
    if (cur) close('change', pl);
    cur = { team, period: pl.period.number, start: clockSec(pl.clock.displayValue), points: 0 };
  };

  plays.forEach((pl, i) => {
    if (pl.period.number !== period) { close('period', null); period = pl.period.number; }
    const c = category(pl);
    const team = pl.team?.id;
    switch (c) {
      case 'fga':
      case 'heave':
        open(team, pl);
        if (pl.scoringPlay) {
          cur.points += pl.scoreValue;
          if (!(c === 'fga' && isAndOne(plays, i))) close('made', pl);
        }
        break;
      case 'ft': {
        if (isTechnical(pl)) {
          if (pl.scoringPlay) techPoints[team] = (techPoints[team] || 0) + pl.scoreValue;
          break;
        }
        open(team, pl);
        if (pl.scoringPlay) cur.points += pl.scoreValue;
        const { k, n } = ftOf(pl);
        if (k === n && pl.scoringPlay && !isFlagrant(pl)) close('ft', pl);
        break;
      }
      case 'oreb':
        if (!isDeadBallRebound(plays, i)) open(team, pl);
        break;
      case 'dreb':
        if (isDeadBallRebound(plays, i)) break;
        if (cur && cur.team !== team) close('dreb', pl);
        open(team, pl);
        break;
      case 'tov':
        open(team, pl);
        close('tov', pl);
        break;
      case 'end':
        close('period', pl);
        break;
      default:
        break;
    }
  });
  close('period', null);
  return { possessions, count, techPoints };
}

// ---- totals --------------------------------------------------------------------
const STAT = {
  fg: 'fieldGoalsMade-fieldGoalsAttempted', tp: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  ft: 'freeThrowsMade-freeThrowsAttempted',
};

export function boxTotals(s) {
  const out = {};
  for (const t of s.boxscore.teams) {
    const v = Object.fromEntries(t.statistics.map(x => [x.name, x.displayValue]));
    const [fgm, fga] = v[STAT.fg].split('-').map(Number);
    const [tpm, tpa] = v[STAT.tp].split('-').map(Number);
    const [ftm, fta] = v[STAT.ft].split('-').map(Number);
    out[t.team.id] = {
      fgm, fga, tpm, tpa, ftm, fta,
      oreb: +v.offensiveRebounds, dreb: +v.defensiveRebounds,
      tov: +v.totalTurnovers, teamTov: +v.teamTurnovers,
    };
  }
  return out;
}

export function pbpTotals(s) {
  const { home, away } = teamsOf(s);
  const z = () => ({ fga: 0, fgm: 0, tpa: 0, tpm: 0, heaves: 0, fta: 0, ftm: 0, ftaTech: 0, tov: 0, orebPlayer: 0, orebTeamLive: 0, orebTeamDead: 0, dreb: 0, pts: 0 });
  const out = { [home]: z(), [away]: z() };
  s.plays.forEach((pl, i) => {
    const t = out[pl.team?.id];
    if (!t) return;
    if (pl.scoringPlay) t.pts += pl.scoreValue;
    switch (category(pl)) {
      case 'fga':
        t.fga++; if (pl.scoringPlay) t.fgm++;
        if (pl.pointsAttempted === 3) { t.tpa++; if (pl.scoringPlay) t.tpm++; }
        break;
      case 'heave': t.heaves++; break;
      case 'ft':
        t.fta++; if (pl.scoringPlay) t.ftm++;
        if (isTechnical(pl)) t.ftaTech++;
        break;
      case 'tov': t.tov++; break;
      case 'oreb':
        if ((pl.participants || []).length) t.orebPlayer++;
        else if (isDeadBallRebound(s.plays, i)) t.orebTeamDead++;
        else t.orebTeamLive++;
        break;
      case 'dreb': t.dreb++; break;
      default: break;
    }
  });
  return out;
}

// Box estimates: formula1 = FGA − OREB + TOV + 0.44·FTA (design original)
// formula2 = FGA − (OREB + live-ball team OREB) + TOV + 0.44·FTA, TOV from pbp if the box is broken
export function possessionEstimate(s) {
  const box = boxTotals(s), pbp = pbpTotals(s);
  const out = {};
  for (const [t, b] of Object.entries(box)) {
    const broken = (b.tov <= 0 || b.teamTov < 0) && pbp[t].tov > 0;
    const tov = broken ? pbp[t].tov : b.tov;
    out[t] = {
      fga: b.fga, oreb: b.oreb, teamOrebLive: pbp[t].orebTeamLive, tov, tovSource: broken ? 'pbp' : 'box', fta: b.fta,
      formula1: b.fga - b.oreb + b.tov + 0.44 * b.fta,
      formula2: b.fga - (b.oreb + pbp[t].orebTeamLive) + tov + 0.44 * b.fta,
    };
  }
  return out;
}

// ---- shot zones ----------------------------------------------------------------
// ra | paint | mid | c3 | ab3; null for heaves, free throws, or a 2 with no location at all
export function shotZone(pl) {
  if (category(pl) !== 'fga') return null;
  const three = pl.pointsAttempted === 3;
  const c = pl.coordinate;
  if (c && c.x > NO_COORD) {
    const dx = c.x - HOOP.x, dy = c.y - HOOP.y;
    if (three) return dy <= CORNER_DEPTH_FROM_HOOP ? 'c3' : 'ab3';
    if (Math.hypot(dx, dy) <= RA_FT) return 'ra';
    if (Math.abs(dx) <= PAINT_HALF_WIDTH && dy <= PAINT_DEPTH_FROM_HOOP) return 'paint';
    return 'mid';
  }
  if (three) return 'ab3'; // corner unknown without a location
  const m = (pl.text ?? '').match(/(\d+)-foot/);
  if (!m) return null;
  const d = +m[1];
  return d <= RA_FT ? 'ra' : d <= 10 ? 'paint' : 'mid';
}

// ---- stints --------------------------------------------------------------------
// plays whose participants are certainly on the floor at that moment
function isCourtEvidence(pl) {
  const c = category(pl);
  if (['fga', 'heave', 'tov', 'oreb', 'dreb'].includes(c)) return true;
  if (c === 'ft' || c === 'foul') return !isTechnical(pl);
  return false;
}

export function toStints(s) {
  const plays = s.plays;
  const { home, away } = teamsOf(s);
  const teams = [home, away];
  const anomalies = { notInBox: 0, subMissingPlayer: 0, repairedByAction: 0, unrecordedSub: 0, periodStartAdjusted: 0, periodLineupNot5: 0 };
  const roster = { [home]: new Set(), [away]: new Set() };
  const starters = { [home]: [], [away]: [] };
  for (const t of s.boxscore.players) {
    for (const a of t.statistics[0].athletes) {
      if (!a.athlete?.id) continue;
      roster[t.team.id].add(a.athlete.id);
      if (a.starter) starters[t.team.id].push(a.athlete.id);
    }
  }
  for (const pl of plays) {
    if (category(pl) !== 'sub' || !roster[pl.team?.id]) continue;
    for (const x of pl.participants || []) {
      if (![...teams].some(t => roster[t].has(x.athlete.id))) { roster[pl.team.id].add(x.athlete.id); anomalies.notInBox++; }
    }
  }
  const teamOf = id => teams.find(t => roster[t].has(id));

  const stints = [];
  const seconds = {};
  const notes = []; // per-event record of every repair, for reports
  let prevEnd = { [home]: starters[home], [away]: starters[away] };
  const periods = [...new Set(plays.map(pl => pl.period.number))].sort((a, b) => a - b);

  for (const per of periods) {
    const idx = plays.map((pl, i) => [pl, i]).filter(([pl]) => pl.period.number === per);
    const on = {};
    for (const t of teams) {
      if (per === 1) { on[t] = new Set(starters[t]); continue; }
      const first = new Map(); // id -> {kind, at}
      idx.forEach(([pl], k) => {
        const c = category(pl);
        if (c === 'sub') {
          const ids = (pl.participants || []).map(x => x.athlete.id);
          const [inn, out] = ids.length === 2 ? ids : [null, ids[0]];
          if (out && teamOf(out) === t && !first.has(out)) first.set(out, { kind: 'out', at: k });
          if (inn && teamOf(inn) === t && !first.has(inn)) first.set(inn, { kind: 'in', at: k });
        } else if (isCourtEvidence(pl)) {
          for (const x of pl.participants || []) {
            const id = x.athlete.id;
            if (teamOf(id) === t && !first.has(id)) first.set(id, { kind: 'act', at: k });
          }
        }
      });
      let cand = [...first].filter(([, v]) => v.kind !== 'in').sort((a, b) => a[1].at - b[1].at).map(([id]) => id);
      if (cand.length > 5) { notes.push({ period: per, kind: 'periodStartTrimmed', team: t, dropped: cand.slice(5) }); cand = cand.slice(0, 5); anomalies.periodStartAdjusted++; }
      if (cand.length < 5) {
        const added = [];
        for (const id of prevEnd[t]) if (cand.length < 5 && !first.has(id)) { cand.push(id); added.push(id); }
        notes.push({ period: per, kind: 'periodStartFilled', team: t, added });
        anomalies.periodStartAdjusted++;
      }
      if (cand.length !== 5) anomalies.periodLineupNot5++;
      on[t] = new Set(cand);
    }

    let last = periodSeconds(per);
    const holes = { [home]: [], [away]: [] }; // open slots left by subs missing the entering player
    const flush = now => {
      const dt = last - now;
      if (dt > 0) {
        stints.push({ period: per, start: last, end: now, lineups: { [home]: [...on[home]], [away]: [...on[away]] }, complete: on[home].size === 5 && on[away].size === 5 });
        for (const t of teams) for (const id of on[t]) seconds[id] = (seconds[id] || 0) + dt;
      }
      last = Math.min(last, now);
    };
    // credit an entering player back to the moment the hole opened
    const fillHole = (t, id) => {
      const h = holes[t].shift();
      for (const st of stints) {
        if (st.period === per && st.start <= h.from && st.lineups[t].length < 5) {
          st.lineups[t].push(id);
          st.complete = st.lineups[home].length === 5 && st.lineups[away].length === 5;
          seconds[id] = (seconds[id] || 0) + (st.start - st.end);
        }
      }
    };
    const subAtSameClock = (k, id) => idx.some(([q]) => category(q) === 'sub'
      && q.clock.displayValue === idx[k][0].clock.displayValue
      && (q.participants || []).some(x => x.athlete.id === id));
    // on-court player least likely to still be there: next court appearance latest (or never)
    const pickLeaver = (t, k, actors) => {
      let best = null, bestAt = -1;
      for (const id of on[t]) {
        if (actors.includes(id)) continue;
        let next = Infinity;
        for (let j = k + 1; j < idx.length; j++) {
          const q = idx[j][0];
          if (category(q) === 'sub' && (q.participants || []).some(x => x.athlete.id === id)) { next = j; break; }
          if (isCourtEvidence(q) && (q.participants || []).some(x => x.athlete.id === id)) { next = j; break; }
        }
        if (next > bestAt) { bestAt = next; best = id; }
      }
      return best;
    };

    idx.forEach(([pl], k) => {
      const c = category(pl);
      const now = clockSec(pl.clock.displayValue);
      if (c === 'sub') {
        const t = pl.team?.id;
        if (!on[t]) return;
        const ids = (pl.participants || []).map(x => x.athlete.id);
        flush(now);
        if (ids.length === 2) {
          on[t].delete(ids[1]);
          on[t].add(ids[0]);
        } else if (ids.length === 1) {
          anomalies.subMissingPlayer++;
          notes.push({ period: per, clock: pl.clock.displayValue, kind: 'subMissingPlayer', team: t, out: ids[0], play: pl.text });
          on[t].delete(ids[0]);
          holes[t].push({ from: now });
        }
        return;
      }
      if (!isCourtEvidence(pl)) return;
      const actors = (pl.participants || []).map(x => x.athlete.id);
      for (const id of actors) {
        const t = teamOf(id);
        if (!t || on[t].has(id)) continue;
        // the feed can list a play after the sub that took its player off at the same clock
        if (subAtSameClock(k, id)) continue;
        flush(now);
        if (holes[t].length) {
          on[t].add(id);
          fillHole(t, id);
          anomalies.repairedByAction++;
          notes.push({ period: per, clock: pl.clock.displayValue, kind: 'repairedByAction', team: t, in: id, play: pl.text });
        } else if (on[t].size < 5) {
          on[t].add(id);
        } else {
          const out = pickLeaver(t, k, actors);
          on[t].delete(out);
          on[t].add(id);
          anomalies.unrecordedSub++;
          notes.push({ period: per, clock: pl.clock.displayValue, kind: 'unrecordedSub', team: t, in: id, out, play: pl.text });
        }
      }
    });
    flush(0);
    prevEnd = { [home]: [...on[home]], [away]: [...on[away]] };
  }

  const teamMinutes = {};
  for (const t of teams) teamMinutes[t] = [...roster[t]].reduce((a, id) => a + (seconds[id] || 0), 0) / 60;
  const expectedMinutes = periods.reduce((a, per) => a + periodSeconds(per), 0) * 5 / 60;
  return { stints, seconds, teamMinutes, expectedMinutes, anomalies, notes };
}

// ---- integrity -----------------------------------------------------------------
// usable.pbp=false: play-by-play is incomplete; skip possession/stint/zone data for the game.
// usable.stints=false: lineups unreliable; use box minutes, skip lineup-based features.
export function checkIntegrity(s, { stints } = {}) {
  const issues = [];
  const usable = { pbp: true, stints: true, box: true };
  const { home, away, final } = teamsOf(s);
  const last = s.plays.at(-1);
  const pbp = pbpTotals(s), box = boxTotals(s);

  if (last.homeScore !== final[home] || last.awayScore !== final[away] || pbp[home].pts !== final[home] || pbp[away].pts !== final[away]) {
    issues.push({ code: 'pbp_incomplete', detail: `final ${final[home]}-${final[away]}, play-by-play ${last.homeScore}-${last.awayScore}` });
    usable.pbp = false;
    usable.stints = false;
  }
  for (const t of [home, away]) {
    if ((box[t].tov <= 0 || box[t].teamTov < 0) && pbp[t].tov > 0) {
      issues.push({ code: 'box_tov_invalid', team: t, detail: `box totalTurnovers ${box[t].tov}, teamTurnovers ${box[t].teamTov}, play-by-play ${pbp[t].tov}` });
    }
    if (pbp[t].fga !== box[t].fga || pbp[t].tpa !== box[t].tpa) {
      issues.push({ code: 'fga_mismatch', team: t, detail: `FGA pbp ${pbp[t].fga} box ${box[t].fga}; 3PA pbp ${pbp[t].tpa} box ${box[t].tpa} (heaves ${pbp[t].heaves})` });
    }
  }
  for (const t of s.boxscore.players) {
    t.statistics[0].athletes.forEach((a, j) => {
      if (!a.athlete?.id) issues.push({ code: 'box_row_missing_id', team: t.team.id, detail: `athletes[${j}] stats ${JSON.stringify(a.stats)}` });
    });
  }
  if (stints) {
    const a = stints.anomalies;
    if (a.subMissingPlayer) issues.push({ code: 'sub_missing_player', detail: `${a.subMissingPlayer} substitution(s) without the entering player, ${a.repairedByAction} repaired` });
    if (a.unrecordedSub) issues.push({ code: 'unrecorded_sub', detail: `${a.unrecordedSub} player(s) appeared without a substitution` });
    if (a.notInBox) issues.push({ code: 'player_not_in_box', detail: `${a.notInBox} substituted player(s) missing from the box score` });
    if (a.periodStartAdjusted) issues.push({ code: 'period_start_inferred', detail: `${a.periodStartAdjusted} period-start lineup(s) trimmed or filled` });
    const partial = stints.stints.filter(x => !x.complete);
    if (partial.length) {
      issues.push({ code: 'incomplete_lineups', detail: `${partial.length} stint(s), ${partial.reduce((a, x) => a + x.start - x.end, 0)}s without 5 players a side; excluded from lineup features` });
    }
    for (const [t, m] of Object.entries(stints.teamMinutes)) {
      if (Math.abs(m - stints.expectedMinutes) > 1) {
        issues.push({ code: 'minutes_mismatch', team: t, detail: `team minutes ${m.toFixed(1)} vs ${stints.expectedMinutes}` });
        usable.stints = false;
      }
    }
  }
  return { issues, usable };
}
