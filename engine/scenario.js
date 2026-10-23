// Scenario engine (P6, design §8.1, §8.4). Additive only: a scenario changes copies of the simulator inputs
// (ratings, minutes plans, rules) and never the validated prediction code or parameter files. Scenario results
// are "unverified" and never feed picks or EV (2026-10-23 user condition 3).
//   playerOut / playProb  play probabilities in the plan; the simulator moves absent minutes within the position
//   minutesCap           cap one player's expected minutes; the excess goes to same-position teammates
//   shootingShift        add percentage points to the team's players' 3-point (fg3) or 2-point (fg2) accuracy
//   fatigue              back-to-back on/off: the minutes model's starter cut (MINUTES_PARAMS.b2bStarterCut) moved
//                        between starters and bench, symmetric; rest probabilities are not recomputed (approximation)
//   chemistry            points per 100 possessions as a multiplier on the team's make probabilities
//   paceShift            both teams' pace scaled so the expected possessions change by the given number
//   rules                garbage time / clutch fouling switches of the simulator
import { MINUTES_PARAMS } from './minutes.js';

export const UNVERIFIED = 'unverified';
const ZONES = { fg2: [0, 1, 2], fg3: [3, 4] };
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

// input: { ratings, home, away, abbr?: { home, away }, homePlan, awayPlan }
export function applyScenario(input, scenario = {}) {
  const out = {
    ratings: structuredClone(input.ratings), home: input.home, away: input.away, abbr: input.abbr,
    homePlan: structuredClone(input.homePlan), awayPlan: structuredClone(input.awayPlan),
    rules: { ...(input.rules ?? {}), ...(scenario.rules ?? {}) }, notes: [...(input.notes ?? [])],
  };
  const plans = [out.homePlan, out.awayPlan];
  const sideOf = team => [0, 1].find(s => team === [out.home, out.away][s] || team === [out.abbr?.home, out.abbr?.away][s]);
  const findPlayer = id => { for (const p of plans) { const x = p.players.find(q => q.playerId === id); if (x) return [p, x]; } return [null, null]; };
  const team = (t, what) => { const s = sideOf(t); if (s === undefined) out.notes.push(`${what}: team ${t} is not in this game`); return s; };

  for (const id of scenario.playerOut ?? []) {
    const [, x] = findPlayer(id);
    if (x) x.playProb = 0; else out.notes.push(`playerOut: ${id} is not in either plan`);
  }
  for (const [id, p] of Object.entries(scenario.playProb ?? {})) {
    const [, x] = findPlayer(id);
    if (x) x.playProb = clamp(p, 0, 1); else out.notes.push(`playProb: ${id} is not in either plan`);
  }
  for (const [id, cap] of Object.entries(scenario.minutesCap ?? {})) {
    const [plan, x] = findPlayer(id);
    if (!x) { out.notes.push(`minutesCap: ${id} is not in either plan`); continue; }
    if (x.expMin <= cap) continue;
    const excess = x.expMin - cap;
    x.expMin = cap;
    const mates = plan.players.filter(q => q !== x && q.playProb > 0 && q.expMin > 0);
    const same = mates.filter(q => q.pos === x.pos);
    spread(same.length ? same : mates, excess);
  }
  for (const { team: t, fg2 = 0, fg3 = 0 } of scenario.shootingShift ?? []) {
    const s = team(t, 'shootingShift');
    if (s === undefined) continue;
    for (const p of plans[s].players) {
      const r = out.ratings.players[p.playerId];
      if (!r) continue;
      for (const z of ZONES.fg2) r.fg[z] = clamp(r.fg[z] + fg2, 0.01, 0.99);
      for (const z of ZONES.fg3) r.fg[z] = clamp(r.fg[z] + fg3, 0.01, 0.99);
    }
  }
  for (const { team: t, b2b } of scenario.fatigue ?? []) {
    const s = team(t, 'fatigue');
    if (s === undefined || !!plans[s].b2b === !!b2b) continue;
    const cut = MINUTES_PARAMS.b2bStarterCut;
    const starters = plans[s].players.filter(p => p.starter && p.expMin > 0), bench = plans[s].players.filter(p => !p.starter && p.expMin > 0 && p.playProb > 0);
    const S = starters.reduce((a, p) => a + p.expMin, 0);
    const moved = b2b ? S * cut : S * cut / (1 - cut); // on: starters × (1 - cut); off: back to the full minutes
    for (const p of starters) p.expMin = b2b ? p.expMin * (1 - cut) : p.expMin / (1 - cut);
    spread(bench, b2b ? moved : -moved);
    plans[s].b2b = !!b2b;
    out.notes.push(`fatigue ${[out.abbr?.home, out.abbr?.away][s] ?? t}: approximation (starter minutes only, rest probabilities unchanged)`);
  }
  for (const { team: t, ptsPer100 } of scenario.chemistry ?? []) {
    const s = team(t, 'chemistry');
    if (s === undefined || !ptsPer100) continue;
    const m = 1 + ptsPer100 / out.ratings.league.ortg;
    for (const p of plans[s].players) {
      const r = out.ratings.players[p.playerId];
      if (r) r.fg = r.fg.map(f => clamp(f * m, 0.01, 0.99));
    }
  }
  if (scenario.paceShift) {
    const T = out.ratings.teams[out.home].pace * out.ratings.teams[out.away].pace / out.ratings.league.pace * (out.ratings.league.env?.paceRatio ?? 1);
    const f = Math.sqrt(Math.max(1, T + scenario.paceShift) / T);
    out.ratings.teams[out.home] = { ...out.ratings.teams[out.home], pace: out.ratings.teams[out.home].pace * f };
    out.ratings.teams[out.away] = { ...out.ratings.teams[out.away], pace: out.ratings.teams[out.away].pace * f };
  }
  return out;
}

// add `amount` minutes over players in proportion to their expected minutes (negative removes)
function spread(players, amount) {
  const w = players.reduce((a, p) => a + p.expMin, 0);
  if (w > 0) for (const p of players) p.expMin += amount * p.expMin / w;
}

// probability histograms of a simulateGame result, in the form engine/calibrate.js markets() reads
export function simSummary(res, shift = 0) {
  const toP = h => h.map(c => c / res.n);
  return {
    margin: res.margin.mean, total: res.total.mean, marginSD: res.margin.sd, totalSD: res.total.sd,
    marginHist: { lo: -60, p: toP(res.margin.hist) }, totalHist: { lo: 150, p: toP(res.total.hist) }, shift,
  };
}

// §8.4: both distributions move by the base shift (1 - w)(baseline - base mean), so the scenario mean is the
// ensemble location plus (scenario - base); the calibration layer is applied afterwards by the caller
export function combine({ base, scenario, baselineMargin, w }) {
  const shift = (1 - w) * (baselineMargin - base.margin.mean);
  return {
    base: simSummary(base, shift), scenario: simSummary(scenario, shift),
    ensembleMargin: base.margin.mean + shift,
    delta: { margin: scenario.margin.mean - base.margin.mean, total: scenario.total.mean - base.total.mean },
    label: UNVERIFIED,
  };
}
