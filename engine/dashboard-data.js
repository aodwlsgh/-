// Dashboard view logic (P8, design §11.1): the day file the daily job publishes and its checks, the numbers each
// tab shows and the fixed wording. Wording rules (2026-10-23 user conditions 4, 5, 7, 8):
//   every pick and EV carries "기록 전용 — 구매 비권장" (example data: "예시"); scenario results are "미검증", a
//   back-to-back scenario also "근사"; scenario and sensitivity results never reach the pick and EV columns
//   (they are not base predictions, engine/markets.js assertBase); the exit progress never reads as a release.
// Day file (data/live/today.json):
//   { schema: 1, kind: 'live'|'example', exampleNote?, date (ET), season?, run, generatedAt, source,
//     games: [{ gameId, start: {utc, kst, et}, group, home/away: {id, espn, name, ko, koVerified}, prediction:
//       {source: 'base', runId, run, final, sim: {margin, total, marginSD, totalSD, ot, marginHist, totalHist, n,
//       shift}}, simInput, seed, breakeven, dataStatus, sensitivity: {label: 'unverified', ...}|null, autoScenarios }] }
import { markets } from './calibrate.js';
import { simSummary, UNVERIFIED } from './scenario.js';
import { settle } from './picks.js';
import { rng } from './sim.js';
import { seasonOf } from './model.js';

export const DAY_SCHEMA = 1;
export const EXAMPLE_SEASON = '2024-25';
export const TEXT = {
  recordOnly: '기록 전용 — 구매 비권장',
  example: '예시 — 2024-25 과거 경기, 운영 데이터 아님, 보정 구간 표본 내 예측',
  exampleCell: '예시',
  exampleLocked: '예시 데이터라서 배당 입력과 픽 기록을 막아 두었습니다',
  unverified: '미검증',
  approx: '근사',
  unconfirmed: '미확인',
  unsupported: '미지원(픽 제외)',
  exitUnmet: '해제 조건 미충족 — 기록 전용 유지',
  exitAllMet: '조건 충족 보고 대상 — 해제는 사용자 승인으로만, 승인 전까지 기록 전용 유지',
  pass: '오늘은 패스',
  met: '충족',
  unmet: '미충족',
  // P9 (2026-10-23 approval): no odds is not a pass; unevaluated markets stay in the ledger with a reason
  noOdds: '배당 미입력',
  noOddsClosed: '배당 미입력(마감)',
  awaiting: '평가 대기(실행 B 뒤)',
  awaitingFinal: '평가 대기(최종 예측 뒤)',
  unevaluated: '평가 못 함',
  deadlineMissed: '마감 경과로 평가 못 함',
  noPrediction: '예측 없음',
  provisional: '예비 — 실행 시각 전 예측, 평가에 쓰지 않음',
  fixed: '확정된 기록은 수정할 수 없습니다',
  overroundWarn: '오버라운드 경고',
  parallel: 'ESPN+PDF 병행 기록 — 픽·EV 미사용',
  writeFailed: '픽 로그 쓰기 실패',
};
// wording that would read as a release or as purchase advice; never shown in any state
export const FORBIDDEN = [/해제\s*가능/, /구매\s*가능/, /베팅\s*가능/, /추천/, /구매\s*하세요/, /베팅\s*하세요/, /지금\s*구매/];
export const forbiddenIn = text => FORBIDDEN.filter(re => re.test(text)).map(String);

export function validateDay(day) {
  const e = [];
  if (day?.schema !== DAY_SCHEMA) e.push(`schema ${day?.schema} (expected ${DAY_SCHEMA})`);
  if (!['live', 'example'].includes(day?.kind)) e.push(`kind ${day?.kind}`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day?.date ?? '')) e.push(`date ${day?.date}`);
  if (day?.kind === 'example') {
    if (day.exampleNote !== TEXT.example) e.push('exampleNote must be the fixed example text');
    if (seasonOf(day.date) !== EXAMPLE_SEASON) e.push(`example date ${day.date} is not in 2024-25`);
  }
  if (!Array.isArray(day?.games)) { e.push('games missing'); return e; }
  for (const g of day.games) {
    const at = `game ${g.gameId}`;
    if (!g.home?.espn || !g.away?.espn) e.push(`${at}: teams`);
    if (!g.start?.utc) e.push(`${at}: start`);
    const p = g.prediction;
    if (!p || p.source !== 'base' || p.label === UNVERIFIED) e.push(`${at}: prediction must be the base prediction`);
    else if (!p.sim?.marginHist || !p.sim?.totalHist) e.push(`${at}: prediction histograms missing`);
    if (g.sensitivity && g.sensitivity.label !== UNVERIFIED) e.push(`${at}: sensitivity must be labelled unverified`);
  }
  return e;
}

// quantile of an integer histogram spread uniformly over [k - 0.5, k + 0.5]
function quantile(hist, q) {
  const tot = hist.p.reduce((a, b) => a + b, 0);
  let c = 0;
  for (let i = 0; i < hist.p.length; i++) {
    const pi = hist.p[i] / tot;
    if (c + pi >= q) return hist.lo + i - 0.5 + (pi ? (q - c) / pi : 0);
    c += pi;
  }
  return hist.lo + hist.p.length - 0.5;
}

// base prediction of one game: calibrated probabilities, ensemble location, 90% interval of the simulated
// distribution moved to the ensemble location
export function gameView(game, cal) {
  const sim = game.prediction.sim, shift = sim.shift ?? 0, m = markets(cal, sim);
  return {
    gameId: game.gameId, winProbHome: m.ml.home, winProbAway: m.ml.away, ml5: m.ml5,
    margin: sim.margin + shift, total: sim.total,
    interval90: {
      margin: [quantile(sim.marginHist, 0.05) + shift, quantile(sim.marginHist, 0.95) + shift],
      total: [quantile(sim.totalHist, 0.05), quantile(sim.totalHist, 0.95)],
    },
  };
}

// a scenario re-run (simulateGame result, same seed as the base): moved by the base ensemble shift (§8.4),
// unverified; back-to-back changes are an approximation. Its `prediction` is not a base prediction.
export function scenarioView(game, res, cal, scenario = {}) {
  const base = game.prediction.sim, shift = base.shift ?? 0;
  const sim = simSummary(res, shift);
  const m = markets(cal, sim);
  const approx = (scenario.fatigue ?? []).length > 0;
  return {
    label: UNVERIFIED, approx, badges: approx ? [TEXT.unverified, TEXT.approx] : [TEXT.unverified],
    prediction: { source: 'scenario', label: UNVERIFIED, sim },
    winProbHome: m.ml.home, margin: res.margin.mean + shift, total: res.total.mean,
    delta: { margin: res.margin.mean - base.margin, total: res.total.mean - base.total },
  };
}
export const sensitivityBadges = v => (String(v.key).startsWith('b2b:') ? [TEXT.unverified, TEXT.approx] : [TEXT.unverified]);

const PROBLEM_KO = [[/^missing block (\w+)/, '블록 $1 없음'], [/sequence range/, '블록 범위 불일치'], [/head lastSeq/, '머리 문서의 마지막 seq 불일치'], [/head lastHash/, '머리 문서의 마지막 해시 불일치']];
const problemKo = p => { for (const [re, ko] of PROBLEM_KO) if (re.test(p)) return p.replace(re, ko).replace(/^(블록 \w+ 없음).*$/, '$1'); return p; };

export function chainText({ verify, records }) {
  if (!verify.ok) {
    const at = verify.brokenAt != null ? `seq ${verify.brokenAt}에서 끊김` : problemKo(verify.problems?.[0] ?? '구조 오류');
    return { ok: false, text: `검증 실패 — ${at}` };
  }
  if (!records.length) return { ok: true, text: '정상(레코드 0개)' };
  const last = records.at(-1);
  return { ok: true, text: `정상(레코드 ${records.length}개, 마지막 seq ${last.seq}, 해시 ${last.hash.slice(0, 12)})` };
}

// the daily git copy (P9): its last sequence number and hash must match the database chain
export function anchorCheck(records, anchor) {
  if (!anchor) return { status: 'none', text: 'git 기준점 없음(첫 일일 커밋 전)' };
  const c = String(anchor.commit ?? '').slice(0, 7);
  if (anchor.count === 0) return { status: 'match', text: `git 기준점 일치 — 레코드 0개, 커밋 ${c}` }; // the empty copy is a prefix of any chain
  const r = records[anchor.seq];
  if (!r || r.seq !== anchor.seq || r.hash !== anchor.hash) return { status: 'mismatch', text: `git 기준점 불일치 — seq ${anchor.seq}, 커밋 ${c}` };
  return { status: 'match', text: `git 기준점 일치 — seq ${anchor.seq}, 커밋 ${c}` };
}

const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
// exit conditions (§9.4) as rows; the overall line keeps record-only in every state
export function exitView(exit) {
  const row = (key, label, value, target, met) => ({ key, label, value, target, met: !!met, status: met ? TEXT.met : TEXT.unmet });
  const roi = exit.roi ?? {};
  const rows = [
    row('minPicks', '정산된 픽 수', `${exit.minPicks.value ?? 0}개`, `${exit.minPicks.target}개 이상`, exit.minPicks.met),
    row('minWeeks', '기록 기간', `${(exit.minWeeks.value ?? 0).toFixed(1)}주`, `${exit.minWeeks.target}주 이상`, exit.minWeeks.met),
    row('calibration', '적중률 − 평균 p_cons', exit.calibration.value == null ? '—' : `${(exit.calibration.value * 100).toFixed(1)}%p`, '±5%p 이내', exit.calibration.met),
    row('marketBrier', '시장 대비 Brier (모델 / 시장)', exit.marketBrier.model == null ? '—' : `${exit.marketBrier.model.toFixed(4)} / ${exit.marketBrier.market.toFixed(4)}`, '모델 ≤ 시장', exit.marketBrier.met),
    row('roi', 'ROI 1단위 [95% 구간]', roi.value == null ? '—' : `${pct(roi.value)} [${pct(roi.ci95?.[0])}, ${pct(roi.ci95?.[1])}]`, '점추정 ≥ 0, 하한 ≥ −10%', roi.met),
  ];
  return { rows, allMet: !!exit.allMet, overall: exit.allMet ? TEXT.exitAllMet : TEXT.exitUnmet };
}

const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r4 = x => (x == null ? null : +x.toFixed(4));
// 2-folds against the same conditions, counted apart from single picks (§9.4). Market Brier: product of the legs'
// model probabilities against the product of their no-vig market probabilities. ROI interval resamples rounds
// (2-folds of one round share legs).
export function comboProgress(log, { resamples = 2000, seed = 1 } = {}) {
  const results = new Map(log.filter(r => r.type === 'result').map(r => [r.gameId, r]));
  const picksById = new Map(log.filter(r => r.type === 'pick').map(r => [r.id, r]));
  const legWin = l => { const g = results.get(l.gameId); return g ? settle(l.market, l.selection, l.line, g.margin, g.total) : null; };
  const combos = log.filter(r => r.type === 'combo').map(c => {
    const legs = c.legs.map(id => picksById.get(id));
    const outs = legs.map(l => (l ? legWin(l) : null));
    return { ...c, legRecs: legs, win: outs.some(o => o === null) ? null : outs.every(Boolean) };
  });
  const settled = combos.filter(c => c.win !== null);
  const created = combos.map(c => Date.parse(c.createdAt?.utc)).filter(Number.isFinite).sort((a, b) => a - b);
  const weeks = created.length > 1 ? (created.at(-1) - created[0]) / (7 * 86400e3) : 0;
  const ys = settled.map(c => (c.win ? 1 : 0));
  const gap = settled.length ? mean(ys) - mean(settled.map(c => c.pCons)) : null;
  const pm = settled.map(c => c.legRecs.reduce((a, l) => a * l.p, 1)), pk = settled.map(c => c.legRecs.reduce((a, l) => a * l.noVig, 1));
  const brierModel = mean(pm.map((p, i) => (p - ys[i]) ** 2)), brierMarket = mean(pk.map((p, i) => (p - ys[i]) ** 2));
  const groups = new Map();
  for (const c of settled) (groups.get(c.round) ?? groups.set(c.round, []).get(c.round)).push(c.win ? c.oddsProduct - 1 : -1);
  const g = [...groups.values()];
  const est = list => { let s = 0, n = 0; for (const x of list) { for (const v of x) s += v; n += x.length; } return s / n; };
  let roi = { value: null, ci95: null };
  if (g.length) {
    const rand = rng(seed), boot = [];
    for (let b = 0; b < resamples; b++) boot.push(est(Array.from({ length: g.length }, () => g[Math.floor(rand() * g.length)])));
    boot.sort((a, b) => a - b);
    roi = { value: r4(est(g)), ci95: [r4(boot[Math.floor(0.025 * resamples)]), r4(boot[Math.floor(0.975 * resamples)])] };
  }
  const exit = {
    minPicks: { target: 200, value: settled.length, met: settled.length >= 200 },
    minWeeks: { target: 8, value: r4(weeks), met: weeks >= 8 },
    calibration: { target: 0.05, value: r4(gap), met: gap != null && Math.abs(gap) <= 0.05 },
    marketBrier: { model: r4(brierModel), market: r4(brierMarket), met: brierModel != null && brierModel <= brierMarket },
    roi: { ...roi, clusteredBy: 'round', met: roi.value != null && roi.value >= 0 && roi.ci95[0] >= -0.10 },
    releaseNeedsUserApproval: true,
  };
  exit.allMet = ['minPicks', 'minWeeks', 'calibration', 'marketBrier', 'roi'].every(k => exit[k].met);
  return exit;
}
