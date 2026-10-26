// Daily-run warnings added 2026-10-26 (user decision 4 and 6): a PDF "Out" row whose player is known under another
// spelling (the prediction then ignores the injury), and the escalation of a warning seen in two runs in a row.
import { normalizeName, teamKey } from './injury.js';
import { byEspn } from './teams.js';

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
export const ESCALATE = { dataDelay: 'A', pdfUnmatched: 'any' };

// alerts of this run, earlier run logs (oldest first) -> the alerts with { escalated, streak } on codes seen in the
// comparable earlier run too, and the push texts
export function escalate(alerts, earlier, run) {
  const push = [];
  const out = alerts.map(a => {
    const scope = ESCALATE[a.code];
    if (!scope) return a;
    const prev = earlier.filter(l => scope === 'any' || l.run === scope).filter(l => scope !== 'A' || run === 'A');
    let streak = 1;
    for (let i = prev.length - 1; i >= 0 && prev[i].alerts?.some(x => x.code === a.code); i--) streak++;
    if (streak < 2) return a;
    push.push(`[NBA 일일 실행] ${streak}회 연속 경고 — ${a.text}`);
    return { ...a, escalated: true, streak };
  });
  return { alerts: out, push };
}
