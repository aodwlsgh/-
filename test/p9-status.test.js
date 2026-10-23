// P9 statuses and records (2026-10-23 P9 approvals: 1 latest entry before the deadline, 2 missed deadlines are
// "마감 경과로 평가 못 함", 4 overround warning < 1.00 or > 1.30 only, 5 no odds vs pass, 8 unevaluated markets stay
// in the ledger with their reason).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OVERROUND_WARN, overroundWarning, oddsMovement, unevaluatedRecords, gameStatuses, dayStatus, comboTable, UNEVALUATED_REASONS } from '../engine/day-status.js';
import { TEXT, forbiddenIn } from '../engine/dashboard-data.js';
import { pendingOdds, evaluationRecords } from '../engine/log-records.js';
import { chainRecords } from '../engine/log-store.js';
import { verifyChain } from '../engine/pick-log.js';
import { stamp } from '../engine/clock.js';
import { IDENTITY } from '../engine/calibrate.js';

const T = iso => new Date(iso);
const odds = (betmanNo, gameId, o, { at, deadline, market = 'ML', line = null, round = 7 } = {}) => {
  const inv = Object.fromEntries(Object.entries(o).map(([k, v]) => [k, 1 / v]));
  const s = Object.values(inv).reduce((a, b) => a + b, 0);
  return { type: 'odds', round, betmanNo, gameId, market, line, odds: o, capturedAt: stamp(at), deadline: stamp(deadline), implied: inv, overround: s, noVig: Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v / s])), home: 'BOS', away: 'NY' };
};
const hist = (lo, n, c) => { const w = Array.from({ length: n }, (_, i) => Math.exp(-0.5 * ((lo + i - c) / 12) ** 2)), s = w.reduce((x, y) => x + y, 0); return { lo, p: w.map(x => x / s) }; };
const game = (gameId, start, { final = true, group = 'A' } = {}) => ({
  gameId, start: stamp(start), group, home: { espn: 'BOS' }, away: { espn: 'NY' },
  prediction: { source: 'base', runId: `r-${gameId}`, run: group, final, sim: { margin: 3, total: 220, marginHist: hist(-60, 121, 3), totalHist: hist(150, 151, 220), shift: 0 } },
});
const cal = { ...IDENTITY };

test('overround warning: below 1.00 or above 1.30 only, fixed thresholds, a warning never blocks', () => {
  assert.deepEqual(OVERROUND_WARN, { below: 1.0, above: 1.3 });
  assert.ok(Object.isFrozen(OVERROUND_WARN));
  assert.equal(overroundWarning(1.0), null);
  assert.equal(overroundWarning(1.3), null);
  assert.equal(overroundWarning(1.12), null);
  assert.match(overroundWarning(0.99).text, /오버라운드 0\.990/);
  assert.match(overroundWarning(1.31).text, /1\.00 미만 또는 1\.30 초과/);
});

test('odds movement: later entries of a market against its first entry (odds and no-vig points)', () => {
  const chain = [
    odds(72, 'g1', { home: 2.5, away: 1.45 }, { at: '2026-10-23T08:00:00Z', deadline: '2026-10-23T14:00:00Z' }),
    odds(80, 'g2', { home: 1.73, away: 1.75 }, { at: '2026-10-23T08:00:00Z', deadline: '2026-10-23T14:00:00Z' }),
    odds(72, 'g1', { home: 2.97, away: 1.23 }, { at: '2026-10-23T09:00:00Z', deadline: '2026-10-23T14:00:00Z' }),
  ];
  const m = oddsMovement(chain);
  assert.equal(m.markets.length, 1);
  const x = m.markets[0];
  assert.equal(x.market, '7-72');
  assert.deepEqual(x.first.odds, { home: 2.5, away: 1.45 });
  assert.equal(x.later.length, 1);
  assert.equal(+x.later[0].dOdds.home.toFixed(2), 0.47);
  assert.ok(x.later[0].dNoVigPp.home < 0 && x.later[0].dNoVigPp.away > 0);
  assert.equal(m.summary.markets, 1);
  assert.equal(m.summary.laterEntries, 1);
});

test('pending odds: the latest entry before the deadline is evaluated once; later entries stay odds records', () => {
  const g = game('g1', '2026-11-03T00:00:00Z', { group: 'B' });
  const day = { kind: 'live', games: [g] };
  const chain = chainRecords(null, [
    odds(1, 'g1', { home: 2.0, away: 1.8 }, { at: '2026-11-02T12:00:00Z', deadline: '2026-11-02T23:50:00Z' }),
    odds(1, 'g1', { home: 2.2, away: 1.7 }, { at: '2026-11-02T13:00:00Z', deadline: '2026-11-02T23:50:00Z' }),
  ]);
  const now = T('2026-11-02T21:50:00Z');
  const pend = pendingOdds(chain, { now });
  assert.equal(pend.length, 1);
  assert.equal(pend[0].odds.home, 2.2);
  const ev = evaluationRecords({ oddsRecs: pend, day, cal, chain, now });
  assert.equal(ev.records.filter(r => r.type === 'evaluation').length, 2);
  const after = chainRecords(chain.at(-1), ev.records);
  assert.equal(pendingOdds([...chain, ...after], { now }).length, 0, 'fixed once');
});

test('unevaluated markets stay in the ledger with their reason (deadline before the final prediction, no prediction, not written)', () => {
  const now = T('2026-10-24T01:00:00Z');
  const chain = chainRecords(null, [
    odds(56, 'gA', { home: 1.56, away: 1.97 }, { at: '2026-10-23T08:00:00Z', deadline: '2026-10-23T14:00:00Z' }),
    odds(76, 'gB', { home: 1.84, away: 1.65 }, { at: '2026-10-23T08:00:00Z', deadline: '2026-10-24T00:00:00Z' }),
    odds(60, 'gC', { home: 1.95, away: 1.57 }, { at: '2026-10-23T08:00:00Z', deadline: '2026-10-23T14:00:00Z' }),
    odds(92, 'gD', { home: 1.56, away: 1.97 }, { at: '2026-10-23T08:00:00Z', deadline: '2026-10-24T02:00:00Z' }),
  ]);
  const finals = new Map([['gA', { at: '2026-10-23T21:55:00Z', runId: 'A' }], ['gB', { at: '2026-10-23T21:55:00Z', runId: 'A' }]]);
  const recs = unevaluatedRecords({ chain, finals, now });
  const by = Object.fromEntries(recs.map(r => [r.gameId, r]));
  assert.equal(recs.length, 3, 'gD is still before its deadline');
  assert.equal(by.gA.reason, 'deadline before final prediction');
  assert.match(by.gA.note, /^마감 경과로 평가 못 함/);
  assert.equal(by.gB.reason, 'not written before deadline');
  assert.equal(by.gC.reason, 'no final prediction');
  for (const r of recs) assert.ok(UNEVALUATED_REASONS[r.reason], r.reason);
  assert.equal(by.gA.type, 'unevaluated');
  assert.equal(by.gA.id, '7-56');
  assert.equal(by.gA.oddsSeq, 0);
  assert.deepEqual(by.gA.createdAt, stamp(now));
  const all = [...chain, ...chainRecords(chain.at(-1), recs)];
  assert.equal(verifyChain(all).ok, true);
  assert.deepEqual(unevaluatedRecords({ chain: all, finals, now }), [], 'written once');
  assert.equal(pendingOdds(all, { now: T('2026-10-23T12:00:00Z') }).length, 1, 'gD only');
});

test('game and day status: no odds is "배당 미입력", never "오늘은 패스"; pass only after evaluation without candidates', () => {
  const now = T('2026-11-02T23:00:00Z');
  const day = { kind: 'live', games: [game('g1', '2026-11-03T00:00:00Z'), game('g2', '2026-11-03T03:00:00Z', { group: 'B', final: false })] };
  let s = dayStatus({ day, chain: [], now });
  assert.equal(s.code, 'noOdds');
  assert.equal(s.text, TEXT.noOdds);
  assert.notEqual(s.text, TEXT.pass);
  let g = gameStatuses({ day, chain: [], now });
  assert.equal(g.get('g1').text, TEXT.noOdds);
  assert.equal(gameStatuses({ day, chain: [], now: T('2026-11-03T00:30:00Z') }).get('g1').text, TEXT.noOddsClosed);

  const o2 = odds(9, 'g2', { home: 1.9, away: 1.9 }, { at: '2026-11-02T22:00:00Z', deadline: '2026-11-03T02:50:00Z' });
  g = gameStatuses({ day, chain: [o2], now });
  assert.equal(g.get('g2').text, TEXT.awaiting);
  s = dayStatus({ day, chain: [o2], now });
  assert.equal(s.code, 'pending');

  // evaluated, no leg reaches EV +3%: the only state that reads "오늘은 패스"
  const o1 = odds(3, 'g1', { home: 1.2, away: 1.2 }, { at: '2026-11-02T22:00:00Z', deadline: '2026-11-02T23:50:00Z' });
  const ev = evaluationRecords({ oddsRecs: [o1], day, cal, chain: [o1], now });
  assert.equal(ev.records.filter(r => r.type === 'pick').length, 0);
  const day1 = { ...day, games: [day.games[0]] };
  s = dayStatus({ day: day1, chain: [o1, ...ev.records], now });
  assert.equal(s.code, 'pass');
  assert.equal(s.text, TEXT.pass);
  const un = { type: 'unevaluated', id: '7-9', round: 7, betmanNo: 9, gameId: 'g2', reason: 'deadline before final prediction', note: UNEVALUATED_REASONS['deadline before final prediction'] };
  assert.match(gameStatuses({ day, chain: [o2, un], now }).get('g2').text, /^평가 못 함|^마감 경과로 평가 못 함/);
});

test('2-folds: a separate record table, no exit targets or met/unmet cells', () => {
  const t = comboTable([]);
  assert.deepEqual(t.columns.map(c => c.key), ['n', 'settled', 'hits', 'roi', 'roiCi', 'brier']);
  assert.ok(!JSON.stringify(t).includes(TEXT.met) && !JSON.stringify(t).includes(TEXT.unmet));
  assert.match(t.caption, /해제 조건에 넣지 않음/);
});

test('new wording has no forbidden phrases', () => {
  const texts = [...Object.values(TEXT), ...Object.values(UNEVALUATED_REASONS), overroundWarning(1.4).text, comboTable([]).caption];
  assert.deepEqual(texts.flatMap(forbiddenIn), []);
});

test('confirmation screen: the first entry of a market fixes it, later or pre-final entries are odds only, integer lines unsupported, overround warns without blocking', async () => {
  const { classifyInput, HANDLING } = await import('../engine/day-status.js');
  const now = new Date('2026-11-02T22:00:00Z');
  const day = { kind: 'live', games: [game('g1', '2026-11-03T00:00:00Z'), { ...game('g2', '2026-11-03T03:00:00Z', { group: 'B', final: false }), home: { espn: 'LAL' }, away: { espn: 'LAC' } }] };
  const mk = (betmanNo, home, away, type, odds, line) => ({ betmanNo, home, away, deadline: '2026-11-03T08:50:00+09:00', type, odds, ...(line != null ? { line } : {}) });
  const input = { round: 7, capturedAt: '2026-11-03T06:59:00+09:00', source: 'manual', markets: [
    mk(1, '보스턴 셀틱스', '뉴욕 닉스', 'ML', { home: 1.5, away: 1.5 }),
    mk(1, '보스턴 셀틱스', '뉴욕 닉스', 'ML', { home: 1.6, away: 2.2 }),
    mk(2, '보스턴 셀틱스', '뉴욕 닉스', 'OU', { over: 1.8, under: 1.9 }, 220),
    mk(3, 'LA 레이커스', 'LA 클리퍼스', 'ML', { home: 1.8, away: 1.9 }),
  ] };
  const fixedBefore = [{ type: 'evaluation', round: 7, betmanNo: 9, gameId: 'g1' }];
  const c = classifyInput({ input, day, chain: fixedBefore, now });
  assert.equal(c.ok, true, c.error);
  assert.deepEqual(c.rows.map(r => r.handling), ['fix', 'oddsOnlyFixed', 'unsupported', 'oddsOnlyAwaitingB']);
  assert.equal(c.rows[0].text, HANDLING.fix);
  assert.match(c.rows[0].text, /수정 불가/);
  assert.ok(c.rows[0].warning, 'overround 1.333 > 1.30 warns');
  assert.equal(c.warnings, 1);
  const again = classifyInput({ input: { ...input, markets: [input.markets[0]] }, day, chain: [{ type: 'evaluation', round: 7, betmanNo: 1 }], now });
  assert.equal(again.rows[0].handling, 'oddsOnlyFixed');
  assert.equal(classifyInput({ input: { ...input, round: 'x' }, day, chain: [], now }).ok, false);
});
