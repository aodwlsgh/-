// Pick engine (P7, design §9.2-§9.4). Unchanged rules (2026-10-23 user condition 3):
//   p_cons = p - 0.1·|p - 0.5| (registered formula);  EV = p_cons × odds - 1
//   leg: EV >= +3%;  2-fold: two legs, different games, same round, raw odds product >= 2.0,
//   combo EV = p_cons1·p_cons2·o1·o2 - 1, sorted by EV then hit probability, top 3; none -> "오늘은 패스"
// The old formula 0.5 + 0.9·(p - 0.5) and its EV are kept on every row for comparison only.
// Only the base prediction is used (engine/markets.js assertBase). Every market is record-only for now (§9.4).
import { marketProbs, assertBase } from './markets.js';
import { markets } from './calibrate.js';
import { noVig } from './odds.js';
import { seasonOf } from './model.js';

export const EV_MIN = 0.03, COMBO_MIN_ODDS = 2.0, TOP_COMBOS = 3;
export const pCons = p => p - 0.1 * Math.abs(p - 0.5);
export const pConsOld = p => 0.5 + 0.9 * (p - 0.5);

// first month of a season: the opening day (ET) through opening day + 30 days, inclusive — the same definition
// as the 2025-26 opening report. 2026-27 opening day from data/schedule/2026-27.json (ESPN scoreboard scan,
// generated 2026-10-22): 2026-10-20 (BOS@DET, PHI@NY, OKC@SA).
export const SEASON_OPENING = { '2026-27': '2026-10-20' };
export const FIRST_MONTH = { days: 30, rule: 'opening day through opening day + 30 days, inclusive (ET dates)' };

export function inFirstMonth(etDate) {
  const open = SEASON_OPENING[seasonOf(etDate)];
  if (!open) return false;
  const days = (Date.parse(etDate) - Date.parse(open)) / 86400e3;
  return days >= 0 && days <= FIRST_MONTH.days;
}

// every market is record-only until the user releases it (§9.4); the first month of 2026-27 stays record-only
// regardless of market (2026-10-23 user decision)
export function gate(market, etDate) {
  const reasons = ['record-only period (§9.4): no purchase advice until the exit conditions are met and the user approves'];
  if (inFirstMonth(etDate)) reasons.push(`first month of ${seasonOf(etDate)} (opening ${SEASON_OPENING[seasonOf(etDate)]} + ${FIRST_MONTH.days} days)`);
  return { market, status: 'record-only', purchaseAllowed: false, reasons };
}

// outcome of a selection from the final score (overtime included); null when the line is unsupported
export function settle(market, selection, line, margin, total) {
  switch (market) {
    case 'ML': return selection === 'home' ? margin > 0 : margin < 0;
    case 'ML5': return selection === 'home' ? margin >= 6 : selection === 'away' ? margin <= -6 : Math.abs(margin) <= 5;
    case 'HC': { if (Number.isInteger(line)) return null; const home = margin + line > 0; return selection === 'home' ? home : !home; }
    case 'OU': { if (Number.isInteger(line)) return null; const over = total > line; return selection === 'over' ? over : !over; }
    default: return null;
  }
}

// one row per selection of every odds record that has a base prediction for its game
export function evaluate(oddsRecs, predictions, cal, { now = new Date() } = {}) {
  predictions.forEach(assertBase);
  const byGame = new Map(predictions.map(p => [p.gameId, p]));
  const rows = [];
  for (const rec of oddsRecs) {
    const pred = byGame.get(rec.gameId);
    if (!pred) continue;
    const market = rec.type === 'odds' ? rec.market : rec.type;
    const probs = marketProbs(pred, cal, { ...rec, type: market });
    const nv = rec.noVig ?? noVig(rec.odds);
    for (const [selection, odds] of Object.entries(rec.odds)) {
      const base = { gameId: rec.gameId, round: rec.round, betmanNo: rec.betmanNo, market, line: rec.line ?? null, selection, odds, deadline: rec.deadline, noVig: nv[selection], predictionRef: pred.runId, predictionRun: pred.run ?? null, predTotal: pred.sim.total, evaluatedAt: new Date(now).toISOString() };
      if (probs.unsupported) { rows.push({ ...base, unsupported: probs.unsupported }); continue; }
      const p = probs[selection], pc = pCons(p), pco = pConsOld(p);
      rows.push({ ...base, p, pCons: pc, ev: pc * odds - 1, pConsOld: pco, evOld: pco * odds - 1 });
    }
  }
  return rows;
}

export function picks(rows) {
  const legs = rows.filter(r => !r.unsupported && r.ev >= EV_MIN);
  const combos = [];
  for (let i = 0; i < legs.length; i++) {
    for (let j = i + 1; j < legs.length; j++) {
      const a = legs[i], b = legs[j];
      if (a.gameId === b.gameId || a.round !== b.round) continue;
      const oddsProduct = a.odds * b.odds;
      if (oddsProduct < COMBO_MIN_ODDS) continue;
      const hit = a.pCons * b.pCons;
      combos.push({ legs: [a, b], oddsProduct, pCons: hit, ev: hit * oddsProduct - 1 });
    }
  }
  combos.sort((x, y) => y.ev - x.ev || y.pCons - x.pCons);
  const top = combos.slice(0, TOP_COMBOS);
  const deadlines = top.flatMap(c => c.legs.map(l => l.deadline?.utc)).filter(Boolean).sort();
  return { legs, combos: top, earliestDeadline: deadlines[0] ?? null, pass: top.length === 0, message: top.length === 0 ? '오늘은 패스' : null };
}

// §9.3 breakeven table: minimum odds 1.03 / p_cons; handicap and over/under x.5 lines within ±3 of the expectation
export function breakeven(prediction, cal) {
  assertBase(prediction);
  const m = markets(cal, prediction.sim);
  const row = p => ({ p, pCons: pCons(p), minOdds: 1.03 / pCons(p) });
  const center = prediction.sim.margin + (prediction.sim.shift ?? 0);
  const halfLines = (c, lo, hi) => { const out = []; for (let L = Math.ceil(c - 3 - 0.5) + 0.5; L <= c + 3; L += 1) if (L >= c - 3 && L >= lo && L <= hi) out.push(L); return out; };
  const hc = halfLines(-center, -15.5, 15.5).filter(H => m.hc(H) !== null).map(H => ({ line: H, home: row(m.hc(H)), away: row(1 - m.hc(H)) }));
  const ou = halfLines(prediction.sim.total, -Infinity, Infinity).filter(L => m.ou(L) !== null).map(L => ({ line: L, over: row(m.ou(L)), under: row(1 - m.ou(L)) }));
  return { ml: { home: row(m.ml.home), away: row(m.ml.away) }, ml5: Object.fromEntries(Object.entries(m.ml5).map(([k, p]) => [k, row(p)])), hc, ou };
}
