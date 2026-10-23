import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyScenario, combine, simSummary, UNVERIFIED } from '../engine/scenario.js';
import { sensitivity } from '../engine/sensitivity.js';
import { chemistryFlag } from '../engine/auto-scenario.js';
import { simulateGame } from '../engine/sim.js';
import { MINUTES_PARAMS } from '../engine/minutes.js';

// toy league as in test/sim.test.js
const league = { fg: [0.65, 0.44, 0.42, 0.39, 0.355], attRate: [0.26, 0.175, 0.083, 0.098, 0.278], ftaRate: 0.218, ft: 0.78, tovRate: 0.136, pace: 99, ortg: 114.5, hca: 0, env: { ortgRatio: 1, paceRatio: 1 } };
const avgPlayer = () => ({ att: league.attRate.map(a => a / 5), fg: [...league.fg], fta: league.ftaRate / 5, ft: league.ft, tov: league.tovRate / 5, ast: 0.05, orbPct: 0.05, drbPct: 0.15 });
const neutral = () => ({ fgMult: [1, 1, 1, 1, 1], attMult: [1, 1, 1, 1, 1], tovMult: 1, ftaMult: 1, orbAllowMult: 1, pace: 99, ortg: 114.5, drtg: 114.5 });
const ids = pre => Array.from({ length: 9 }, (_, i) => `${pre}${i + 1}`);
const MIN = [36, 34, 33, 32, 30, 25, 20, 18, 12];
const plan = pre => ({ b2b: false, players: ids(pre).map((id, i) => ({ playerId: id, expMin: MIN[i], playProb: 1, starter: i < 5, pos: i % 3 === 2 ? 'C' : i % 3 ? 'F' : 'G' })) });
const input = () => {
  const players = Object.fromEntries([...ids('h'), ...ids('a')].map(id => [id, avgPlayer()]));
  players.h1 = { ...avgPlayer(), fg: league.fg.map(x => x + 0.06), att: league.attRate.map(a => a / 3.5) }; // home star
  return { ratings: { league, teams: { H: neutral(), A: neutral() }, players }, home: 'H', away: 'A', abbr: { home: 'HOU', away: 'DAL' }, homePlan: plan('h'), awayPlan: plan('a') };
};
const run = (inp, rules = {}, n = 6000) => simulateGame(inp, { n, seed: 3, rules: { garbageTime: false, clutchFoul: false, overtime: true, latent: true, ...rules } });
const sumMin = p => p.players.reduce((a, x) => a + x.expMin, 0);

test('the scenario works on copies: the input is never changed', () => {
  const inp = input();
  const before = JSON.stringify(inp);
  applyScenario(inp, { playerOut: ['h1'], shootingShift: [{ team: 'HOU', fg3: -0.02 }], paceShift: 2, minutesCap: { h2: 20 }, fatigue: [{ team: 'HOU', b2b: true }], chemistry: [{ team: 'DAL', ptsPer100: -1.5 }] });
  assert.equal(JSON.stringify(inp), before);
});

test('playerOut and playProb: the star out lowers the home margin; half way in between', () => {
  const base = run(input()), out = run(applyScenario(input(), { playerOut: ['h1'] })), half = run(applyScenario(input(), { playProb: { h1: 0.5 } }));
  assert.ok(out.margin.mean < base.margin.mean - 1, `${out.margin.mean} vs ${base.margin.mean}`);
  assert.ok(half.margin.mean < base.margin.mean && half.margin.mean > out.margin.mean);
  assert.equal(out.playerMeans.h1?.min ?? 0, 0);
});

test('minutesCap: capped, the excess goes to the same position, team minutes unchanged', () => {
  const s = applyScenario(input(), { minutesCap: { h1: 20 } });
  const h1 = s.homePlan.players.find(p => p.playerId === 'h1');
  assert.equal(h1.expMin, 20);
  assert.ok(Math.abs(sumMin(s.homePlan) - sumMin(input().homePlan)) < 1e-9);
  const sameG = s.homePlan.players.filter(p => p.pos === 'G' && p.playerId !== 'h1');
  const before = input().homePlan.players.filter(p => p.pos === 'G' && p.playerId !== 'h1');
  assert.ok(sameG.every((p, i) => p.expMin > before[i].expMin));
  assert.equal(simulateGame(s, { n: 300, seed: 1, check: true }).invariantFailures, 0);
});

test('shootingShift: home 3-point -2%p lowers home points', () => {
  const base = run(input()), s = run(applyScenario(input(), { shootingShift: [{ team: 'HOU', fg3: -0.02 }] }));
  assert.ok(s.home.mean < base.home.mean - 0.8, `${s.home.mean} vs ${base.home.mean}`);
  assert.ok(Math.abs(s.away.mean - base.away.mean) < 0.6);
});

test('paceShift: +2 possessions raises possessions by about 2 and the total', () => {
  const base = run(input()), s = run(applyScenario(input(), { paceShift: 2 }));
  assert.ok(Math.abs(s.possessions.mean - base.possessions.mean - 2) < 0.5, `${s.possessions.mean} vs ${base.possessions.mean}`);
  assert.ok(s.total.mean > base.total.mean + 2);
});

test('fatigue: back-to-back on moves the base cut (minutes model value) from starters to the bench; off reverses it exactly', () => {
  const on = applyScenario(input(), { fatigue: [{ team: 'HOU', b2b: true }] });
  const st = p => p.players.filter(x => x.starter).reduce((a, x) => a + x.expMin, 0);
  assert.ok(Math.abs(st(on.homePlan) - st(input().homePlan) * (1 - MINUTES_PARAMS.b2bStarterCut)) < 1e-9);
  assert.ok(Math.abs(sumMin(on.homePlan) - sumMin(input().homePlan)) < 1e-9);
  assert.equal(on.homePlan.b2b, true);
  assert.ok(on.notes.some(n => /approximation/.test(n)));
  const off = applyScenario(on, { fatigue: [{ team: 'HOU', b2b: false }] });
  input().homePlan.players.forEach((p, i) => assert.ok(Math.abs(off.homePlan.players[i].expMin - p.expMin) < 1e-9));
  // starters better than the bench (as in real teams): moving starter minutes to the bench costs the home side
  const strong = input();
  for (const id of ["h2", "h3", "h4", "h5"]) strong.ratings.players[id].fg = league.fg.map(x => x + 0.04);
  const b2b = applyScenario(strong, { fatigue: [{ team: "HOU", b2b: true }] });
  assert.ok(run(b2b, {}, 20000).margin.mean < run(strong, {}, 20000).margin.mean - 0.2);
});

test('chemistry: -1.5 points per 100 possessions lowers home points by about 1.5', () => {
  const base = run(input(), {}, 20000), s = run(applyScenario(input(), { chemistry: [{ team: 'HOU', ptsPer100: -1.5 }] }), {}, 20000);
  const d = s.home.mean - base.home.mean;
  assert.ok(d < -0.7 && d > -2.5, `${d}`);
});

test('rules: garbage time off widens a lopsided margin', () => {
  const inp = input();
  inp.ratings.players.h1.fg = league.fg.map(x => Math.min(0.95, x + 0.25));
  const on = simulateGame(applyScenario(inp, {}), { n: 4000, seed: 9, rules: { garbageTime: true, clutchFoul: false, overtime: true, latent: true } });
  const s = applyScenario(inp, { rules: { garbageTime: false } });
  const off = simulateGame(s, { n: 4000, seed: 9, rules: { clutchFoul: false, ...s.rules } });
  assert.ok(off.margin.mean > on.margin.mean);
});

test('unknown players and teams are noted, not fatal', () => {
  const s = applyScenario(input(), { playerOut: ['zz'], shootingShift: [{ team: 'XXX', fg3: 0.02 }] });
  assert.equal(s.notes.length, 2);
});

// §8.4 (2026-10-23 user condition 5): checked on the pre-calibration mean of the simulated margin distribution
test('ensemble combination, pre-calibration mean: shifted scenario mean = ensemble + (scenario - base) within 0.3', () => {
  const inp = input(), w = 0.6, baselineMargin = 1.5;
  const base = run(inp, {}, 8000), scen = run(applyScenario(inp, { playerOut: ['h1'] }), {}, 8000);
  const c = combine({ base, scenario: scen, baselineMargin, w });
  const histMean = s => s.marginHist.p.reduce((a, q, i) => a + q * (s.marginHist.lo + i), 0) + s.shift;
  const ensemble = w * base.margin.mean + (1 - w) * baselineMargin;
  assert.ok(Math.abs(histMean(c.base) - ensemble) < 0.3, `${histMean(c.base)} vs ${ensemble}`);
  assert.ok(Math.abs(histMean(c.scenario) - (ensemble + (scen.margin.mean - base.margin.mean))) < 0.3);
  assert.equal(c.scenario.shift, c.base.shift);
  assert.equal(c.label, UNVERIFIED);
});

test('simSummary: probabilities from simulated counts', () => {
  const s = simSummary(run(input(), {}, 1000));
  assert.ok(Math.abs(s.marginHist.p.reduce((a, b) => a + b, 0) - 1) < 1e-9);
  assert.equal(s.marginHist.lo, -60);
});

test('sensitivity: one variable at a time, common random numbers, Top 3 by margin and total, unverified', () => {
  const r = sensitivity(input(), { n: 600, seed: 2 });
  assert.equal(r.label, UNVERIFIED);
  assert.ok(r.variants.length >= 20);
  assert.equal(r.topMargin.length, 3);
  assert.equal(r.topTotal.length, 3);
  const sorted = [...r.variants].sort((a, b) => Math.abs(b.dMargin) - Math.abs(a.dMargin));
  assert.equal(r.topMargin[0].key, sorted[0].key);
  assert.ok(r.variants.some(v => v.key === 'out:h1'));
  assert.ok(r.variants.find(v => v.key === 'out:h1').dMargin < 0);
});

test('chemistry flag: off by default, unverified size, decays to 0 by game 15', () => {
  const f = chemistryFlag({ plan: plan('h'), newPlayerIds: ['h2', 'h7'], teamGame: 1, team: 'HOU' });
  assert.equal(f.flagged, true);
  assert.equal(f.applied, false);
  assert.equal(f.label, UNVERIFIED);
  assert.equal(f.suggested.chemistry[0].ptsPer100, -1.5);
  assert.equal(chemistryFlag({ plan: plan('h'), newPlayerIds: ['h2', 'h7'], teamGame: 15, team: 'HOU' }).suggested.chemistry[0].ptsPer100, 0);
  assert.equal(chemistryFlag({ plan: plan('h'), newPlayerIds: ['h9'], teamGame: 1, team: 'HOU' }).flagged, false); // h9 outside the top 8
});

import { newPlayers } from '../engine/auto-scenario.js';

test('new players: no previous-season games for this team', () => {
  const acc = { log: new Map([
    ['p1', [{ date: '2025-03-01', team: 'T' }]], // same team last season
    ['p2', [{ date: '2025-03-01', team: 'X' }]], // other team last season
    ['p3', [{ date: '2025-11-01', team: 'T' }]], // this season only
  ]) };
  const pl = { players: ['p1', 'p2', 'p3'].map(playerId => ({ playerId })) };
  assert.deepEqual(newPlayers(acc, 'T', '2025-11-20', pl), ['p2', 'p3']);
});
