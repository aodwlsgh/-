import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { extractGame, CHECK_LIMITS } from '../engine/extract.js';
import { toPossessions, pbpTotals } from '../engine/parse.js';

const load = name => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url))));

for (const [label, file, season] of [['2026-27', 'summary_401909834.json.gz', '2026-27'], ['2024-25', 'summary_401705129_2024-25.json.gz', '2024-25']]) {
  test(`extractGame (${label}): record is complete and self-consistent`, () => {
    const s = load(file);
    const g = extractGame(s);
    assert.equal(g.season, season);
    assert.equal(g.id, s.header.id);
    // points: players sum to the final score
    for (const [i, side] of ['home', 'away'].entries()) {
      const pts = g.players.filter(p => p.t === i).reduce((a, p) => a + p.pts, 0);
      assert.equal(pts, g.final[i], `${side} points`);
    }
    // shots: zone attempts + heave-like attempts = play-by-play FGA incl. heaves of every type
    const totals = pbpTotals(s);
    const ids = [g.home.id, g.away.id];
    for (const [i, id] of ids.entries()) {
      const zoneAtt = g.players.filter(p => p.t === i).reduce((a, p) => a + Object.values(p.z).reduce((x, [, att]) => x + att, 0) + p.hv, 0);
      const expected = totals[id].fga + (g.checks.heaveRule === 'excluded' ? totals[id].heaves : 0);
      assert.equal(zoneAtt, expected, 'zone attempts');
    }
    // P3 fields: position, DNP reason, shot log consistent with zone totals
    assert.ok(g.players.every(p => ['G', 'F', 'C', ''].includes(p.pos)));
    assert.ok(g.players.filter(p => p.dnp).every(p => typeof p.dnpr === 'string'));
    for (const [i] of ['home', 'away'].entries()) {
      const zoned = g.players.filter(p => p.t === i).reduce((a, p) => a + Object.values(p.z).reduce((x, [, att]) => x + att, 0), 0);
      assert.equal(g.shots.filter(x => x[2] === i && x[3] >= 0).length, zoned, 'shot log vs zones');
    }
    // possessions and stints carried through
    const poss = toPossessions(s).count;
    assert.deepEqual(g.checks.poss, ids.map(id => poss[id]));
    assert.equal(g.poss.filter(x => x[3] === 0).length, poss[g.home.id]);
    assert.ok(g.stints.length > 10 && g.stints.every(st => st[3].length === 5 && st[4].length === 5));
    // checks
    assert.equal(g.checks.pbpComplete, true);
    assert.equal(g.checks.fgaMatch, true);
    assert.equal(g.checks.teamMinutesOk, true);
    assert.ok(Math.abs(g.checks.errPct2) < CHECK_LIMITS.possMaxPct);
    assert.deepEqual(g.failed, []);
    // compact enough to commit
    assert.ok(gzipSync(JSON.stringify(g)).length < 20000, `gz ${gzipSync(JSON.stringify(g)).length}`);
  });
}

test('extractGame flags each failed check by name', () => {
  const s = load('summary_401909834.json.gz');
  s.header.competitions[0].competitors[0].score = '999'; // truncated feed
  const g = extractGame(s);
  assert.ok(g.failed.includes('pbp_incomplete'));
  assert.equal(g.excluded, true);
});
