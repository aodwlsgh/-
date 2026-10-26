// P9 daily job end to end, offline, on the 2024-25 example day (2025-02-12): run A then run B, sensitivity, mark,
// report. Output goes to a temporary directory; nothing in the repository changes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { forbiddenIn, TEXT } from '../engine/dashboard-data.js';
import { filesHash } from '../jobs/lib/provenance.js';

let out, hashes, example;
const FITTED = ['data/model/params.json', 'data/model/latent.json', 'data/model/calibration.json', 'data/model/play-prob.json', 'docs/reports/tuning-ledger.json'];
const daily = (...args) => {
  const r = spawnSync(process.execPath, ['jobs/daily.js', ...args, '--out', out], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const json = async p => JSON.parse(await readFile(join(out, p), 'utf8'));

before(async () => {
  out = await mkdtemp(join(tmpdir(), 'p9-daily-'));
  hashes = await filesHash(FITTED);
  example = JSON.parse(await readFile('data/live/example-day.json', 'utf8'));
});
after(async () => { await rm(out, { recursive: true, force: true }); });

test('run A (18:00 ET): every game after 17:50 ET predicted, A-group final, B-group provisional; plans as validated', async () => {
  const s = JSON.parse(daily('prepare', 'A', '--offline', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-12T23:00:00Z', '--n', '1000'));
  assert.equal(s.ok, true);
  const day = await json('data/live/today.json');
  assert.equal(day.kind, 'live');
  assert.equal(day.games.length, example.games.length);
  for (const g of day.games) {
    assert.equal(g.prediction.final, g.group === 'A', g.gameId);
    const e = example.games.find(x => x.gameId === g.gameId);
    if (g.group === 'A') assert.deepEqual([g.simInput.homePlan, g.simInput.awayPlan], [e.simInput.homePlan, e.simInput.awayPlan]); // B games: run A snapshot, provisional
    assert.equal(g.parallel, null, 'offline: no ESPN feed, no parallel record');
  }
  const log = await json(`data/runs/2024-25/${day.runId}.json`);
  assert.equal(log.runId, '2025-02-12-A-1800');
  assert.ok((await readdir(join(out, 'data/predictions/2024-25'))).includes(`${day.runId}.json.gz`));
});

test('a run before its time publishes every prediction as provisional', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'p9-early-'));
  const r = spawnSync(process.execPath, ['jobs/daily.js', 'prepare', 'A', '--offline', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-12T15:00:00Z', '--n', '200', '--out', dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const day = JSON.parse(await readFile(join(dir, 'data/live/today.json'), 'utf8'));
  assert.ok(day.games.every(g => g.prediction.final === false));
  await rm(dir, { recursive: true, force: true });
});

test('run B (20:55 ET): B-group final from run B, run A games carried with their run A prediction', async () => {
  daily('mark', 'published', '--at', '2025-02-12T23:05:00Z');
  const a = await json('data/live/today.json');
  daily('prepare', 'B', '--offline', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-13T01:55:00Z', '--n', '1000');
  const b = await json('data/live/today.json');
  assert.equal(b.games.length, a.games.length);
  for (const g of b.games) {
    if (g.group === 'B') {
      assert.equal(g.prediction.run, 'B'); assert.equal(g.prediction.final, true);
      const e = example.games.find(x => x.gameId === g.gameId);
      assert.deepEqual([g.simInput.homePlan, g.simInput.awayPlan], [e.simInput.homePlan, e.simInput.awayPlan]); // the 20:50 ET snapshot, as validated
    } else {
      const x = a.games.find(y => y.gameId === g.gameId);
      assert.deepEqual(g.prediction, x.prediction);
      assert.deepEqual(g.simInput.homePlan, x.simInput.homePlan);
    }
  }
});

test('sensitivity, a failed write mark and the report: alerts shown, no odds reads "배당 미입력", fitted files untouched', async () => {
  daily('sensitivity', '--n', '200');
  const d = await json('data/live/today.json');
  assert.ok(d.games.filter(g => g.prediction.run === 'B').every(g => g.sensitivity?.label === 'unverified'));
  daily('mark', 'db', JSON.stringify({ ok: false, reason: 'retries exhausted', markets: 2 }));
  const md = daily('report');
  assert.match(md, /픽 로그 쓰기 실패 — retries exhausted/);
  assert.match(md, new RegExp(TEXT.noOdds));
  assert.ok(md.includes('- 승5패: 베트맨 미제공 — 평가 안 함'), 'the report says 승5패 is not offered (2026-10-23 approval)');
  assert.match(md, /- 언더오버 총점 편향\(실제 − 예측, 경기당 평균\), 평가한 경기: /, 'the bias is a per-game mean, labelled so (2026-10-26 decision 8)');
  assert.ok(!md.includes(TEXT.pass));
  assert.deepEqual(forbiddenIn(md), []);
  const day = await json('data/live/today.json');
  assert.ok(day.alerts.some(a => a.code === 'db'));
  const arch = JSON.parse(gunzipSync(await readFile(join(out, `data/predictions/2024-25/${(await readdir(join(out, 'data/predictions/2024-25'))).find(f => f.includes('-A-'))}`))));
  assert.equal(arch.publishedAt.utc, '2025-02-12T23:05:00.000Z');
  assert.deepEqual(await filesHash(FITTED), hashes, 'the daily job fits nothing');
});
