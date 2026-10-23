// Dashboard browser tests (P8; 2026-10-23 user conditions 2-5, 7, 8). Chromium, fake artifact database.
// Run: cd tools/browser && npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { launch, open, tab, liveDay, closeAll } from './harness.mjs';
import { FORBIDDEN, TEXT } from '../../engine/dashboard-data.js';
import { stamp } from '../../engine/clock.js';

let browser;
before(async () => { browser = await launch(); });
after(async () => { await closeAll(); await browser?.close(); });

const TABS = ['today', 'detail', 'odds', 'record', 'model'];
const forbidden = text => FORBIDDEN.filter(re => re.test(text)).map(String);
const controls = page => page.$$eval('button, a, [role=button], input[type=button], input[type=submit]', els => els.map(e => (e.textContent || e.value || e.getAttribute('aria-label') || '').trim()));
const kstLocal = t => stamp(t).kst.slice(0, 16);

async function enterOdds(page, day, rows, round = 901) {
  await tab(page, 'odds');
  await page.fill('#o-round', String(round));
  for (let i = 0; i < rows.length; i++) {
    if (i > 0) await page.click('#o-add');
    const r = rows[i], g = day.games[r.game];
    await page.selectOption(`#o-${i}-game`, String(r.game));
    await page.fill(`#o-${i}-no`, String(r.no));
    await page.selectOption(`#o-${i}-type`, r.type);
    if (r.line != null) await page.fill(`#o-${i}-line`, String(r.line));
    for (const [k, v] of Object.entries(r.odds)) await page.fill(`#o-${i}-odd-${k}`, String(v));
    await page.fill(`#o-${i}-deadline`, kstLocal(Date.parse(g.start.utc) - 10 * 60e3));
  }
  await page.click('#o-save');
  await page.waitForSelector('#odds .msg');
  return page.textContent('#odds .msg');
}

test('example data: the example banner is large, odds input and pick records are locked, every pick and EV area says 예시', async () => {
  const { page, errors, close } = await open(browser);
  assert.equal(await page.isVisible('#exBand'), true);
  assert.equal((await page.textContent('#exText')).trim(), TEXT.example);
  assert.equal((await page.textContent('#roText')).trim(), TEXT.recordOnly);
  assert.ok(await page.$eval('#exText', e => parseFloat(getComputedStyle(e).fontSize)) >= 20);
  assert.match(await page.textContent('#chain'), /체인 검증: 정상\(레코드 0개\)/);
  await tab(page, 'odds');
  assert.equal((await page.textContent('#odds .lock')).trim(), TEXT.exampleLocked);
  assert.equal(await page.$('#o-save'), null);
  const areas = await page.$$eval('#odds .pick-area', els => els.map(e => e.textContent));
  assert.equal(areas.length, 3);
  assert.ok(areas.every(t => t.includes('예시')));
  await tab(page, 'today');
  const winCells = await page.$$eval('#today tbody tr td:nth-child(3)', els => els.map(e => e.textContent));
  assert.ok(winCells.length === 15 && winCells.every(t => t.includes('예시')));
  await tab(page, 'detail');
  assert.ok((await page.textContent('#detail')).includes('최소 배당'));
  assert.deepEqual(errors, []);
  await close();
});

test('no wording reads as a release or purchase advice, and there are no edit or delete controls (example and live, every tab)', async () => {
  for (const day of [undefined, liveDay()]) {
    const { page, errors, close } = await open(browser, day ? { day } : {});
    if (day) await enterOdds(page, day, [{ game: 0, no: 1, type: 'ML', odds: { home: 3, away: 3 } }, { game: 1, no: 2, type: 'ML', odds: { home: 3, away: 3 } }]);
    for (const t of TABS) {
      await tab(page, t);
      const text = await page.evaluate(() => document.body.innerText);
      assert.deepEqual(forbidden(text), [], `${day ? 'live' : 'example'} ${t}`);
      const bad = (await controls(page)).filter(c => /수정|삭제|편집|지우/.test(c));
      assert.deepEqual(bad, [], `${t} controls`);
    }
    assert.deepEqual(errors, []);
    await close();
  }
});

test('phone width: no horizontal page scroll in any tab', async () => {
  const { page, close } = await open(browser, { viewport: { width: 400, height: 860 } });
  for (const t of TABS) {
    await tab(page, t);
    const [sw, cw] = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    assert.ok(sw <= cw, `${t}: scrollWidth ${sw} > ${cw}`);
  }
  await close();
});

test('engine parity: a browser re-run with no change reproduces the published base mean exactly', async () => {
  const { page, close, errors } = await open(browser);
  await tab(page, 'detail');
  for (const gi of [0, 7]) {
    await page.selectOption('#gsel', String(gi));
    await page.click('#rerun');
    await page.waitForSelector('#scenOut[data-done="1"]');
    const [m, t, pm, pt] = await page.evaluate(i => { const g = window.__dash.day.games[i], s = window.__dash.scen.get(g.gameId); return [s.res.margin.mean, s.res.total.mean, g.prediction.sim.margin, g.prediction.sim.total]; }, gi);
    assert.equal(+m.toFixed(4), pm);
    assert.equal(+t.toFixed(4), pt);
  }
  assert.deepEqual(errors, []);
  await close();
});

test('live: odds input appends records, every pick row and EV cell says 기록 전용, purchases are separate records, integer lines are 미지원', async () => {
  const day = liveDay();
  const { page, errors, close } = await open(browser, { day });
  const msg = await enterOdds(page, day, [{ game: 0, no: 1, type: 'ML', odds: { home: 3, away: 3 } }, { game: 1, no: 2, type: 'ML', odds: { home: 3, away: 3 } }]);
  assert.match(msg, /기록했습니다: 레코드 \d+개/);
  const recs = await page.evaluate(() => window.__dash.chain.records.map(r => r.type));
  assert.equal(recs.filter(t => t === 'odds').length, 2);
  assert.equal(recs.filter(t => t === 'evaluation').length, 4);
  const nPick = recs.filter(t => t === 'pick').length;
  assert.ok(nPick >= 2);
  assert.ok(recs.filter(t => t === 'combo').length >= 1);
  assert.match(await page.textContent('#chain'), new RegExp(`정상\\(레코드 ${recs.length}개`));
  const rows = await page.$$eval('#odds .pick-row', els => els.map(e => !!e.querySelector('.badge.record')));
  assert.ok(rows.length >= nPick + 1 && rows.every(Boolean));
  const evs = await page.$$eval('#odds .ev-cell', els => els.map(e => e.querySelector('.badge.record')?.textContent));
  assert.ok(evs.length >= 4 + nPick && evs.every(t => t === TEXT.recordOnly));
  await page.click('#odds [data-buy][data-v="1"]');
  await page.waitForFunction(() => window.__dash.chain.records.some(r => r.type === 'purchase'));
  const after = await page.evaluate(() => window.__dash.chain.records.map(r => r.type));
  assert.equal(after.filter(t => t === 'pick').length, nPick);
  assert.equal(after.length, recs.length + 1);
  await enterOdds(page, day, [{ game: 2, no: 3, type: 'OU', line: 226, odds: { over: 1.9, under: 1.9 } }], 902);
  assert.ok((await page.textContent('#odds')).includes(TEXT.unsupported));
  const blocks = await page.evaluate(() => [...window.__db.docs.keys()].filter(k => k.startsWith('blocks/')).length);
  assert.equal(blocks, 3);
  assert.deepEqual(errors, []);
  await close();
});

test('scenario results are 미검증 (back-to-back also 근사) and leave the odds and EV columns unchanged', async () => {
  const day = liveDay();
  const { page, errors, close } = await open(browser, { day });
  await enterOdds(page, day, [{ game: 0, no: 1, type: 'ML', odds: { home: 3, away: 3 } }]);
  const oddsBefore = await page.$eval('#odds', e => [...e.querySelectorAll('.card')].slice(1).map(c => c.innerText).join('\n'));
  await tab(page, 'detail');
  await page.check('#b2b-home');
  await page.fill('#fg3-away', '3');
  await page.click('#rerun');
  await page.waitForSelector('#scenOut[data-done="1"]');
  const scen = await page.textContent('#scenOut');
  assert.ok(scen.includes(TEXT.unverified) && scen.includes(TEXT.approx));
  assert.equal(await page.$eval('#b2b-home', e => e.checked), true, 'inputs stay after a run');
  await page.uncheck('#b2b-home');
  await page.click('#rerun');
  await page.waitForSelector('#scenOut[data-done="2"]');
  const scen2 = await page.textContent('#scenOut');
  assert.ok(scen2.includes(TEXT.unverified) && !scen2.includes(TEXT.approx));
  await tab(page, 'odds');
  const oddsAfter = await page.$eval('#odds', e => [...e.querySelectorAll('.card')].slice(1).map(c => c.innerText).join('\n'));
  assert.equal(oddsAfter, oddsBefore);
  assert.deepEqual(errors, []);
  await close();
});

test('a changed record turns the chain check red and stops writing', async () => {
  const day = liveDay();
  const { page, close } = await open(browser, { day });
  await enterOdds(page, day, [{ game: 0, no: 1, type: 'ML', odds: { home: 3, away: 3 } }]);
  await page.evaluate(() => { window.__db.docs.get('blocks/b000000').data.records[0].odds.home = 9.99; });
  await page.evaluate(() => window.__dashRefresh());
  assert.equal(await page.getAttribute('#chain', 'data-state'), 'broken');
  assert.match(await page.textContent('#chain'), /검증 실패 — seq 0에서 끊김/);
  await tab(page, 'odds');
  assert.match(await page.textContent('#odds .lock'), /체인 검증이 실패해서 기록을 멈췄습니다/);
  await close();
});

test('git anchor: shown as matching when the copy equals the database chain', async () => {
  const day = liveDay();
  const { page, close } = await open(browser, { day });
  await enterOdds(page, day, [{ game: 0, no: 1, type: 'ML', odds: { home: 3, away: 3 } }]);
  assert.match(await page.textContent('#anchor'), /git 기준점 없음/);
  const r1 = await page.evaluate(() => window.__dash.chain.records[1]);
  await page.evaluate(a => { window.__dash.anchor = a; return window.__dashRefresh(); }, { seq: 1, hash: r1.hash, commit: 'abcdef1234' });
  assert.match(await page.textContent('#anchor'), /git 기준점 일치 — seq 1, 커밋 abcdef1/);
  await close();
});

test('not the owner: read-only, no odds form', async () => {
  const { page, close } = await open(browser, { day: liveDay(), owner: false });
  await tab(page, 'odds');
  assert.match(await page.textContent('#odds .lock'), /소유자만/);
  assert.equal(await page.$('#o-save'), null);
  await close();
});
