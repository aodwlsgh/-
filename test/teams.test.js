import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEAMS, byEspn, byNba, byKey } from '../engine/teams.js';
import { NBA_TEAMS } from '../engine/schedule.js';
import { teamKey } from '../engine/injury.js';

test('30 teams; every ESPN abbreviation of the schedule maps to one NBA abbreviation and nickname key', () => {
  assert.equal(TEAMS.length, 30);
  assert.deepEqual(TEAMS.map(t => t.espn).sort(), [...NBA_TEAMS].sort());
  assert.equal(new Set(TEAMS.map(t => t.nba)).size, 30);
  assert.equal(new Set(TEAMS.map(t => t.key)).size, 30);
  for (const t of TEAMS) assert.equal(teamKey(t.name), t.key, t.name);
});

test('abbreviations that differ between ESPN and the NBA injury PDF', () => {
  assert.equal(byEspn('GS').nba, 'GSW');
  assert.equal(byEspn('NY').nba, 'NYK');
  assert.equal(byEspn('NO').nba, 'NOP');
  assert.equal(byEspn('SA').nba, 'SAS');
  assert.equal(byEspn('UTAH').nba, 'UTA');
  assert.equal(byEspn('WSH').nba, 'WAS');
  assert.equal(byNba('PHX').espn, 'PHX');
  assert.equal(byKey('blazers').espn, 'POR');
  assert.equal(byEspn('XXX'), undefined);
});
