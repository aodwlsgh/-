import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Accumulator } from '../engine/model.js';
import { roster, projectMinutes, MINUTES_PARAMS } from '../engine/minutes.js';
import { rec, pl } from './helpers/record-builder.js';

const day = i => new Date(Date.UTC(2025, 10, 1) + i * 86400e3).toISOString().slice(0, 10);
// team H: starters s1..s5 (G,G,F,F,C), bench b1..b3; opponent A filler
function season(n, { mins = {}, rest = {}, b2bDays = [] } = {}) {
  const acc = new Accumulator();
  for (let i = 0; i < n; i++) {
    const hPlayers = [
      ['s1', 'G', 34], ['s2', 'G', 32], ['s3', 'F', 33], ['s4', 'F', 30], ['s5', 'C', 31], ['b1', 'G', 25], ['b2', 'F', 30], ['b3', 'C', 25],
    ].map(([id, pos, m]) => (rest[id]?.includes(i) ? { ...pl(id, 0, { pos, min: 0, dnp: 1 }), dnpr: 'REST' } : pl(id, 0, { pos, min: mins[id]?.[i] ?? m, st: id.startsWith('s') ? 1 : 0 })));
    const aPlayers = ['a1', 'a2', 'a3', 'a4', 'a5'].map(id => pl(id, 1, { min: 48 }));
    acc.add(rec({ id: `g${i}`, start: `${day(i * 2 - (b2bDays.includes(i) ? 1 : 0))}T23:00Z`, players: [...hPlayers, ...aPlayers] }));
  }
  return acc;
}

test('roster: latest team of each player, recent appearances only', () => {
  const acc = season(5);
  assert.deepEqual(roster(acc, 'H', day(20)).sort(), ['b1', 'b2', 'b3', 's1', 's2', 's3', 's4', 's5']);
});

test('expected minutes: EWMA (half-life 5) of the last 15 appearances, scaled to 240', () => {
  const plan = projectMinutes(season(20), 'H', day(50));
  const total = plan.players.reduce((a, p) => a + p.expMin * p.playProb, 0);
  assert.ok(Math.abs(total - 240) < 1e-6);
  assert.equal(MINUTES_PARAMS.halfLife, 5);
  assert.equal(MINUTES_PARAMS.window, 15);
});

test('recent games weigh more than old ones', () => {
  const mins = { b1: Array.from({ length: 20 }, (_, i) => (i < 15 ? 10 : 30)) };
  const plan = projectMinutes(season(20, { mins }), 'H', day(50));
  const b1 = plan.players.find(p => p.playerId === 'b1').expMin;
  const s1 = plan.players.find(p => p.playerId === 's1').expMin;
  assert.ok(b1 > 18 && b1 < s1, `b1 ${b1}`);
});

test('an absent player\'s minutes go to the same position group first', () => {
  const full = projectMinutes(season(20), 'H', day(50));
  const noC = projectMinutes(season(20), 'H', day(50), { injuries: { s5: 0 } });
  const get = (pl, id) => pl.players.find(p => p.playerId === id);
  assert.equal(get(noC, 's5').playProb, 0);
  const gainC = get(noC, 'b3').expMin - get(full, 'b3').expMin;
  const gainG = get(noC, 'b1').expMin - get(full, 'b1').expMin;
  assert.ok(gainC > 10, `backup C gains ${gainC}`);
  assert.ok(gainC > 3 * gainG);
  assert.ok(Math.abs(noC.players.reduce((a, p) => a + p.expMin * p.playProb, 0) - 240) < 1e-6);
});

test('participants mode (backtest A): only listed players, renormalised to 240', () => {
  const plan = projectMinutes(season(20), 'H', day(50), { participants: ['s1', 's2', 's3', 's4', 's5', 'b1', 'b2', 'new'] });
  assert.equal(plan.players.filter(p => p.playProb > 0).length, 8);
  assert.equal(plan.players.find(p => p.playerId === 'b3').playProb, 0); // on the roster, did not play
  assert.ok(plan.players.find(p => p.playerId === 'new').expMin > 0); // debut player gets default minutes
  assert.ok(Math.abs(plan.players.reduce((a, p) => a + p.expMin, 0) - 240) < 1e-6);
});

test('back-to-back second night: starters lose 8% before renormalising', () => {
  const acc = season(10);
  const normal = projectMinutes(acc, 'H', day(30));
  const b2b = projectMinutes(acc, 'H', day(19)); // last game was day 18
  assert.equal(b2b.b2b, true);
  assert.equal(normal.b2b, false);
  const s = id => b2b.players.find(p => p.playerId === id).expMin / normal.players.find(p => p.playerId === id).expMin;
  // 0.92 cut, then renormalised to 240: starters end near 0.97, bench rises
  assert.ok(s('s1') < 0.98 && s('b1') > 1.03, `${s('s1')} ${s('b1')}`);
});

test('players with a rest history on back-to-backs get a rest probability', () => {
  const acc = season(12, { b2bDays: [3, 6, 9], rest: { s1: [3, 6] } });
  const plan = projectMinutes(acc, 'H', day(23)); // game 11 on day 22 -> day 23 is a back-to-back
  assert.equal(plan.b2b, true);
  const s1 = plan.players.find(p => p.playerId === 's1');
  const s2 = plan.players.find(p => p.playerId === 's2');
  assert.ok(s1.playProb < 0.8, `s1 ${s1.playProb}`);
  assert.equal(s2.playProb, 1);
});
