import { test } from 'node:test';
import assert from 'node:assert/strict';
import { expectedGame, baselineGame, winProb, normCdf } from '../engine/predict.js';

const league = { fg: [0.65, 0.42, 0.42, 0.38, 0.36], attRate: [0.28, 0.17, 0.08, 0.1, 0.27], ftaRate: 0.25, ft: 0.78, tovRate: 0.13, pace: 99, ortg: 114, hca: 2 };
const player = (o = {}) => ({ att: league.attRate.map(a => a / 5), fg: [...league.fg], fta: league.ftaRate / 5, ft: league.ft, tov: league.tovRate / 5, ast: 0.05, orbPct: 0.05, drbPct: 0.15, ...o });
const neutralTeam = (o = {}) => ({ fgMult: [1, 1, 1, 1, 1], attMult: [1, 1, 1, 1, 1], tovMult: 1, ftaMult: 1, orbAllowMult: 1, pace: 99, ortg: 114, drtg: 114, ...o });
const ratings = (o = {}) => ({ league: { ...league, ...o.league }, teams: { H: neutralTeam(o.H), A: neutralTeam(o.A) }, players: o.players ?? Object.fromEntries(['h1', 'h2', 'h3', 'h4', 'h5', 'a1', 'a2', 'a3', 'a4', 'a5'].map(id => [id, player()])) });
const plan = pre => ({ players: [1, 2, 3, 4, 5].map(i => ({ playerId: `${pre}${i}`, expMin: 48, playProb: 1 })) });

test('identical teams without home advantage: margin 0', () => {
  const g = expectedGame(ratings({ league: { hca: 0 } }), 'H', 'A', plan('h'), plan('a'));
  assert.ok(Math.abs(g.margin) < 1e-9);
  assert.ok(g.total > 180 && g.total < 260, `total ${g.total}`);
});

test('home advantage adds hca per 100 possessions to the margin', () => {
  const g = expectedGame(ratings({ league: { hca: 3 } }), 'H', 'A', plan('h'), plan('a'));
  assert.ok(Math.abs(g.margin - 3 * g.possessions / 100) < 1e-9);
});

test('better shooters and a weak opposing defence raise expected points', () => {
  const r = ratings({ league: { hca: 0 } });
  r.players.h1 = player({ fg: league.fg.map(x => x + 0.08) });
  assert.ok(expectedGame(r, 'H', 'A', plan('h'), plan('a')).margin > 0.5);
  const r2 = ratings({ league: { hca: 0 }, A: { fgMult: [1.05, 1.05, 1.05, 1.05, 1.05] } });
  assert.ok(expectedGame(r2, 'H', 'A', plan('h'), plan('a')).margin > 0.5);
});

test('faster teams play more possessions', () => {
  const slow = expectedGame(ratings(), 'H', 'A', plan('h'), plan('a'));
  const fast = expectedGame(ratings({ H: { pace: 104 }, A: { pace: 104 } }), 'H', 'A', plan('h'), plan('a'));
  assert.ok(fast.possessions > slow.possessions + 5);
});

test('players without ratings fall back to league-average rates', () => {
  const r = ratings({ league: { hca: 0 } });
  delete r.players.h1;
  assert.ok(Math.abs(expectedGame(r, 'H', 'A', plan('h'), plan('a')).margin) < 1e-9);
});

test('baseline: team net ratings plus home advantage', () => {
  const r = ratings({ league: { hca: 2 }, H: { ortg: 118, drtg: 110 } });
  const b = baselineGame(r, 'H', 'A');
  // home ppp (118+114-114) vs away (114+110-114), +/- hca/2
  const poss = 99;
  assert.ok(Math.abs(b.margin - poss * ((118 - 110) + 2) / 100) < 1e-9);
});

test('win probability from margin and sigma', () => {
  assert.ok(Math.abs(normCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normCdf(1.96) - 0.975) < 1e-3);
  assert.ok(Math.abs(winProb(5, 12) - normCdf(5 / 12)) < 1e-12);
});

// a lineup must still end its possessions: low-usage players do not lower the shot volume
test('usage is normalised to the league team usage per possession', () => {
  const r = ratings({ league: { hca: 0 } });
  const shy = player({ att: league.attRate.map(a => a / 10), fta: league.ftaRate / 10, tov: league.tovRate / 10 });
  r.players.h1 = shy; r.players.h2 = shy; // same accuracy, half the volume
  const g = expectedGame(r, 'H', 'A', plan('h'), plan('a'));
  assert.ok(Math.abs(g.margin) < 1e-9, `margin ${g.margin}`);
});
