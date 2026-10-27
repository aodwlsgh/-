import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stamp } from '../engine/clock.js';
import { byKorean, BETMAN_TEAMS as TEAMS, KO_CAPTURE, teamNameWarning, inputTeamWarnings } from '../engine/betman-teams.js';
import { validateRound, toOddsRecords, noVig } from '../engine/odds.js';
import { marketProbs } from '../engine/markets.js';
import { pCons, pConsOld, evaluate, picks, gate, breakeven, FIRST_MONTH, SEASON_OPENING } from '../engine/picks.js';
import { chainAppend, verifyChain, pickRecord, summarize } from '../engine/pick-log.js';
import { IDENTITY } from '../engine/calibrate.js';
import { normCdf } from '../engine/predict.js';
import { fromEt } from '../engine/time.js';
import { rng } from '../engine/sim.js';

// ---- time: UTC and KST together; US DST ends 2026-11-01 (KST has no DST) ----
test('stamps carry UTC and KST; ET tip-offs move by one KST hour across 2026-11-01', () => {
  const before = stamp(fromEt('2026-10-31', 19, 30)), after = stamp(fromEt('2026-11-02', 19, 30));
  assert.deepEqual(before, { utc: '2026-10-31T23:30:00.000Z', kst: '2026-11-01T08:30:00+09:00' });
  assert.deepEqual(after, { utc: '2026-11-03T00:30:00.000Z', kst: '2026-11-03T09:30:00+09:00' });
});

// ---- teams ----
test('Betman Korean team names map to ESPN abbreviations', () => {
  assert.equal(byKorean('마이애미 히트').espn, 'MIA');
  assert.equal(byKorean('미네소타 팀버울브스').espn, 'MIN');
  assert.equal(byKorean('LA레이커스').espn, 'LAL');
  assert.equal(byKorean('골든스테이트').espn, 'GS');
  assert.equal(byKorean('없는팀'), undefined);
  assert.ok(TEAMS.every(t => t.ko));
});

// 2026-10-23 "첫 캡처 확인 종결 / 팀명 변경 승인": the first capture (17:00 KST, estimated) showed 24 teams
test('captures: Houston is "휴스턴 로케츠", Denver "덴버 너게츠"; the 29 teams seen on screen are confirmed, PHI stays unconfirmed', () => {
  assert.equal(byKorean('휴스턴 로케츠').espn, 'HOU');
  assert.equal(byKorean('휴스턴 로키츠'), undefined, 'the earlier guess is not a Betman name');
  assert.equal(TEAMS.filter(t => t.koVerified).length, 29);
  assert.deepEqual(TEAMS.filter(t => !t.koVerified).map(t => t.espn).sort(), ['PHI']);
  assert.equal(byKorean('덴버 너게츠').espn, 'DEN', 'Denver as written on the 2026-10-27 screens');
  assert.equal(KO_CAPTURE.at, '2026-10-23T17:00:00+09:00');
  assert.equal(KO_CAPTURE.atEstimated, true);
});

test('an unconfirmed team name in an odds input gets a warning (input is not blocked); confirmed names do not', () => {
  const w = teamNameWarning('필라델피아 76ers');
  assert.equal(w.espn, 'PHI');
  assert.match(w.text, /미확인/);
  assert.equal(teamNameWarning('휴스턴 로케츠'), null);
  assert.equal(teamNameWarning('없는팀'), null, 'unmapped names are rejected by validateRound, not warned');
  const input = { markets: [{ betmanNo: 1, home: '보스턴 셀틱스', away: '필라델피아 76ers' }, { betmanNo: 2, home: '피닉스 선즈', away: '브루클린 네츠' }] };
  assert.deepEqual(inputTeamWarnings(input).map(x => [x.betmanNo, x.espn]), [[1, 'PHI']], 'PHX (10-27) and BKN (10-28 screens) were seen');
  assert.deepEqual(inputTeamWarnings({ markets: [{ betmanNo: 3, home: '휴스턴 로케츠', away: '샌안토니오 스퍼스' }] }), []);
});

// ---- odds input ----
const NOW = '2026-11-05T05:00:00Z';
const round = (over = {}) => ({
  round: 125, capturedAt: '2026-11-05T14:30:00+09:00', source: 'manual',
  markets: [
    { betmanNo: 1, home: '마이애미 히트', away: '미네소타 팀버울브스', deadline: '2026-11-06T08:30:00+09:00', type: 'OU', line: 225.5, odds: { under: 1.71, over: 1.77 } },
    { betmanNo: 2, home: '마이애미 히트', away: '미네소타 팀버울브스', deadline: '2026-11-06T08:30:00+09:00', type: 'HC', line: -3.5, odds: { home: 1.75, away: 1.73 } },
    { betmanNo: 3, home: '보스턴 셀틱스', away: '뉴욕 닉스', deadline: '2026-11-06T09:00:00+09:00', type: 'ML', odds: { home: 1.55, away: 2.15 } },
    { betmanNo: 4, home: '보스턴 셀틱스', away: '뉴욕 닉스', deadline: '2026-11-06T09:00:00+09:00', type: 'ML5', odds: { home: 2.1, close: 3.3, away: 3.4 } },
  ],
  ...over,
});

test('odds validation (§10.2)', () => {
  assert.deepEqual(validateRound(round(), { now: NOW }), []);
  const bad = round();
  bad.markets[0].odds.over = 60;
  bad.markets[1].line = -3.3;
  bad.markets[2].deadline = '2026-11-05T00:00:00Z';
  bad.markets[3].home = '알수없음';
  const errs = validateRound(bad, { now: NOW });
  assert.equal(errs.length, 4, JSON.stringify(errs));
  assert.ok(validateRound(round({ markets: [{ ...round().markets[0], odds: { over: 1.77 } }] }), { now: NOW }).some(e => /selection/.test(e)));
});

test('records keep line, odds, capture time (UTC and KST) and proportional no-vig implied probabilities', () => {
  const recs = toOddsRecords(round(), { now: NOW });
  const ou = recs[0];
  assert.equal(ou.line, 225.5);
  assert.deepEqual(ou.capturedAt, stamp(new Date('2026-11-05T14:30:00+09:00')));
  assert.ok(Math.abs(ou.overround - (1 / 1.71 + 1 / 1.77)) < 1e-12);
  assert.ok(Math.abs(ou.noVig.over + ou.noVig.under - 1) < 1e-12);
  assert.ok(Math.abs(ou.noVig.over - (1 / 1.77) / ou.overround) < 1e-12);
  assert.equal(recs[3].noVig.close > 0 && Math.abs(recs[3].noVig.home + recs[3].noVig.close + recs[3].noVig.away - 1) < 1e-12, true);
  assert.equal(ou.home, 'MIA');
  assert.equal(ou.noVigMethod, 'proportional');
  assert.deepEqual(noVig({ a: 2, b: 2 }), { a: 0.5, b: 0.5 });
});

// ---- market probabilities from the base prediction ----
const MU = 4, SD = 13, TMU = 226, TSD = 18;
function basePrediction(gameId = 'g1', over = {}, mu = MU) {
  const Phi = z => normCdf(z);
  const p = [], tp = [];
  for (let k = -60; k <= 60; k++) p.push(Phi((k + 0.5 - mu) / SD) - Phi((k - 0.5 - mu) / SD));
  for (let k = 150; k <= 300; k++) tp.push(Phi((k + 0.5 - TMU) / TSD) - Phi((k - 0.5 - TMU) / TSD));
  return { source: 'base', runId: 'run-1', run: 'A', gameId, home: 'MIA', away: 'MIN', tipoff: '2026-11-06T00:00:00Z', sim: { margin: mu, total: TMU, marginHist: { lo: -60, p }, totalHist: { lo: 150, p: tp }, shift: 0 }, ...over };
}
const rec = (type, line, odds, gameId = 'g1') => ({ type, line, odds, gameId, round: 125, betmanNo: 9, deadline: stamp(new Date('2026-11-06T08:30:00+09:00')) });

test('probabilities at the Betman line itself, matching the analytic distribution', () => {
  const pred = basePrediction();
  const hc = marketProbs(pred, IDENTITY, rec('HC', -3.5));
  // tolerance 1e-4: the histogram is cut at ±60 and normCdf is an approximation
  assert.ok(Math.abs(hc.home - (1 - normCdf((3.5 - MU) / SD))) < 1e-4);
  assert.ok(Math.abs(hc.home + hc.away - 1) < 1e-12);
  const ou = marketProbs(pred, IDENTITY, rec('OU', 230.5));
  assert.ok(Math.abs(ou.over - (1 - normCdf((230.5 - TMU) / TSD))) < 1e-4);
  const ml5 = marketProbs(pred, IDENTITY, rec('ML5'));
  assert.ok(Math.abs(ml5.close - (normCdf((5.5 - MU) / SD) - normCdf((-5.5 - MU) / SD))) < 1e-4);
  assert.ok(Math.abs(ml5.home + ml5.close + ml5.away - 1) < 1e-12);
});

test('integer lines and lines outside the calibrated range are unsupported (recorded, never picked)', () => {
  const pred = basePrediction();
  assert.match(marketProbs(pred, IDENTITY, rec('HC', -4)).unsupported, /integer/);
  assert.match(marketProbs(pred, IDENTITY, rec('OU', 230)).unsupported, /integer/);
  assert.match(marketProbs(pred, IDENTITY, rec('HC', -16.5)).unsupported, /range/);
  assert.match(marketProbs(pred, IDENTITY, rec('OU', 245.5)).unsupported, /range/);
});

test('only the base prediction is accepted: scenario or sensitivity results are refused', () => {
  assert.throws(() => marketProbs({ ...basePrediction(), source: undefined, label: 'unverified' }, IDENTITY, rec('ML')), /base prediction/);
  assert.throws(() => evaluate([rec('ML', null, { home: 1.9, away: 1.9 })], [{ ...basePrediction(), source: 'scenario' }], IDENTITY, { now: NOW }), /base prediction/);
});

// ---- pick rules (§9.2, §14.1) ----
test('p_cons is the registered formula; the old formula is kept for comparison only', () => {
  assert.equal(pCons(0.7), 0.7 - 0.1 * 0.2);
  assert.equal(pCons(0.2), 0.2 - 0.1 * 0.3);
  assert.ok(Math.abs(pConsOld(0.2) - 0.23) < 1e-12);
});

function day() {
  // three games; probabilities from the base predictions, odds chosen to make some legs pass EV >= 3%
  const preds = [basePrediction('g1'), basePrediction('g2'), basePrediction('g3')];
  const recs = [
    { ...rec('ML', null, { home: 1.8, away: 2.2 }, 'g1'), betmanNo: 1 }, // home p≈0.62 -> pCons≈0.608, EV≈+9.4%
    { ...rec('ML', null, { home: 1.8, away: 2.2 }, 'g2'), betmanNo: 2 },
    { ...rec('HC', -3.5, { home: 1.55, away: 1.75 }, 'g3'), betmanNo: 3 }, // p≈0.515 / 0.485 -> EV < 3% both sides
    { ...rec('OU', 225.5, { over: 1.95, under: 1.95 }, 'g1'), betmanNo: 4 },
  ];
  return { preds, recs };
}

test('legs need EV >= +3%; 2-folds need different games, the same round and a raw odds product >= 2.0', () => {
  const { preds, recs } = day();
  const ev = evaluate(recs, preds, IDENTITY, { now: NOW });
  const out = picks(ev);
  assert.ok(out.legs.every(l => l.ev >= 0.03));
  assert.ok(out.legs.some(l => l.gameId === 'g1' && l.selection === 'home'));
  assert.ok(!out.legs.some(l => l.gameId === 'g3'));
  for (const c of out.combos) {
    assert.notEqual(c.legs[0].gameId, c.legs[1].gameId);
    assert.ok(c.oddsProduct >= 2.0);
    assert.ok(Math.abs(c.ev - (c.legs[0].pCons * c.legs[1].pCons * c.oddsProduct - 1)) < 1e-12);
  }
  assert.ok(out.combos.length >= 1 && out.combos.length <= 3);
  assert.equal(out.pass, false);
  for (let i = 1; i < out.combos.length; i++) assert.ok(out.combos[i - 1].ev >= out.combos[i].ev);
});

test('same-game legs never combine; different rounds never combine; nothing valid -> "오늘은 패스"', () => {
  const { preds, recs } = day();
  const ev = evaluate([recs[0], recs[3]], preds, IDENTITY, { now: NOW }); // both g1
  const out = picks(ev);
  assert.equal(out.combos.length, 0);
  assert.equal(out.pass, true);
  assert.equal(out.message, '오늘은 패스');
  const r2 = [recs[0], { ...recs[1], round: 126 }];
  assert.equal(picks(evaluate(r2, preds, IDENTITY, { now: NOW })).combos.length, 0);
  const noEv = [{ ...recs[0], odds: { home: 1.3, away: 2.6 } }, { ...recs[1], odds: { home: 1.4, away: 2.6 } }]; // every EV < 3%
  assert.equal(picks(evaluate(noEv, preds, IDENTITY, { now: NOW })).legs.length, 0);
  // strong favourites: both legs pass EV >= 3% but the raw odds product 1.35 × 1.35 < 2.0
  const fav = [basePrediction('f1', {}, 12), basePrediction('f2', {}, 12)];
  const short = [{ ...rec('ML', null, { home: 1.35, away: 3.6 }, 'f1'), betmanNo: 5 }, { ...rec('ML', null, { home: 1.35, away: 3.6 }, 'f2'), betmanNo: 6 }];
  const sp = picks(evaluate(short, fav, IDENTITY, { now: NOW }));
  assert.equal(sp.legs.filter(l => l.selection === 'home').length, 2);
  assert.equal(sp.combos.filter(c => c.legs.every(l => l.selection === 'home')).length, 0);
});

test('breakeven table: minimum odds 1.03 / p_cons; handicap and over/under lines within ±3 of the expectation', () => {
  const t = breakeven(basePrediction(), IDENTITY);
  assert.ok(Math.abs(t.ml.home.minOdds - 1.03 / t.ml.home.pCons) < 1e-12);
  assert.ok(t.hc.every(x => Math.abs(x.line + MU) <= 3 + 1e-9 && x.line % 1 !== 0));
  assert.ok(t.ou.every(x => Math.abs(x.line - TMU) <= 3 + 1e-9 && x.line % 1 !== 0));
});

test('gate: every market record-only now; the first month of 2026-27 also record-only, with reasons', () => {
  assert.equal(SEASON_OPENING['2026-27'], '2026-10-20');
  assert.equal(FIRST_MONTH.days, 30);
  const early = gate('ML', '2026-11-19'), later = gate('OU', '2026-11-20');
  assert.equal(early.status, 'record-only');
  assert.equal(early.purchaseAllowed, false);
  assert.ok(early.reasons.some(r => /first month/.test(r)));
  assert.equal(later.status, 'record-only');
  assert.ok(!later.reasons.some(r => /first month/.test(r)));
  assert.ok(later.reasons.some(r => /record-only period/.test(r)));
});

// ---- append-only pick log ----
test('hash chain: each record carries the previous hash; any later edit is detected', () => {
  let prev = null;
  const log = [];
  for (const r of [{ type: 'note', text: 'a' }, { type: 'note', text: 'b' }, { type: 'note', text: 'c' }]) { const x = chainAppend(prev, r); log.push(x); prev = x; }
  assert.equal(log[1].prevHash, log[0].hash);
  assert.deepEqual(verifyChain(log), { ok: true, brokenAt: null });
  const tampered = log.map(x => ({ ...x }));
  tampered[1].text = 'B';
  assert.equal(verifyChain(tampered).ok, false);
  assert.equal(verifyChain(tampered).brokenAt, 1);
  assert.equal(verifyChain([log[0], log[2]]).ok, false); // removal detected
});

test('pick records are fixed before the deadline and hold every model candidate, purchase is a separate record', () => {
  const { preds, recs } = day();
  const out = picks(evaluate(recs, preds, IDENTITY, { now: NOW }));
  const leg = out.legs[0];
  const r = pickRecord(leg, { now: NOW });
  assert.equal(r.type, 'pick');
  assert.deepEqual(r.createdAt, stamp(new Date(NOW)));
  assert.equal(r.purchased, undefined); // purchase is not part of the pick
  assert.ok(r.pConsOld > 0 && r.evOld !== undefined && r.predictionRef === 'run-1');
  assert.throws(() => pickRecord(leg, { now: '2026-11-06T00:00:00Z' }), /deadline/); // 09:00 KST deadline passed
});

test('summary: single picks with a game-clustered ROI interval, 2-folds apart, market Brier on every recorded market, total bias monitor', () => {
  const r = rng(4);
  let prev = null;
  const log = [];
  const add = x => { prev = chainAppend(prev, x); log.push(prev); };
  const at = d => stamp(new Date(d));
  for (let g = 0; g < 60; g++) {
    const gameId = `G${g}`, p = 0.55 + 0.1 * r();
    const created = at(new Date(Date.UTC(2026, 10, 1) + g * 86400e3).toISOString()); // one game a day: 60 days
    const deadline = at(new Date(Date.UTC(2026, 10, 1) + g * 86400e3 + 3600e3).toISOString());
    add({ type: 'pick', id: `${gameId}-ml`, gameId, market: 'ML', selection: 'home', line: null, odds: 1.95, p, pCons: pCons(p), ev: pCons(p) * 1.95 - 1, deadline, createdAt: created });
    add({ type: 'pick', id: `${gameId}-hc`, gameId, market: 'HC', selection: 'home', line: -3.5, odds: 1.9, p, pCons: pCons(p), ev: pCons(p) * 1.9 - 1, deadline, createdAt: created });
    add({ type: 'evaluation', gameId, market: 'ML', selection: 'home', line: null, p, noVig: 0.5, predTotal: 225 });
    const win = r() < p;
    add({ type: 'result', gameId, margin: win ? 5 : -5, total: 228 });
  }
  add({ type: 'combo', id: 'C1', legs: ['G0-ml', 'G1-ml'], oddsProduct: 3.8, pCons: 0.36, ev: 0.37 });
  add({ type: 'purchase', pickId: 'G0-ml', purchased: true });
  const s = summarize(log);
  assert.equal(s.singles.n, 120);
  assert.equal(s.singles.settled, 120);
  assert.equal(s.combos.n, 1);
  assert.ok(s.singles.roi.ci95[1] - s.singles.roi.ci95[0] > 0);
  assert.equal(s.singles.roi.clusteredBy, 'game');
  assert.equal(s.purchases.purchased, 1);
  assert.ok(s.market.brierModel > 0 && s.market.brierMarket > 0 && s.market.n === 60);
  assert.ok(Math.abs(s.monitor.totalBias.all - 3) < 1e-9); // actual 228 - predicted 225
  assert.equal(s.chain.ok, true);
  assert.equal(s.exit.minPicks.target, 200);
  assert.equal(s.exit.minPicks.met, false);
  assert.equal(s.exit.minWeeks.met, true); // 59 days of picks
  assert.equal(s.exit.releaseNeedsUserApproval, true);
});
