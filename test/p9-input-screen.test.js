// 2026-10-26 user decision (odds input flow): markets outside the input rule (승5패, SUM), past their deadline or for a
// game not on the dashboard's day are left out one by one and listed with the reason; number and format errors still
// reject the whole input. A capture time taken from the time the message arrived is kept on the records.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyInput, screenInput, EXCLUDED } from '../engine/day-status.js';
import { toOddsRecords } from '../engine/odds.js';

const game = (id, start, extra = {}) => ({ gameId: id, start: { utc: start }, group: 'A', home: { espn: 'BOS' }, away: { espn: 'NY' }, prediction: { final: true }, ...extra });
const day = { kind: 'live', games: [game('g1', '2026-11-03T00:00:00Z'), game('g2', '2026-11-03T03:00:00Z', { home: { espn: 'LAL' }, away: { espn: 'LAC' } })] };
const now = new Date('2026-11-02T22:00:00Z'); // 07:00 KST
const mk = (betmanNo, home, away, type, odds, extra = {}) => ({ betmanNo, home, away, deadline: '2026-11-03T08:50:00+09:00', type, odds, ...extra });
const BOS = ['보스턴 셀틱스', '뉴욕 닉스'], LAL = ['LA 레이커스', 'LA 클리퍼스'];
const good = [
  mk(1, ...BOS, 'ML', { home: 1.6, away: 2.2 }),
  mk(2, ...BOS, 'HC', { home: 1.8, away: 1.9 }, { line: -2.5 }),
  mk(3, ...BOS, 'OU', { over: 1.8, under: 1.9 }, { line: 220.5 }),
];
const input = markets => ({ round: 127, capturedAt: '2026-11-03T06:59:00+09:00', source: 'screenshot', markets });

test('승5패 and SUM are left out market by market, with the reason; the rest goes on', () => {
  const c = classifyInput({ input: input([...good, mk(4, ...BOS, 'ML5', { home: 2, close: 4, away: 3 }), mk(5, ...BOS, 'SUM', { odd: 1.8, even: 1.8 })]), day, chain: [], now });
  assert.equal(c.ok, true, c.error);
  assert.deepEqual(c.rows.map(r => r.market), ['127-1', '127-2', '127-3']);
  assert.deepEqual(c.excluded.map(x => [x.betmanNo, x.type, x.reason]), [[4, 'ML5', 'notInRule'], [5, 'SUM', 'notInRule']]);
  assert.equal(c.excluded[0].text, EXCLUDED.notInRule);
  assert.deepEqual(c.input.markets.map(m => m.betmanNo), [1, 2, 3], 'only the kept markets are written on [확정]');
});

test('a market past its deadline and a game not on the day are left out too', () => {
  const late = mk(6, ...LAL, 'ML', { home: 1.8, away: 1.9 }, { deadline: '2026-11-03T06:30:00+09:00' });
  const other = mk(7, '밀워키 벅스', '시카고 불스', 'ML', { home: 1.7, away: 2.0 });
  const c = classifyInput({ input: input([...good, late, other]), day, chain: [], now });
  assert.equal(c.ok, true, c.error);
  assert.deepEqual(c.excluded.map(x => [x.betmanNo, x.reason]), [[6, 'pastDeadline'], [7, 'noGame']]);
  assert.match(c.excluded[1].game, /시카고 불스 @ 밀워키 벅스/);
});

test('nothing left: no record, the exclusions are still listed', () => {
  const c = classifyInput({ input: input([mk(5, ...BOS, 'SUM', { odd: 1.8, even: 1.8 })]), day, chain: [], now });
  assert.equal(c.ok, false);
  assert.match(c.error, /기록할 마켓이 없습니다/);
  assert.deepEqual(c.excluded.map(x => x.reason), ['notInRule']);
});

test('number and format errors still reject the whole input', () => {
  const bad = [
    ['odds out of range', mk(8, ...BOS, 'ML', { home: 0.9, away: 2 })],
    ['line not in 0.5 steps', mk(9, ...BOS, 'OU', { over: 1.8, under: 1.9 }, { line: 220.3 })],
    ['selection missing', mk(10, ...BOS, 'HC', { home: 1.8 }, { line: -2.5 })],
    ['unknown market type', mk(11, ...BOS, 'XX', { a: 2, b: 2 })],
    ['team not mapped', mk(12, '없는 팀', '뉴욕 닉스', 'ML', { home: 1.8, away: 1.9 })],
    ['deadline not a time', mk(13, ...BOS, 'ML', { home: 1.8, away: 1.9 }, { deadline: 'soon' })],
    ['deadline after tip-off', mk(14, ...BOS, 'ML', { home: 1.8, away: 1.9 }, { deadline: '2026-11-03T10:00:00+09:00' })],
  ];
  for (const [why, m] of bad) {
    const c = classifyInput({ input: input([...good, m]), day, chain: [], now });
    assert.equal(c.ok, false, why);
    assert.deepEqual(c.rows, [], why);
  }
  assert.equal(classifyInput({ input: { ...input(good), round: 'x' }, day, chain: [], now }).ok, false, 'round');
  assert.equal(classifyInput({ input: { ...input(good), source: 'crawl' }, day, chain: [], now }).ok, false, 'source');
});

test('screenInput leaves a valid input untouched', () => {
  const s = screenInput({ input: input(good), day, now });
  assert.deepEqual(s.excluded, []);
  assert.deepEqual(s.input.markets, good);
});

test('a capture time standing in for the receive time is kept on every record', () => {
  const recs = toOddsRecords({ ...input(good), capturedAtBasis: 'received' }, { now });
  assert.deepEqual([...new Set(recs.map(r => r.capturedAtBasis))], ['received']);
  assert.equal(toOddsRecords(input(good), { now })[0].capturedAtBasis, undefined, 'absent unless given');
  assert.throws(() => toOddsRecords({ ...input(good), capturedAtBasis: 'guess' }, { now }), /capturedAtBasis/);
});
