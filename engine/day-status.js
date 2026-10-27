// What the day's games and markets are waiting for (P9; 2026-10-23 P9 approvals 1, 2, 4, 5, 8):
//   no odds -> "배당 미입력" (nothing is evaluated); odds before the game's final prediction -> "평가 대기";
//   "오늘은 패스" only when markets were evaluated and no leg or 2-fold qualified.
// Markets with odds that were never evaluated before their deadline get an `unevaluated` record with the reason,
// written by the next run, so they stay in the ledger. Overround outside [1.00, 1.30] is a warning only (thresholds
// fixed, never relaxed afterwards). Odds movement compares later entries of a market with its first entry
// (monitoring only; picks and EV never use it). 2-folds are a separate record table, not exit conditions.
import { TEXT, comboProgress } from './dashboard-data.js';
import { marketKey, joinGames } from './log-records.js';
import { toOddsRecords } from './odds.js';
import { byKorean } from './betman-teams.js';
import { canEvaluate, evalPath } from './trigger-time.js';
import { stamp } from './clock.js';

const ms = t => new Date(t).getTime();

export const OVERROUND_WARN = Object.freeze({ below: 1.0, above: 1.3 });
export function overroundWarning(overround) {
  if (!(overround < OVERROUND_WARN.below || overround > OVERROUND_WARN.above)) return null;
  return { overround, text: `${TEXT.overroundWarn}: 오버라운드 ${overround.toFixed(3)} — 기준(1.00 미만 또는 1.30 초과) 밖입니다. 입력을 확인하세요. 저장은 막지 않습니다.` };
}

export function oddsMovement(chain) {
  const by = new Map();
  for (const r of chain) if (r.type === 'odds') (by.get(marketKey(r)) ?? by.set(marketKey(r), []).get(marketKey(r))).push(r);
  const markets = [];
  for (const [market, list] of by) {
    if (list.length < 2) continue;
    const [first, ...rest] = [...list].sort((a, b) => ms(a.capturedAt.utc) - ms(b.capturedAt.utc));
    const later = rest.map(r => {
      const dOdds = {}, dNoVigPp = {};
      for (const k of Object.keys(first.odds)) { dOdds[k] = r.odds[k] - first.odds[k]; dNoVigPp[k] = (r.noVig[k] - first.noVig[k]) * 100; }
      return { capturedAt: r.capturedAt, odds: r.odds, line: r.line ?? null, lineChanged: (r.line ?? null) !== (first.line ?? null), dOdds, dNoVigPp, maxAbsPp: Math.max(...Object.values(dNoVigPp).map(Math.abs)) };
    });
    markets.push({ market, gameId: first.gameId, type: first.market, line: first.line ?? null, first: { capturedAt: first.capturedAt, odds: first.odds, noVig: first.noVig }, later });
  }
  const entries = markets.flatMap(m => m.later);
  const pp = entries.map(e => e.maxAbsPp);
  return { markets, summary: { markets: markets.length, laterEntries: entries.length, meanAbsNoVigPp: pp.length ? pp.reduce((a, b) => a + b, 0) / pp.length : null, maxAbsNoVigPp: pp.length ? Math.max(...pp) : null } };
}

export const UNEVALUATED_REASONS = {
  'deadline before final prediction': `${TEXT.deadlineMissed} — 최종 예측보다 베트맨 마감이 먼저`,
  'no final prediction': `${TEXT.unevaluated} — 최종 예측 없음(제외·실패·실행 전 시작 경기)`,
  'not written before deadline': `${TEXT.unevaluated} — 최종 예측은 있었지만 마감 전에 기록되지 않음`,
  // early run C (2026-10-27): a market of path C with no C prediction published (no run C that day)
  'no C prediction': `${TEXT.unevaluated} — 아침 리포트 기준(C) 예측 없음`,
};

// markets with odds but no evaluation whose deadline has passed: one record each, with the reason.
// finals / finalsC: Map gameId -> { at (when the final prediction was published), runId, start } of path AB / C; a
// market is judged against its own path's final prediction (engine/trigger-time.js evalPath)
// starts: Map gameId -> tip-off (any predicted game), so the path is known even without a final prediction
export function unevaluatedRecords({ chain, finals = new Map(), finalsC = new Map(), starts = new Map(), now = new Date() }) {
  const done = new Set(chain.filter(r => r.type === 'evaluation' || r.type === 'unevaluated').map(marketKey));
  const latest = new Map();
  for (const r of chain) {
    if (r.type !== 'odds' || done.has(marketKey(r))) continue;
    const cur = latest.get(marketKey(r));
    if (!cur || ms(r.capturedAt.utc) >= ms(cur.capturedAt.utc)) latest.set(marketKey(r), r);
  }
  const out = [];
  for (const o of latest.values()) {
    if (ms(o.deadline.utc) > ms(now)) continue; // still before its deadline: pending
    const start = starts.get(o.gameId) ?? (finals.get(o.gameId) ?? finalsC.get(o.gameId))?.start;
    const pathC = !!start && evalPath(o.deadline.utc, start) === 'C';
    const f = (pathC ? finalsC : finals).get(o.gameId);
    const reason = !f ? (pathC ? 'no C prediction' : 'no final prediction') : ms(f.at) >= ms(o.deadline.utc) ? 'deadline before final prediction' : 'not written before deadline';
    out.push({
      type: 'unevaluated', id: marketKey(o), round: o.round, betmanNo: o.betmanNo, gameId: o.gameId, market: o.market, line: o.line ?? null,
      deadline: o.deadline, oddsSeq: o.seq, oddsCapturedAt: o.capturedAt, finalAt: f?.at ?? null, reason, note: UNEVALUATED_REASONS[reason], createdAt: stamp(now),
    });
  }
  return out;
}

function counts(recs, now) {
  const evaluated = new Set(recs.filter(r => r.type === 'evaluation').map(marketKey));
  const unevaluated = recs.filter(r => r.type === 'unevaluated');
  const closed = new Set(unevaluated.map(marketKey));
  const oddsMarkets = new Set(recs.filter(r => r.type === 'odds').map(marketKey));
  const open = recs.filter(r => r.type === 'odds' && !evaluated.has(marketKey(r)) && !closed.has(marketKey(r)));
  const pending = new Set(open.filter(r => ms(r.deadline.utc) > ms(now)).map(marketKey));
  const missed = new Set(open.filter(r => ms(r.deadline.utc) <= ms(now)).map(marketKey));
  return { oddsMarkets: oddsMarkets.size, evaluated: evaluated.size, pending: pending.size, missed: missed.size, unevaluated, picks: recs.filter(r => r.type === 'pick').length };
}

export function gameStatuses({ day, chain, now = new Date() }) {
  const out = new Map();
  for (const g of day.games) {
    const c = counts(chain.filter(r => r.gameId === g.gameId), now);
    let code, text;
    if (!c.oddsMarkets) [code, text] = ms(now) >= ms(g.start.utc) ? ['noOddsClosed', TEXT.noOddsClosed] : ['noOdds', TEXT.noOdds];
    else if (c.picks) [code, text] = ['picks', `후보 ${c.picks}개`];
    else if (c.pending) [code, text] = g.prediction?.final ? ['awaiting', TEXT.awaitingFinal] : ['awaiting', g.group === 'B' ? TEXT.awaiting : TEXT.awaitingFinal];
    else if (c.unevaluated.length && !c.evaluated) [code, text] = ['unevaluated', c.unevaluated[0].note];
    else if (c.missed && !c.evaluated) [code, text] = ['unevaluated', TEXT.deadlineMissed];
    else if (!g.prediction) [code, text] = ['noPrediction', TEXT.noPrediction];
    else [code, text] = ['evaluated', '평가 완료 — 후보 없음'];
    out.set(g.gameId, { code, text, ...c, unevaluated: c.unevaluated.length });
  }
  return out;
}

export function dayStatus({ day, chain, now = new Date() }) {
  const ids = new Set(day.games.map(g => g.gameId));
  const recs = chain.filter(r => ids.has(r.gameId));
  const c = counts(recs, now);
  const pickIds = new Set(recs.filter(r => r.type === 'pick').map(r => r.id));
  const combos = chain.filter(r => r.type === 'combo' && r.legs.some(id => pickIds.has(id))).length;
  const base = { ...c, unevaluated: c.unevaluated.length, combos };
  if (!c.oddsMarkets) return { code: 'noOdds', text: TEXT.noOdds, ...base };
  if (c.picks || combos) return { code: 'picks', text: `후보 ${c.picks}개 · 2폴더 ${combos}개${c.pending ? ` · 평가 대기 마켓 ${c.pending}개` : ''}`, ...base };
  if (c.pending) return { code: 'pending', text: `평가 대기 — 마켓 ${c.pending}개`, ...base };
  if (c.evaluated) return { code: 'pass', text: TEXT.pass, ...base };
  return { code: 'unevaluated', text: TEXT.unevaluated, ...base };
}

// 2-folds (2026-10-23 P9 approval 3): values only, kept out of the exit conditions
export function comboTable(log) {
  const p = comboProgress(log);
  const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
  const n = log.filter(r => r.type === 'combo').length;
  const settled = p.minPicks.value ?? 0;
  return {
    caption: '2폴더 기록 — 해제 조건에 넣지 않음. 조합 확률과 시장 Brier는 두 다리 확률의 곱, ROI 구간은 회차 단위 군집',
    columns: [
      { key: 'n', label: '2폴더 후보', value: `${n}개` },
      { key: 'settled', label: '정산', value: `${settled}개` },
      { key: 'hits', label: '적중률 − 평균 p_cons', value: p.calibration.value == null ? '—' : `${(p.calibration.value * 100).toFixed(1)}%p` },
      { key: 'roi', label: 'ROI 1단위', value: pct(p.roi.value) },
      { key: 'roiCi', label: 'ROI 95% 구간', value: p.roi.ci95 ? `[${pct(p.roi.ci95[0])}, ${pct(p.roi.ci95[1])}]` : '—' },
      { key: 'brier', label: 'Brier 모델 / 시장', value: p.marketBrier.model == null ? '—' : `${p.marketBrier.model.toFixed(4)} / ${p.marketBrier.market.toFixed(4)}` },
    ],
  };
}

// confirmation screen (2026-10-23 P9 approval 1): what saving an odds input will do, market by market, before
// anything is written. The first entry of a market fixes its evaluation; later entries are odds records only.
export const HANDLING = {
  fix: '평가·픽 확정 — 확정 뒤 수정 불가',
  oddsOnlyFixed: '배당만 기록 — 이미 확정된 마켓(변동 모니터링용)',
  oddsOnlyAwaitingB: '배당만 기록 — 실행 B 예측 뒤 평가',
  oddsOnlyAwaitingFinal: '배당만 기록 — 최종 예측 뒤 평가',
  // early run C (2026-10-27): markets whose Betman deadline comes before the game's A/B final prediction
  oddsOnlyAwaitingC: '배당만 기록 — 아침 리포트 기준(C) 예측 뒤 평가',
  fixC: '평가·픽 확정 — 아침 리포트 기준(C) 예측, 확정 뒤 수정 불가',
  unsupported: '미지원(정수 기준선) — 평가만 기록, 픽 제외',
};
// markets left out one by one before validation (2026-10-26 user decision on the odds input flow): the input rule is
// 승패·핸디캡·언더오버 per game, so 승5패 and SUM are not recorded; a market past its deadline or for a game not on the
// dashboard's day cannot be evaluated. Each is listed with its reason on the confirmation screen, never dropped
// silently. Anything else wrong (numbers, lines, selections, unknown types or team names, times) rejects the whole input.
export const EXCLUDED = {
  notInRule: '기록 안 함 — 입력 규칙 밖(승5패·SUM)',
  pastDeadline: '기록 안 함 — 마감 지남',
  noGame: '기록 안 함 — 오늘 대시보드 일정에 없는 경기(17:50 ET 전 시작 등)',
};
const OUT_OF_RULE = new Set(['ML5', 'SUM']);
export function screenInput({ input, day, now = new Date() }) {
  const excluded = [], markets = [];
  for (const m of input?.markets ?? []) {
    const h = byKorean(m.home), a = byKorean(m.away), dl = new Date(m.deadline);
    const reason = OUT_OF_RULE.has(m.type) ? 'notInRule'
      : !Number.isNaN(dl.getTime()) && dl <= new Date(now) ? 'pastDeadline'
      : h && a && !day.games.some(g => g.home.espn === h.espn && g.away.espn === a.espn) ? 'noGame' : null;
    if (reason) excluded.push({ betmanNo: m.betmanNo, type: m.type, game: `${m.away} @ ${m.home}`, reason, text: EXCLUDED[reason] });
    else markets.push(m);
  }
  return { input: excluded.length ? { ...input, markets } : input, excluded };
}

export function classifyInput({ input: raw, day, chain, now = new Date() }) {
  const { input, excluded } = screenInput({ input: raw, day, now });
  if (excluded.length && !input.markets.length) return { ok: false, error: '기록할 마켓이 없습니다 — 모두 제외됐습니다', rows: [], excluded };
  let recs;
  try { recs = joinGames(toOddsRecords(input, { now }), day.games); } catch (e) { return { ok: false, error: e.message, rows: [], excluded }; }
  const closed = new Set(chain.filter(r => r.type === 'evaluation' || r.type === 'unevaluated').map(marketKey));
  const rows = recs.map(o => {
    const g = day.games.find(x => x.gameId === o.gameId), k = marketKey(o);
    const path = evalPath(o.deadline.utc, g.start.utc); // shown next to the deadline for the user to check (2026-10-28 item 5)
    const handling = closed.has(k) ? 'oddsOnlyFixed'
      : !canEvaluate(o, g) ? (path === 'C' ? 'oddsOnlyAwaitingC' : g.group === 'B' ? 'oddsOnlyAwaitingB' : 'oddsOnlyAwaitingFinal')
      : o.lineKind === 'integer' ? 'unsupported' : g.prediction.run === 'C' ? 'fixC' : 'fix';
    closed.add(k); // a market repeated in the same input: only its first entry fixes
    return { market: k, gameId: o.gameId, game: `${g.away.espn}@${g.home.espn}`, type: o.market, line: o.line, odds: o.odds, overround: o.overround, warning: overroundWarning(o.overround), deadline: o.deadline, path, handling, text: HANDLING[handling] };
  });
  return { ok: true, rows, warnings: rows.filter(r => r.warning).length, excluded, input };
}
