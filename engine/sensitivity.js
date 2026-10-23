// Sensitivity analysis (P6, design §8.3): one variable at a time, the same seed as the base run (common random
// numbers), changes of the simulated mean margin and total; Top 3 of each. The changes are added to the ensemble
// location when shown (§8.4) and are labelled unverified (never used for picks).
//   per team: each starter out, each starter -20% minutes, 3-point ±2%p (fixed, 2026-10-23 user decision),
//   back-to-back switched; per game: pace ±3 possessions
import { simulateGame } from './sim.js';
import { applyScenario, UNVERIFIED } from './scenario.js';

const starters = plan => {
  const flagged = plan.players.filter(p => p.starter && p.playProb > 0 && p.expMin > 0);
  return flagged.length ? flagged : [...plan.players].filter(p => p.playProb > 0).sort((a, b) => b.expMin - a.expMin).slice(0, 5);
};

export function variantsOf(input) {
  const out = [];
  [input.homePlan, input.awayPlan].forEach((plan, s) => {
    const team = s ? input.away : input.home, name = (s ? input.abbr?.away : input.abbr?.home) ?? team;
    for (const p of starters(plan)) {
      out.push({ key: `out:${p.playerId}`, label: `${name} ${p.playerId} out`, scenario: { playerOut: [p.playerId] } });
      out.push({ key: `cap:${p.playerId}`, label: `${name} ${p.playerId} minutes -20%`, scenario: { minutesCap: { [p.playerId]: p.expMin * 0.8 } } });
    }
    for (const d of [-0.02, 0.02]) out.push({ key: `fg3:${team}:${d}`, label: `${name} 3P ${d > 0 ? '+' : ''}${d * 100}%p`, scenario: { shootingShift: [{ team, fg3: d }] } });
    out.push({ key: `b2b:${team}`, label: `${name} back-to-back ${plan.b2b ? 'off' : 'on'} (approximation)`, scenario: { fatigue: [{ team, b2b: !plan.b2b }] } });
  });
  for (const d of [-3, 3]) out.push({ key: `pace:${d}`, label: `pace ${d > 0 ? '+' : ''}${d}`, scenario: { paceShift: d } });
  return out;
}

export function sensitivity(input, { n = 2000, seed = 1, rules = {} } = {}) {
  const t0 = performance.now();
  const base = simulateGame(input, { n, seed, rules });
  const variants = variantsOf(input).map(v => {
    const s = applyScenario(input, v.scenario);
    const r = simulateGame(s, { n, seed, rules: { ...rules, ...s.rules } });
    return { ...v, dMargin: r.margin.mean - base.margin.mean, dTotal: r.total.mean - base.total.mean, notes: s.notes };
  });
  const top = k => [...variants].sort((a, b) => Math.abs(b[k]) - Math.abs(a[k])).slice(0, 3);
  return { label: UNVERIFIED, n, seed, base: { margin: base.margin.mean, total: base.total.mean }, variants, topMargin: top('dMargin'), topTotal: top('dTotal'), ms: performance.now() - t0 };
}
