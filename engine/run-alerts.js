// Daily-run warnings added 2026-10-26 (user decision 4 and 6): a PDF "Out" row whose player is known under another
// spelling (the prediction then ignores the injury), and the escalation of a warning seen in two runs in a row.
import { normalizeName, teamKey } from './injury.js';
import { byEspn } from './teams.js';
import { runAt } from './trigger-time.js';
import { etParts } from './time.js';

const loose = name => normalizeName(name ?? '').replace(/[^a-z]/g, '');

// rows: engine/live.js livePlans rows; pdfRows: the snapshot rows the run used.
// Out rows the exact match missed: `known` when a player of the pool has the same letters (warning), else no game
// record yet (two-way, unsigned or not yet played: no minutes in any plan, listed in the run log only).
export function pdfOutUnmatched(rows, pdfRows = []) {
  const known = [], noRecord = [];
  for (const r of rows) {
    const f = r.fixture;
    ['home', 'away'].forEach((side, i) => {
      const abbr = f[side].abbr, key = byEspn(abbr).key;
      const pool = new Map(r.players[i].map(p => [loose(p.name), p]));
      for (const name of r.snapshot?.[side]?.unmatched ?? []) {
        const row = pdfRows.find(x => x.player === name && teamKey(x.team) === key);
        if (row?.status !== 'Out') continue;
        const p = pool.get(loose(name));
        const item = { gameId: f.id, game: `${f.away.abbr}@${f.home.abbr}`, team: abbr, player: name };
        if (p) known.push({ ...item, playerId: p.id, known: p.name }); else noRecord.push(item);
      }
    });
  }
  return { known, noRecord };
}

// which earlier run a code is compared with: data collection runs in run A only
export const ESCALATE = { dataDelay: 'A', pdfUnmatched: 'any', runEarly: 'same', finalZero: 'same' };

// alerts of this run, earlier run logs (oldest first) -> the alerts with { escalated, streak } on codes seen in the
// comparable earlier run too, and the push texts
export function escalate(alerts, earlier, run) {
  const push = [];
  const out = alerts.map(a => {
    const scope = ESCALATE[a.code];
    if (!scope) return a;
    const prev = earlier.filter(l => scope === 'any' || l.run === (scope === 'same' ? run : scope)).filter(l => scope !== 'A' || run === 'A')
      // finalZero: days with no game of the run's own group (and B "대상 없음") neither count nor break the streak
      .filter(l => a.code !== 'finalZero' || (l.games ?? []).some(g => g.group === run && g.run === run));
    let streak = 1;
    for (let i = prev.length - 1; i >= 0 && prev[i].alerts?.some(x => x.code === a.code); i--) streak++;
    if (streak < 2) return a;
    if (PUSH_AT_ONCE.has(a.code)) return { ...a, escalated: true, streak }; // pushed at once already (prepare)
    push.push(`[NBA 일일 실행] ${streak}회 연속 경고 — ${a.text}`);
    return { ...a, escalated: true, streak };
  });
  return { alerts: out, push };
}

// ---- automatic run checks (docs/plans/2026-11-13-auto-alerts.md, registered 13d9e15, revised 9e36947) ----------
// Warnings only: nothing here changes a prediction, a final/provisional flag, an evaluation or a pick-log record.
const hm = d => { const e = etParts(d); return `${String(e.hour).padStart(2, '0')}:${String(e.minute).padStart(2, '0')}`; };
const prevDate = d => new Date(Date.parse(`${d}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);

// runEarly: a scheduled run (not --manual) that started 5 minutes or more before its time; no upper bound; push at once
export function runEarly({ run, date, startedAt, manual = false }) {
  if (manual) return null;
  const at = runAt(run, date), early = (at - new Date(startedAt)) / 60000;
  if (early < 5) return null;
  const min = Math.floor(early);
  return { code: 'runEarly', text: `실행 ${run}가 기준 시각(${hm(at)} ET)보다 ${min}분 일찍 돌았습니다. 예측은 예비입니다. 예약 시각(서머타임)을 확인하세요`, earlyMin: min };
}

// the scheduled runs in order: C(d) 07:50, A(d) 17:50, B(d) 20:50 ET, then C(d+1)
const ORDER = ['C', 'A', 'B'];
const before = ({ run, date }) => { const i = ORDER.indexOf(run); return i > 0 ? { run: ORDER[i - 1], date } : { run: 'B', date: prevDate(date) }; };
// the runs each run must see (cross-check table): A -> C(d), B(d-1); B -> A(d); C -> B(d-1), A(d-1)
const REQUIRED = { A: 2, B: 1, C: 2 };

// missedRun: present(run, date) -> whether data/runs holds a log of that run. earliest: the ET date of the season's
// first run log (no warning for runs before it). Lists the consecutive missing runs back from this one (at most 9).
export function missedRun({ run, date, present, earliest }) {
  if (!earliest) return null;
  const missing = [];
  let cur = { run, date };
  for (let k = 0; missing.length < 9; k++) {
    cur = before(cur);
    if (cur.date < earliest) break;
    if (present(cur.run, cur.date)) { if (k + 1 >= REQUIRED[run]) break; continue; }
    missing.push(cur);
  }
  if (!missing.length) return null;
  const list = missing.reverse().map(m => `${m.date} ${m.run}`).join(', ');
  return { code: 'missedRun', text: `빠진 실행 ${missing.length}개 — ${list}(ET 날짜). 실행 기록이 없습니다. 예약 실행과 구독 상태를 확인하세요`, missing };
}

// finalZero: run A/B with at least one game of its own group predicted by this run and none of them final; push at once
export function finalZero({ run, games }) {
  if (run === 'C') return null;
  const own = games.filter(g => g.group === run && g.run === run);
  if (!own.length || own.some(g => g.final)) return null;
  return { code: 'finalZero', chip: '시각 오류 의심', text: `시각 오류 의심 — 실행 ${run}의 ${run} 그룹 ${own.length}경기가 모두 예비입니다(최종 0건)`, games: own.length };
}

// push texts of the automatic checks (from the first occurrence)
export const PUSH_AT_ONCE = new Set(['runEarly', 'missedRun', 'finalZero']);
export const pushText = a => `[NBA 일일 실행] ${a.text}`;
