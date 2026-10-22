import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { p, summary, rosters, HOME as H, AWAY as A } from './helpers/espn-builder.js';
import {
  clockSec, toPossessions, toStints, shotZone, boxTotals, pbpTotals, possessionEstimate, checkIntegrity,
} from '../engine/parse.js';

const end = (period = 1) => p('End Period', null, { period, clock: '0.0' });
const count = plays => toPossessions(summary({ plays })).count;

test('clockSec handles mm:ss and sub-minute seconds', () => {
  assert.equal(clockSec('11:45'), 705);
  assert.equal(clockSec('0:07'), 7);
  assert.equal(clockSec('45.3'), 45.3);
});

// ---- possessions (design §6.1) ----
test('made FG, defensive rebound and turnover each end a possession', () => {
  assert.deepEqual(count([
    p('Jump Shot', H, { made: true }),
    p('Jump Shot', A), p('Defensive Rebound', H),
    p('Lost Ball Turnover', H),
    end(),
  ]), { [H]: 2, [A]: 1 });
});

test('and-one: the free throw, not the basket, ends the possession', () => {
  const r = toPossessions(summary({ plays: [
    p('Jump Shot', H, { made: true, clock: '9:00' }),
    p('Shooting Foul', A, { clock: '9:00' }),
    p('Free Throw - 1 of 1', H, { made: true, clock: '9:00' }),
    p('Jump Shot', A, { made: true, clock: '8:40' }),
    end(),
  ] }));
  assert.deepEqual(r.count, { [H]: 1, [A]: 1 });
  assert.equal(r.possessions[0].points, 3);
});

// seen in 2025-11-05 ORL@ATL: technical FT and a dead-ball team rebound sit between basket and and-one FT
test('and-one is still found past a technical free throw and a team rebound at the same clock', () => {
  const r = toPossessions(summary({ plays: [
    p('Running Layup Shot', H, { made: true, clock: '2:27' }),
    p('Shooting Foul', A, { clock: '2:27' }),
    p('Hanging Technical Foul', A, { clock: '2:27' }),
    p('Free Throw - Technical', H, { clock: '2:27' }),
    p('Offensive Rebound', H, { clock: '2:27' }),
    p('Free Throw - 1 of 1', H, { made: true, clock: '2:27' }),
    p('Jump Shot', A, { made: true, clock: '2:10' }),
    end(),
  ] }));
  assert.deepEqual(r.count, { [H]: 1, [A]: 1 });
  assert.equal(r.possessions[0].points, 3);
});

test('missed and-one free throw then offensive rebound keeps the same possession', () => {
  assert.deepEqual(count([
    p('Jump Shot', H, { made: true, clock: '9:00' }),
    p('Shooting Foul', A, { clock: '9:00' }),
    p('Free Throw - 1 of 1', H, { clock: '9:00' }),
    p('Offensive Rebound', H),
    p('Jump Shot', H, { made: true }),
    end(),
  ]), { [H]: 1 });
});

test('only the final made free throw ends a trip; dead-ball team rebound between FTs is ignored', () => {
  const r = toPossessions(summary({ plays: [
    p('Shooting Foul', A),
    p('Free Throw - 1 of 2', H),
    p('Offensive Rebound', H), // team rebound, dead ball
    p('Free Throw - 2 of 2', H, { made: true }),
    p('Jump Shot', A, { made: true }),
    end(),
  ] }));
  assert.deepEqual(r.count, { [H]: 1, [A]: 1 });
});

test('three-shot foul: 1 of 3 and 2 of 3 do not end the possession', () => {
  assert.deepEqual(count([
    p('Free Throw - 1 of 3', H, { made: true }),
    p('Free Throw - 2 of 3', H, { made: true }),
    p('Free Throw - 3 of 3', H, { made: true }),
    p('Jump Shot', A, { made: true }),
    end(),
  ]), { [H]: 1, [A]: 1 });
});

test('missed final free throw goes to the rebound', () => {
  assert.deepEqual(count([
    p('Free Throw - 2 of 2', H),
    p('Defensive Rebound', A),
    p('Jump Shot', A, { made: true }),
    end(),
  ]), { [H]: 1, [A]: 1 });
});

test('technical free throws do not touch the possession in progress', () => {
  const r = toPossessions(summary({ plays: [
    p('Jump Shot', H), p('Offensive Rebound', H),
    p('Free Throw - Technical', A, { made: true }),
    p('Jump Shot', H, { made: true }),
    end(),
  ] }));
  assert.deepEqual(r.count, { [H]: 1 });
  assert.equal(r.possessions[0].points, 2);
});

test('open possession ends at end of period; each period restarts', () => {
  assert.deepEqual(count([
    p('Jump Shot', H, { period: 1 }), end(1),
    p('Jump Shot', A, { period: 2, made: true }), end(2),
  ]), { [H]: 1, [A]: 1 });
});

test('traveling is a turnover', () => {
  assert.deepEqual(count([p('Traveling', H), p('Jump Shot', A, { made: true }), end()]), { [H]: 1, [A]: 1 });
});

test('an unrecorded change of possession still closes the previous possession', () => {
  assert.deepEqual(count([
    p('Jump Shot', H), // miss, rebound missing from feed
    p('Jump Shot', A, { made: true }),
    end(),
  ]), { [H]: 1, [A]: 1 });
});

test('heave ends the possession at the buzzer but is not a box FGA', () => {
  const s = summary({ plays: [p('Heave Jump Shot', H, { pts: 3, x: 25, y: 70, clock: '0.2' }), end()] });
  assert.deepEqual(toPossessions(s).count, { [H]: 1 });
  const t = pbpTotals(s);
  assert.equal(t[H].fga, 0);
  assert.equal(t[H].heaves, 1);
});

// ---- totals and estimator ② ----
test('estimator ② adds live-ball team offensive rebounds and repairs broken box turnovers', () => {
  const s = summary({
    plays: [
      p('Jump Shot', H), p('Offensive Rebound', H), // team OREB after a live miss: counts
      p('Free Throw - 1 of 2', H), p('Offensive Rebound', H), // dead ball: does not count
      p('Free Throw - 2 of 2', H, { made: true }),
      p('Lost Ball Turnover', A), p('Lost Ball Turnover', A),
      end(),
    ],
    box: { [H]: { fg: [0, 1], ft: [1, 2], oreb: 0, tov: 0 }, [A]: { tov: 0, teamTov: 0 } },
  });
  const est = possessionEstimate(s);
  assert.equal(est[H].teamOrebLive, 1);
  assert.equal(+est[H].formula2.toFixed(2), +(1 - 1 + 0 + 0.44 * 2).toFixed(2));
  assert.equal(est[A].tovSource, 'pbp');
  assert.equal(est[A].formula2, 2);
  assert.equal(est[H].tovSource, 'box'); // box 0 and pbp 0: nothing to repair
});

// ---- shot zones ----
test('shot zones from coordinates (hoop at 25,1)', () => {
  assert.equal(shotZone(p('Jump Shot', H, { x: 25, y: 2 })), 'ra');
  assert.equal(shotZone(p('Jump Shot', H, { x: 21, y: 9 })), 'paint');
  assert.equal(shotZone(p('Jump Shot', H, { x: 10, y: 12 })), 'mid');
  assert.equal(shotZone(p('Jump Shot', H, { pts: 3, x: 48, y: 0 })), 'c3');
  assert.equal(shotZone(p('Jump Shot', H, { pts: 3, x: 25, y: 26 })), 'ab3');
  assert.equal(shotZone(p('Heave Jump Shot', H, { pts: 3, x: 25, y: 70 })), null);
  assert.equal(shotZone(p('Free Throw - 1 of 2', H)), null);
});

test('shot zone falls back to text distance without coordinates', () => {
  assert.equal(shotZone(p('Jump Shot', H, { dist: 2 })), 'ra');
  assert.equal(shotZone(p('Jump Shot', H, { dist: 16 })), 'mid');
  assert.equal(shotZone(p('Jump Shot', H, { pts: 3, dist: 25 })), 'ab3');
});

// ---- stints ----
const sub = (team, inn, out, o) => p('Substitution', team, { ids: [inn, out], text: `${inn} enters the game for ${out}`, ...o });

test('stints from starters and substitutions; minutes sum to 5 x period length', () => {
  const s = summary({
    roster: rosters({ H1: 12, H2: 12, H3: 12, H4: 12, H5: 6, H6: 6, A1: 12, A2: 12, A3: 12, A4: 12, A5: 12 }),
    plays: [p('Jump Shot', H, { ids: ['H1'] }), sub(H, 'H6', 'H5', { clock: '6:00' }), p('End Period', null, { clock: '0.0' })],
  });
  const r = toStints(s);
  assert.equal(r.stints.length, 2);
  assert.equal(r.seconds.H5, 360);
  assert.equal(r.seconds.H6, 360);
  assert.equal(r.teamMinutes[H], 60);
  assert.equal(r.teamMinutes[A], 60);
});

test('later periods: lineup inferred from first appearances, including players subbed out first', () => {
  const s = summary({
    roster: rosters(),
    plays: [
      end(1),
      sub(H, 'H6', 'H1', { period: 2, clock: '12:00' }),
      ...['H2', 'H3', 'H4', 'H5'].map(id => p('Jump Shot', H, { ids: [id], period: 2 })),
      ...['A1', 'A2', 'A3', 'A4', 'A5'].map(id => p('Jump Shot', A, { ids: [id], period: 2 })),
      end(2),
    ],
  });
  const r = toStints(s);
  const q2 = r.stints.filter(x => x.period === 2);
  assert.deepEqual(q2.at(-1).lineups[H].sort(), ['H2', 'H3', 'H4', 'H5', 'H6']);
  assert.equal(r.anomalies.periodLineupNot5, 0);
});

test('a substitution missing the entering player is repaired when that player acts', () => {
  const s = summary({
    roster: rosters(),
    plays: [
      p('Substitution', H, { ids: ['H5'], text: 'enters the game for H5', clock: '8:00' }),
      p('Jump Shot', H, { ids: ['H7'], clock: '7:00' }),
      end(),
    ],
  });
  const r = toStints(s);
  assert.equal(r.anomalies.subMissingPlayer, 1);
  assert.equal(r.anomalies.repairedByAction, 1);
  assert.equal(r.seconds.H7, 480); // credited back to the substitution at 8:00
  assert.equal(r.seconds.H5, 240);
  assert.ok(r.stints.every(x => x.lineups[H].length === 5));
  assert.ok(r.stints.every(x => x.complete));
});

test('an unrepaired substitution leaves flagged incomplete stints', () => {
  const s = summary({
    roster: rosters(),
    plays: [p('Substitution', H, { ids: ['H5'], text: 'enters the game for H5', clock: '8:00' }), end()],
  });
  const st = toStints(s);
  assert.deepEqual(st.stints.map(x => x.complete), [true, false]);
  const issue = checkIntegrity(s, { stints: st }).issues.find(x => x.code === 'incomplete_lineups');
  assert.match(issue.detail, /480s/);
});

test('a player acting without a recorded sub replaces the on-court player not seen again', () => {
  const s = summary({
    roster: rosters(),
    plays: [
      ...['H1', 'H2', 'H3', 'H4', 'H5'].map(id => p('Jump Shot', H, { ids: [id], clock: '11:00' })),
      p('Jump Shot', H, { ids: ['H8'], clock: '5:00' }), // H8 never subbed in
      ...['H1', 'H2', 'H3', 'H4'].map(id => p('Jump Shot', H, { ids: [id], clock: '2:00' })),
      end(),
    ],
  });
  const r = toStints(s);
  assert.equal(r.anomalies.unrecordedSub, 1);
  assert.ok(r.stints.every(x => x.lineups[H].length === 5));
  assert.equal(r.teamMinutes[H], 60);
});

// seen in 2026-10-20 PHI@NY: feed lists the turnover after the sub that removed its player, same clock
test('an action listed after its player was subbed out at the same clock is not an unrecorded sub', () => {
  const s = summary({
    roster: rosters(),
    plays: [
      p('Offensive Foul', H, { ids: ['H1'], clock: '8:46' }),
      sub(H, 'H6', 'H1', { clock: '8:46' }),
      p('Offensive Foul Turnover', H, { ids: ['H1'], clock: '8:46' }),
      end(),
    ],
  });
  const r = toStints(s);
  assert.equal(r.anomalies.unrecordedSub, 0);
  assert.equal(r.seconds.H1, 194);
  assert.equal(r.seconds.H6, 526);
});

test('fouls and technicals by bench players do not put them on court', () => {
  const s = summary({ roster: rosters(), plays: [p('Technical Foul', H, { ids: ['H8'] }), end()] });
  const r = toStints(s);
  assert.equal(r.seconds.H8 ?? 0, 0);
});

// ---- integrity ----
test('integrity: truncated play-by-play is detected from the final score', () => {
  const s = summary({ plays: [p('Jump Shot', H, { made: true }), end()], final: { [H]: 10, [A]: 0 } });
  assert.ok(checkIntegrity(s).issues.some(x => x.code === 'pbp_incomplete'));
  assert.equal(checkIntegrity(s).usable.pbp, false);
});

test('integrity: FGA mismatch ignores heaves; broken box turnovers are flagged', () => {
  const s = summary({
    plays: [p('Jump Shot', H), p('Heave Jump Shot', H, { pts: 3, x: 25, y: 70 }), p('Lost Ball Turnover', A), end()],
    box: { [H]: { fg: [0, 1] }, [A]: { tov: 0 } },
  });
  const r = checkIntegrity(s);
  assert.ok(!r.issues.some(x => x.code === 'fga_mismatch'));
  assert.ok(r.issues.some(x => x.code === 'box_tov_invalid' && x.team === A));
  assert.equal(r.usable.pbp, true);
});

// ---- real game fixture ----
test('real fixture: totals match the box and possessions are balanced', () => {
  const s = JSON.parse(gunzipSync(readFileSync(new URL('./fixtures/espn/summary_401909834.json.gz', import.meta.url))));
  const pt = pbpTotals(s), bt = boxTotals(s), est = possessionEstimate(s);
  const { count: c } = toPossessions(s);
  for (const t of Object.keys(bt)) {
    assert.equal(pt[t].fga, bt[t].fga, 'FGA');
    assert.equal(pt[t].fta, bt[t].fta, 'FTA');
    assert.ok(Math.abs(c[t] - est[t].formula2) / est[t].formula2 < 0.035, `possessions ${c[t]} vs ${est[t].formula2}`);
  }
  const [h, a] = Object.values(c);
  assert.ok(Math.abs(h - a) <= 2);
  const st = toStints(s);
  for (const m of Object.values(st.teamMinutes)) assert.ok(Math.abs(m - 240) < 1, `team minutes ${m}`);
  assert.equal(checkIntegrity(s, { stints: st }).issues.length, 0);
});
