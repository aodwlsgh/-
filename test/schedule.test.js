import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scheduleExclusion } from '../engine/schedule.js';

const row = o => ({ slug: 'regular-season', home: 'OKC', away: 'MIL', ctype: 'STD', status: 'STATUS_FINAL', ...o });

test('regular-season NBA game counts', () => assert.equal(scheduleExclusion(row()), null));
test('NBA Cup final (type CC) is excluded', () => assert.match(scheduleExclusion(row({ ctype: 'CC' })), /Cup/));
test('All-Star teams are excluded', () => assert.match(scheduleExclusion(row({ home: 'STARS', away: 'WORLD' })), /all-star/));
test('postponed original date is excluded', () => assert.match(scheduleExclusion(row({ status: 'STATUS_POSTPONED' })), /POSTPONED/));
test('other slugs are excluded', () => assert.match(scheduleExclusion(row({ slug: 'play-in-season' })), /slug/));
