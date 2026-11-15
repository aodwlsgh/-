// Display items approved 2026-11-11/13 (display only): the dashboard "오래된 게시" banner and the line "평가 레코드 N건,
// 마지막 배당 입력 날짜" in the daily report and the dashboard. Nothing here changes a prediction or a record.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { staleBanner, evalLine, STALE_HOURS } from '../engine/display-status.js';
import { stamp } from '../engine/clock.js';

const day = (generatedUtc, run = 'A', groups = ['A', 'B']) => ({ kind: 'live', run, generatedAt: stamp(generatedUtc), games: groups.map((g, i) => ({ gameId: String(i), group: g })) });
const at = s => new Date(s);

test('no banner while the last expected run is less than 3 hours old or was published', () => {
  assert.equal(STALE_HOURS, 3);
  // ET 11-14 B published 01:52Z (10:52 KST); 11-15 06:00Z (15:00 KST): last slot B 01:50Z, published
  assert.equal(staleBanner(day('2026-11-15T01:52:00Z', 'B'), at('2026-11-15T06:00:00Z')), null);
  // A published 22:51Z; at 01:00Z the B slot (01:50Z) has not come; the A slot is covered
  assert.equal(staleBanner(day('2026-11-14T22:51:00Z', 'A'), at('2026-11-15T01:00:00Z')), null);
  // B slot missed but only 2 h 59 m ago
  assert.equal(staleBanner(day('2026-11-14T22:51:00Z', 'A'), at('2026-11-15T04:49:00Z')), null);
  assert.equal(staleBanner({ ...day('2026-11-01T00:00:00Z'), kind: 'example' }, at('2026-11-15T06:00:00Z')), null, 'example data');
});

test('banner when a slot more than 3 hours old has no publish after it: names the run and the hours', () => {
  const b = staleBanner(day('2026-11-14T22:51:00Z', 'A'), at('2026-11-15T04:51:00Z'));
  assert.ok(b);
  assert.equal(b.run, 'B');
  assert.equal(b.hours, 6);
  assert.match(b.text, /마지막 게시 6시간 전\(11-15 07:51 KST\)/);
  assert.match(b.text, /실행 B\(11-15 10:50 KST\)/);
  assert.match(b.text, /예약 작업 확인/);
  // the 11-07..11-10 outage seen on 11-09 12:00 KST: last publish 11-07 C 12:51Z
  const o = staleBanner(day('2026-11-07T12:51:00Z', 'C'), at('2026-11-09T03:00:00Z'));
  assert.equal(o.run, 'A');
  assert.ok(o.hours >= 38);
});

test('B "대상 없음": a run A day without B-group games does not wait for a B publish', () => {
  const onlyA = day('2026-11-14T22:51:00Z', 'A', ['A', 'A']);
  assert.equal(staleBanner(onlyA, at('2026-11-15T06:00:00Z')), null);
  // the next C slot (12:50Z) still counts
  assert.equal(staleBanner(onlyA, at('2026-11-15T16:00:00Z')).run, 'C');
});

test('DST: A and B slots follow 17:50/20:50 ET, C stays 21:50 KST', () => {
  // 2027-03-15 ET (EDT): A at 21:50Z (06:50 KST); published 21:51Z, checked 01:00Z: not stale
  assert.equal(staleBanner(day('2027-03-15T21:51:00Z', 'A'), at('2027-03-16T01:00:00Z')), null);
  // C on ET 03-15 runs 12:50Z (21:50 KST, 08:50 EDT): published 12:51Z, checked 16:00Z: not stale
  assert.equal(staleBanner(day('2027-03-15T12:51:00Z', 'C'), at('2027-03-15T16:00:00Z')), null);
});

test('evaluation line: count and last odds input (KST date), "없음" when no odds', () => {
  const odds = t => ({ type: 'odds', createdAt: stamp(t) });
  assert.deepEqual(evalLine([]), { evaluations: 0, lastOdds: null, text: '평가 레코드 0건 · 마지막 배당 입력 없음' });
  const chain = [odds('2026-10-27T06:38:52Z'), { type: 'unevaluated' }, { type: 'result' }];
  assert.equal(evalLine(chain).text, '평가 레코드 0건 · 마지막 배당 입력 2026-10-27 (KST)');
  assert.equal(evalLine([...chain, { type: 'evaluation' }, { type: 'evaluation' }, odds('2026-11-15T14:00:00Z')]).text, '평가 레코드 2건 · 마지막 배당 입력 2026-11-15 (KST)');
});
