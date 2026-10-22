// Minutes plan for one team and date (design §6.5). Uses only the accumulator's history before the date.
//   expected minutes: EWMA (half-life 5 games) of the last 15 appearances; coach's-decision DNPs count as 0,
//   injury/rest/other DNPs are skipped
//   absences: minutes go to the same position group first, then everyone; team total 240
//   back-to-back second night: starters −8%; players who have rested on back-to-backs get a rest probability
export const MINUTES_PARAMS = {
  window: 15, halfLife: 5, b2bStarterCut: 0.08, restK: 5, newPlayerMin: 12, rosterGames: 15, maxMin: 44,
};

const prevDay = d => new Date(Date.parse(`${d}T12:00:00Z`) - 86400e3).toISOString().slice(0, 10);
const coachDnp = r => /COACH/i.test(r ?? '');

// players whose latest appearance before `date` was for `team`, within the team's last N games
export function roster(acc, team, date, P = MINUTES_PARAMS) {
  const teamDates = (acc.teamDates.get(team) ?? []).filter(d => d < date);
  const recent = new Set(teamDates.slice(-P.rosterGames));
  const out = [];
  for (const [id, log] of acc.log) {
    const last = [...log].reverse().find(x => x.date < date);
    if (last && last.team === team && recent.has(last.date)) out.push(id);
  }
  return out;
}

function expectedMinutes(log, P) {
  const used = log.filter(x => !x.dnp || coachDnp(x.dnpr)).slice(-P.window);
  if (!used.length) return null;
  let num = 0, den = 0;
  used.forEach((x, i) => {
    const w = 0.5 ** ((used.length - 1 - i) / P.halfLife);
    num += w * (x.dnp ? 0 : x.sec / 60);
    den += w;
  });
  return num / den;
}

// share of back-to-back second nights the player sat out to rest, shrunk toward 0
function restProbability(acc, log, P) {
  let opp = 0, rests = 0;
  for (const x of log) {
    if (!acc.teamPlayedOn(x.team, prevDay(x.date))) continue;
    opp++;
    if (x.dnp && /REST/i.test(x.dnpr ?? '')) rests++;
  }
  return rests / (opp + P.restK);
}

const posOf = log => {
  const c = {};
  for (const x of log) if (x.pos) c[x.pos] = (c[x.pos] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'F';
};

// options: participants (backtest A: exactly who played), injuries {playerId: playProb}
export function projectMinutes(acc, team, date, { participants, injuries = {} } = {}, P = MINUTES_PARAMS) {
  const b2b = acc.teamPlayedOn(team, prevDay(date));
  const ids = participants ? [...new Set([...participants, ...roster(acc, team, date, P)])] : roster(acc, team, date, P);
  const rows = ids.map(id => {
    const log = acc.playerLog(id, date);
    const e = expectedMinutes(log, P);
    let playProb = participants ? (participants.includes(id) ? 1 : 0) : (injuries[id] ?? 1);
    if (!participants && b2b && playProb > 0) playProb *= 1 - restProbability(acc, log, P);
    return { playerId: id, pos: log.length ? posOf(log) : 'F', base: e ?? P.newPlayerMin, starter: false, playProb };
  });
  // starters = five largest expected minutes among those likely to play
  [...rows].filter(r => r.playProb > 0).sort((a, b) => b.base - a.base).slice(0, 5).forEach(r => { r.starter = true; });

  // absent minutes -> same position group (proportional), the remainder -> everyone
  const min = new Map(rows.map(r => [r.playerId, r.base]));
  for (const g of ['G', 'F', 'C']) {
    const grp = rows.filter(r => r.pos === g);
    const mass = grp.reduce((a, r) => a + r.base * (1 - r.playProb), 0);
    const act = grp.filter(r => r.playProb > 0);
    const w = act.reduce((a, r) => a + r.base * r.playProb, 0);
    if (mass > 0 && w > 0) for (const r of act) min.set(r.playerId, min.get(r.playerId) + mass * (r.base * r.playProb) / w);
  }
  if (b2b) for (const r of rows) if (r.starter) min.set(r.playerId, min.get(r.playerId) * (1 - P.b2bStarterCut));

  // scale to 240 expected team minutes; players at the cap stay there, the rest absorb the remainder
  const active = rows.filter(r => r.playProb > 0);
  const capped = new Set();
  for (let it = 0; it <= active.length; it++) {
    const fixed = active.filter(r => capped.has(r.playerId)).reduce((a, r) => a + P.maxMin * r.playProb, 0);
    const free = active.filter(r => !capped.has(r.playerId));
    const total = free.reduce((a, r) => a + min.get(r.playerId) * r.playProb, 0);
    if (!total) break;
    const s = (240 - fixed) / total;
    let newCap = false;
    for (const r of free) {
      const m = min.get(r.playerId) * s;
      if (m > P.maxMin) { capped.add(r.playerId); newCap = true; }
      min.set(r.playerId, Math.min(m, P.maxMin));
    }
    if (!newCap) break;
  }
  return {
    teamId: team, date, b2b,
    players: rows.map(r => ({ playerId: r.playerId, pos: r.pos, expMin: r.playProb > 0 ? min.get(r.playerId) : 0, playProb: r.playProb, starter: r.starter })),
  };
}
