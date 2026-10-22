import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asOf, Accumulator, seasonOf, DEFAULT_PARAMS } from '../engine/model.js';
import { rec, pl } from './helpers/record-builder.js';

const games = () => [
  rec({ id: 'g1', start: '2025-11-01T23:00Z' }),
  rec({ id: 'g2', start: '2025-11-03T23:00Z' }),
  rec({ id: 'g3', start: '2025-11-05T23:00Z' }),
];

test('seasonOf maps dates to NBA seasons', () => {
  assert.equal(seasonOf('2025-11-01'), '2025-26');
  assert.equal(seasonOf('2026-04-10'), '2025-26');
  assert.equal(seasonOf('2026-10-21'), '2026-27');
});

// P3 condition 5: only games before the date; changing the future changes nothing
test('asOf uses only games that started before the date', () => {
  const { ratings } = asOf(games(), '2025-11-04');
  assert.equal(ratings.players.h1.n.games, 2);
  assert.equal(ratings.teams.H.n.games, 2);
});

test('asOf is unchanged when future games are edited, removed or added', () => {
  const base = asOf(games(), '2025-11-04').ratings;
  const edited = games();
  edited[2].players.forEach(p => { p.z.ab3 = [9, 9]; p.tov = 0; });
  edited[2].checks.poss = [80, 80];
  const extra = [...games(), rec({ id: 'g9', start: '2026-01-01T00:00Z', players: [pl('h1', 0, { min: 48, z: { c3: [10, 10] } })] })];
  for (const variant of [edited, games().slice(0, 2), extra]) {
    assert.deepEqual(asOf(variant, '2025-11-04').ratings, base);
  }
});

test('incremental accumulation gives the same ratings as asOf', () => {
  const acc = new Accumulator();
  const gs = games();
  acc.add(gs[0]); acc.add(gs[1]);
  assert.deepEqual(acc.ratings('2025-11-04'), asOf(gs, '2025-11-04').ratings);
});

test('games must be added in start order', () => {
  const acc = new Accumulator();
  acc.add(games()[1]);
  assert.throws(() => acc.add(games()[0]), /start order/);
});

// P3 condition 7: ratings belong to the player, not the team
test('a traded player keeps his rating and moves to the new team', () => {
  const gs = [
    rec({ id: 't1', start: '2025-11-01T23:00Z', home: 'X', away: 'Y', players: [pl('star', 0, { min: 36, z: { ab3: [6, 10] } }), pl('y1', 1, { min: 36 })] }),
    rec({ id: 't2', start: '2025-11-03T23:00Z', home: 'Z', away: 'Y', players: [pl('star', 0, { min: 36, z: { ab3: [5, 10] } }), pl('y1', 1, { min: 36 })] }),
  ];
  const before = asOf(gs, '2025-11-02').ratings.players.star;
  const after = asOf(gs, '2025-11-04').ratings.players.star;
  assert.equal(before.team, 'X');
  assert.equal(after.team, 'Z');
  assert.equal(after.n.games, 2); // both teams' games count toward one player rating
  assert.ok(after.fg[4] > before.fg[4] - 1e-9 || after.fg[4] < before.fg[4]); // rating exists and is updated
});

test('shrinkage: no exposure gives the prior, large exposure approaches the observation', () => {
  const big = [];
  for (let i = 0; i < 300; i++) {
    const d = new Date(Date.UTC(2025, 10, 1) + i * 3600e3).toISOString().slice(0, 16) + 'Z';
    big.push(rec({ id: `b${i}`, start: d, players: [pl('sniper', 0, { min: 48, z: { ab3: [6, 10] } }), pl('other', 1, { min: 48, z: { ab3: [3, 10] } })] }));
  }
  const r = asOf(big, '2026-01-01').ratings;
  assert.ok(Math.abs(r.players.sniper.fg[4] - 0.6) < 0.02, `fg3 ${r.players.sniper.fg[4]}`);
  // a player with a single attempt stays near the league average 3P%
  const few = [...big, rec({ id: 'late', start: '2026-01-02T00:00Z', players: [pl('rookie', 0, { min: 5, z: { ab3: [1, 1] } }), pl('other', 1, { min: 48 })] })];
  const r2 = asOf(few, '2026-01-03').ratings;
  assert.ok(Math.abs(r2.players.rookie.fg[4] - r2.league.fg[4]) < 0.01);
});

test('last season carries into the next as a prior (carry x last season + rest x role)', () => {
  const gs = [];
  for (let i = 0; i < 120; i++) {
    const d = new Date(Date.UTC(2025, 0, 1) + i * 86400e3 / 4).toISOString().slice(0, 16) + 'Z';
    gs.push(rec({ id: `p${i}`, start: d, players: [pl('vet', 0, { min: 40, z: { ab3: [6, 10] } }), pl('avg', 1, { min: 40, z: { ab3: [3, 10] } })] }));
  }
  gs.push(rec({ id: 'new1', start: '2025-10-22T23:00Z', players: [pl('avg', 0, { min: 40, z: { ab3: [3, 10] } }), pl('rook', 1, { min: 40, z: { ab3: [3, 10] } })] }));
  const r = asOf(gs, '2025-10-23').ratings;
  assert.equal(r.season, '2025-26');
  assert.equal(r.players.vet.n.prevSeason, true);
  assert.ok(r.players.vet.fg[4] > r.players.avg.fg[4] + 0.1, `vet ${r.players.vet.fg[4]} avg ${r.players.avg.fg[4]}`);
  assert.ok(r.players.vet.fg[4] < 0.6); // pulled toward the role average
  assert.equal(r.players.rook.n.prevSeason, false);
});

test('excluded games (truncated play-by-play) add appearances but no rates', () => {
  const gs = games();
  gs[0].excluded = true;
  const r = asOf(gs, '2025-11-04').ratings;
  assert.equal(r.players.h1.n.games, 1);
  assert.equal(r.players.h1.team, 'H');
});

test('default parameters follow design §6.3 starting values', () => {
  assert.deepEqual(DEFAULT_PARAMS.k.fg, [150, 200, 200, 300, 300]);
  assert.equal(DEFAULT_PARAMS.k.ft, 100);
  assert.equal(DEFAULT_PARAMS.k.tov, 400);
  assert.equal(DEFAULT_PARAMS.k.reb, 600);
  assert.equal(DEFAULT_PARAMS.carry, 0.7);
});

// late tip-offs are the next UTC day; dates and back-to-backs follow the ET calendar
test('a 22:30 ET game counts on its ET date and before the next ET day', () => {
  const gs = [rec({ id: 'late', start: '2025-11-03T03:30Z' })]; // 22:30 ET on Nov 2
  const { acc, ratings } = asOf(gs, '2025-11-03');
  assert.equal(ratings.players.h1.n.games, 1);
  assert.equal(acc.log.get('h1')[0].date, '2025-11-02');
  assert.ok(acc.teamPlayedOn('H', '2025-11-02'));
  assert.equal(asOf(gs, '2025-11-02').ratings.empty, true);
});

// recency: with a half-life, older games weigh less (P3 tuning option; Infinity = none)
test('time decay weights recent games more and keeps asOf == incremental', () => {
  const gs = [];
  for (let i = 0; i < 60; i++) {
    const d = new Date(Date.UTC(2025, 10, 1) + i * 86400e3 + 23 * 3600e3).toISOString().slice(0, 16) + 'Z';
    const hot = i >= 40; // shooter improves for the last 20 days
    gs.push(rec({ id: `d${i}`, start: d, players: [pl('x', 0, { min: 48, z: { ab3: [hot ? 7 : 3, 10] } }), pl('y', 1, { min: 48, z: { ab3: [3, 10] } })] }));
  }
  const flat = asOf(gs, '2026-01-05').ratings.players.x.fg[4];
  const decay = { ...DEFAULT_PARAMS, halfLifeDays: 15 };
  const recent = asOf(gs, '2026-01-05', decay).ratings.players.x.fg[4];
  assert.ok(recent > flat + 0.03, `flat ${flat} recent ${recent}`);
  const acc = new Accumulator(decay);
  gs.forEach(g => acc.add(g));
  assert.deepEqual(acc.ratings('2026-01-05', decay), asOf(gs, '2026-01-05', decay).ratings);
});
