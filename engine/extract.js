// One ESPN game summary -> the compact record committed under data/games/ (plan P2).
// Runs every per-game check (possessions, heaves, team minutes, truncated play-by-play).
import {
  teamsOf, toPossessions, toStints, possessionEstimate, pbpTotals, boxTotals, shotZone, isHeaveLike,
  heaveCountsInBox, checkIntegrity, category, clockSec,
} from './parse.js';

export const ZONE_NAMES = ['ra', 'paint', 'mid', 'c3', 'ab3'];
// ESPN mixes G/F/C with PG/SG/SF/PF by season; keep the three groups
const POS_GROUP = { G: 'G', PG: 'G', SG: 'G', GF: 'G', F: 'F', SF: 'F', PF: 'F', FC: 'F', C: 'C' };

// per-game check limits; season-level pass rules live in the P2 report (design §6.1)
export const CHECK_LIMITS = { possMaxPct: 3.5, homeAwayDiff: 2, minutesTol: 1 };
const END_CODE = { made: 0, dreb: 1, tov: 2, ft: 3, period: 4, change: 5 };
const ZONES = ZONE_NAMES;
const seasonLabel = year => `${year - 1}-${String(year).slice(2)}`;

export function extractGame(s) {
  const { home, away, final } = teamsOf(s);
  const side = { [home]: 0, [away]: 1 };
  const comp = s.header.competitions[0];
  const abbr = id => comp.competitors.find(c => c.team.id === id).team.abbreviation;

  const possR = toPossessions(s);
  const st = toStints(s);
  const est = possessionEstimate(s);
  const pt = pbpTotals(s), bt = boxTotals(s);
  const integ = checkIntegrity(s, { stints: st });

  // players: box line + play-by-play shot zones
  const players = [];
  const byId = new Map();
  for (const t of s.boxscore.players) {
    const L = t.statistics[0].labels;
    const at = k => L.indexOf(k);
    for (const a of t.statistics[0].athletes) {
      if (!a.athlete?.id) continue;
      const v = a.stats;
      const num = k => (v.length ? +(v[at(k)] ?? 0) || 0 : 0);
      const [ftm, fta] = v.length ? v[at('FT')].split('-').map(Number) : [0, 0];
      const p = {
        id: a.athlete.id, t: side[t.team.id], n: a.athlete.displayName ?? a.athlete.shortName ?? '', st: a.starter ? 1 : 0,
        pos: POS_GROUP[a.athlete.position?.abbreviation] ?? '', dnp: a.didNotPlay ? 1 : 0, ...(a.didNotPlay ? { dnpr: a.reason ?? '' } : {}), min: num('MIN'), sec: Math.round(st.seconds[a.athlete.id] ?? 0),
        pts: num('PTS'), ast: num('AST'), stl: num('STL'), blk: num('BLK'), pf: num('PF'),
        orb: num('OREB'), drb: num('DREB'), tov: num('TO'), ftm, fta,
        z: Object.fromEntries(ZONES.map(z => [z, [0, 0]])), hv: 0, zx: 0,
      };
      players.push(p);
      byId.set(p.id, p);
    }
  }
  // shot log for on/off splits: [period, clockSec, side, zone index (-1 = heave-like or unlocated), made, shooter]
  const shots = [];
  for (const pl of s.plays) {
    const c = category(pl);
    if (c !== 'fga' && c !== 'heave') continue;
    const p = byId.get(pl.participants?.[0]?.athlete?.id);
    if (!p) continue;
    const z = isHeaveLike(pl) ? null : shotZone(pl);
    shots.push([pl.period.number, clockSec(pl.clock.displayValue), side[pl.team?.id] ?? p.t, z ? ZONES.indexOf(z) : -1, pl.scoringPlay ? 1 : 0, p.id]);
    if (isHeaveLike(pl)) { p.hv++; continue; }
    if (!z) { p.zx++; continue; } // no location at all
    p.z[z][1]++;
    if (pl.scoringPlay) p.z[z][0]++;
  }

  const count = t => possR.count[t] ?? 0;
  const sum = f => f(home) + f(away);
  const errPct2 = 100 * (sum(count) - sum(t => est[t].formula2)) / sum(t => est[t].formula2);
  const errPct1 = 100 * (sum(count) - sum(t => est[t].formula1)) / sum(t => est[t].formula1);
  const codes = integ.issues.map(i => i.code);
  const checks = {
    poss: [count(home), count(away)],
    est2: [est[home].formula2, est[away].formula2].map(x => +x.toFixed(2)),
    errPct2: +errPct2.toFixed(3), errPct1: +errPct1.toFixed(3),
    haDiff: Math.abs(count(home) - count(away)),
    heaves: [pt[home].heaves, pt[away].heaves], heaveRule: heaveCountsInBox(s) ? 'included' : 'excluded',
    fga: { pbp: [pt[home].fga, pt[away].fga], box: [bt[home].fga, bt[away].fga] },
    tpa: { pbp: [pt[home].tpa, pt[away].tpa], box: [bt[home].tpa, bt[away].tpa] },
    teamMinutes: [st.teamMinutes[home], st.teamMinutes[away]].map(x => +x.toFixed(2)), expectedMinutes: st.expectedMinutes,
  };
  checks.pbpComplete = !codes.includes('pbp_incomplete');
  checks.fgaMatch = checks.fga.pbp.every((x, i) => x === checks.fga.box[i]) && checks.tpa.pbp.every((x, i) => x === checks.tpa.box[i]);
  checks.teamMinutesOk = checks.teamMinutes.every(m => Math.abs(m - st.expectedMinutes) <= CHECK_LIMITS.minutesTol);

  const failed = [];
  if (!checks.pbpComplete) failed.push('pbp_incomplete');
  if (checks.pbpComplete && Math.abs(errPct2) > CHECK_LIMITS.possMaxPct) failed.push('possessions_over_3.5pct');
  if (checks.pbpComplete && checks.haDiff > CHECK_LIMITS.homeAwayDiff) failed.push('home_away_diff_over_2');
  if (!checks.fgaMatch) failed.push('fga_mismatch');
  if (checks.pbpComplete && !checks.teamMinutesOk) failed.push('team_minutes');

  return {
    id: s.header.id, season: seasonLabel(s.header.season.year), start: comp.date,
    home: { id: home, abbr: abbr(home) }, away: { id: away, abbr: abbr(away) },
    final: [final[home], final[away]], periods: Math.max(...s.plays.map(pl => pl.period.number)),
    checks, failed, excluded: !checks.pbpComplete,
    quality: { issues: integ.issues, usable: integ.usable, notes: st.notes },
    players,
    // [period, startSec, endSec, side 0=home 1=away, points, endCode]
    poss: possR.possessions.map(x => [x.period, x.start, x.end, side[x.team], x.points, END_CODE[x.endType]]),
    shots,
    // [period, startSec, endSec, home5, away5, complete]
    stints: st.stints.map(x => [x.period, x.start, x.end, x.lineups[home], x.lineups[away], x.complete ? 1 : 0]),
  };
}
