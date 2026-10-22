// ESPN response schema checks. Real fixtures must pass; any drift must fail loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import {
  checkScoreboard, checkSummary, checkSummaryQuality, checkInjuries, assertValid, SchemaError,
} from '../engine/schema/espn.js';

const load = name => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url))));
const fresh = {
  scoreboard: () => load('scoreboard_20261021.json.gz'),
  summary: () => load('summary_401909834.json.gz'),
  injuries: () => load('injuries_20261022.json.gz'),
};

test('real fixtures pass', () => {
  assert.deepEqual(checkScoreboard(fresh.scoreboard()), []);
  assert.deepEqual(checkSummary(fresh.summary()), []);
  assert.deepEqual(checkInjuries(fresh.injuries()), []);
});

test('assertValid throws SchemaError listing every problem', () => {
  const s = fresh.summary();
  delete s.plays;
  delete s.boxscore.players;
  assert.throws(() => assertValid('summary', s), err => {
    assert.ok(err instanceof SchemaError);
    assert.match(err.message, /plays/);
    assert.match(err.message, /boxscore\.players/);
    return true;
  });
});

test('assertValid rejects an unknown kind instead of passing', () => {
  assert.throws(() => assertValid('nope', {}), SchemaError);
});

// each mutation models a plausible upstream format change
const summaryDrift = {
  'stat labels reordered': s => { s.boxscore.players[0].statistics[0].labels.reverse(); },
  'MIN label renamed': s => { const l = s.boxscore.players[0].statistics[0].labels; l[l.indexOf('MIN')] = 'MINS'; },
  'team stat missing': s => { s.boxscore.teams[0].statistics = s.boxscore.teams[0].statistics.filter(x => x.name !== 'totalTurnovers'); },
  'made-attempted no longer "m-a"': s => { s.boxscore.teams[0].statistics.find(x => x.name === 'fieldGoalsMade-fieldGoalsAttempted').displayValue = '46/86'; },
  'athlete id became a number': s => { s.boxscore.players[0].statistics[0].athletes[0].athlete.id = 123; },
  'starter flag dropped': s => { delete s.boxscore.players[0].statistics[0].athletes[0].starter; },
  'clock format changed': s => { s.plays[5].clock.displayValue = 'PT11M45.00S'; },
  'period no longer an object': s => { s.plays[5].period = 1; },
  'coordinate dropped from a shot': s => { delete s.plays.find(p => p.shootingPlay && !/Free Throw/.test(p.type.text)).coordinate; },
  'shot coordinate out of court': s => { s.plays.find(p => p.shootingPlay && !/Free Throw/.test(p.type.text)).coordinate = { x: 400, y: 12 }; },
  'pointsAttempted missing on shot': s => { delete s.plays.find(p => p.shootingPlay).pointsAttempted; },
  'unknown play type id': s => { s.plays[5].type = { id: '99999', text: 'Hyper Dunk' }; },
  'known id with new text': s => { const p = s.plays.find(q => q.type.text === 'Substitution'); p.type.text = 'Sub'; },
  'substitution text changed': s => { s.plays.find(p => p.type.text === 'Substitution').text = 'X replaces Y'; },
  'substitution without participants': s => { delete s.plays.find(p => p.type.text === 'Substitution').participants; },
  'header competitors missing homeAway': s => { delete s.header.competitions[0].competitors[0].homeAway; },
  'only one team in boxscore': s => { s.boxscore.players.pop(); },
};
for (const [name, mutate] of Object.entries(summaryDrift)) {
  test(`summary drift fails: ${name}`, () => {
    const s = fresh.summary();
    mutate(s);
    assert.ok(checkSummary(s).length > 0, `expected an error for "${name}"`);
  });
}

const scoreboardDrift = {
  'events not an array': s => { s.events = {}; },
  'season slug missing': s => { delete s.events[0].season.slug; },
  'status name missing': s => { delete s.events[0].competitions[0].status.type.name; },
  'event date not ISO': s => { s.events[0].date = '10/21/2026'; },
  'competitor abbreviation missing': s => { delete s.events[0].competitions[0].competitors[0].team.abbreviation; },
};
for (const [name, mutate] of Object.entries(scoreboardDrift)) {
  test(`scoreboard drift fails: ${name}`, () => {
    const s = fresh.scoreboard();
    mutate(s);
    assert.ok(checkScoreboard(s).length > 0, `expected an error for "${name}"`);
  });
}

// 2023-24: "Grant Williams enters the game for" (leaving player's name missing) is a data defect, not a format change
test('substitution with the leaving name missing is a quality issue, not a schema error', () => {
  const s = fresh.summary();
  const sub = s.plays.find(p => p.type.text === 'Substitution');
  sub.text = sub.text.replace(/ enters the game for .*$/, ' enters the game for');
  sub.participants = sub.participants.slice(0, 1);
  assert.deepEqual(checkSummary(s), []);
  assert.ok(checkSummaryQuality(s).some(x => /substitution with 1 participant/.test(x)));
});

test('clean fixture has no quality issues', () => {
  assert.deepEqual(checkSummaryQuality(fresh.summary()), []);
});

// defects seen in real ESPN games (2026-01-21 LAC@CHI, 2026-10-21 MIN@MIA):
// format stays valid, but each defect is reported, never dropped
test('known data defects are reported as quality issues, not schema errors', () => {
  const s = fresh.summary();
  const sub = s.plays.find(p => p.type.text === 'Substitution');
  sub.participants = sub.participants.slice(1);
  sub.text = sub.text.replace(/^.* enters/, 'enters');
  s.boxscore.teams[0].statistics.find(x => x.name === 'teamTurnovers').displayValue = '-16';
  s.boxscore.teams[1].statistics.find(x => x.name === 'totalTurnovers').displayValue = '0';
  delete s.boxscore.players[1].statistics[0].athletes.at(-1).athlete.id;
  assert.deepEqual(checkSummary(s), []);
  const issues = checkSummaryQuality(s);
  assert.equal(issues.length, 4, issues.join('\n'));
  assert.ok(issues.some(x => /substitution with 1 participant/.test(x)));
  assert.ok(issues.some(x => /teamTurnovers: negative/.test(x)));
  assert.ok(issues.some(x => /totalTurnovers: 0 but plays show/.test(x)));
  assert.ok(issues.some(x => /athlete without id/.test(x)));
});

// 2024-10-16 preseason: Ulm (German club) at Portland, no abbreviation for Ulm
test('preseason exhibition opponent without an abbreviation is accepted', () => {
  const s = fresh.scoreboard();
  s.events[0].season.slug = 'preseason';
  delete s.events[0].competitions[0].competitors[1].team.abbreviation;
  assert.deepEqual(checkScoreboard(s), []);
});

const injuriesDrift = {
  'injuries not an array': s => { s.injuries = null; },
  'unknown status value': s => { s.injuries[0].injuries[0].status = 'Questionable-ish'; },
  'athlete link without id': s => { s.injuries[0].injuries[0].athlete.links = []; },
  'team id missing': s => { delete s.injuries[0].id; },
};
for (const [name, mutate] of Object.entries(injuriesDrift)) {
  test(`injuries drift fails: ${name}`, () => {
    const s = fresh.injuries();
    mutate(s);
    assert.ok(checkInjuries(s).length > 0, `expected an error for "${name}"`);
  });
}
