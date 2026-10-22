// Which ESPN "regular-season" events count toward the 82-game schedule (P2).
export const NBA_TEAMS = ['ATL', 'BKN', 'BOS', 'CHA', 'CHI', 'CLE', 'DAL', 'DEN', 'DET', 'GS', 'HOU', 'IND', 'LAC', 'LAL', 'MEM',
  'MIA', 'MIL', 'MIN', 'NO', 'NY', 'OKC', 'ORL', 'PHI', 'PHX', 'POR', 'SA', 'SAC', 'TOR', 'UTAH', 'WSH'];

// ESPN labels All-Star games and the NBA Cup final "regular-season"; neither counts toward the 82.
// Returns the reason a row is excluded, or null when it counts.
export function scheduleExclusion(row) {
  if (row.slug !== 'regular-season') return `slug ${row.slug}`;
  if (!NBA_TEAMS.includes(row.home) || !NBA_TEAMS.includes(row.away)) return 'all-star / non-NBA team';
  if (row.ctype === 'CC') return 'NBA Cup championship (not in standings)';
  if (row.status !== 'STATUS_FINAL') return `status ${row.status}`;
  return null;
}
