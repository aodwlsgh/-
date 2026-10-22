// Player and team ratings as of a date (design §6.2–6.4). Pure: only games that started before
// `asOf` are used. Ratings belong to players (trades move with the player); a player's team is
// the team of his latest appearance.
//
// Shrinkage (§6.3): posterior = (count + k·prior) / (exposure + k)
//   prior = carry·(last season posterior) + (1 − carry)·(role average); no last season -> role average
//   role = position group (G/F/C) × minutes tier
import { ZONE_NAMES } from './extract.js';
import { etParts, fromEt } from './time.js';

const NZ = ZONE_NAMES.length;
export const ZONE_POINTS = [2, 2, 2, 3, 3];

export const DEFAULT_PARAMS = {
  // exposures: fg by zone in attempts; ft in FTA; rates in offensive possessions on court; rebounds in chances
  k: {
    fg: [150, 200, 200, 300, 300], ft: 100, att: 500, fta: 500, tov: 400, ast: 500, reb: 600,
    teamFg: 600, teamRate: 2000, teamReb: 2000, teamRtg: 2000, pace: 15, hca: 300, rim: 400,
  },
  carry: 0.7, // design §6.3: last season pulled 30% toward the role average
  tiers: [15, 28], // minutes-per-game tier edges
  prevFadeGames: 200, // league/role averages: last season's weight fades out over this many current games
  halfLifeDays: null, // recency weighting of the current season's games (null = none); tuned on 2024-25
};

export function seasonOf(date) {
  const y = +date.slice(0, 4), m = +date.slice(5, 7);
  const end = m >= 8 ? y + 1 : y;
  return `${end - 1}-${String(end).slice(2)}`;
}
const prevSeason = s => `${+s.slice(0, 4) - 1}-${s.slice(2, 4)}`;

// ---- per-game derived numbers (memoised per record object; records are never mutated) -------
const derivedCache = new WeakMap();
export function gameDerived(g) {
  if (derivedCache.has(g)) return derivedCache.get(g);
  const gameSec = 4 * 720 + Math.max(0, g.periods - 4) * 300;
  const useStints = g.quality.usable.stints;
  const poss = g.checks.poss;
  const misses = [0, 0], orb = [0, 0], drb = [0, 0], pts = [0, 0], tov = [0, 0], fta = [0, 0];
  for (const p of g.players) {
    for (let z = 0; z < NZ; z++) misses[p.t] += p.z[ZONE_NAMES[z]][1] - p.z[ZONE_NAMES[z]][0];
    misses[p.t] += p.zx;
    orb[p.t] += p.orb; drb[p.t] += p.drb; pts[p.t] += p.pts; tov[p.t] += p.tov; fta[p.t] += p.fta;
  }
  // restricted-area shots allowed with each defender on the floor (complete stints only)
  const rimOn = new Map();
  const oppRA = [[0, 0], [0, 0]]; // by defending side
  for (const [period, clock, side, zone, made] of g.shots) {
    if (zone !== 0) continue;
    oppRA[1 - side][1]++; oppRA[1 - side][0] += made;
    if (!useStints) continue;
    const st = g.stints.find(s => s[0] === period && clock <= s[1] && clock > s[2] && s[5]) ??
      g.stints.find(s => s[0] === period && clock <= s[1] && clock >= s[2] && s[5]);
    if (!st) continue;
    for (const id of st[3 + (1 - side)]) {
      const r = rimOn.get(id) ?? [0, 0];
      r[0] += made; r[1]++;
      rimOn.set(id, r);
    }
  }
  const players = [];
  for (const p of g.players) {
    const sec = useStints && p.sec > 0 ? p.sec : p.min * 60;
    if (p.dnp || sec <= 0) { players.push({ id: p.id, t: p.t, pos: p.pos, dnp: 1, dnpr: p.dnpr ?? '', sec: 0, st: p.st }); continue; }
    const share = sec / gameSec;
    players.push({
      id: p.id, t: p.t, pos: p.pos, st: p.st, dnp: 0, sec, min: sec / 60, share,
      offPoss: poss[p.t] * share, defPoss: poss[1 - p.t] * share,
      orbOpp: misses[p.t] * share, drbOpp: misses[1 - p.t] * share,
      att: ZONE_NAMES.map(z => p.z[z][1]), made: ZONE_NAMES.map(z => p.z[z][0]),
      fta: p.fta, ftm: p.ftm, tov: p.tov, ast: p.ast, orb: p.orb, drb: p.drb, blk: p.blk, pts: p.pts,
      rimOn: useStints ? rimOn.get(p.id) ?? [0, 0] : null,
      rimTeam: oppRA[p.t],
    });
  }
  const d = {
    id: g.id, start: g.start, date: etParts(new Date(g.start)).date, season: g.season, gameSec, poss, pts, misses, orb, drb, tov, fta,
    teams: [g.home.id, g.away.id], abbr: [g.home.abbr, g.away.abbr], players, useStints,
    // opponent shots by zone, per defending side
    oppZone: [1, 0].map(off => ZONE_NAMES.map((_, z) => g.players.filter(p => p.t === off).reduce((a, p) => [a[0] + p.z[ZONE_NAMES[z]][0], a[1] + p.z[ZONE_NAMES[z]][1]], [0, 0]))),
  };
  derivedCache.set(g, d);
  return d;
}

// ---- accumulation ---------------------------------------------------------------------------
const zeros = n => Array.from({ length: n }, () => 0);
const newPlayer = () => ({ games: 0, sec: 0, offPoss: 0, defPoss: 0, att: zeros(NZ), made: zeros(NZ), fta: 0, ftm: 0, tov: 0, ast: 0, orb: 0, orbOpp: 0, drb: 0, drbOpp: 0, blk: 0, rimOn: [0, 0], rimTeam: [0, 0], rimGames: 0, pos: {} });
const newTeam = () => ({ games: 0, offPoss: 0, defPoss: 0, pts: 0, oppPts: 0, oppAtt: zeros(NZ), oppMade: zeros(NZ), oppFta: 0, forcedTov: 0, oppOrb: 0, oppOrbOpp: 0, paceMin: 0, pacePoss: 0 });
const newLeague = () => ({ rawGames: 0, games: 0, poss: 0, att: zeros(NZ), made: zeros(NZ), fta: 0, ftm: 0, tov: 0, ast: 0, orb: 0, orbOpp: 0, pts: 0, paceMin: 0, pacePoss: 0, homePts: 0, homePoss: 0, awayPts: 0, awayPoss: 0 });

// multiply every accumulated count/exposure of a season by f (recency decay); pos tallies and raw counts stay
function decaySeason(S, f) {
  const scale = o => {
    for (const [k, v] of Object.entries(o)) {
      if (k === 'pos' || k === 'rawGames') continue;
      if (Array.isArray(v)) for (let i = 0; i < v.length; i++) v[i] *= f;
      else if (typeof v === 'number') o[k] = v * f;
    }
  };
  for (const P of S.players.values()) scale(P);
  for (const T of S.teams.values()) scale(T);
  scale(S.league);
}
const daysBetween = (a, b) => (Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86400e3;

export class Accumulator {
  constructor(params = DEFAULT_PARAMS) {
    this.halfLifeDays = params.halfLifeDays ?? null;
    this.seasons = new Map(); // season -> {players, teams, league}
    this.log = new Map(); // playerId -> [{date, team, sec, dnp, dnpr, st, pos}]
    this.teamDates = new Map(); // teamId -> [date...]
    this.lastStart = null;
  }

  season(s) {
    if (!this.seasons.has(s)) this.seasons.set(s, { players: new Map(), teams: new Map(), league: newLeague() });
    return this.seasons.get(s);
  }

  add(g) {
    if (this.lastStart && Date.parse(g.start) < Date.parse(this.lastStart)) throw new Error(`games must be added in start order (${g.id})`);
    this.lastStart = g.start;
    const d = gameDerived(g);
    for (const [i, t] of d.teams.entries()) {
      const arr = this.teamDates.get(t) ?? [];
      arr.push(d.date);
      this.teamDates.set(t, arr);
    }
    for (const p of d.players) {
      const L = this.log.get(p.id) ?? [];
      L.push({ date: d.date, team: d.teams[p.t], sec: p.sec, dnp: p.dnp, dnpr: p.dnpr ?? '', st: p.st, pos: p.pos });
      this.log.set(p.id, L);
    }
    if (g.excluded) return; // truncated play-by-play: logs only (who played), no rates
    const S = this.season(d.season);
    if (this.halfLifeDays && S.lastDay && d.date > S.lastDay) decaySeason(S, 0.5 ** (daysBetween(S.lastDay, d.date) / this.halfLifeDays));
    S.lastDay = d.date;
    const lg = S.league;
    lg.games++; lg.rawGames++;
    const gameMin = d.gameSec * 5 / 60 / 5; // minutes of one game
    for (const side of [0, 1]) {
      const T = S.teams.get(d.teams[side]) ?? newTeam();
      T.games++; T.offPoss += d.poss[side]; T.defPoss += d.poss[1 - side];
      T.pts += d.pts[side]; T.oppPts += d.pts[1 - side];
      for (let z = 0; z < NZ; z++) { T.oppAtt[z] += d.oppZone[side][z][1]; T.oppMade[z] += d.oppZone[side][z][0]; }
      T.oppFta += d.fta[1 - side]; T.forcedTov += d.tov[1 - side];
      T.oppOrb += d.orb[1 - side]; T.oppOrbOpp += d.misses[1 - side];
      T.paceMin += gameMin; T.pacePoss += d.poss[side];
      S.teams.set(d.teams[side], T);
      lg.poss += d.poss[side]; lg.pts += d.pts[side]; lg.tov += d.tov[side]; lg.fta += d.fta[side];
      lg.orb += d.orb[side]; lg.orbOpp += d.misses[side];
      lg.paceMin += gameMin; lg.pacePoss += d.poss[side];
    }
    lg.homePts += d.pts[0]; lg.homePoss += d.poss[0]; lg.awayPts += d.pts[1]; lg.awayPoss += d.poss[1];
    for (const p of d.players) {
      if (p.dnp) continue;
      const P = S.players.get(p.id) ?? newPlayer();
      P.games++; P.sec += p.sec; P.offPoss += p.offPoss; P.defPoss += p.defPoss;
      for (let z = 0; z < NZ; z++) { P.att[z] += p.att[z]; P.made[z] += p.made[z]; lg.att[z] += p.att[z]; lg.made[z] += p.made[z]; }
      P.fta += p.fta; P.ftm += p.ftm; P.tov += p.tov; P.ast += p.ast; lg.ftm += p.ftm; lg.ast += p.ast;
      P.orb += p.orb; P.orbOpp += p.orbOpp; P.drb += p.drb; P.drbOpp += p.drbOpp; P.blk += p.blk;
      if (p.rimOn) { P.rimOn[0] += p.rimOn[0]; P.rimOn[1] += p.rimOn[1]; P.rimTeam[0] += p.rimTeam[0]; P.rimTeam[1] += p.rimTeam[1]; P.rimGames++; }
      P.pos[p.pos] = (P.pos[p.pos] || 0) + 1;
      S.players.set(p.id, P);
    }
  }

  // ---- ratings at the current state (= asOf the next game) ------------------------------------
  ratings(asOf, params = DEFAULT_PARAMS) {
    asOf = cutoffOf(asOf);
    const asOfDate = etParts(new Date(asOf)).date;
    const season = seasonOf(asOfDate);
    const cur = this.seasons.get(season) ?? { players: new Map(), teams: new Map(), league: newLeague() };
    const prev = this.seasons.get(prevSeason(season));
    const prevW = prev ? Math.max(0, 1 - cur.league.rawGames / params.prevFadeGames) : 0;

    // league averages: current season, plus last season fading out
    const L = blendLeague(cur.league, prev?.league, prevW);
    if (!L) return { asOf, season, empty: true };
    const league = {
      fg: L.att.map((a, z) => L.made[z] / a), attRate: L.att.map(a => a / L.poss),
      ftaRate: L.fta / L.poss, ft: L.ftm / L.fta, tovRate: L.tov / L.poss, astRate: L.ast / L.poss,
      orbPct: L.orb / L.orbOpp, pace: 48 * L.pacePoss / L.paceMin, ortg: 100 * L.pts / L.poss,
    };
    // home advantage in points per 100 possessions (home ORtg − away ORtg), shrunk toward 0
    const hcaObs = 100 * (L.homePts / L.homePoss - L.awayPts / L.awayPoss);
    league.hca = hcaObs * L.games / (L.games + params.k.hca);

    const tierOf = mpg => (mpg < params.tiers[0] ? 0 : mpg < params.tiers[1] ? 1 : 2);
    const posOf = P => Object.entries(P.pos).sort((a, b) => b[1] - a[1])[0]?.[0] || 'F';
    const roles = roleAverages([[cur.players, 1], [prev?.players, prevW]], tierOf, posOf, league);

    // last-season posteriors (shrunk toward last season's own role averages)
    let prevPost = new Map();
    if (prev) {
      const pL = blendLeague(prev.league, null, 0);
      const pLeague = { fg: pL.att.map((a, z) => pL.made[z] / a), attRate: pL.att.map(a => a / pL.poss), ftaRate: pL.fta / pL.poss, ft: pL.ftm / pL.fta, tovRate: pL.tov / pL.poss, astRate: pL.ast / pL.poss, orbPct: pL.orb / pL.orbOpp };
      const pRoles = roleAverages([[prev.players, 1]], tierOf, posOf, pLeague);
      for (const [id, P] of prev.players) prevPost.set(id, shrinkPlayer(P, pRoles[roleKey(P, tierOf, posOf)] ?? pRoles.all, params));
    }

    const players = {};
    const ids = new Set([...cur.players.keys(), ...prevPost.keys()]);
    for (const id of ids) {
      const P = cur.players.get(id) ?? newPlayer();
      const src = cur.players.has(id) ? P : prev.players.get(id);
      const role = roles[roleKey(src, tierOf, posOf)] ?? roles.all;
      const last = prevPost.get(id);
      const prior = last ? mixRates(last, role, params.carry) : role;
      const r = shrinkPlayer(P, prior, params);
      const log = this.log.get(id) ?? [];
      const lastApp = [...log].reverse().find(x => x.date <= asOfDate);
      players[id] = { ...r, team: lastApp?.team ?? null, pos: posOf(src), n: { poss: P.offPoss, games: P.games, fga3: P.att[3] + P.att[4], prevSeason: !!last } };
    }

    // teams (defence, pace, net rating for the baseline)
    const teams = {};
    const teamIds = new Set([...cur.teams.keys(), ...(prev ? prev.teams.keys() : [])]);
    for (const id of teamIds) {
      const T = cur.teams.get(id) ?? newTeam();
      const pT = prev?.teams.get(id);
      teams[id] = shrinkTeam(T, pT, league, params, prev ? blendLeague(prev.league, null, 0) : null);
    }
    rimProtectors(teams, players, cur, params);
    return { asOf, season, league, teams, players, params };
  }

  // player game log before a date (for minutes projection)
  playerLog(id, before) { return (this.log.get(id) ?? []).filter(x => x.date < before); }
  teamPlayedOn(team, date) { return (this.teamDates.get(team) ?? []).includes(date); }
}

function blendLeague(a, b, w) {
  if (!a.poss && !(b && w > 0 && b.poss)) return null;
  const out = newLeague();
  for (const [src, wt] of [[a, 1], [b, w]]) {
    if (!src || !wt) continue;
    for (const k of Object.keys(out)) {
      if (Array.isArray(out[k])) out[k] = out[k].map((x, i) => x + wt * src[k][i]);
      else out[k] += wt * src[k];
    }
  }
  return out;
}

const roleKey = (P, tierOf, posOf) => `${posOf(P)}${tierOf(P.games ? P.sec / 60 / P.games : 20)}`;

// possession-weighted averages of raw rates by role, from (player map, weight) sources
function roleAverages(sources, tierOf, posOf, league) {
  const acc = {};
  const add = (key, P, w) => {
    const A = acc[key] ?? (acc[key] = newPlayer());
    A.offPoss += w * P.offPoss; A.orbOpp += w * P.orbOpp; A.drbOpp += w * P.drbOpp;
    for (let z = 0; z < NZ; z++) { A.att[z] += w * P.att[z]; A.made[z] += w * P.made[z]; }
    A.fta += w * P.fta; A.ftm += w * P.ftm; A.tov += w * P.tov; A.ast += w * P.ast; A.orb += w * P.orb; A.drb += w * P.drb;
  };
  for (const [map, w] of sources) {
    if (!map || !w) continue;
    for (const P of map.values()) { add(roleKey(P, tierOf, posOf), P, w); add('all', P, w); }
  }
  const out = {};
  const fallback = { att: league.attRate, fg: league.fg, fta: league.ftaRate, ft: league.ft, tov: league.tovRate, ast: league.astRate, orbPct: league.orbPct, drbPct: 1 - league.orbPct };
  for (const [k, A] of Object.entries(acc)) {
    out[k] = A.offPoss > 200
      ? { att: A.att.map(a => a / A.offPoss), fg: A.att.map((a, z) => (a > 20 ? A.made[z] / a : fallback.fg[z])), fta: A.fta / A.offPoss, ft: A.fta > 20 ? A.ftm / A.fta : fallback.ft, tov: A.tov / A.offPoss, ast: A.ast / A.offPoss, orbPct: A.orb / A.orbOpp, drbPct: A.drb / A.drbOpp }
      : fallback;
  }
  out.all ??= fallback;
  return out;
}

const shr = (count, exposure, prior, k) => (count + k * prior) / (exposure + k);
function shrinkPlayer(P, prior, params) {
  const k = params.k;
  // rebound shares are per player-on-court chance; a fifth of the team's rebounds each
  return {
    att: P.att.map((a, z) => shr(a, P.offPoss, prior.att[z], k.att)),
    fg: P.att.map((a, z) => shr(P.made[z], a, prior.fg[z], k.fg[z])),
    fta: shr(P.fta, P.offPoss, prior.fta, k.fta),
    ft: shr(P.ftm, P.fta, prior.ft, k.ft),
    tov: shr(P.tov, P.offPoss, prior.tov, k.tov),
    ast: shr(P.ast, P.offPoss, prior.ast, k.ast),
    orbPct: shr(P.orb, P.orbOpp, prior.orbPct, k.reb),
    drbPct: shr(P.drb, P.drbOpp, prior.drbPct, k.reb),
  };
}
const mixRates = (a, b, w) => ({
  att: a.att.map((x, z) => w * x + (1 - w) * b.att[z]), fg: a.fg.map((x, z) => w * x + (1 - w) * b.fg[z]),
  fta: w * a.fta + (1 - w) * b.fta, ft: w * a.ft + (1 - w) * b.ft, tov: w * a.tov + (1 - w) * b.tov,
  ast: w * a.ast + (1 - w) * b.ast, orbPct: w * a.orbPct + (1 - w) * b.orbPct, drbPct: w * a.drbPct + (1 - w) * b.drbPct,
});

function shrinkTeam(T, pT, league, params, prevLeagueSums) {
  const k = params.k, c = params.carry;
  // prior: last season's team ratio pulled toward league (1.0) by (1 - carry)
  const prevRatio = (num, den, lgRate) => (pT && den(pT) > 0 ? c * (num(pT) / den(pT)) / lgRate + (1 - c) : 1);
  const lgPrevFg = prevLeagueSums ? prevLeagueSums.att.map((a, z) => prevLeagueSums.made[z] / a) : league.fg;
  const lgPrevAtt = prevLeagueSums ? prevLeagueSums.att.map(a => a / prevLeagueSums.poss) : league.attRate;
  const fgMult = league.fg.map((lg, z) => {
    const prior = prevRatio(t => t.oppMade[z], t => t.oppAtt[z], lgPrevFg[z]);
    return shr(T.oppMade[z] / lg, T.oppAtt[z], prior, k.teamFg);
  });
  const attMult = league.attRate.map((lg, z) => {
    const prior = prevRatio(t => t.oppAtt[z], t => t.defPoss, lgPrevAtt[z]);
    return shr(T.oppAtt[z] / lg, T.defPoss, prior, k.teamRate);
  });
  const lgPrev = prevLeagueSums ?? null;
  const tovPrior = prevRatio(t => t.forcedTov, t => t.defPoss, lgPrev ? lgPrev.tov / lgPrev.poss : league.tovRate);
  const ftaPrior = prevRatio(t => t.oppFta, t => t.defPoss, lgPrev ? lgPrev.fta / lgPrev.poss : league.ftaRate);
  const orbPrior = prevRatio(t => t.oppOrb, t => t.oppOrbOpp, lgPrev ? lgPrev.orb / lgPrev.orbOpp : league.orbPct);
  const pacePrior = pT && pT.paceMin ? c * (48 * pT.pacePoss / pT.paceMin) + (1 - c) * league.pace : league.pace;
  // net rating pieces for the baseline (points per 100, shrunk toward league)
  const ortgPrior = pT && pT.offPoss ? c * 100 * pT.pts / pT.offPoss + (1 - c) * league.ortg : league.ortg;
  const drtgPrior = pT && pT.defPoss ? c * 100 * pT.oppPts / pT.defPoss + (1 - c) * league.ortg : league.ortg;
  return {
    fgMult, attMult,
    tovMult: shr(T.forcedTov / league.tovRate, T.defPoss, tovPrior, k.teamRate),
    ftaMult: shr(T.oppFta / league.ftaRate, T.defPoss, ftaPrior, k.teamRate),
    orbAllowMult: shr(T.oppOrb / league.orbPct, T.oppOrbOpp, orbPrior, k.teamReb),
    pace: shr(T.games * (48 * (T.pacePoss / Math.max(T.paceMin, 1))), T.games, pacePrior, k.pace),
    ortg: shr(100 * T.pts, T.offPoss, ortgPrior, k.teamRtg),
    drtg: shr(100 * T.oppPts, T.defPoss, drtgPrior, k.teamRtg),
    n: { games: T.games, defPoss: T.defPoss, prevSeason: !!pT },
  };
}

// design §6.4: two bigs with the most defensive rebounds + blocks per minute; restricted-area FG%
// allowed with them on vs off the floor, heavily shrunk toward no effect
function rimProtectors(teams, players, cur, params) {
  for (const [tid, team] of Object.entries(teams)) {
    const cands = Object.entries(players)
      .filter(([id, p]) => p.team === tid && p.pos !== 'G' && cur.players.get(id)?.sec > 300 * 60)
      .map(([id]) => [id, cur.players.get(id)])
      .filter(([, P]) => P.rimGames > 0)
      .sort((a, b) => (b[1].drb + b[1].blk) / b[1].sec - (a[1].drb + a[1].blk) / a[1].sec)
      .slice(0, 2);
    team.rim = cands.map(([id, P]) => {
      const on = P.rimOn, off = [P.rimTeam[0] - P.rimOn[0], P.rimTeam[1] - P.rimOn[1]];
      const diff = on[1] > 0 && off[1] > 0 ? off[0] / off[1] - on[0] / on[1] : 0;
      const n = Math.min(on[1], off[1]);
      return { id, raAllowedOn: on, raAllowedOff: off, raDiff: diff * n / (n + params.k.rim) };
    });
  }
}

// cutoff instant for a date: an ET calendar date means 00:00 ET that day; ISO passes through
export const cutoffOf = date => (date.length === 10 ? fromEt(date, 0, 0).toISOString() : date);
const startedBefore = (g, cutoff) => Date.parse(g.start) < Date.parse(cutoff);

// asOf: ratings from every game that started strictly before `date`
export function asOf(games, date, params = DEFAULT_PARAMS) {
  const cutoff = cutoffOf(date);
  const acc = new Accumulator(params);
  for (const g of [...games].filter(x => startedBefore(x, cutoff)).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))) acc.add(g);
  return { acc, ratings: acc.ratings(cutoff, params) };
}
