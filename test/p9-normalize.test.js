// 2026-10-26 user decisions 2-8: input normalizers in new files (frozen engine/jobs files untouched), the PDF Out
// warning, escalation of repeated warnings, the raw ESPN feed path and the per-game bias label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { aliasPlayTypes, aliasingCache, PLAY_TYPE_ALIASES } from '../engine/schema/play-type-aliases.js';
import { assertValid, SchemaError } from '../engine/schema/espn.js';
import { createCollector } from '../engine/collect.js';
import { extractGame } from '../engine/extract.js';
import { normalizeSeason } from '../jobs/normalize-raw.js';
import { rejoinSplitAccents, normalizePdfRows } from '../engine/pdf-names.js';
import { snapshotInjuries } from '../engine/snapshot.js';
import { pdfOutUnmatched, escalate } from '../engine/run-alerts.js';
import { paths } from '../jobs/daily.js';
import { allowed } from '../jobs/lib/commit-guard.js';
import { TEXT } from '../engine/dashboard-data.js';

const fx = name => JSON.parse(gunzipSync(readFileSync(new URL(`./fixtures/espn/${name}`, import.meta.url))));
const memCache = () => { const m = new Map(); return { m, get: async k => m.get(k), set: async (k, v) => { m.set(k, v); } }; };

test('play type 17 "Short Timeout" is mapped to 16 explicitly; the raw game fails validation, the mapped one passes', () => {
  const raw = fx('summary_401909852.json.gz');
  assert.throws(() => assertValid('summary', raw), e => e instanceof SchemaError && /unknown play type id "17" "Short Timeout"/.test(e.message));
  const { summary, mapped } = aliasPlayTypes(raw);
  assert.deepEqual(mapped, [{ playId: '401909852354', from: '17', to: '16', text: 'Short Timeout' }]);
  assert.doesNotThrow(() => assertValid('summary', summary));
  const p = summary.plays.find(x => x.id === '401909852354');
  assert.deepEqual([p.type.id, p.type.text, p.text], ['16', 'Full Timeout', 'Kings 20 Sec. timeout']);
  assert.equal(raw.plays.find(x => x.id === '401909852354').type.id, '17', 'the input is not modified');
  assert.deepEqual(Object.keys(PLAY_TYPE_ALIASES), ['17']);
});

test('an alias needs the same text; games without aliased types come back as the same object', () => {
  const raw = fx('summary_401909852.json.gz');
  const other = { ...raw, plays: raw.plays.map(p => (p.type.id === '17' ? { ...p, type: { id: '17', text: 'Something Else' } } : p)) };
  assert.deepEqual(aliasPlayTypes(other).mapped, []);
  assert.throws(() => assertValid('summary', aliasPlayTypes(other).summary), SchemaError);
  for (const f of ['summary_401909834.json.gz', 'summary_401705129_2024-25.json.gz']) {
    const s = fx(f);
    const r = aliasPlayTypes(s);
    assert.equal(r.summary, s, f);
    assert.deepEqual(r.mapped, [], f);
  }
});

test('a finished game with play type 17 is collected: cached with the alias, then read and extracted as build-data does', async () => {
  const raw = fx('summary_401909852.json.gz');
  const inner = memCache(), log = [];
  const fetch = async url => {
    assert.match(url, /summary\?event=401909852$/);
    return { ok: true, status: 200, headers: new Map(), json: async () => structuredClone(raw) };
  };
  const col = createCollector({ fetch, cache: aliasingCache(inner, (id, plays) => log.push({ id, plays })), sleep: async () => {} });
  const sched = { list: [{ id: '401909852', usDate: '20261023', status: 'STATUS_FINAL' }, { id: 'x', usDate: '20261024', status: 'STATUS_FINAL' }] };
  const r = await normalizeSeason({ sched, count: async d => (d === '20261024' ? 1 : 0), col });
  assert.deepEqual(r, { checked: 1, unknown: [] });
  assert.deepEqual(log, [{ id: '401909852', plays: [{ playId: '401909852354', from: '17', to: '16', text: 'Short Timeout' }] }]);
  // jobs/build-data.js reads the same cache with a plain collector
  const plain = createCollector({ cache: inner, fetch: async () => { throw new Error('no network expected'); } });
  const s = await plain.game('401909852');
  const g = extractGame(s);
  assert.equal(g.id, '401909852');
  assert.deepEqual([g.away.abbr, g.home.abbr], ['POR', 'SAC']);
});

test('split accents are rejoined: the López rows of 2026-10-25 now match the player', async () => {
  assert.equal(rejoinSplitAccents('L ó pez, Karim'), 'López, Karim');
  assert.equal(rejoinSplitAccents('Jos é, Juan'), 'José, Juan');
  assert.equal(rejoinSplitAccents('Á lvarez, Juan'), 'Álvarez, Juan');
  for (const n of ['Lopez, Karim', 'Dončić, Luka', 'Jokić, Nikola', 'Pierre Jr., Jaron', 'Nance Jr., Larry', 'Antetokounmpo, Giannis', 'Ó, Á']) assert.equal(rejoinSplitAccents(n), n);
  const rec = JSON.parse(gunzipSync(readFileSync(new URL('../data/injury-pdf/2026-27/2026-10-25.json.gz', import.meta.url))));
  const found = [];
  for (const [snap, status] of [[rec.main, 'Questionable'], [rec.runB, 'Out']]) {
    const before = snap.rows.filter(r => r.player === 'L ó pez, Karim');
    assert.equal(before.length, 1);
    const { rows, fixes } = normalizePdfRows(snap.rows);
    assert.deepEqual(fixes, [{ team: 'Memphis Grizzlies', from: 'L ó pez, Karim', to: 'López, Karim' }]);
    const players = [{ id: '5231919', name: 'Karim Lopez' }];
    const was = snapshotInjuries({ ...snap, rows: snap.rows }, { team: 'MEM', home: 'SAC', away: 'MEM', players });
    const now = snapshotInjuries({ ...snap, rows }, { team: 'MEM', home: 'SAC', away: 'MEM', players });
    assert.equal(was.injuries['5231919'], undefined);
    assert.ok(was.unmatched.includes('L ó pez, Karim'));
    assert.equal(now.injuries['5231919'], status === 'Out' ? 0 : 0.53);
    assert.ok(!now.unmatched.includes('López, Karim'));
    found.push(status);
  }
  assert.deepEqual(found, ['Questionable', 'Out'], 'both 2026-27 rows (run A and run B reports)');
});

test('every PDF player row of 2023-24, 2024-25 and 2025-26 passes the normalizer byte-identical', () => {
  let rows = 0;
  const walk = (o, f) => { if (Array.isArray(o)) { if (o.some(x => typeof x?.player === 'string')) f(o); else o.forEach(x => walk(x, f)); } else if (o && typeof o === 'object') Object.values(o).forEach(x => walk(x, f)); };
  for (const s of ['2023-24', '2024-25', '2025-26']) {
    const dir = new URL(`../data/injury-pdf/${s}/`, import.meta.url);
    for (const f of readdirSync(dir).filter(x => x.endsWith('.json.gz'))) {
      const j = JSON.parse(gunzipSync(readFileSync(new URL(f, dir))));
      walk(j, arr => {
        const r = normalizePdfRows(arr);
        assert.deepEqual(r.fixes, [], `${s}/${f}`);
        assert.equal(JSON.stringify(r.rows), JSON.stringify(arr), `${s}/${f}`);
        rows += arr.length;
      });
    }
  }
  assert.equal(rows, 103921);
});

const lpRow = (unmatched, players) => ({ fixture: { id: 'g1', home: { abbr: 'SAC' }, away: { abbr: 'MEM' } }, players: [[], players], snapshot: { home: { unmatched: [] }, away: { unmatched } } });

test('PDF Out rows not matched: a known player under another spelling warns; one with no game record is only logged', () => {
  const pdf = [
    { team: 'Memphis Grizzlies', player: 'L ó pez, Karim', status: 'Out' },
    { team: 'Memphis Grizzlies', player: 'Small, Javon', status: 'Out' },
    { team: 'Memphis Grizzlies', player: 'Somebody, New', status: 'Questionable' },
  ];
  const r = pdfOutUnmatched([lpRow(['L ó pez, Karim', 'Small, Javon', 'Somebody, New'], [{ id: '5231919', name: 'Karim Lopez' }])], pdf);
  assert.deepEqual(r.known, [{ gameId: 'g1', game: 'MEM@SAC', team: 'MEM', player: 'L ó pez, Karim', playerId: '5231919', known: 'Karim Lopez' }]);
  assert.deepEqual(r.noRecord, [{ gameId: 'g1', game: 'MEM@SAC', team: 'MEM', player: 'Small, Javon' }]);
});

test('a warning in two runs in a row is escalated: data delay against the previous run A, PDF names against the previous run', () => {
  const dd = { code: 'dataDelay', text: '데이터 지연' }, pu = { code: 'pdfUnmatched', text: 'PDF 선수 못 찾음' };
  const logs = [{ run: 'A', alerts: [dd] }, { run: 'B', alerts: [] }];
  let r = escalate([dd], logs, 'A');
  assert.deepEqual(r.alerts, [{ ...dd, escalated: true, streak: 2 }]);
  assert.deepEqual(r.push, ['[NBA 일일 실행] 2회 연속 경고 — 데이터 지연']);
  assert.deepEqual(escalate([dd], [{ run: 'A', alerts: [] }, { run: 'B', alerts: [] }], 'A'), { alerts: [dd], push: [] });
  r = escalate([pu], [{ run: 'A', alerts: [pu] }, { run: 'B', alerts: [pu] }], 'A');
  assert.equal(r.alerts[0].streak, 3);
  assert.deepEqual(escalate([pu], [{ run: 'A', alerts: [pu] }, { run: 'B', alerts: [] }], 'A'), { alerts: [pu], push: [] });
  assert.deepEqual(escalate([{ code: 'schema', text: 'x' }], logs, 'A').push, [], 'other codes are not escalated');
});

test('the raw ESPN feed is kept under an allowed path; the bias is labelled as a per-game mean', () => {
  const p = paths('2026-27').espn;
  assert.equal(p, 'data/injury-pdf/2026-27/espn-feed');
  assert.equal(allowed(`${p}/2026-10-26-A-1750.json.gz`), true);
  assert.match(TEXT.biasLabel, /경기당 평균/);
});
