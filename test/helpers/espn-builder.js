// Builds small ESPN-shaped summaries for parser tests.
import { PLAY_TYPES } from '../../engine/schema/espn-play-types.js';

const ID_BY_TEXT = Object.fromEntries(Object.entries(PLAY_TYPES).map(([id, [text]]) => [text, id]));
export const HOME = '1';
export const AWAY = '2';

// p(text, team, opts): one play. opts: made, pts, x, y, period, clock, ids, text, dist
export function p(typeText, team, o = {}) {
  const id = ID_BY_TEXT[typeText];
  if (!id) throw new Error(`no play type "${typeText}" in registry`);
  const cat = PLAY_TYPES[id][1];
  const isFt = cat === 'ft';
  const shooting = cat === 'fga' || cat === 'heave' || isFt;
  const pts = o.pts ?? (isFt ? 1 : 2);
  return {
    type: { id, text: typeText },
    text: o.text ?? (o.dist != null ? `x ${o.made ? 'makes' : 'misses'} ${o.dist}-foot shot` : typeText),
    period: { number: o.period ?? 1 },
    clock: { displayValue: o.clock ?? '10:00' },
    scoringPlay: !!o.made,
    scoreValue: o.made ? pts : 0,
    shootingPlay: shooting,
    pointsAttempted: shooting ? pts : 0,
    team: team ? { id: team } : undefined,
    participants: (o.ids ?? []).map(x => ({ athlete: { id: x } })),
    coordinate: o.x != null ? { x: o.x, y: o.y } : { x: -214748340, y: -214748365 },
  };
}

// fills homeScore/awayScore from scoring plays
function score(plays) {
  let h = 0, a = 0;
  for (const pl of plays) {
    if (pl.scoringPlay) { if (pl.team.id === HOME) h += pl.scoreValue; else a += pl.scoreValue; }
    pl.homeScore = h; pl.awayScore = a;
  }
  return { h, a };
}

const TEAM_STAT_KEYS = {
  fg: 'fieldGoalsMade-fieldGoalsAttempted', tp: 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  ft: 'freeThrowsMade-freeThrowsAttempted',
};

// box: {[team]: {fg:[m,a], tp:[m,a], ft:[m,a], oreb, dreb, tov, teamTov}}; roster: {[team]: [{id, starter, min}]}
export function summary({ plays, box = {}, roster = {}, final } = {}) {
  const { h, a } = score(plays);
  const fin = final ?? { [HOME]: h, [AWAY]: a };
  const teams = [HOME, AWAY].map(t => {
    const b = { fg: [0, 0], tp: [0, 0], ft: [0, 0], oreb: 0, dreb: 0, tov: 0, teamTov: 0, ...box[t] };
    return {
      team: { id: t, abbreviation: t === HOME ? 'HOM' : 'AWY' },
      statistics: [
        { name: TEAM_STAT_KEYS.fg, displayValue: b.fg.join('-') },
        { name: TEAM_STAT_KEYS.tp, displayValue: b.tp.join('-') },
        { name: TEAM_STAT_KEYS.ft, displayValue: b.ft.join('-') },
        { name: 'offensiveRebounds', displayValue: String(b.oreb) },
        { name: 'defensiveRebounds', displayValue: String(b.dreb) },
        { name: 'totalRebounds', displayValue: String(b.oreb + b.dreb) },
        { name: 'turnovers', displayValue: String(b.tov - b.teamTov) },
        { name: 'teamTurnovers', displayValue: String(b.teamTov) },
        { name: 'totalTurnovers', displayValue: String(b.tov) },
        { name: 'fouls', displayValue: '0' },
      ],
    };
  });
  const players = [HOME, AWAY].map(t => ({
    team: { id: t },
    statistics: [{
      labels: ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-'],
      athletes: (roster[t] ?? []).map(r => ({
        athlete: { id: r.id, shortName: r.id }, starter: !!r.starter, didNotPlay: !r.min,
        stats: r.min ? [String(r.min), '0', '0-0', '0-0', '0-0', '0', '0', '0', '0', '0', '0', '0', '0', '0'] : [],
      })),
    }],
  }));
  return {
    header: { id: '9', competitions: [{ date: '2026-01-01T00:00Z', competitors: [
      { homeAway: 'home', team: { id: HOME, abbreviation: 'HOM' }, score: String(fin[HOME]) },
      { homeAway: 'away', team: { id: AWAY, abbreviation: 'AWY' }, score: String(fin[AWAY]) },
    ] }] },
    boxscore: { teams, players },
    plays,
  };
}

// five-man rosters: H1..H8 / A1..A8, first five start; min = box minutes
export function rosters(minutes = {}) {
  const mk = (pre, team) => Array.from({ length: 8 }, (_, i) => ({ id: `${pre}${i + 1}`, starter: i < 5, min: minutes[`${pre}${i + 1}`] ?? 0 }));
  return { [HOME]: mk('H', HOME), [AWAY]: mk('A', AWAY) };
}
