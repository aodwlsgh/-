import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walkForward, metrics, fitSigma } from '../engine/evaluate.js';
import { asOf, DEFAULT_PARAMS } from '../engine/model.js';
import { projectMinutes } from '../engine/minutes.js';
import { expectedGame } from '../engine/predict.js';
import { rec, pl } from './helpers/record-builder.js';
import { etParts } from '../engine/time.js';

function league(n) {
  const teams = ['T0', 'T1', 'T2', 'T3'];
  const gs = [];
  for (let i = 0; i < n; i++) {
    const h = teams[i % 4], a = teams[(i + 1 + Math.floor(i / 4)) % 4 === i % 4 ? (i + 2) % 4 : (i + 1 + Math.floor(i / 4)) % 4];
    const start = new Date(Date.UTC(2025, 9, 25) + i * 86400e3 / 2 + 23 * 3600e3).toISOString().slice(0, 16) + 'Z';
    const skill = t => +t.slice(1);
    const players = [
      ...[1, 2, 3, 4, 5].map(k => pl(`${h}p${k}`, 0, { min: 48, z: { ra: [4 + skill(h), 9], ab3: [3, 8] }, fta: 4, ftm: 3, tov: 3, drb: 6 })),
      ...[1, 2, 3, 4, 5].map(k => pl(`${a}p${k}`, 1, { min: 48, z: { ra: [4 + skill(a), 9], ab3: [3, 8] }, fta: 4, ftm: 3, tov: 3, drb: 6 })),
    ];
    gs.push(rec({ id: `w${i}`, start, home: h, away: a, players }));
  }
  return gs;
}

test('walk-forward predictions use only earlier games (equal to asOf on the game date)', () => {
  const gs = league(40);
  const rows = walkForward({ games: gs, target: { season: '2025-26', from: '2025-11-01' }, params: DEFAULT_PARAMS });
  assert.ok(rows.length > 20);
  for (const r of rows.slice(-5)) {
    const g = gs.find(x => x.id === r.id);
    const d = etParts(new Date(g.start)).date;
    const { acc, ratings } = asOf(gs, d);
    const parts = t => g.players.filter(p => p.t === t && !p.dnp).map(p => p.id);
    const e = expectedGame(ratings, g.home.id, g.away.id, projectMinutes(acc, g.home.id, d, { participants: parts(0) }), projectMinutes(acc, g.away.id, d, { participants: parts(1) }));
    assert.ok(Math.abs(e.margin - r.model.margin) < 1e-9);
  }
});

test('changing a game result does not change its own prediction', () => {
  const gs = league(40);
  const before = walkForward({ games: gs, target: { season: '2025-26', from: '2025-11-01' }, params: DEFAULT_PARAMS });
  const last = gs.at(-1);
  last.players.forEach(p => { p.z.ra = [9, 9]; p.pts = 30; });
  last.final = [150, 150];
  const after = walkForward({ games: gs, target: { season: '2025-26', from: '2025-11-01' }, params: DEFAULT_PARAMS });
  assert.equal(after.at(-1).model.margin, before.at(-1).model.margin);
  assert.notEqual(after.at(-1).actual.total, before.at(-1).actual.total);
});

test('metrics: MAE, Brier and per-month split', () => {
  const rows = [
    { month: '2025-11', actual: { margin: 10, total: 220, homeWin: 1 }, model: { margin: 5, total: 210 }, base: { margin: 0, total: 230 } },
    { month: '2025-12', actual: { margin: -4, total: 200, homeWin: 0 }, model: { margin: -2, total: 205 }, base: { margin: 3, total: 225 } },
  ];
  const m = metrics(rows, { model: 12, base: 12 });
  assert.equal(m.all.n, 2);
  assert.equal(m.all.model.marginMAE, 3.5);
  assert.equal(m.all.base.totalMAE, 17.5);
  assert.ok(m.all.model.brier < m.all.base.brier);
  assert.deepEqual(Object.keys(m.byMonth), ['2025-11', '2025-12']);
  assert.ok(Math.abs(fitSigma(rows, 'model') - Math.sqrt((25 + 4) / 2)) < 1e-12);
});

// variant B (design §14.2): roster from history, play probabilities from the pre-game injury snapshot,
// never the actual participants
test('variant B: snapshot play probabilities, not the actual participants', () => {
  const gs = league(40);
  const last = gs.at(-1);
  const sat = last.players.find(p => p.t === 0); // played in reality, listed Out in the snapshot
  const seen = [];
  const injuriesFor = (g, side, players) => {
    seen.push({ id: g.id, side, n: players.length, named: players.every(p => p.name) });
    return g.id === last.id && side === 0 ? { injuries: { [sat.id]: 0 }, rows: 1, unmatched: [] } : { injuries: {}, rows: 0, unmatched: [] };
  };
  const target = { season: '2025-26', from: last.start.slice(0, 10), to: last.start.slice(0, 10) };
  let plan = null;
  const rowsB = walkForward({ games: gs, target, variant: 'B', injuriesFor, onGame: ({ homePlan, game }) => { if (game.id === last.id) plan = homePlan; return {}; } });
  const rowsA = walkForward({ games: gs, target });
  const rb = rowsB.find(r => r.id === last.id), ra = rowsA.find(r => r.id === last.id);
  assert.equal(plan.players.find(p => p.playerId === sat.id).playProb, 0);
  assert.equal(plan.players.find(p => p.playerId === sat.id).expMin, 0);
  assert.notEqual(rb.model.margin, ra.model.margin);
  assert.equal(rb.variant, 'B');
  assert.deepEqual(rb.snapshot.home, { rows: 1, unmatched: [], top3Absent: 1 });
  assert.equal(rb.snapshot.away.top3Absent, 0);
  assert.ok(seen.every(s => s.n >= 5 && s.named));
});

test('variant B: a player listed non-Out who dropped off the recent roster (long absence) is added to the plan', () => {
  const gs = league(60);
  const back = 'T0p5';
  // T0p5 misses every game from the 10th on (long injury); T0 plays with four
  gs.forEach((g, i) => { if (i >= 10) g.players = g.players.filter(p => p.id !== back); });
  const last = gs.filter(g => g.home.id === 'T0').at(-1);
  let plan = null;
  const injuriesFor = (g, side, players) => {
    const inj = {};
    if (g.id === last.id && side === 0) { assert.ok(players.some(p => p.id === back), 'candidate list includes the absent player'); inj[back] = 0.55; }
    return { injuries: inj, rows: 0, unmatched: [] };
  };
  walkForward({ games: gs, target: { season: '2025-26', from: last.start.slice(0, 10), to: last.start.slice(0, 10) }, variant: 'B', injuriesFor, onGame: ({ homePlan, game }) => { if (game.id === last.id) plan = homePlan; return {}; } });
  const p = plan.players.find(x => x.playerId === back);
  assert.ok(p, 'returning player in the plan');
  assert.equal(p.playProb, 0.55);
  assert.ok(p.expMin > 0);
});
