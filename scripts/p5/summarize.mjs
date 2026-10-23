// P5 tables (markdown) from a backtest report: node scripts/p5/summarize.mjs docs/reports/p5-rehearsal-2.json
// render(rep) returns the same text for other scripts (scripts/p5/open-report.mjs)
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

let lines = [];
const log = (...a) => lines.push(a.join(' '));
const pct = x => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const f = (x, d = 4) => (x == null ? '—' : (+x).toFixed(d));
const ci = c => (c ? `[${f(c[0], 3)}, ${f(c[1], 3)}]` : '');
const ok = b => (b ? '통과' : '**미달**');
const GRADE = { pass: '통과', conditional: '조건부', fail: '**미달**' };
const S1L = { pass: '통과', 'pass, advantage unconfirmed': '통과(우위 미확정)', fail: '**미달**' };
const ACTION = { 'all-pass': '전부 통과', 'some-markets': '일부 시장만 통과', 'S1-fail': 'S1 미달', 'S3-fail': 'S3 미달', 'S1-and-S3-fail': 'S1·S3 미달' };
const MK = { ml: '승패', ml5: '승5패', hc: '핸디캡', ou: '언더오버' };

function sTable(title, blocks) {
  log(`\n**${title}**\n`);
  log('| 구분 | 경기 | Brier 앙상블(보정) / 기준 (차이, 95%) | S1 | S3 점수 차 / 총점 | 승패 | 승5패 | 핸디캡 | 언더오버 |');
  log('|---|---|---|---|---|---|---|---|---|');
  for (const [k, j] of blocks) {
    if (!j || !j.n) { log(`| ${k} | 0 | | | | | | | |`); continue; }
    const g = m => `${f(j.markets[m].slope, 2)} ${GRADE[j.markets[m].grade]}`;
    log(`| ${k} | ${j.n} | ${f(j.S1.model)} / ${f(j.S1.base)} (${f(j.S1.diff)}, ${ci(j.S1.ci95)}) | ${S1L[j.S1.label] ?? ok(j.S1.pass)} | ${f(j.S3.margin.ratio, 3)} / ${f(j.S3.total.ratio, 3)} ${ok(j.S3.pass)} | ${g('ml')} | ${g('ml5')} | ${g('hc')} | ${g('ou')} |`);
  }
}

export function render(rep) {
  lines = [];
for (const [v, r] of Object.entries(rep.variants)) {
  const a = r.all;
  log(`\n### ${rep.season} ${v}판 — 판정 ${r.counts.judged}경기 (pre_job_start ${r.counts.preJobStart}, 데이터 제외 ${r.counts.dataExcluded})`);
  log(`\n- **결과: ${ACTION[a.outcome.action]}** — 픽 대상 ${a.outcome.pickEligible.map(k => MK[k]).join(', ') || '없음'}, 조건부 ${a.outcome.conditional.map(k => MK[k]).join(', ') || '없음'}, 기록 전용 ${a.outcome.recordOnly.map(k => MK[k]).join(', ') || '없음'}`);
  log(`- S1 Brier ${f(a.S1.model)} 대 기준 ${f(a.S1.base)}, 차이 ${f(a.S1.diff)} 95% ${ci(a.S1.ci95)} → ${S1L[a.S1.label]}`);
  log(`- S3 점수 차 ${f(a.S3.margin.sim, 2)}/${f(a.S3.margin.actual, 2)} = ${f(a.S3.margin.ratio, 3)} ${ci(a.S3.margin.ci95)}, 총점 ${f(a.S3.total.sim, 2)}/${f(a.S3.total.actual, 2)} = ${f(a.S3.total.ratio, 3)} ${ci(a.S3.total.ci95)} → ${ok(a.S3.pass)}`);
  log('\n| 시장 | 기울기 | 95% 구간 | 등급 | 행 수 |\n|---|---|---|---|---|');
  for (const [m, x] of Object.entries(a.markets)) log(`| ${MK[m]} | ${f(x.slope, 3)} | ${ci(x.ci95)} | ${GRADE[x.grade]} | ${x.n} |`);
  log('\n| Brier(승패) | 값 |\n|---|---|');
  log(`| 시뮬레이터 단독(보정 전) | ${f(a.brier.simulatorRaw)} |\n| 앙상블(보정 전) | ${f(a.brier.ensembleRaw)} |\n| **앙상블(보정 후, S1 대상)** | ${f(a.brier.ensembleCalibrated)} |\n| 단순 기준모델 | ${f(a.brier.baseline)} |`);
  log('\n| 정확도 | 점수 차 MAE | 점수 차 편향 | 총점 MAE |\n|---|---|---|---|');
  log(`| 앙상블 위치 | ${f(a.accuracy.ensemble.marginMAE, 2)} | ${f(a.accuracy.ensemble.marginBias, 2)} | |`);
  log(`| 시뮬레이터 | ${f(a.accuracy.simulator.marginMAE, 2)} | | ${f(a.accuracy.simulator.totalMAE, 2)} (편향 ${f(a.accuracy.simulator.totalBias, 2)}) |`);
  log(`| 단순 기준모델 | ${f(a.accuracy.baseline.marginMAE, 2)} | | ${f(a.accuracy.baseline.totalMAE, 2)} |`);
  log('\n시장별 보정 곡선 (예측 확률 구간: 평균 예측 → 실제, 표본)\n');
  log('| 시장 | ' + Array.from({ length: 10 }, (_, b) => `${b * 10}~${b * 10 + 10}%`).join(' | ') + ' |');
  log('|---|' + '---|'.repeat(10));
  for (const [m, bins] of Object.entries(a.reliability)) log(`| ${MK[m]} | ${bins.map(b => (b.n ? `${pct(b.meanPredicted)}→${pct(b.observed)} (${b.n})` : '—')).join(' | ')} |`);
  log('\n접전 분포 (|점수 차| ≤ N: 보정 후 / 보정 전 / 실제)\n');
  log('| 구간 | 경기 | ≤1 | ≤3 | ≤5 | ≤7 | ≤10 |\n|---|---|---|---|---|---|---|');
  for (const [b, x] of Object.entries(a.close)) log(`| ${b} | ${x.games} | ${[1, 3, 5, 7, 10].map(N => `${pct(x[`le${N}`].calibrated)} / ${pct(x[`le${N}`].raw)} / ${pct(x[`le${N}`].actual)}`).join(' | ')} |`);
  log(`\n연장 비율: 시뮬레이션 ${pct(a.overtime.sim)}, 실제 ${pct(a.overtime.actual)}`);
  sTable('PDF 구간별 (시간 단위 / 15분 단위)', Object.entries(r.byPeriod ?? {}));
  if (r.byAbsence) sTable('결장 변수(상위 3명 중 Out/Doubtful)', Object.entries(r.byAbsence));
  if (r.byFirstMonth) sTable(`첫 한 달(${rep.firstMonth?.from}~${rep.firstMonth?.to}) / 나머지`, Object.entries(r.byFirstMonth));
  sTable('PDF 구간 × 그룹', Object.entries(r.byPeriodGroup));
  sTable('월별', Object.entries(r.byMonth));
  sTable('참고: pre_job_start', [['pre_job_start', r.preJobStartReference]]);
}
  return lines.join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) console.log(render(JSON.parse(await readFile(process.argv[2], 'utf8'))));
