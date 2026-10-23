// P9 live prediction: the steps for games not played yet reproduce the validated backtest variant B exactly
// (2024-25 example day 2025-02-12, stored in data/live/example-day.json from data/model/sims/2024-25-B.json.gz).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { loadGames } from '../jobs/lib/games.js';
import { livePlans, simulateRow, mergedInjuries, injuryDiff, PARALLEL_LABEL } from '../engine/live.js';
import { snapshotInjuries, jobGroup } from '../engine/snapshot.js';
import { resolveStatuses } from '../engine/injury.js';
import { etParts } from '../engine/time.js';

const DATE = '2025-02-12';
let example, live, P, LATENT, CAL;
before(async () => {
  example = JSON.parse(await readFile(new URL('../data/live/example-day.json', import.meta.url), 'utf8'));
  P = JSON.parse(await readFile(new URL('../data/model/params.json', import.meta.url), 'utf8'));
  LATENT = JSON.parse(await readFile(new URL('../data/model/latent.json', import.meta.url), 'utf8')).latent;
  CAL = JSON.parse(await readFile(new URL('../data/model/calibration.json', import.meta.url), 'utf8'));
  const pdf = JSON.parse(gunzipSync(await readFile(new URL(`../data/injury-pdf/2024-25/${DATE}.json.gz`, import.meta.url))));
  const games = await loadGames(['2023-24', '2024-25']);
  const day = games.filter(g => etParts(new Date(g.start)).date === DATE);
  // fixtures carry nothing a finished game would add: no score, no box score
  const fixtures = day.map(g => ({ id: g.id, start: g.start, season: g.season, home: g.home, away: g.away }));
  const history = games.filter(g => etParts(new Date(g.start)).date < DATE);
  const snapOf = f => (jobGroup(f.start) === 'B' ? pdf.runB : pdf.main);
  const injuriesFor = (f, side, players) => snapshotInjuries(snapOf(f), { team: side ? f.away.abbr : f.home.abbr, home: f.home.abbr, away: f.away.abbr, players });
  live = livePlans({ history, fixtures, date: DATE, params: P.params, injuriesFor });
});

test('every example-day game: the live plans equal the validated walk-forward plans', () => {
  assert.equal(live.rows.length, example.games.length);
  assert.deepEqual(live.skipped, []);
  for (const g of example.games) {
    const r = live.rows.find(x => x.fixture.id === g.gameId);
    assert.ok(r, g.gameId);
    assert.deepEqual(r.homePlan, g.simInput.homePlan, `${g.gameId} home`);
    assert.deepEqual(r.awayPlan, g.simInput.awayPlan, `${g.gameId} away`);
    for (const id of Object.keys(g.simInput.ratings.players)) assert.deepEqual(r.ratings.players[id], g.simInput.ratings.players[id]);
    assert.equal(r.group, g.group);
  }
});

test('live simulations equal the stored validated 2024-25 B simulations (10,000 runs, two games)', () => {
  for (const g of example.games.slice(0, 2)) {
    const r = live.rows.find(x => x.fixture.id === g.gameId);
    const { sim } = simulateRow(r, { n: 10000, latent: LATENT, w: CAL.ensemble.w });
    assert.equal(sim.margin, g.prediction.sim.margin);
    assert.equal(sim.total, g.prediction.sim.total);
    assert.equal(sim.marginSD, g.prediction.sim.marginSD);
    assert.deepEqual(sim.marginHist, g.prediction.sim.marginHist);
    assert.equal(+sim.shift.toFixed(9), +g.prediction.sim.shift.toFixed(9));
  }
});

test('design §6.5 merge for the parallel record: ESPN Out wins, ESPN-only Day-To-Day 0.55, matched by ESPN id then name', () => {
  const espn = [
    { espnId: '1', name: 'Alpha One', team: 'hornets', status: 'Out' },
    { espnId: '99', name: 'Beta Two', team: 'hornets', status: 'Day-To-Day' },
    { espnId: '3', name: 'Gamma Three', team: 'magic', status: 'Out' },
  ];
  const pdf = { rows: [{ matchup: 'CHA@ORL', team: 'Charlotte Hornets', player: 'Two, Beta', status: 'Questionable' }, { matchup: 'CHA@ORL', team: 'Charlotte Hornets', player: 'Four, Delta', status: 'Out' }] };
  const resolved = resolveStatuses({ espn, pdf });
  const players = [{ id: '1', name: 'Alpha One' }, { id: '2', name: 'Beta Two' }, { id: '4', name: 'Delta Four' }];
  const m = mergedInjuries(resolved, { team: 'CHA', players });
  assert.deepEqual(m.injuries, { 1: 0, 2: 0.53, 4: 0 });
  assert.deepEqual(m.unmatched, []);
  const names = new Map(players.map(p => [p.id, p.name]));
  assert.deepEqual(injuryDiff({ 2: 0.53, 4: 0 }, m.injuries, names), [{ id: '1', name: 'Alpha One', pdf: null, merged: 0 }]);
  assert.deepEqual(injuryDiff(m.injuries, m.injuries, names), []);
  assert.match(PARALLEL_LABEL, /픽·EV 미사용/);
});
