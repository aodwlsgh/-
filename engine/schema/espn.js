// Schema checks for the ESPN NBA endpoints the collector depends on.
// Each check returns a list of "path: problem" strings; [] means the shape matches.
// assertValid() throws a SchemaError so callers can never skip a drifted response.
import { PLAY_TYPES } from './espn-play-types.js';

export class SchemaError extends Error {
  constructor(kind, errors) {
    super(`ESPN ${kind} schema mismatch (${errors.length}):\n  ${errors.slice(0, 20).join('\n  ')}`);
    this.name = 'SchemaError';
    this.kind = kind;
    this.errors = errors;
  }
}

export const BOX_LABELS = ['MIN', 'PTS', 'FG', '3PT', 'FT', 'REB', 'AST', 'TO', 'STL', 'BLK', 'OREB', 'DREB', 'PF', '+/-'];
export const TEAM_STATS = [
  'fieldGoalsMade-fieldGoalsAttempted', 'threePointFieldGoalsMade-threePointFieldGoalsAttempted',
  'freeThrowsMade-freeThrowsAttempted', 'offensiveRebounds', 'defensiveRebounds', 'totalRebounds',
  'turnovers', 'teamTurnovers', 'totalTurnovers', 'fouls',
];
export const INJURY_STATUSES = ['Out', 'Day-To-Day'];
export const NO_COORD = -1e6; // ESPN marks "no coordinate" with values near -2^31

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/;
const CLOCK = /^(\d{1,2}:\d{2}|\d{1,2}(\.\d+)?)$/;
const MADE_ATT = /^\d+-\d+$/;
const ID = /^\d+$/;
const INT = /^-?\d+$/;

function make() {
  const errs = [];
  const at = (path, msg) => errs.push(`${path}: ${msg}`);
  const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const req = {
    obj: (v, p) => (isObj(v) ? true : (at(p, `expected object, got ${kind(v)}`), false)),
    arr: (v, p, min = 0) => {
      if (!Array.isArray(v)) return at(p, `expected array, got ${kind(v)}`), false;
      if (v.length < min) return at(p, `expected at least ${min} item(s), got ${v.length}`), false;
      return true;
    },
    str: (v, p, re) => {
      if (typeof v !== 'string') return at(p, `expected string, got ${kind(v)}`), false;
      if (re && !re.test(v)) return at(p, `unexpected format ${JSON.stringify(v)}`), false;
      return true;
    },
    num: (v, p) => (typeof v === 'number' && Number.isFinite(v) ? true : (at(p, `expected number, got ${kind(v)}`), false)),
    bool: (v, p) => (typeof v === 'boolean' ? true : (at(p, `expected boolean, got ${kind(v)}`), false)),
    oneOf: (v, p, xs) => (xs.includes(v) ? true : (at(p, `unexpected value ${JSON.stringify(v)}`), false)),
  };
  return { errs, at, req };
}
const kind = v => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

export function checkScoreboard(sb) {
  const { errs, req } = make();
  if (!req.obj(sb, 'scoreboard') || !req.arr(sb.events, 'events')) return errs;
  sb.events.forEach((e, i) => {
    const p = `events[${i}]`;
    if (!req.obj(e, p)) return;
    req.str(e.id, `${p}.id`, ID);
    req.str(e.date, `${p}.date`, ISO);
    if (req.obj(e.season, `${p}.season`)) {
      req.num(e.season.year, `${p}.season.year`);
      req.str(e.season.slug, `${p}.season.slug`);
    }
    if (!req.arr(e.competitions, `${p}.competitions`, 1)) return;
    const c = e.competitions[0];
    req.str(c?.status?.type?.name, `${p}.competitions[0].status.type.name`);
    if (req.arr(c.competitors, `${p}.competitions[0].competitors`, 2)) {
      c.competitors.forEach((t, j) => {
        const q = `${p}.competitions[0].competitors[${j}]`;
        req.oneOf(t.homeAway, `${q}.homeAway`, ['home', 'away']);
        req.str(t.team?.id, `${q}.team.id`, ID);
        req.str(t.team?.abbreviation, `${q}.team.abbreviation`);
      });
    }
  });
  return errs;
}

export function checkSummary(s) {
  const { errs, at, req } = make();
  if (!req.obj(s, 'summary')) return errs;

  // header: teams and home/away
  const comp = s.header?.competitions?.[0];
  if (req.obj(comp, 'header.competitions[0]') && req.arr(comp.competitors, 'header.competitions[0].competitors', 2)) {
    comp.competitors.forEach((t, j) => {
      req.oneOf(t.homeAway, `header.competitions[0].competitors[${j}].homeAway`, ['home', 'away']);
      req.str(t.team?.id, `header.competitions[0].competitors[${j}].team.id`, ID);
    });
  }

  // boxscore: player rows and team totals
  if (req.obj(s.boxscore, 'boxscore')) {
    const { players, teams } = s.boxscore;
    if (req.arr(players, 'boxscore.players', 2)) {
      if (players.length !== 2) at('boxscore.players', `expected 2 teams, got ${players.length}`);
      players.forEach((t, i) => {
        const p = `boxscore.players[${i}]`;
        req.str(t.team?.id, `${p}.team.id`, ID);
        const st = t.statistics?.[0];
        if (!req.obj(st, `${p}.statistics[0]`)) return;
        if (req.arr(st.labels, `${p}.statistics[0].labels`) && st.labels.join(',') !== BOX_LABELS.join(',')) {
          at(`${p}.statistics[0].labels`, `expected ${BOX_LABELS.join(',')}, got ${st.labels.join(',')}`);
        }
        if (!req.arr(st.athletes, `${p}.statistics[0].athletes`, 5)) return;
        st.athletes.forEach((a, j) => {
          const q = `${p}.statistics[0].athletes[${j}]`;
          req.obj(a.athlete, `${q}.athlete`);
          if (a.athlete?.id !== undefined) req.str(a.athlete.id, `${q}.athlete.id`, ID); // missing id: quality issue
          req.bool(a.starter, `${q}.starter`);
          req.bool(a.didNotPlay, `${q}.didNotPlay`);
          if (req.arr(a.stats, `${q}.stats`) && a.stats.length && a.stats.length !== BOX_LABELS.length) {
            at(`${q}.stats`, `expected ${BOX_LABELS.length} values, got ${a.stats.length}`);
          }
        });
        const starters = st.athletes.filter(a => a.starter).length;
        if (starters !== 5) at(`${p}.statistics[0].athletes`, `expected 5 starters, got ${starters}`);
      });
    }
    if (req.arr(teams, 'boxscore.teams', 2)) {
      teams.forEach((t, i) => {
        const p = `boxscore.teams[${i}]`;
        if (!req.arr(t.statistics, `${p}.statistics`)) return;
        const byName = Object.fromEntries(t.statistics.map(x => [x.name, x.displayValue]));
        for (const n of TEAM_STATS) {
          if (!(n in byName)) { at(`${p}.statistics`, `missing ${n}`); continue; }
          req.str(byName[n], `${p}.statistics.${n}`, n.includes('-') ? MADE_ATT : INT); // sign: quality issue
        }
      });
    }
  }

  // plays
  if (req.arr(s.plays, 'plays', 50)) {
    s.plays.forEach((pl, i) => {
      const p = `plays[${i}]`;
      if (!req.obj(pl, p)) return;
      if (!req.obj(pl.type, `${p}.type`)) return;
      const known = PLAY_TYPES[pl.type.id];
      if (!known) at(`${p}.type`, `unknown play type id ${JSON.stringify(pl.type.id)} ${JSON.stringify(pl.type.text)}`);
      else if (known[0] !== pl.type.text) at(`${p}.type`, `id ${pl.type.id} text changed: ${JSON.stringify(known[0])} -> ${JSON.stringify(pl.type.text)}`);
      req.str(pl.text ?? '', `${p}.text`);
      if (req.obj(pl.period, `${p}.period`)) req.num(pl.period.number, `${p}.period.number`);
      req.str(pl.clock?.displayValue, `${p}.clock.displayValue`, CLOCK);
      req.num(pl.homeScore, `${p}.homeScore`);
      req.num(pl.awayScore, `${p}.awayScore`);
      req.bool(pl.shootingPlay, `${p}.shootingPlay`);
      req.bool(pl.scoringPlay, `${p}.scoringPlay`);
      const cat = known?.[1];
      if (pl.shootingPlay) {
        req.oneOf(pl.pointsAttempted, `${p}.pointsAttempted`, [1, 2, 3]);
        if (cat !== 'ft') {
          if (req.obj(pl.coordinate, `${p}.coordinate`)) {
            const { x, y } = pl.coordinate;
            if (req.num(x, `${p}.coordinate.x`) && req.num(y, `${p}.coordinate.y`) && x > NO_COORD
              && !(x >= -2 && x <= 52 && y >= -6 && y <= 96)) {
              at(`${p}.coordinate`, `out of court (${x}, ${y})`);
            }
          }
        }
      }
      if (cat === 'sub') {
        // the entering name can be blank in a broken record (quality issue); the phrase itself must stay
        if (!/(^| )enters the game for /.test(pl.text ?? '')) at(`${p}.text`, `substitution text changed: ${JSON.stringify(pl.text)}`);
        if (req.arr(pl.participants, `${p}.participants`, 1)) {
          pl.participants.forEach((x, j) => req.str(x?.athlete?.id, `${p}.participants[${j}].athlete.id`, ID));
        }
      }
    });
  }
  return errs;
}

// Data defects inside a well-formed summary. Not a format change, but never ignored:
// the game is flagged with these and the parser falls back where it can.
export function checkSummaryQuality(s) {
  const issues = [];
  s.boxscore.players.forEach((t, i) => {
    t.statistics[0].athletes.forEach((a, j) => {
      if (a.athlete?.id === undefined) issues.push(`boxscore.players[${i}].athletes[${j}]: athlete without id`);
    });
  });
  s.boxscore.teams.forEach((t, i) => {
    const byName = Object.fromEntries(t.statistics.map(x => [x.name, x.displayValue]));
    for (const n of TEAM_STATS) if (!n.includes('-') && +byName[n] < 0) issues.push(`boxscore.teams[${i}].${n}: negative (${byName[n]})`);
    if (+byName.totalTurnovers === 0) {
      const tov = s.plays.filter(p => p.team?.id === t.team?.id && PLAY_TYPES[p.type?.id]?.[1] === 'tov').length;
      if (tov > 0) issues.push(`boxscore.teams[${i}].totalTurnovers: 0 but plays show ${tov}`);
    }
  });
  s.plays.forEach((p, i) => {
    if (PLAY_TYPES[p.type?.id]?.[1] === 'sub' && (p.participants || []).length !== 2) {
      issues.push(`plays[${i}]: substitution with ${(p.participants || []).length} participant(s) ${JSON.stringify(p.text)}`);
    }
  });
  return issues;
}

export function checkInjuries(doc) {
  const { errs, req } = make();
  if (!req.obj(doc, 'injuries') || !req.arr(doc.injuries, 'injuries')) return errs;
  req.str(doc.timestamp, 'timestamp', ISO);
  doc.injuries.forEach((t, i) => {
    const p = `injuries[${i}]`;
    req.str(t.id, `${p}.id`, ID);
    req.str(t.displayName, `${p}.displayName`);
    if (!req.arr(t.injuries, `${p}.injuries`)) return;
    t.injuries.forEach((x, j) => {
      const q = `${p}.injuries[${j}]`;
      req.oneOf(x.status, `${q}.status`, INJURY_STATUSES);
      req.str(x.date, `${q}.date`, ISO);
      req.str(x.athlete?.displayName, `${q}.athlete.displayName`);
      if (req.arr(x.athlete?.links, `${q}.athlete.links`, 1) && !x.athlete.links.some(l => /\/id\/\d+/.test(l?.href ?? ''))) {
        req.str(undefined, `${q}.athlete.links[].href (/id/N)`);
      }
    });
  });
  return errs;
}

const CHECKS = { scoreboard: checkScoreboard, summary: checkSummary, injuries: checkInjuries };

export function assertValid(kindName, doc) {
  const check = CHECKS[kindName];
  if (!check) throw new SchemaError(kindName, [`no schema for kind ${JSON.stringify(kindName)}`]);
  const errors = check(doc);
  if (errors.length) throw new SchemaError(kindName, errors);
  return doc;
}
