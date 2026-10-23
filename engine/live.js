// Live base predictions for games not played yet (P9). The same steps as the validated backtest variant B
// (engine/evaluate.js walkForward, B): ratings from every game before the ET date, the roster from history,
// play probabilities from the run's injury snapshot, minutes from projectMinutes, the simulator with the backtest
// seed, rules and latent, then the ensemble shift. walkForward needs final scores, so the steps are repeated here
// and a test holds them to the stored 2024-25 B simulations.
// Injuries (2026-10-23 P9 approval 5): picks and EV use the validated path (NBA PDF snapshot only). The design §6.5
// merge (ESPN Out + PDF statuses) is predicted alongside, labelled, and never reaches picks; the players and games
// where the two differ are listed.
import { Accumulator, DEFAULT_PARAMS, cutoffOf } from './model.js';
import { projectMinutes, roster, teamHistory, MINUTES_PARAMS } from './minutes.js';
import { expectedGame, baselineGame } from './predict.js';
import { simulateGame } from './sim.js';
import { etParts } from './time.js';
import { jobGroup } from './snapshot.js';
import { PLAY_PROB, normalizeName } from './injury.js';
import { byEspn } from './teams.js';
import { TEXT } from './dashboard-data.js';

export const RULES_ON = { garbageTime: true, clutchFoul: true, overtime: true, latent: true }; // = jobs/backtest.js
export const PARALLEL_LABEL = TEXT.parallel;
const etDate = start => etParts(new Date(start)).date;
const round = (x, d = 6) => +x.toFixed(d);

// history: finished games (any order); fixtures: [{ id, start, season, home: {id, abbr}, away: {id, abbr} }] of `date`
// injuriesFor(fixture, side, players[{id, name}]) -> { injuries: {playerId: playProb}, ...info }
export function livePlans({ history, fixtures, date, params = DEFAULT_PARAMS, minutesParams = MINUTES_PARAMS, baselineParams = DEFAULT_PARAMS, injuriesFor }) {
  const sorted = history.filter(g => etDate(g.start) < date).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const acc = new Accumulator(params), accBase = new Accumulator(baselineParams);
  const names = new Map();
  for (const g of sorted) { acc.add(g); accBase.add(g); for (const p of g.players) names.set(p.id, p.n); }
  const ratings = acc.ratings(cutoffOf(date), params), ratingsBase = accBase.ratings(cutoffOf(date), baselineParams);
  const rows = [], skipped = [];
  if (ratings.empty) return { rows, skipped: fixtures.map(f => ({ id: f.id, reason: 'no ratings before this date' })), names, acc };
  const playersOf = team => {
    const own = teamHistory(acc, team, date), mine = new Set(own);
    return [...own, ...[...names.keys()].filter(id => !mine.has(id))].map(id => ({ id, name: names.get(id) }));
  };
  const plansFor = (f, inj) => {
    const extra = (team, side) => { const r = new Set(roster(acc, team, date, minutesParams)); return Object.entries(inj[side]).filter(([id, p]) => p > 0 && !r.has(id)).map(([id]) => id); };
    return [f.home.id, f.away.id].map((team, side) => projectMinutes(acc, team, date, { injuries: inj[side], extra: extra(team, side) }, minutesParams));
  };
  const top3Absent = (team, inj) => projectMinutes(acc, team, date, {}, minutesParams).players.filter(x => x.playProb > 0)
    .sort((x, y) => y.expMin - x.expMin).slice(0, 3).filter(x => (inj[x.playerId] ?? 1) <= PLAY_PROB.Doubtful).length;
  for (const f of fixtures) {
    if (etDate(f.start) !== date) throw new Error(`fixture ${f.id} is not on ${date}`);
    if (!ratings.teams[f.home.id] || !ratings.teams[f.away.id]) { skipped.push({ id: f.id, reason: 'no team ratings' }); continue; }
    const players = [f.home.id, f.away.id].map(playersOf);
    const info = [0, 1].map(side => (injuriesFor ? injuriesFor(f, side, players[side]) : { injuries: {} }));
    const inj = info.map(x => x.injuries);
    const [homePlan, awayPlan] = plansFor(f, inj);
    const snapshot = Object.fromEntries(['home', 'away'].map((k, side) => { const { injuries, ...rest } = info[side]; return [k, { ...rest, top3Absent: top3Absent([f.home.id, f.away.id][side], inj[side]) }]; }));
    const m = expectedGame(ratings, f.home.id, f.away.id, homePlan, awayPlan);
    const b = baselineGame(ratingsBase, f.home.id, f.away.id);
    rows.push({ fixture: f, group: jobGroup(f.start), ratings, homePlan, awayPlan, players, injuries: inj, snapshot, model: { margin: m.margin, total: m.total }, base: { margin: b.margin, total: b.total }, plansWith: injuries => plansFor(f, injuries) });
  }
  return { rows, skipped, names, acc };
}

// one game's simulation in the backtest's stored form, plus the ensemble shift (engine/backtest.js withShift)
export function simulateRow(row, { n = 10000, latent, w, plans = null }) {
  const [homePlan, awayPlan] = plans ?? [row.homePlan, row.awayPlan];
  const input = { ratings: row.ratings, home: row.fixture.home.id, away: row.fixture.away.id, homePlan, awayPlan };
  const s = simulateGame(input, { n, seed: +row.fixture.id % 2147483647, rules: RULES_ON, latent });
  const hist = (h, lo) => ({ lo, p: h.map(c => round(c / s.n)) });
  const sim = { margin: round(s.margin.mean, 4), total: round(s.total.mean, 4), marginSD: round(s.margin.sd, 4), totalSD: round(s.total.sd, 4), ot: s.overtimeRate, marginHist: hist(s.margin.hist, -60), totalHist: hist(s.total.hist, 150), n: s.n };
  sim.shift = (1 - w) * (row.base.margin - sim.margin);
  return { sim, input };
}

// design §6.5 statuses (engine/injury.js resolveStatuses output) for one team, matched by ESPN id, then by name
export function mergedInjuries(resolved, { team, players }) {
  const key = byEspn(team).key;
  const byName = new Map();
  for (const p of players) { const k = normalizeName(p.name ?? ''); if (!byName.has(k)) byName.set(k, p.id); }
  const ids = new Set(players.map(p => p.id));
  const out = { injuries: {}, statuses: [], unmatched: [], conflicts: (resolved.conflicts ?? []).filter(c => c.team === key) };
  for (const r of resolved.players.filter(x => x.team === key)) {
    const id = r.espnId && ids.has(r.espnId) ? r.espnId : byName.get(normalizeName(r.name));
    if (!id) { out.unmatched.push(r.name); continue; }
    out.injuries[id] = r.playProb;
    out.statuses.push({ id, status: r.status, source: r.source });
  }
  return out;
}

// players whose play probability differs between the validated (PDF) and the merged input
export function injuryDiff(pdf, merged, names) {
  const out = [];
  for (const id of new Set([...Object.keys(pdf), ...Object.keys(merged)])) {
    const a = pdf[id] ?? null, b = merged[id] ?? null;
    if (a !== b) out.push({ id, name: names.get(id) ?? id, pdf: a, merged: b });
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}
