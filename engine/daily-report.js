// Daily report (P9, design §11.2): games, statuses, record-only picks, unevaluated markets with reasons, monitoring
// (over/under total bias, odds movement) and alerts. Every pick line says "기록 전용 — 구매 비권장"; provisional
// predictions and the ESPN+PDF parallel record are labelled; the wording is checked against the forbidden list.
import { TEXT, gameView, chainText, anchorCheck, forbiddenIn } from './dashboard-data.js';
import { gameStatuses, dayStatus, oddsMovement, comboTable } from './day-status.js';
import { summarize } from './pick-log.js';
import { breakeven } from './picks.js';

const pct = x => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const sgn = (x, d = 1) => (x == null ? '—' : `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x).toFixed(d)}`);
const hm = s => (s ? s.slice(11, 16) : '—');
const mean = xs => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// markets that never got an evaluation, by reason (the ledger keeps every one)
export function unevaluatedSummary(chain) {
  const un = chain.filter(r => r.type === 'unevaluated');
  const byReason = {};
  for (const r of un) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  return { markets: un.length, games: new Set(un.map(r => r.gameId)).size, byReason };
}

// minutes from odds input to evaluation, one value per market, per path (2026-10-28 item 6); evaluation records
// before this field (none in the chain at the time) are counted as missing
export function inputGapSummary(chain) {
  const seen = new Set(), by = { AB: [], C: [] };
  let missing = 0;
  for (const r of chain) {
    if (r.type !== 'evaluation') continue;
    const k = `${r.round}-${r.betmanNo}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (r.inputToEvalMin == null) { missing++; continue; }
    by[r.predictionRun === 'C' ? 'C' : 'AB'].push(r.inputToEvalMin);
  }
  const q = (xs, f) => xs[Math.min(xs.length - 1, Math.floor(f * xs.length))];
  const dist = xs => { const s = [...xs].sort((a, b) => a - b); return s.length ? { n: s.length, min: s[0], median: q(s, 0.5), p90: q(s, 0.9), max: s.at(-1), sameRun: s.filter(x => x <= 5).length } : { n: 0 }; };
  return { AB: dist(by.AB), C: dist(by.C), missing };
}

// over/under monitoring on every predicted game: rows [{ pred, actual, at }] (shown only, predictions unchanged)
export function totalBias(rows, now) {
  const cut = new Date(now).getTime() - 28 * 86400e3;
  const d = rows.map(r => ({ d: r.actual - r.pred, at: Date.parse(r.at) }));
  return { games: d.length, all: mean(d.map(x => x.d)), last4weeks: mean(d.filter(x => x.at >= cut).map(x => x.d)) };
}

export function reportMarkdown({ day, cal, chain, verify, anchor, run, alerts = [], biasAll = null, now = new Date() }) {
  const st = gameStatuses({ day, chain, now }), ds = dayStatus({ day, chain, now });
  const ids = new Set(day.games.map(g => g.gameId));
  const picks = chain.filter(r => r.type === 'pick' && ids.has(r.gameId));
  const pickIds = new Set(picks.map(p => p.id));
  const combos = chain.filter(r => r.type === 'combo' && r.legs.some(id => pickIds.has(id)));
  const un = unevaluatedSummary(chain), unToday = chain.filter(r => r.type === 'unevaluated' && ids.has(r.gameId));
  const mv = oddsMovement(chain), sum = summarize(chain, { now });
  const ct = chainText({ verify, records: chain }), an = anchorCheck(chain, anchor);
  const L = [];
  L.push(`# 일일 리포트 — ${day.date} (ET) 실행 ${run.run}`);
  L.push('');
  L.push(`- 실행 id: \`${run.runId}\` · 시작 ${run.startedAt?.kst ?? '—'} · 게시 ${run.publishedAt?.kst ?? '게시 전'}`);
  L.push(`- **${TEXT.recordOnly}** (2026-27 첫 한 달, 설계 §9.4 기록 전용 기간)`);
  L.push(`- 오늘 상태: **${ds.text}**`);
  L.push(`- ${TEXT.ml5NotOffered}`);
  L.push(`- 픽 로그: 체인 검증 ${ct.text} · ${an.text}`);
  if (alerts.length) { L.push(''); L.push('## 경고'); for (const a of alerts) L.push(`- 🔴 ${a.text}`); }
  L.push('');
  L.push('## 경기');
  L.push('| 시작 KST (ET) | 경기 | 그룹 | 예측 | 홈 승률 | 점수 차 [90%] | 총점 [90%] | 부상 입력(PDF) | ESPN+PDF 병행 | 상태 |');
  L.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const g of day.games) {
    const v = gameView(g, cal), s = st.get(g.gameId), inj = g.dataStatus?.injurySnapshot;
    const par = g.parallel ? (g.parallel.same ? '차이 없음' : `차이 ${g.parallel.diffs.length}명, 홈 승률 ${pct(g.parallel.winProbHome)}`) : '—';
    L.push(`| ${hm(g.start.kst)} (${g.start.et?.slice(11) ?? ''}) | ${g.away.espn} @ ${g.home.espn} | ${g.group} | ${g.prediction.final ? '최종' : '예비'} | ${pct(v.winProbHome)} | ${sgn(v.margin)} [${sgn(v.interval90.margin[0], 0)}, ${sgn(v.interval90.margin[1], 0)}] | ${v.total.toFixed(1)} [${v.interval90.total[0].toFixed(0)}, ${v.interval90.total[1].toFixed(0)}] | ${inj?.pdf ? inj.pdf : '없음'} | ${par} | ${s.text} |`);
  }
  if (day.games.some(g => !g.prediction.final)) L.push(`\n예비: ${TEXT.provisional}`);
  L.push(`\nESPN+PDF 병행: ${TEXT.parallel}. 픽과 EV는 검증한 경로(NBA PDF만)의 예측으로만 냅니다.`);
  L.push('');
  L.push('## 손익분기 최소 배당 (승패, 기본 예측)');
  for (const g of day.games) { const b = breakeven(g.prediction, cal).ml; L.push(`- ${g.away.espn} @ ${g.home.espn}: 홈 ${b.home.minOdds.toFixed(2)} · 원정 ${b.away.minOdds.toFixed(2)}`); }
  L.push('');
  L.push(`## 단일 후보·2폴더 — ${TEXT.recordOnly}`);
  if (!picks.length && !combos.length) L.push(`- ${ds.code === 'pass' ? TEXT.pass : ds.text}`);
  for (const p of picks) L.push(`- ${TEXT.recordOnly} · ${p.id} ${p.market}${p.line != null ? ` ${p.line}` : ''} ${p.selection} 배당 ${p.odds} · p_cons ${pct(p.pCons)} · EV ${sgn(p.ev * 100)}%`);
  for (const c of combos) L.push(`- ${TEXT.recordOnly} · 2폴더 ${c.legs.join(' + ')} 원배당 곱 ${c.oddsProduct.toFixed(2)} · EV ${sgn(c.ev * 100)}%`);
  L.push('');
  L.push('## 평가 못 한 마켓 (장부에 사유와 함께 남김)');
  L.push(`- 오늘 경기: ${unToday.length}개${unToday.length ? ` — ${unToday.map(r => `${r.id} ${r.note}`).join('; ')}` : ''}`);
  L.push(`- 누적: 마켓 ${un.markets}개, 경기 ${un.games}개${Object.keys(un.byReason).length ? ` (${Object.entries(un.byReason).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`);
  L.push('');
  L.push('## 모니터링 (표시만, 예측은 조정하지 않음)');
  const tb = sum.monitor.totalBias;
  // both are means of (actual − predicted) per game; the sum is shown beside them (2026-10-26 decision 8)
  const sumOf = b => (b.games ? `, 합 ${sgn(b.all * b.games, 1)}` : '');
  L.push(`- ${TEXT.biasLabel}, 평가한 경기: ${sgn(tb.all, 2)} (${tb.games}경기${sumOf(tb)}, 최근 4주 경기당 ${sgn(tb.last4weeks, 2)})`);
  if (biasAll) L.push(`- ${TEXT.biasLabel}, 모든 예측 경기(보관본): ${sgn(biasAll.all, 2)} (${biasAll.games}경기${sumOf(biasAll)}, 최근 4주 경기당 ${sgn(biasAll.last4weeks, 2)})`);
  L.push(`- 배당 변동(첫 입력 대비): 마켓 ${mv.summary.markets}개, 나중 입력 ${mv.summary.laterEntries}개${mv.summary.maxAbsNoVigPp != null ? `, 마진 제거 확률 변화 평균 ${mv.summary.meanAbsNoVigPp.toFixed(1)}%p · 최대 ${mv.summary.maxAbsNoVigPp.toFixed(1)}%p` : ''}`);
  const gap = inputGapSummary(chain);
  const gapText = d => (d.n ? `${d.n}마켓, 중앙값 ${d.median}분 · 90% ${d.p90}분 · 최소 ${d.min}분 · 최대 ${d.max}분 (5분 이내 ${d.sameRun})` : '없음');
  L.push(`- 배당 입력→평가 간격: 경로 A·B ${gapText(gap.AB)} · 경로 C ${gapText(gap.C)}${gap.missing ? ` · 간격 기록 없는 평가 ${gap.missing}마켓` : ''}`);
  const t = comboTable(chain);
  L.push(`- ${t.caption}: ${t.columns.map(c => `${c.label} ${c.value}`).join(' · ')}`);
  L.push('');
  L.push('## 민감도 상위 3 (미검증)');
  for (const g of day.games) {
    const s = g.sensitivity;
    L.push(`- ${g.away.espn} @ ${g.home.espn}: ${s ? s.topMargin.map(v => `${v.label} ${sgn(v.dMargin, 2)}`).join(' · ') : '계산 전'}`);
  }
  const text = L.join('\n') + '\n';
  const bad = forbiddenIn(text);
  if (bad.length) throw new Error(`report wording: ${bad.join(', ')}`);
  return text;
}
