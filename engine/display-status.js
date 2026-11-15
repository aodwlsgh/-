// Display-only status lines (approved 2026-11-11 and 2026-11-13): the dashboard "오래된 게시" banner and the line
// "평가 레코드 N건 · 마지막 배당 입력 날짜" in the daily report and the dashboard. Nothing here changes a prediction
// or a record; the banner is computed in the viewer's browser when the page opens.
import { runAt } from './trigger-time.js';
import { etParts } from './time.js';
import { stamp } from './clock.js';

export const STALE_HOURS = 3;
const SLACK_MS = 15 * 60e3; // a publish up to 15 minutes before a slot still covers it (runs start a minute or two late)
const kst = t => stamp(t).kst;
const md = s => `${s.slice(5, 10)} ${s.slice(11, 16)}`;

// scheduled runs around `now`: A and B at 17:50/20:50 ET of the ET date, C at 21:50 KST (KST-fixed task, 12:50 UTC)
function slots(now) {
  const out = [];
  for (let k = -3; k <= 1; k++) {
    const d = etParts(new Date(now.getTime() + k * 864e5)).date;
    out.push({ run: 'C', date: d, at: new Date(`${d}T12:50:00Z`) }, { run: 'A', date: d, at: runAt('A', d) }, { run: 'B', date: d, at: runAt('B', d) });
  }
  return out.sort((a, b) => a.at - b.at);
}

// day: the published day file; now: the viewer's clock. null, or { run, slot, hours, text }
export function staleBanner(day, now = new Date()) {
  if (!day || day.kind !== 'live' || !day.generatedAt?.utc) return null;
  const gen = new Date(day.generatedAt.utc), t = new Date(now);
  const genDate = etParts(gen).date;
  // B "대상 없음": a run A day with no B-group game has no B publish to wait for
  const noB = day.run === 'A' && !(day.games ?? []).some(g => g.group === 'B');
  const due = slots(t).filter(s => s.at.getTime() + STALE_HOURS * 3600e3 <= t.getTime() && s.at.getTime() - SLACK_MS > gen.getTime())
    .filter(s => !(noB && s.run === 'B' && s.date === genDate));
  if (!due.length) return null;
  const s = due[0]; // the first expected run with no publish after it
  const hours = Math.floor((t - gen) / 3600e3);
  return { run: s.run, slot: s.at.toISOString(), hours, text: `마지막 게시 ${hours}시간 전(${md(kst(gen))} KST) — 실행 ${s.run}(${md(kst(s.at))} KST) 뒤 게시가 없습니다. 예약 작업 확인` };
}

// chain records -> evaluation count and the KST date of the last odds record
export function evalLine(chain = []) {
  const evaluations = chain.filter(r => r.type === 'evaluation').length;
  const odds = chain.filter(r => r.type === 'odds' && r.createdAt);
  const last = odds.map(r => r.createdAt.utc ?? r.createdAt).sort().at(-1) ?? null;
  const lastOdds = last ? kst(last).slice(0, 10) : null;
  return { evaluations, lastOdds, text: `평가 레코드 ${evaluations}건 · 마지막 배당 입력 ${lastOdds ? `${lastOdds} (KST)` : '없음'}` };
}
