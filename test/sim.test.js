import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulateGame, allocateMinutes, rng } from '../engine/sim.js';
import { expectedGame } from '../engine/predict.js';

const league = { fg: [0.65, 0.44, 0.42, 0.39, 0.355], attRate: [0.26, 0.175, 0.083, 0.098, 0.278], ftaRate: 0.218, ft: 0.78, tovRate: 0.136, pace: 99, ortg: 114.5, hca: 0, env: { ortgRatio: 1, paceRatio: 1 } };
const avgPlayer = () => ({ att: league.attRate.map(a => a / 5), fg: [...league.fg], fta: league.ftaRate / 5, ft: league.ft, tov: league.tovRate / 5, ast: 0.05, orbPct: 0.05, drbPct: 0.15 });
const neutral = () => ({ fgMult: [1, 1, 1, 1, 1], attMult: [1, 1, 1, 1, 1], tovMult: 1, ftaMult: 1, orbAllowMult: 1, pace: 99, ortg: 114.5, drtg: 114.5 });
const ids = pre => Array.from({ length: 9 }, (_, i) => `${pre}${i + 1}`);
const MIN = [36, 34, 33, 32, 30, 25, 20, 18, 12];
const ratings = (o = {}) => ({
  league: { ...league, ...o.league }, teams: { H: neutral(), A: neutral() },
  players: Object.fromEntries([...ids('h'), ...ids('a')].map(id => [id, avgPlayer()])), ...o.extra,
});
const plan = pre => ({ players: ids(pre).map((id, i) => ({ playerId: id, expMin: MIN[i], playProb: 1, pos: i % 3 === 2 ? 'C' : i % 3 ? 'F' : 'G' })) });
const RULES_OFF = { garbageTime: false, clutchFoul: false, overtime: false, latent: false };

test('seeded RNG is reproducible', () => {
  const a = rng(42), b = rng(42);
  for (let i = 0; i < 5; i++) assert.equal(a(), b());
});

test('minutes allocation: integer minutes summing to 240, close to the plan, starters open each half', () => {
  const sched = allocateMinutes(plan('h').players);
  assert.equal(sched.slots.length, 48);
  assert.ok(sched.slots.every(s => s.length === 5 && new Set(s).size === 5));
  const mins = {};
  sched.slots.flat().forEach(id => { mins[id] = (mins[id] || 0) + 1; });
  assert.equal(Object.values(mins).reduce((a, b) => a + b, 0), 240);
  ids('h').forEach((id, i) => assert.ok(Math.abs((mins[id] ?? 0) - MIN[i]) <= 1, `${id} ${mins[id]}`));
  assert.deepEqual([...sched.slots[0]].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);
  assert.deepEqual([...sched.slots[24]].sort(), ['h1', 'h2', 'h3', 'h4', 'h5']);
});

test('same seed, same result; different seed, different result', () => {
  const r = ratings();
  const a = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 500, seed: 7 });
  const b = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 500, seed: 7 });
  const c = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 500, seed: 8 });
  assert.deepEqual(a, b);
  assert.notEqual(a.margin.mean, c.margin.mean);
});

test('invariants on every simulated game: team score = player points, minutes = 240 + 25 per OT', () => {
  const r = ratings();
  const res = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 300, seed: 3, check: true });
  assert.equal(res.invariantFailures, 0);
  assert.ok(res.overtimeRate > 0); // ties go to overtime with rules on
});

test('league-average teams: mean points within 1.5 of the league average and margin near 0', () => {
  const r = ratings();
  const res = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 10000, seed: 11, rules: RULES_OFF });
  const lgPts = league.ortg * league.pace / 100;
  assert.ok(Math.abs(res.home.mean - lgPts) < 1.5, `home ${res.home.mean} vs ${lgPts}`);
  assert.ok(Math.abs(res.away.mean - lgPts) < 1.5, `away ${res.away.mean}`);
  assert.ok(Math.abs(res.possessions.mean - league.pace) < 0.5, `poss ${res.possessions.mean}`);
});

test('rules off: simulation mean matches the analytic expectation (P4 check)', () => {
  const r = ratings({ league: { hca: 3, env: { ortgRatio: 1.01, paceRatio: 1.02 } } });
  r.players.h1 = { ...avgPlayer(), fg: league.fg.map(x => x + 0.06), att: league.attRate.map(a => a / 3.5) };
  r.teams.A.fgMult = [1.03, 1.0, 0.98, 1.02, 1.04];
  r.teams.H.tovMult = 1.1;
  const e = expectedGame(r, 'H', 'A', plan('h'), plan('a'));
  const s = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 20000, seed: 5, rules: RULES_OFF });
  assert.ok(Math.abs(s.margin.mean - e.margin) < 0.5, `margin sim ${s.margin.mean} analytic ${e.margin}`);
  assert.ok(Math.abs(s.total.mean - e.total) < 1.0, `total sim ${s.total.mean} analytic ${e.total}`);
});

test('latent shooting form and pace noise widen the distribution', () => {
  const r = ratings();
  const base = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 4000, seed: 2, rules: RULES_OFF });
  const lat = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 4000, seed: 2, rules: { ...RULES_OFF, latent: true }, latent: { shootSD: 0.06, paceSD: 0.04 } });
  assert.ok(lat.margin.sd > base.margin.sd + 0.5, `${lat.margin.sd} vs ${base.margin.sd}`);
  assert.ok(lat.total.sd > base.total.sd + 1, `${lat.total.sd} vs ${base.total.sd}`);
});

test('garbage time and clutch fouling change late-game scoring as designed', () => {
  const r = ratings();
  r.players.h1 = { ...avgPlayer(), fg: league.fg.map(x => Math.min(0.95, x + 0.25)) }; // lopsided matchup
  const p = { ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') };
  const on = simulateGame(p, { n: 4000, seed: 9, rules: { garbageTime: true, clutchFoul: true, overtime: true, latent: false } });
  const off = simulateGame(p, { n: 4000, seed: 9, rules: { garbageTime: false, clutchFoul: true, overtime: true, latent: false } });
  assert.ok(on.garbageTimeRate > 0.05);
  assert.ok(on.margin.mean < off.margin.mean); // bench units close the gap
  const clutch = simulateGame(p, { n: 4000, seed: 9, rules: { garbageTime: false, clutchFoul: true, overtime: true, latent: false } });
  const noClutch = simulateGame(p, { n: 4000, seed: 9, rules: { garbageTime: false, clutchFoul: false, overtime: true, latent: false } });
  assert.ok(clutch.clutchFoulRate > 0.05);
  assert.ok(clutch.possessions.mean > noClutch.possessions.mean);
});

test('play probability: absent players are replaced, minutes still 240', () => {
  const r = ratings();
  const hp = plan('h');
  hp.players[0].playProb = 0; // star out
  const res = simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: hp, awayPlan: plan('a') }, { n: 200, seed: 4, check: true });
  assert.equal(res.invariantFailures, 0);
  assert.equal(res.playerMeans.h1?.min ?? 0, 0);
});

test('performance: 10,000 games in under 2 seconds in Node', () => {
  const r = ratings();
  const t0 = performance.now();
  simulateGame({ ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') }, { n: 10000, seed: 1 });
  const ms = performance.now() - t0;
  assert.ok(ms < 2000, `${ms.toFixed(0)} ms`);
});

// P4 variance structure: shared game environment raises total spread; score effect relative to the
// expected lead lowers margin spread without moving the mean
test('shared game shooting factor widens totals more than margins', () => {
  const r = ratings();
  const p = { ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') };
  const off = simulateGame(p, { n: 6000, seed: 21, rules: { ...RULES_OFF, latent: true }, latent: { shootSD: 0, gameSD: 0, paceSD: 0, kappa: 0 } });
  const shared = simulateGame(p, { n: 6000, seed: 21, rules: { ...RULES_OFF, latent: true }, latent: { shootSD: 0, gameSD: 0.06, paceSD: 0, kappa: 0 } });
  assert.ok(shared.total.sd - off.total.sd > 2 * Math.abs(shared.margin.sd - off.margin.sd), `${shared.total.sd} ${off.total.sd} ${shared.margin.sd} ${off.margin.sd}`);
});

test('score effect relative to the expected lead: smaller margin spread, same mean', () => {
  const r = ratings({ league: { hca: 6 } });
  const p = { ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') };
  const a = simulateGame(p, { n: 20000, seed: 22, rules: { ...RULES_OFF, latent: true }, latent: { shootSD: 0, gameSD: 0, paceSD: 0, kappa: 0 } });
  const b = simulateGame(p, { n: 20000, seed: 22, rules: { ...RULES_OFF, latent: true }, latent: { shootSD: 0, gameSD: 0, paceSD: 0, kappa: 1.5 } });
  assert.ok(b.margin.sd < a.margin.sd - 1, `${b.margin.sd} vs ${a.margin.sd}`);
  assert.ok(Math.abs(b.margin.mean - a.margin.mean) < 0.3, `${b.margin.mean} vs ${a.margin.mean}`);
});

// the P3 ratings already contain late-game fouling and overtime; with the rules on, the regulation pace
// is scaled by regPace (calibrated on 2024-25) so that the simulated total does not count them twice
test('regPace scales the regulation possession count', () => {
  const r = ratings();
  const p = { ratings: r, home: 'H', away: 'A', homePlan: plan('h'), awayPlan: plan('a') };
  const lat = { shootSD: 0, gameSD: 0, paceSD: 0, kappa: 0 };
  const a = simulateGame(p, { n: 4000, seed: 31, rules: { ...RULES_OFF, latent: true }, latent: { ...lat, regPace: 1 } });
  const b = simulateGame(p, { n: 4000, seed: 31, rules: { ...RULES_OFF, latent: true }, latent: { ...lat, regPace: 0.98 } });
  assert.ok(Math.abs(b.possessions.mean / a.possessions.mean - 0.98) < 0.003, `${b.possessions.mean} / ${a.possessions.mean}`);
  assert.ok(Math.abs(b.total.mean / a.total.mean - 0.98) < 0.006, `${b.total.mean} / ${a.total.mean}`);
});
