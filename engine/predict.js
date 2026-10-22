// Analytic expectation of a game from ratings (P3 evaluation; the P4 simulator replaces it).
// Per-player rates are per team possession while on the floor, so a team rate is
// Σ (minutes/48) × player rate over its rotation (the shares sum to 5).
import { ZONE_POINTS } from './model.js';

export function normCdf(x) {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
export const winProb = (margin, sigma) => normCdf(margin / sigma);

function leaguePlayer(league) {
  return { att: league.attRate.map(a => a / 5), fg: [...league.fg], fta: league.ftaRate / 5, ft: league.ft, tov: league.tovRate / 5 };
}

// points per 100 possessions for `plan` against defence `def`
export function offense(ratings, plan, def) {
  const { league } = ratings;
  const fallback = leaguePlayer(league);
  const rows = plan.players.filter(p => p.playProb > 0 && p.expMin > 0);
  const totalMin = rows.reduce((a, p) => a + p.expMin * p.playProb, 0);
  const att = [0, 0, 0, 0, 0], made = [0, 0, 0, 0, 0];
  let fta = 0, ftm = 0, tov = 0;
  for (const p of rows) {
    const r = ratings.players[p.playerId] ?? fallback;
    const f = 5 * (p.expMin * p.playProb) / totalMin; // floor share, Σ f = 5
    for (let z = 0; z < 5; z++) { att[z] += f * r.att[z]; made[z] += f * r.att[z] * r.fg[z]; }
    fta += f * r.fta; ftm += f * r.fta * r.ft; tov += f * r.tov;
  }
  // usage: the five on the floor end every possession, so scale shot, FT-trip and turnover volume to
  // the league's team usage per possession (accuracy unchanged)
  const used = att.reduce((x, y) => x + y, 0) + 0.44 * fta + tov;
  const lgUsed = league.attRate.reduce((x, y) => x + y, 0) + 0.44 * league.ftaRate + league.tovRate;
  const u = used > 0 ? lgUsed / used : 1;
  for (let z = 0; z < 5; z++) { att[z] *= u; made[z] *= u; }
  fta *= u; ftm *= u; tov *= u;
  // defence: more forced turnovers -> fewer shots; zone mix and accuracy allowed relative to league
  const tovAdj = Math.min(0.5, tov * def.tovMult);
  const shotScale = (1 - tovAdj) / (1 - tov);
  let pts = 0;
  for (let z = 0; z < 5; z++) {
    if (!att[z]) continue;
    const a = att[z] * def.attMult[z] * shotScale;
    pts += a * (made[z] / att[z]) * def.fgMult[z] * ZONE_POINTS[z];
  }
  pts += fta * def.ftaMult * shotScale * (ftm / Math.max(fta, 1e-9));
  return 100 * pts;
}

const possessions = (ratings, h, a) => ratings.teams[h].pace * ratings.teams[a].pace / ratings.league.pace;

export function expectedGame(ratings, home, away, homePlan, awayPlan) {
  const hca = ratings.league.hca ?? 0;
  const env = ratings.league.env ?? { ortgRatio: 1, paceRatio: 1 }; // date-based league scoring environment
  const homeRtg = offense(ratings, homePlan, ratings.teams[away]) * env.ortgRatio + hca / 2;
  const awayRtg = offense(ratings, awayPlan, ratings.teams[home]) * env.ortgRatio - hca / 2;
  const poss = possessions(ratings, home, away) * env.paceRatio;
  const homePts = poss * homeRtg / 100, awayPts = poss * awayRtg / 100;
  return { homePts, awayPts, margin: homePts - awayPts, total: homePts + awayPts, possessions: poss, homeRtg, awayRtg };
}

// baseline (P3 condition 8): team net ratings + home advantage
export function baselineGame(ratings, home, away) {
  const { league } = ratings;
  const H = ratings.teams[home], A = ratings.teams[away];
  const hca = league.hca ?? 0;
  const homeRtg = H.ortg + A.drtg - league.ortg + hca / 2;
  const awayRtg = A.ortg + H.drtg - league.ortg - hca / 2;
  const poss = possessions(ratings, home, away);
  const homePts = poss * homeRtg / 100, awayPts = poss * awayRtg / 100;
  return { homePts, awayPts, margin: homePts - awayPts, total: homePts + awayPts, possessions: poss };
}
