// Walk-forward evaluation (P3): every game is predicted from ratings built only on games that started
// before its ET date; then that date's games are added. Variant "A" (design §14.2): the players who
// actually took part, with minutes projected from history. Variant "B": the roster from history with play
// probabilities from the pre-game injury snapshot; injuriesFor(game, side, players[{id, name}]) returns
// { injuries: {playerId: playProb}, ...info } and the info is kept on the row (snapshot.home / .away).
import { Accumulator, DEFAULT_PARAMS, cutoffOf, seasonOf } from './model.js';
import { projectMinutes, roster, teamHistory, MINUTES_PARAMS } from './minutes.js';
import { expectedGame, baselineGame, winProb } from './predict.js';
import { etParts } from './time.js';
import { jobGroup } from './snapshot.js';
import { PLAY_PROB } from './injury.js';

const etDate = g => etParts(new Date(g.start)).date;

// target: { season, from?, to? } ET dates inclusive
// the baseline keeps fixed parameters (design defaults) so tuning the model never moves it
// onGame({ ratings, homePlan, awayPlan, game, row }) may add fields to the row (P4 simulation)
export function walkForward({ games, target, params = DEFAULT_PARAMS, minutesParams = MINUTES_PARAMS, baselineParams = DEFAULT_PARAMS, onGame = null, filter = null, variant = 'A', injuriesFor = null }) {
  const sorted = [...games].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  const byDate = new Map();
  for (const g of sorted) { const d = etDate(g); if (!byDate.has(d)) byDate.set(d, []); byDate.get(d).push(g); }
  const acc = new Accumulator(params);
  const accBase = new Accumulator(baselineParams);
  const rows = [];
  const names = new Map();
  const inTarget = (g, d) => g.season === target.season && (!target.from || d >= target.from) && (!target.to || d <= target.to);
  for (const [d, list] of byDate) {
    const targets = list.filter(g => inTarget(g, d));
    if (targets.length) {
      const ratings = acc.ratings(cutoffOf(d), params);
      const ratingsBase = accBase.ratings(cutoffOf(d), baselineParams);
      if (!ratings.empty) {
        for (const g of targets) {
          if (!ratings.teams[g.home.id] || !ratings.teams[g.away.id]) continue;
          if (filter && !filter(g)) continue;
          const parts = t => g.players.filter(p => p.t === t && !p.dnp && (p.sec > 0 || p.min > 0)).map(p => p.id);
          let hp, ap, snapshot;
          if (variant === 'B') {
            const info = [g.home.id, g.away.id].map((team, side) => {
              // the team's own history first, then everyone else (a player listed right after a trade)
              const own = teamHistory(acc, team, d), mine = new Set(own);
              const players = [...own, ...[...names.keys()].filter(id => !mine.has(id))].map(id => ({ id, name: names.get(id) }));
              return injuriesFor ? injuriesFor(g, side, players) : { injuries: {} };
            });
            // listed players outside the recent roster join the plan unless Out
            const extra = (team, side) => { const r = new Set(roster(acc, team, d, minutesParams)); return Object.entries(info[side].injuries).filter(([id, p]) => p > 0 && !r.has(id)).map(([id]) => id); };
            [hp, ap] = [g.home.id, g.away.id].map((team, side) => projectMinutes(acc, team, d, { injuries: info[side].injuries, extra: extra(team, side) }, minutesParams));
            // user request 7: games where one of the team's top three (projected minutes before injuries) is Out or Doubtful
            const top3Absent = (team, inj) => projectMinutes(acc, team, d, {}, minutesParams).players.filter(x => x.playProb > 0)
              .sort((x, y) => y.expMin - x.expMin).slice(0, 3).filter(x => (inj[x.playerId] ?? 1) <= PLAY_PROB.Doubtful).length;
            snapshot = Object.fromEntries(['home', 'away'].map((k, side) => { const { injuries, ...rest } = info[side]; return [k, { ...rest, top3Absent: top3Absent([g.home.id, g.away.id][side], injuries) }]; }));
          } else {
            hp = projectMinutes(acc, g.home.id, d, { participants: parts(0) }, minutesParams);
            ap = projectMinutes(acc, g.away.id, d, { participants: parts(1) }, minutesParams);
          }
          const m = expectedGame(ratings, g.home.id, g.away.id, hp, ap);
          const b = baselineGame(ratingsBase, g.home.id, g.away.id);
          const margin = g.final[0] - g.final[1];
          const row = {
            id: g.id, variant, date: d, month: d.slice(0, 7), season: g.season, game: `${g.away.abbr}@${g.home.abbr}`, group: jobGroup(g.start),
            pdfFormat: d < '2025-12-22' ? 'hourly' : '15min', overtime: g.periods > 4, dataExcluded: !!g.excluded,
            actual: { margin, total: g.final[0] + g.final[1], homeWin: margin > 0 ? 1 : 0 },
            model: { margin: m.margin, total: m.total }, base: { margin: b.margin, total: b.total },
          };
          if (snapshot) row.snapshot = snapshot;
          if (onGame) Object.assign(row, onGame({ ratings, homePlan: hp, awayPlan: ap, game: g, row }));
          rows.push(row);
        }
      }
    }
    for (const g of list) { acc.add(g); accBase.add(g); for (const p of g.players) names.set(p.id, p.n); }
  }
  return rows;
}

export const fitSigma = (rows, key) => Math.sqrt(rows.reduce((a, r) => a + (r.actual.margin - r[key].margin) ** 2, 0) / rows.length);

function score(rows, key, sigma) {
  let mm = 0, tm = 0, br = 0, ll = 0, bias = 0, tbias = 0;
  for (const r of rows) {
    const p = Math.min(1 - 1e-6, Math.max(1e-6, winProb(r[key].margin, sigma)));
    mm += Math.abs(r.actual.margin - r[key].margin);
    tm += Math.abs(r.actual.total - r[key].total);
    br += (p - r.actual.homeWin) ** 2;
    ll += -(r.actual.homeWin ? Math.log(p) : Math.log(1 - p));
    bias += r.actual.margin - r[key].margin;
    tbias += r.actual.total - r[key].total;
  }
  const n = rows.length;
  const r4 = x => +x.toFixed(4);
  return { marginMAE: r4(mm / n), totalMAE: r4(tm / n), brier: r4(br / n), logLoss: r4(ll / n), marginBias: r4(bias / n), totalBias: r4(tbias / n) };
}

// sigma: { model, base } margin SDs (fitted on the development season and then frozen)
export function metrics(rows, sigma, { groupBy = 'month' } = {}) {
  const block = rs => ({ n: rs.length, model: score(rs, 'model', sigma.model), base: score(rs, 'base', sigma.base) });
  const groups = {};
  for (const r of rows) (groups[r[groupBy]] ??= []).push(r);
  return { all: block(rows), [groupBy === 'month' ? 'byMonth' : `by_${groupBy}`]: Object.fromEntries(Object.entries(groups).sort().map(([k, rs]) => [k, block(rs)])) };
}

export { seasonOf };
