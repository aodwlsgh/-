// Report edition of run C pinned to the cutoff hour's :30 report (2026-10-28 user decision 2): the edition the C
// validations used. Missing, late or broken -> no snapshot, no other edition; the C predictions are provisional.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCollector, injuryPdfName } from '../engine/collect.js';
import { pickSnapshot, PIN30, LATEST } from '../jobs/lib/live-collect.js';
import { searchAtOf, cPin, cMorningReport, runAt } from '../engine/trigger-time.js';
import { evaluate } from '../engine/picks.js';
import { pickRecord } from '../engine/pick-log.js';
import { IDENTITY } from '../engine/calibrate.js';
import { normCdf } from '../engine/predict.js';
import { stamp } from '../engine/clock.js';

// files: name -> { lm: Last-Modified ISO, rt: title time "MM/DD/YY hh:mm AM" (default from the name), bad: format error }
function collector(files) {
  const fetch = async url => {
    const name = url.split('/').pop(), f = files[name];
    return f ? { ok: true, status: 200, headers: { get: h => ({ 'content-type': 'application/pdf', 'last-modified': new Date(f.lm).toUTCString() })[h] ?? null }, arrayBuffer: async () => new TextEncoder().encode(name).buffer }
      : { ok: false, status: 404, headers: { get: () => 'application/xml' } };
  };
  return createCollector({ fetch, sleep: async () => {}, perSecond: 1e6 });
}
const titleOf = name => { const m = name.match(/_(\d{4})-(\d{2})-(\d{2})_(\d{2})(?:_(\d{2}))?(AM|PM)/); return `${m[2]}/${m[3]}/${m[1].slice(2)} ${m[4]}:${m[5] ?? '30'} ${m[6]}`; };
const parserFor = files => async bytes => {
  const name = new TextDecoder().decode(bytes), f = files[name];
  if (f.bad) { const { PdfFormatError } = await import('../engine/injury.js'); throw new PdfFormatError('broken'); }
  return { reportTime: f.rt ?? titleOf(name), rows: [], notSubmitted: [], issues: [] };
};
const pick = (files, date, at, pin, steps = pin ? 4 : 16) => pickSnapshot(collector(files).injuryPdfsBefore(at, { maxSteps: steps }), { at, gameDate: date, parse: parserFor(files), pin });
const name = (date, h, m) => injuryPdfName({ date, hour: h, minute: m });

test('15-minute reports: pin30 takes the :30 report, latest the newest one out by the cutoff', async () => {
  const date = '2026-11-01', at = searchAtOf('C', date, '2026-11-01T12:50:40Z'); // 07:50 EST
  const files = { [name(date, 7, 45)]: { lm: '2026-11-01T12:47:00Z' }, [name(date, 7, 30)]: { lm: '2026-11-01T12:31:00Z' }, [name(date, 7, 15)]: { lm: '2026-11-01T12:16:00Z' } };
  assert.equal((await pick(files, date, at, null)).pdf, name(date, 7, 45), 'latest');
  const s = await pick(files, date, at, cPin(date));
  assert.equal(s.pdf, name(date, 7, 30), 'pin30');
  assert.equal(s.reportTime, '11/01/26 07:30 AM');
  assert.deepEqual(cMorningReport(s, date, at), { ok: true, why: null });
});

test(':30 report missing, late or broken: no snapshot and no other edition; C is provisional', async () => {
  const date = '2026-11-01', at = searchAtOf('C', date, '2026-11-01T12:50:40Z');
  const missing = await pick({ [name(date, 7, 45)]: { lm: '2026-11-01T12:47:00Z' }, [name(date, 7, 15)]: { lm: '2026-11-01T12:16:00Z' } }, date, at, cPin(date));
  assert.equal(missing.pdf, null);
  assert.equal(missing.pinMiss, 'missing');
  assert.deepEqual(cMorningReport(missing, date, at), { ok: false, why: ':30판 없음' });
  const nothing = await pick({}, date, at, cPin(date));
  assert.equal(nothing.pinMiss, 'missing');
  const late = await pick({ [name(date, 7, 30)]: { lm: '2026-11-01T12:52:00Z' }, [name(date, 7, 15)]: { lm: '2026-11-01T12:16:00Z' } }, date, at, cPin(date));
  assert.equal(late.pdf, null, 'the 07:15 report is not taken instead');
  assert.equal(late.pinMiss, 'late');
  assert.match(cMorningReport(late, date, at).why, /^:30판이 기준 시각 뒤에 나옴/);
  const bad = await pick({ [name(date, 7, 30)]: { lm: '2026-11-01T12:31:00Z', bad: true } }, date, at, cPin(date));
  assert.equal(bad.pinMiss, 'format error');
  assert.equal(cMorningReport(bad, date, at).ok, false);
});

test('daylight-time boundary: the 21:50 KST run C reads the 08:30 report on 10-30 and 10-31, the 07:30 report on 11-01 and 11-02', async () => {
  for (const [now, date, h] of [['2026-10-30T12:50:40Z', '2026-10-30', 8], ['2026-10-31T12:50:40Z', '2026-10-31', 8], ['2026-11-01T12:50:40Z', '2026-11-01', 7], ['2026-11-02T12:51:30Z', '2026-11-02', 7]]) {
    const at = searchAtOf('C', date, now);
    assert.equal(at.getTime(), runAt('C', date).getTime());
    const files = {};
    for (const [hh, mm] of [[h, 45], [h, 30], [h, 15], [h, 0], [h - 1, 30]]) files[name(date, hh, mm)] = { lm: new Date(runAt('C', date).getTime() - (50 - mm) * 60e3 - (h - hh) * 3600e3 + 60e3).toISOString() };
    const s = await pick(files, date, at, cPin(date));
    assert.equal(s.pdf, name(date, h, 30), date);
    assert.equal(cMorningReport(s, date, at).ok, true, date);
  }
});

test('2024-25 hourly files: pin30 picks the file the C validations used (08:50 and 07:50 ET)', async () => {
  for (const date of ['2024-11-12', '2025-01-15', '2025-03-20']) {
    for (const [dir, hour] of [['data/injury-pdf-c', 8], ['data/injury-pdf-c0750', 7]]) {
      const rec = JSON.parse(gunzipSync(readFileSync(`${dir}/2024-25/${date}.json.gz`)));
      const v = rec.snap;
      const files = { [v.pdf]: { lm: v.lastModified, rt: v.reportTime } };
      for (const hh of [hour - 1, hour - 2]) files[name(date, hh, 0)] = { lm: new Date(Date.parse(v.lastModified) - (hour - hh) * 3600e3).toISOString() };
      const at = new Date(rec.cutoff);
      const s = await pick(files, date, at, { date, hour, minute: 30 });
      assert.equal(s.pdf, v.pdf, `${dir} ${date}`);
      assert.equal(s.reportTime, v.reportTime);
      assert.equal(hour === 8 ? cPin(date).hour : 7, hour, 'cPin of a date before 2026-11-01 is the 08:30 report');
    }
  }
});

test('evaluation and pick records name the report edition and the rule (pin30 or latest)', () => {
  const p = [], tp = [];
  for (let k = -60; k <= 60; k++) p.push(normCdf((k + 0.5 - 6) / 13) - normCdf((k - 0.5 - 6) / 13));
  for (let k = 150; k <= 300; k++) tp.push(normCdf((k + 0.5 - 226) / 18) - normCdf((k - 0.5 - 226) / 18));
  const report = { rule: PIN30, pdf: 'Injury-Report_2026-11-01_07_30AM.pdf', reportTime: '11/01/26 07:30 AM' };
  const pred = { source: 'base', runId: 'x', run: 'C', final: true, report, gameId: 'g', sim: { margin: 6, total: 226, marginHist: { lo: -60, p }, totalHist: { lo: 150, p: tp }, shift: 0 } };
  const odds = { type: 'odds', round: 1, betmanNo: 1, gameId: 'g', market: 'ML', line: null, odds: { home: 2.2, away: 1.7 }, deadline: stamp('2026-11-02T00:00:00Z') };
  const rows = evaluate([odds], [pred], IDENTITY, { now: new Date('2026-11-01T13:00:00Z') });
  assert.ok(rows.every(r => r.predictionReport === report));
  const leg = rows.find(r => r.ev >= 0.03);
  assert.ok(leg, 'a candidate leg');
  assert.deepEqual(pickRecord(leg, { now: new Date('2026-11-01T13:00:00Z') }).predictionReport, report);
  assert.equal(LATEST, 'latest');
});

test('prepare C (offline) records the rule and the report on every prediction', () => {
  const out = mkdtempSync(join(tmpdir(), 'p30-'));
  const r = spawnSync(process.execPath, ['jobs/daily.js', 'prepare', 'C', '--offline', '--season', '2024-25', '--date', '2025-02-12', '--now', '2025-02-12T14:00:00Z', '--n', '200', '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const day = JSON.parse(readFileSync(join(out, 'data/live/today.json'), 'utf8'));
  assert.ok(day.games.every(g => g.prediction.report.rule === PIN30 && g.prediction.report.reportTime === '02/12/25 08:30 AM'), JSON.stringify(day.games[0].prediction.report));
});
