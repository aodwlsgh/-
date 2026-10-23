// Betman odds input (P7, design §10). Odds are read from the screen, a capture or typed in; never crawled.
// Every market record keeps the line, the odds per selection, the capture time and the deadline (UTC and KST), the
// simple implied probabilities 1/odds, the overround and the no-vig market probabilities. The no-vig method is
// fixed to proportional normalisation, (1/odds) / Σ(1/odds) (2026-10-23 user condition 3; design §10.3).
import { byKorean } from './teams.js';
import { stamp } from './clock.js';

export const SELECTIONS = { ML: ['home', 'away'], ML5: ['home', 'close', 'away'], HC: ['home', 'away'], OU: ['over', 'under'] };
export const NO_VIG_METHOD = 'proportional';

export function noVig(odds) {
  const inv = Object.fromEntries(Object.entries(odds).map(([k, o]) => [k, 1 / o]));
  const s = Object.values(inv).reduce((a, b) => a + b, 0);
  return Object.fromEntries(Object.entries(inv).map(([k, v]) => [k, v / s]));
}

// §10.2: odds 1.01-50, lines in 0.5 steps (HC, OU), deadline after the capture time and after `now`,
// one round per input, known team names, every selection of the market present
export function validateRound(input, { now = new Date() } = {}) {
  const errs = [];
  const cap = new Date(input.capturedAt);
  if (!Number.isInteger(input.round)) errs.push('round: not an integer');
  if (Number.isNaN(cap.getTime())) errs.push('capturedAt: not a time');
  if (!['chrome', 'screenshot', 'manual'].includes(input.source)) errs.push(`source: ${input.source}`);
  for (const m of input.markets ?? []) {
    const at = `#${m.betmanNo}`;
    const sel = SELECTIONS[m.type];
    if (!sel) { errs.push(`${at} type ${m.type}`); continue; }
    for (const k of sel) if (!(k in (m.odds ?? {}))) errs.push(`${at} ${m.type}: selection ${k} missing`);
    for (const [k, o] of Object.entries(m.odds ?? {})) if (!(o >= 1.01 && o <= 50)) errs.push(`${at} odds ${k}=${o} outside 1.01-50`);
    if (m.type === 'HC' || m.type === 'OU') { if (!Number.isFinite(m.line) || Math.abs(m.line * 2 - Math.round(m.line * 2)) > 1e-9) errs.push(`${at} line ${m.line} not in 0.5 steps`); }
    const dl = new Date(m.deadline);
    if (Number.isNaN(dl.getTime()) || dl <= cap || dl <= new Date(now)) errs.push(`${at} deadline ${m.deadline} not in the future`);
    if (!byKorean(m.home) || !byKorean(m.away)) errs.push(`${at} team name not mapped: ${m.home} / ${m.away}`);
  }
  return errs;
}

// one record per market; gameId is joined later from the schedule (home, away, deadline date)
export function toOddsRecords(input, { now = new Date() } = {}) {
  const errs = validateRound(input, { now });
  if (errs.length) throw new Error(`odds input rejected: ${errs.join('; ')}`);
  return input.markets.map(m => {
    const implied = Object.fromEntries(Object.entries(m.odds).map(([k, o]) => [k, 1 / o]));
    const line = m.type === 'HC' || m.type === 'OU' ? m.line : null;
    return {
      type: 'odds', round: input.round, betmanNo: m.betmanNo, source: input.source, capturedAt: stamp(input.capturedAt), deadline: stamp(m.deadline),
      home: byKorean(m.home).espn, away: byKorean(m.away).espn, homeKo: m.home, awayKo: m.away, market: m.type, line,
      lineKind: line === null ? null : Number.isInteger(line) ? 'integer' : 'half',
      odds: { ...m.odds }, implied, overround: Object.values(implied).reduce((a, b) => a + b, 0), noVig: noVig(m.odds), noVigMethod: NO_VIG_METHOD,
    };
  });
}
