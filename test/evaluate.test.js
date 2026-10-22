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
