// Automatic scenarios (P6, design §8.2). Injuries and back-to-backs are already inside the validated base
// prediction (minutes plans), so nothing is applied twice. The early-season chemistry scenario is OFF by default
// (2026-10-23 user decision): it is only detected and offered to the user, with the design's initial size
// (-1.5 points per 100 possessions at the team's first game, linearly to 0 at game 15) labelled unverified.
// Turning it on needs a size set on 2024-25 or earlier data, a check on accumulating 2026-27 games and approval.
import { UNVERIFIED } from './scenario.js';
import { seasonOf } from './model.js';

export const CHEMISTRY = { initialPtsPer100: -1.5, zeroAtGame: 15, minNewInTop8: 2, status: 'initial value from design §8.2, not fitted' };

export function chemistryFlag({ plan, newPlayerIds, teamGame, team }) {
  const top8 = [...plan.players].filter(p => p.playProb > 0 && p.expMin > 0).sort((a, b) => b.expMin - a.expMin).slice(0, 8).map(p => p.playerId);
  const newInTop8 = top8.filter(id => newPlayerIds.includes(id)).length;
  const size = CHEMISTRY.initialPtsPer100 * Math.max(0, 1 - (teamGame - 1) / (CHEMISTRY.zeroAtGame - 1));
  return {
    flagged: newInTop8 >= CHEMISTRY.minNewInTop8, newInTop8, applied: false, label: UNVERIFIED, basis: CHEMISTRY.status,
    suggested: { chemistry: [{ team, ptsPer100: +size.toFixed(4) || 0 }] },
  };
}

// players in the plan whose previous-season games were not for this team (or who have no previous season)
export function newPlayers(acc, team, date, plan) {
  const prev = `${+seasonOf(date).slice(0, 4) - 1}-${seasonOf(date).slice(2, 4)}`;
  return plan.players.map(p => p.playerId).filter(id => {
    const last = (acc.log.get(id) ?? []).filter(x => x.date < date && seasonOf(x.date) === prev).at(-1);
    return !last || last.team !== team;
  });
}
