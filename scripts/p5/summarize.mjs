// Print the P5 tables (markdown) from a backtest report: node scripts/p5/summarize.mjs docs/reports/p5-rehearsal.json
import { readFile } from 'node:fs/promises';

const rep = JSON.parse(await readFile(process.argv[2], 'utf8'));
const pct = x => (x == null ? '—' : `${(100 * x).toFixed(1)}%`);
const f = (x, d = 4) => (x == null ? '—' : (+x).toFixed(d));
const ci = c => (c ? `[${f(c[0], 3)}, ${f(c[1], 3)}]` : '');
const ok = b => (b ? '통과' : '**미달**');

function sTable(title, blocks) {
  console.log(`\n**${title}**\n`);
  console.log('| 구분 | 경기 | Brier 모델 / 기준 (차이) | S1 | 승패 기울기 S2 | 점수 차 SD 비율 | 총점 SD 비율 | S3 |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const [k, j] of blocks) {
    if (!j || !j.n) { console.log(`| ${k} | 0 | | | | | | |`); continue; }
    console.log(`| ${k} | ${j.n} | ${f(j.S1.model)} / ${f(j.S1.base)} (${f(j.S1.diff)}) | ${ok(j.S1.pass)} | ${f(j.S2.slope, 3)} ${ok(j.S2.pass)} | ${f(j.S3.margin.ratio, 3)} | ${f(j.S3.total.ratio, 3)} | ${ok(j.S3.pass)} |`);
  }
}

for (const [v, r] of Object.entries(rep.variants)) {
  console.log(`\n### ${rep.season} ${v}판 — 판정 ${r.counts.judged}경기 (pre_job_start ${r.counts.preJobStart}, 데이터 제외 ${r.counts.dataExcluded})`);
  const a = r.all;
  console.log(`\n- S1 Brier ${f(a.S1.model)} 대 기준 ${f(a.S1.base)}, 차이 ${f(a.S1.diff)} 95% ${ci(a.S1.ci95)} → ${ok(a.S1.pass)}`);
  console.log(`- S2 승패 기울기 ${f(a.S2.slope, 3)} 95% ${ci(a.S2.ci95)} → ${ok(a.S2.pass)}`);
  console.log(`- S3 점수 차 ${f(a.S3.margin.sim, 2)}/${f(a.S3.margin.actual, 2)} = ${f(a.S3.margin.ratio, 3)}, 총점 ${f(a.S3.total.sim, 2)}/${f(a.S3.total.actual, 2)} = ${f(a.S3.total.ratio, 3)} → ${ok(a.S3.pass)}`);
  console.log(`- 전체 ${ok(a.pass)}; 픽 대상 시장: ${a.eligibleMarkets.length ? a.eligibleMarkets.join(', ') : '없음'}`);
  console.log('\n| 시장 | 기울기 | 95% 구간 | 판정 | 행 수 |\n|---|---|---|---|---|');
  for (const [m, x] of Object.entries(a.markets)) console.log(`| ${m} | ${f(x.slope, 3)} | ${ci(x.ci95)} | ${ok(x.pass)} | ${x.n} |`);
  console.log('\n| 정확도 | 점수 차 MAE | 점수 차 편향 | 총점 MAE |\n|---|---|---|---|');
  console.log(`| 앙상블 위치 | ${f(a.accuracy.ensemble.marginMAE, 2)} | ${f(a.accuracy.ensemble.marginBias, 2)} | |`);
  console.log(`| 시뮬레이터 | ${f(a.accuracy.simulator.marginMAE, 2)} | | ${f(a.accuracy.simulator.totalMAE, 2)} (편향 ${f(a.accuracy.simulator.totalBias, 2)}) |`);
  console.log(`| 단순 기준모델 | ${f(a.accuracy.baseline.marginMAE, 2)} | | ${f(a.accuracy.baseline.totalMAE, 2)} |`);
  console.log('\n접전 분포 (|점수 차| ≤ N: 보정 후 / 보정 전 / 실제)\n');
  console.log('| 구간 | 경기 | ≤1 | ≤3 | ≤5 | ≤7 | ≤10 |\n|---|---|---|---|---|---|---|');
  for (const [b, x] of Object.entries(a.close)) console.log(`| ${b} | ${x.games} | ${[1, 3, 5, 7, 10].map(N => `${pct(x[`le${N}`].calibrated)} / ${pct(x[`le${N}`].raw)} / ${pct(x[`le${N}`].actual)}`).join(' | ')} |`);
  console.log(`\n연장 비율: 시뮬레이션 ${pct(a.overtime.sim)}, 실제 ${pct(a.overtime.actual)}`);
  sTable('PDF 구간·그룹별', Object.entries(r.byPeriodGroup));
  if (r.byFirstMonth) sTable('첫 한 달 / 나머지', Object.entries(r.byFirstMonth));
  if (r.byAbsence) sTable('결장 변수(상위 3명 중 Out/Doubtful)', Object.entries(r.byAbsence));
  sTable('월별', Object.entries(r.byMonth));
  sTable('참고: pre_job_start', [['pre_job_start', r.preJobStartReference]]);
}
