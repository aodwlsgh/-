// Scenario engine (P6, design §8.1, §8.4). Additive only: a scenario changes copies of the simulator inputs
// (ratings, minutes plans, rules) and never the validated prediction code or parameter files. Scenario results
// are "unverified" and never feed picks or EV (2026-10-23 user condition 3).
export const UNVERIFIED = 'unverified';

// input: { ratings, home, away, homePlan, awayPlan }; returns copies with the scenario applied, plus the rules
export function applyScenario(input, scenario = {}) {
  const out = {
    ratings: structuredClone(input.ratings), home: input.home, away: input.away,
    homePlan: structuredClone(input.homePlan), awayPlan: structuredClone(input.awayPlan),
    rules: { ...(scenario.rules ?? {}) },
  };
  return out;
}
