// The 2025-26 opening report (user approval 2026-10-23): one pair, docs/reports/p5-open.json and p5-open.md.
// Written before the opening and tried on the 2023-24 rehearsal, so nothing here is chosen after seeing 2025-26.
//   input   the registered command's output (docs/reports/p5-test.json, kept verbatim with its sha256),
//           the simulations of the season, the calibration file, the gate check and the run log
//   adds    close-finish probabilities by expected margin 0-3 / 3-8 / 8-13 / 13+ (predicted vs actual), and the
//           first month vs the rest per market slope table (user request 4)
// Usage: node scripts/p5/open-report.mjs --season 2025-26 --report docs/reports/p5-test.json --gate gate.json
//        --runs runs.json --json docs/reports/p5-open.json --md docs/reports/p5-open.md
import { readFile, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { markets, survival, MARGIN_T } from '../../engine/calibrate.js';
import { withShift, isJudged } from '../../engine/backtest.js';
import { render } from './summarize.mjs';

const arg = k => process.argv[process.argv.indexOf(k) + 1];
const season = arg('--season');
const raw = await readFile(arg('--report'));
const registered = JSON.parse(raw);
const gate = JSON.parse(await readFile(arg('--gate'), 'utf8'));
const runs = JSON.parse(await readFile(arg('--runs'), 'utf8'));
const cal = JSON.parse(await readFile('data/model/calibration.json', 'utf8'));
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r4 = x => (x == null ? null : +x.toFixed(4));

// close finishes by |expected margin| (ensemble location), judged games, calibrated / raw simulated / actual
const BINS = [['0-3', 0, 3], ['3-8', 3, 8], ['8-13', 8, 13], ['13+', 13, Infinity]];
const closeByExpected = {};
for (const v of ['A', 'B']) {
  const rows = withShift(JSON.parse(gunzipSync(await readFile(`data/model/sims/${season}-${v}.json.gz`))).rows, cal.ensemble.w).filter(isJudged);
  const at = (s, t) => s[MARGIN_T.indexOf(t)];
  closeByExpected[v] = {};
  for (const [name, lo, hi] of BINS) {
    const rs = rows.filter(r => { const c = Math.abs(r.sim.margin + r.sim.shift); return c >= lo && c < hi; });
    const ms = rs.map(r => markets(cal.calibration, r.sim).marginSurvival);
    const out = { games: rs.length };
    for (const N of [1, 3, 5, 7, 10]) {
      out[`le${N}`] = {
        calibrated: r4(mean(ms.map(s => at(s, -N - 0.5) - at(s, N + 0.5)))),
        raw: r4(mean(rs.map(r => survival(r.sim.marginHist, -N - 0.5, r.sim.shift) - survival(r.sim.marginHist, N + 0.5, r.sim.shift)))),
        actual: r4(mean(rs.map(r => (Math.abs(r.actual.margin) <= N ? 1 : 0)))),
      };
    }
    closeByExpected[v][name] = out;
  }
}
const firstMonthS2 = Object.fromEntries(Object.entries(registered.variants).map(([v, r]) => [v, Object.fromEntries(Object.entries(r.byFirstMonth ?? {}).map(([k, j]) => [k, { n: j.n, markets: j.markets }]))]));

const out = {
  season, generatedAt: new Date().toISOString(), gate, runs,
  registeredOutput: { path: arg('--report'), sha256: createHash('sha256').update(raw).digest('hex'), content: registered },
  extra: { closeByExpected, firstMonthS2 },
};
await writeFile(arg('--json'), JSON.stringify(out, null, 1));

const pct = x => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const GRADE = { pass: '통과', conditional: '조건부', fail: '**미달**' };
const MK = { ml: '승패', ml5: '승5패', hc: '핸디캡', ou: '언더오버' };
const ACTION = { 'all-pass': '전부 통과', 'some-markets': '일부 시장만 통과', 'S1-fail': 'S1 미달', 'S3-fail': 'S3 미달', 'S1-and-S3-fail': 'S1·S3 미달' };
const S1L = { pass: '통과', 'pass, advantage unconfirmed': '통과(우위 미확정)', fail: '**미달**' };
const md = [];
md.push(`# ${season} 개봉 결과 (P5)`, '');
md.push('> **P3 모델이 시장 대비 우위라는 근거는 아직 없다.** 아래는 확률의 정확도·보정이고 배당 대비 이익은 증명하지 않는다(설계 §9.4).', '');
md.push('## 1. 게이트와 실행 기록', '');
md.push(`- 등록 커밋 \`${gate.registered.commit}\`, 실행 시 HEAD \`${gate.head}\`, 작업 트리 깨끗함: ${gate.clean ? '예' : '**아니오**'}`);
for (const [f, h] of Object.entries(gate.files)) md.push(`- ${f}: 현재 \`${h.now.slice(0, 16)}…\` / 등록 \`${h.registered.slice(0, 16)}…\` → ${h.now === h.registered ? '같음' : '**다름**'}`);
md.push(`- 등록 이후 바뀐 동결 경로: ${gate.changedSinceRegistered.length ? gate.changedSinceRegistered.join(', ') : '없음'}`);
md.push(`- 게이트 판정: ${gate.problems.length ? '**거부** ' + gate.problems.join('; ') : '통과'}`);
md.push(`- 실행 ${runs.length}회: ${runs.map(r => `${r.at} ${r.command} → ${r.result}${r.reason ? ` (${r.reason})` : ''}`).join(' / ')}`);
md.push(`- 등록 명령의 원 출력 \`${arg('--report')}\` sha256 \`${out.registeredOutput.sha256}\` (p5-open.json에 그대로 포함)`, '');
const b = registered.variants.B.all;
md.push('## 2. 판정 — 설계 §14.4.1 규칙을 그대로 적용(B판)', '');
md.push(`- S1: ${S1L[b.S1.label]} (Brier ${b.S1.model} 대 기준 ${b.S1.base}, 차이 ${b.S1.diff}, 95% [${b.S1.ci95.join(', ')}])`);
md.push(`- S3: ${b.S3.pass ? '통과' : '미달'} (점수 차 ${b.S3.margin.ratio}, 총점 ${b.S3.total.ratio})`);
md.push(`- 시장별 S2: ${Object.entries(b.markets).map(([k, x]) => `${MK[k]} ${x.slope} ${GRADE[x.grade]}`).join(', ')}`);
md.push(`- **결과: ${ACTION[b.outcome.action]}** — 픽 대상 ${b.outcome.pickEligible.map(k => MK[k]).join(', ') || '없음'} / 조건부 ${b.outcome.conditional.map(k => MK[k]).join(', ') || '없음'} / 기록 전용 ${b.outcome.recordOnly.map(k => MK[k]).join(', ') || '없음'}`);
md.push('- 2025-26으로는 어떤 값도 새로 맞추지 않는다. 미달·조건부 시장은 기록 전용이고 2026-27 누적 경기로 재확인한다(§14.4).', '');
md.push('## 3. 상세 표 (요청 7)', '', render(registered), '');
md.push('## 4. 추가 표 (개봉 승인 시 요청 4)', '');
md.push('### 4.1 예상 점수 차 구간별 접전 확률 (|점수 차| ≤ N: 보정 후 / 보정 전 / 실제)', '');
for (const [v, bins] of Object.entries(closeByExpected)) {
  md.push(`**${v}판**`, '', '| 예상 |점수 차| | 경기 | ≤1 | ≤3 | ≤5 | ≤7 | ≤10 |', '|---|---|---|---|---|---|---|');
  for (const [name, x] of Object.entries(bins)) md.push(`| ${name} | ${x.games} | ${[1, 3, 5, 7, 10].map(N => `${pct(x[`le${N}`].calibrated)} / ${pct(x[`le${N}`].raw)} / ${pct(x[`le${N}`].actual)}`).join(' | ')} |`);
  md.push('');
}
md.push('### 4.2 시즌 첫 한 달과 나머지의 시장별 S2 (구분별 재표본 200회, 설명용)', '');
for (const [v, parts] of Object.entries(firstMonthS2)) {
  md.push(`**${v}판** (첫 한 달 ${registered.firstMonth?.from}~${registered.firstMonth?.to})`, '', '| 구분 | 경기 | 승패 | 승5패 | 핸디캡 | 언더오버 |', '|---|---|---|---|---|---|');
  for (const [k, x] of Object.entries(parts)) md.push(`| ${k === 'firstMonth' ? '첫 한 달' : '나머지'} | ${x.n} | ${['ml', 'ml5', 'hc', 'ou'].map(m => `${x.markets[m].slope} [${x.markets[m].ci95?.join(', ') ?? ''}] ${GRADE[x.markets[m].grade]}`).join(' | ')} |`);
  md.push('');
}
md.push('## 5. 해석 (판정과 분리)', '', '(판정 뒤에 따로 쓴다. 위 판정은 바꾸지 않는다.)', '');
await writeFile(arg('--md'), md.join('\n'));
console.log(`written ${arg('--json')} and ${arg('--md')}`);
