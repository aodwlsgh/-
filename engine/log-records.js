// Pick-log record bodies (P8, design §9.2, §12): odds, evaluation, pick and 2-fold records. The chain functions
// of engine/pick-log.js are used as they are; engine/log-store.js stores the chain.
// One evaluation and at most one pick per market selection: the first one fixed before the deadline with the
// game's final base prediction (run A, or run B for games after 21:00 ET) stays. A later odds entry for the same
// market is kept as an odds record only (no post-hoc edits). A game whose final prediction is not in yet gets odds
// records only; the daily job evaluates the latest odds entry before the deadline (`pendingOdds`).
// Every pick and 2-fold carries the record-only flag and the gate reasons (§9.4).
import { toOddsRecords } from './odds.js';
import { evaluate, picks, gate } from './picks.js';
import { pickRecord } from './pick-log.js';
import { stamp } from './clock.js';
import { etParts } from './time.js';

export const marketKey = r => `${r.round}-${r.betmanNo}`;
export const pickId = leg => `${leg.round}-${leg.betmanNo}-${leg.selection}`; // = pickRecord id
const ms = t => new Date(t).getTime();

// odds records -> the day's games by home and away team (ESPN abbreviations); the deadline must precede the tip-off
export function joinGames(oddsRecs, games) {
  const errs = [];
  const out = oddsRecs.map(r => {
    const g = games.find(x => x.home.espn === r.home && x.away.espn === r.away);
    if (!g) { errs.push(`#${r.betmanNo} ${r.awayKo} @ ${r.homeKo}: no such game on this day`); return r; }
    if (ms(r.deadline.utc) > ms(g.start.utc)) errs.push(`#${r.betmanNo}: deadline ${r.deadline.kst} after the tip-off`);
    return { ...r, gameId: g.gameId };
  });
  if (errs.length) throw new Error(`odds input rejected: ${errs.join('; ')}`);
  return out;
}

// odds records not evaluated yet: the latest entry per market before its deadline (a market closed as
// `unevaluated`, engine/day-status.js, is never evaluated later)
export function pendingOdds(chain, { now = new Date() } = {}) {
  const done = new Set(chain.filter(r => r.type === 'evaluation' || r.type === 'unevaluated').map(marketKey));
  const latest = new Map();
  for (const r of chain) {
    if (r.type !== 'odds' || done.has(marketKey(r)) || ms(r.deadline.utc) <= ms(now)) continue;
    const cur = latest.get(marketKey(r));
    if (!cur || ms(r.capturedAt.utc) >= ms(cur.capturedAt.utc)) latest.set(marketKey(r), r);
  }
  return [...latest.values()];
}

export function evaluationRecords({ oddsRecs, day, cal, chain = [], now = new Date() }) {
  const games = new Map(day.games.map(g => [g.gameId, g]));
  const fixed = new Set(chain.filter(r => r.type === 'evaluation' || r.type === 'unevaluated').map(marketKey)); // closed either way
  const notes = [], todo = [];
  for (const o of oddsRecs) {
    const k = marketKey(o);
    if (fixed.has(k)) { notes.push({ market: k, note: 'already fixed' }); continue; }
    if (!games.get(o.gameId)?.prediction?.final) { notes.push({ market: k, note: 'awaiting the final prediction' }); continue; }
    if (ms(now) >= ms(o.deadline.utc)) { notes.push({ market: k, note: 'after the deadline' }); continue; }
    fixed.add(k);
    todo.push(o);
  }
  const preds = [...new Set(todo.map(o => o.gameId))].map(id => ({ ...games.get(id).prediction, gameId: id }));
  const rows = evaluate(todo, preds, cal, { now });
  // earlier evaluations of the same rounds still before their deadline can pair with the new legs
  const rounds = new Set(todo.map(o => o.round));
  const open = chain.filter(r => r.type === 'evaluation' && rounds.has(r.round) && !r.unsupported && ms(r.deadline.utc) > ms(now));
  const result = picks([...open, ...rows]);
  const havePick = new Set(chain.filter(r => r.type === 'pick').map(r => r.id));
  const haveCombo = new Set(chain.filter(r => r.type === 'combo').map(r => r.id));
  const reasons = leg => gate(leg.market, etParts(new Date(games.get(leg.gameId)?.start?.utc ?? leg.deadline.utc)).date).reasons;
  const createdAt = stamp(now);
  const evals = rows.map(r => ({ type: 'evaluation', id: pickId(r), ...r, createdAt }));
  const newPicks = result.legs.filter(l => !havePick.has(pickId(l))).map(l => ({ ...pickRecord(l, { now }), recordOnly: true, gateReasons: reasons(l) }));
  const combos = result.combos.map(c => {
    const legs = c.legs.map(pickId).sort();
    const deadline = [...c.legs].sort((a, b) => ms(a.deadline.utc) - ms(b.deadline.utc))[0].deadline;
    return { type: 'combo', id: legs.join('+'), legs, round: c.legs[0].round, oddsProduct: c.oddsProduct, pCons: c.pCons, ev: c.ev, deadline, createdAt, recordOnly: true, gateReasons: [...new Set(c.legs.flatMap(reasons))] };
  }).filter(c => !haveCombo.has(c.id));
  return { records: [...evals, ...newPicks, ...combos], notes, rows, view: result };
}

// a Betman round typed or read on the dashboard -> records to append (odds first)
export function roundRecords({ input, day, cal, chain = [], now = new Date() }) {
  if (day.kind !== 'live') throw new Error('example data: odds input and pick records are disabled');
  const createdAt = stamp(now);
  const odds = joinGames(toOddsRecords(input, { now }), day.games).map(o => ({ ...o, createdAt }));
  const ev = evaluationRecords({ oddsRecs: odds, day, cal, chain, now });
  return { records: [...odds, ...ev.records], notes: ev.notes, rows: ev.rows, view: ev.view };
}
