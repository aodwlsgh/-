// Automatic run checks (docs/plans/2026-11-13-auto-alerts.md, registered 13d9e15, revised 9e36947): runEarly,
// missedRun, finalZero. Warnings only: the prediction archive of a run is the same with or without a warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { runEarly, missedRun, finalZero, escalate, PUSH_AT_ONCE } from '../engine/run-alerts.js';
import { runAt } from '../engine/trigger-time.js';

const min = m => m * 60000;
const startAt = (run, date, earlyMin) => new Date(runAt(run, date).getTime() - min(earlyMin));

test('runEarly boundaries: 4:59 early no, 5 yes, 180 yes, 181 and 600 yes (no upper bound); late starts never', () => {
  const d = '2026-11-12';
  for (const run of ['A', 'B', 'C']) {
    assert.equal(runEarly({ run, date: d, startedAt: new Date(runAt(run, d) - (min(5) - 1000)) }), null, `${run} 4:59`);
    for (const m of [5, 180, 181, 600]) {
      const a = runEarly({ run, date: d, startedAt: startAt(run, d, m) });
      assert.equal(a?.code, 'runEarly', `${run} ${m}`);
      assert.equal(a.earlyMin, m);
    }
    for (const late of [0, 2, 30, 180]) assert.equal(runEarly({ run, date: d, startedAt: startAt(run, d, -late) }), null, `${run} +${late}`);
    assert.equal(runEarly({ run, date: d, startedAt: startAt(run, d, 60), manual: true }), null, 'manual runs are not checked');
  }
  assert.match(runEarly({ run: 'A', date: d, startedAt: startAt('A', d, 60) }).text, /실행 A가 기준 시각\(17:50 ET\)보다 60분 일찍/);
  assert.ok(PUSH_AT_ONCE.has('runEarly') && PUSH_AT_ONCE.has('missedRun') && PUSH_AT_ONCE.has('finalZero'));
});

test('runEarly on the real 2026 records: every A/B of 11-01..11-06 and 11-10 is caught, no C and no run since 11-11', async () => {
  const dir = 'data/runs/2026-27';
  // the two manual runs of 10-23 (B 05:37 ET) and 10-27 (A 02:32 ET) came before the --manual flag existed
  const MANUAL = ['2026-10-23-B-0537.json', '2026-10-27-A-0232.json'];
  const all = (await readdir(dir)).filter(f => f >= '2026-10-23' && f.endsWith('.json'));
  for (const f of MANUAL) assert.ok(all.includes(f), f);
  const logs = all.filter(f => !MANUAL.includes(f));
  const hits = [];
  for (const f of logs) {
    const l = JSON.parse(await readFile(join(dir, f), 'utf8'));
    if (runEarly({ run: l.run, date: l.date, startedAt: l.startedAt.utc })) hits.push(`${l.date}-${l.run}`);
  }
  const want = [];
  for (const d of ['01', '02', '03', '04', '05', '06', '10']) for (const r of ['A', 'B']) if (logs.some(f => f.startsWith(`2026-11-${d}-${r}-`))) want.push(`2026-11-${d}-${r}`);
  assert.deepEqual(hits.sort(), want.sort());
  assert.ok(want.length >= 12, `${want.length}`);
});

test('runEarly across the DST changes: schedule changed or not (KST-fixed tasks)', () => {
  const kst = (date, hhmm) => new Date(`${date}T${hhmm}:00+09:00`);
  // after 2026-11-01 (EST): unchanged 06:50/09:50 KST is 60 min early; changed 07:50/10:50 is on time
  assert.equal(runEarly({ run: 'A', date: '2026-11-02', startedAt: kst('2026-11-03', '06:50') }).earlyMin, 60);
  assert.equal(runEarly({ run: 'B', date: '2026-11-02', startedAt: kst('2026-11-03', '09:50') }).earlyMin, 60);
  assert.equal(runEarly({ run: 'A', date: '2026-11-02', startedAt: kst('2026-11-03', '07:50') }), null);
  // before the change (EDT, 10-31): 06:50 KST = 17:50 EDT on time
  assert.equal(runEarly({ run: 'A', date: '2026-10-31', startedAt: kst('2026-11-01', '06:50') }), null);
  // after 2027-03-14 (EDT): unchanged 07:50/10:50 KST is 60 min late (not this warning); changed back 06:50 on time
  assert.equal(runEarly({ run: 'A', date: '2027-03-15', startedAt: kst('2027-03-16', '07:50') }), null);
  assert.equal(runEarly({ run: 'A', date: '2027-03-15', startedAt: kst('2027-03-16', '06:50') }), null);
  // C stays at 07:50 ET: 21:50 KST is on time in EST and an hour late in EDT
  assert.equal(runEarly({ run: 'C', date: '2026-11-12', startedAt: kst('2026-11-12', '21:50') }), null);
  assert.equal(runEarly({ run: 'C', date: '2027-03-15', startedAt: kst('2027-03-15', '21:50') }), null);
});

const presentFrom = files => (r, d) => files.some(f => f.startsWith(`${d}-${r}-`));

test('missedRun cross-checks: A sees B(d-1) and C(d), B sees A(d), C sees A·B(d-1); none when all are there', () => {
  const all = ['2026-11-11-C-0751', '2026-11-11-A-1752', '2026-11-11-B-2051', '2026-11-12-C-0752', '2026-11-12-A-1751', '2026-11-12-B-2051'];
  const e = '2026-11-11';
  assert.equal(missedRun({ run: 'A', date: '2026-11-12', present: presentFrom(all), earliest: e }), null);
  assert.equal(missedRun({ run: 'B', date: '2026-11-12', present: presentFrom(all), earliest: e }), null);
  assert.equal(missedRun({ run: 'C', date: '2026-11-13', present: presentFrom(all), earliest: e }), null);
  const noB = all.filter(f => f !== '2026-11-11-B-2051');
  assert.deepEqual(missedRun({ run: 'A', date: '2026-11-12', present: presentFrom(noB), earliest: e }).missing, [{ run: 'B', date: '2026-11-11' }]);
  assert.deepEqual(missedRun({ run: 'C', date: '2026-11-12', present: presentFrom(noB), earliest: e }).missing, [{ run: 'B', date: '2026-11-11' }]);
  const noAB = all.filter(f => !f.startsWith('2026-11-12-A') && !f.startsWith('2026-11-12-B'));
  assert.deepEqual(missedRun({ run: 'C', date: '2026-11-13', present: presentFrom(noAB), earliest: e }).missing, [{ run: 'A', date: '2026-11-12' }, { run: 'B', date: '2026-11-12' }]);
  const noC = all.filter(f => f !== '2026-11-12-C-0752');
  assert.deepEqual(missedRun({ run: 'A', date: '2026-11-12', present: presentFrom(noC), earliest: e }).missing, [{ run: 'C', date: '2026-11-12' }]);
  assert.equal(missedRun({ run: 'B', date: '2026-11-12', present: presentFrom(noC), earliest: e }), null, 'B looks at A(d) only');
  assert.equal(missedRun({ run: 'A', date: '2026-11-12', present: () => false, earliest: null }), null, 'season first run');
  assert.equal(missedRun({ run: 'C', date: '2026-11-11', present: presentFrom([]), earliest: '2026-11-11' }), null, 'nothing before the first log');
});

test('missedRun reproduces the 11-07..11-10 outage from the real run logs: 9 runs at 11-10 A, pushed at once', async () => {
  const files = (await readdir('data/runs/2026-27')).filter(f => f.endsWith('.json') && f < '2026-11-10-A');
  const m = missedRun({ run: 'A', date: '2026-11-10', present: presentFrom(files), earliest: files.sort()[0].slice(0, 10) });
  assert.deepEqual(m.missing.map(x => `${x.date} ${x.run}`), ['2026-11-07 A', '2026-11-07 B', '2026-11-08 C', '2026-11-08 A', '2026-11-08 B', '2026-11-09 C', '2026-11-09 A', '2026-11-09 B', '2026-11-10 C']);
  assert.match(m.text, /빠진 실행 9개/);
  // a no-game day or B "대상 없음" still leaves a run log, so such a day is not missing
  const withNote = [...files, '2026-11-10-C-0751.json'];
  assert.equal(missedRun({ run: 'B', date: '2026-11-10', present: presentFrom([...withNote, '2026-11-10-A-1651.json']), earliest: '2026-10-23' }), null);
});

test('finalZero: own-group games all provisional; not on no-game days, B "대상 없음" or run C; first time pushed', () => {
  const g = (group, run, final) => ({ group, run, final });
  assert.equal(finalZero({ run: 'A', games: [g('A', 'A', true), g('B', 'A', false)] }), null);
  assert.equal(finalZero({ run: 'A', games: [g('A', 'A', false), g('B', 'A', false)] }).games, 1);
  assert.equal(finalZero({ run: 'A', games: [g('B', 'A', false)] }), null, 'no A-group game');
  assert.equal(finalZero({ run: 'A', games: [] }), null, 'no-game day');
  assert.equal(finalZero({ run: 'B', games: [g('A', 'A', true)] }), null, 'B "대상 없음": only carried run A games');
  assert.equal(finalZero({ run: 'B', games: [g('A', 'A', false), g('B', 'B', false)] }).chip, '시각 오류 의심');
  assert.equal(finalZero({ run: 'C', games: [g('A', 'C', false)] }), null);
  // streak: a no-game day between two finalZero days neither counts nor breaks it
  const earlier = [
    { run: 'A', games: [g('A', 'A', false)], alerts: [{ code: 'finalZero' }] },
    { run: 'A', games: [], alerts: [] },
  ];
  const e = escalate([finalZero({ run: 'A', games: [g('A', 'A', false)] })], earlier, 'A');
  assert.equal(e.alerts[0].streak, 2);
  assert.deepEqual(e.push, [], 'pushed by prepare from the first time, not again by escalate');
});

test('prepare: early run and missing earlier runs warn and push; the prediction archive is byte-identical', async () => {
  const run = async seed => {
    const dir = await mkdtemp(join(tmpdir(), 'p9-alerts-'));
    if (seed) { await mkdir(join(dir, 'data/runs/2024-25'), { recursive: true }); await writeFile(join(dir, 'data/runs/2024-25/2025-02-10-B-2051.json'), JSON.stringify({ run: 'B', date: '2025-02-10', startedAt: { utc: '2025-02-11T01:51:00Z' }, alerts: [], games: [] })); }
    const r = spawnSync(process.execPath, ['jobs/daily.js', 'prepare', 'A', '--offline', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-12T21:50:00Z', '--n', '200', '--out', dir], { encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout.trim().split('\n').at(-1));
    const arch = (await readdir(join(dir, 'data/predictions/2024-25')))[0];
    const bytes = gunzipSync(await readFile(join(dir, 'data/predictions/2024-25', arch)));
    const day = JSON.parse(await readFile(join(dir, 'data/live/today.json'), 'utf8'));
    await rm(dir, { recursive: true, force: true });
    return { out, bytes, games: JSON.stringify(day.games), codes: day.alerts.map(a => a.code) };
  };
  const quiet = await run(false), loud = await run(true);
  assert.ok(loud.codes.includes('runEarly') && loud.codes.includes('missedRun') && loud.codes.includes('finalZero'), loud.codes.join());
  assert.ok(!quiet.codes.includes('missedRun'), 'season first run: no missedRun');
  assert.equal(loud.out.push.filter(t => /일찍 돌았|빠진 실행|시각 오류 의심/.test(t)).length, 3);
  assert.ok(Buffer.compare(quiet.bytes, loud.bytes) === 0, 'prediction archive identical');
  assert.equal(quiet.games, loud.games);
});
