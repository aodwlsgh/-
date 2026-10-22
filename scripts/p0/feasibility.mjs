// P0 feasibility check on an ESPN sample: possessions vs box estimate,
// stints from substitutions, shot zones from coordinates.
// Prototype only — P1 rebuilds this as engine/parse.js under TDD.
// Usage: node scripts/p0/feasibility.mjs <rawDir> [--json out.json]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2];
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const sample = JSON.parse(await readFile(join(dir, 'sample.json'), 'utf8'));

const NO_COORD = -1e6;
const isFT = p => /^Free Throw/.test(p.type.text);
const isFGA = p => p.shootingPlay && !isFT(p);
const isTO = p => /Turnover/.test(p.type.text) || p.type.text === 'Traveling';
const isOreb = p => p.type.text === 'Offensive Rebound';
const isDreb = p => p.type.text === 'Defensive Rebound';
const isTechFT = p => /Technical/.test(p.type.text) || /technical/i.test(p.text);

function clockSec(s) {
  if (s.includes(':')) { const [m, x] = s.split(':'); return +m * 60 + +x; }
  return +s;
}
const periodLen = n => (n <= 4 ? 720 : 300);

function teamStat(team, name) {
  const s = team.statistics.find(x => x.name === name);
  if (!s) throw new Error(`missing team stat ${name}`);
  return s.displayValue;
}
const pair = v => v.split('-').map(Number);

// --- A. possessions: count runs of the offensive team per period ---------------
function offenseOf(p) {
  if (isFT(p)) return isTechFT(p) ? null : p.team?.id;
  if (isFGA(p) || isTO(p) || isOreb(p)) return p.team?.id;
  if (isDreb(p)) return p.team?.id; // rebounding team gains the ball
  return null;
}
function possessions(plays) {
  const count = {};
  let cur = null, period = 0;
  for (const p of plays) {
    if (p.period.number !== period) { period = p.period.number; cur = null; }
    const o = offenseOf(p);
    if (!o) continue;
    if (isDreb(p)) { // ends the other team's possession; new run for rebounder
      if (cur !== o) { cur = o; count[o] = (count[o] || 0) + 1; }
      continue;
    }
    if (o !== cur) { cur = o; count[o] = (count[o] || 0) + 1; }
  }
  return count;
}

// --- B. stints ------------------------------------------------------------------
function stints(s) {
  const plays = s.plays;
  const teams = s.boxscore.players.map(t => t.team.id);
  const box = {}; const starters = {}; const roster = {};
  const anomalies = { notInBox: 0, subMissingIn: 0, lateFill: 0, boxMinMissing: 0 };
  for (const t of s.boxscore.players) {
    const st = t.statistics[0];
    const iMin = st.labels.indexOf('MIN');
    starters[t.team.id] = st.athletes.filter(a => a.starter).map(a => a.athlete.id);
    roster[t.team.id] = new Set(st.athletes.map(a => a.athlete.id));
    for (const a of st.athletes) { const v = a.didNotPlay ? 0 : +(a.stats[iMin] || 0); if (Number.isFinite(v)) box[a.athlete.id] = v; else anomalies.boxMinMissing++; }
  }
  const teamOf = pid => teams.find(t => roster[t].has(pid));
  // ids in substitutions but missing from the box roster: attribute by the play's team
  for (const p of plays) {
    if (p.type.text !== 'Substitution' || !teams.includes(p.team?.id)) continue;
    for (const x of p.participants || []) {
      if (!teamOf(x.athlete.id)) { roster[p.team.id].add(x.athlete.id); anomalies.notInBox++; }
    }
  }
  const maxPeriod = Math.max(...plays.map(p => p.period.number));
  const secs = {}; let periodsOk = 0, periodsTotal = 0, badStints = 0, nStints = 0;
  let prevEnd = { [teams[0]]: starters[teams[0]], [teams[1]]: starters[teams[1]] };
  for (let per = 1; per <= maxPeriod; per++) {
    const pp = plays.filter(p => p.period.number === per);
    const on = {};
    for (const t of teams) {
      if (per === 1) { on[t] = new Set(starters[t]); continue; }
      // players whose first event in the period is not "entering" were on court at the start
      const first = new Map();
      for (const p of pp) {
        const sub = p.type.text === 'Substitution';
        (p.participants || []).forEach((x, i) => {
          const id = x.athlete.id;
          if (teamOf(id) !== t || first.has(id)) return;
          first.set(id, sub ? (i === 0 ? 'in' : 'out') : 'act');
        });
      }
      const start = new Set([...first].filter(([, v]) => v !== 'in').map(([k]) => k));
      // players silent all period: carry over from previous period's end if needed
      for (const id of prevEnd[t]) if (start.size < 5 && !first.has(id)) start.add(id);
      on[t] = start;
    }
    for (const t of teams) { periodsTotal++; if (on[t].size === 5) periodsOk++; }
    let last = periodLen(per);
    const flush = now => {
      const dt = last - now;
      if (dt > 0) {
        nStints++;
        for (const t of teams) {
          if (on[t].size !== 5) badStints++;
          for (const id of on[t]) secs[id] = (secs[id] || 0) + dt;
        }
      }
      last = now;
    };
    for (const p of pp) {
      if (p.type.text !== 'Substitution') {
        // a player acting while not on court fills a hole left by a broken sub
        for (const x of p.participants || []) {
          const id = x.athlete.id, t = teamOf(id);
          if (t && on[t].size < 5 && !on[t].has(id) && !/Foul|Technical/.test(p.type.text)) { on[t].add(id); anomalies.lateFill++; }
        }
        continue;
      }
      const ids = (p.participants || []).map(x => x.athlete.id);
      const t = p.team?.id;
      flush(clockSec(p.clock.displayValue));
      if (ids.length === 1) { anomalies.subMissingIn++; on[t].delete(ids[0]); continue; }
      on[t].delete(ids[1]); on[t].add(ids[0]);
    }
    flush(0);
    prevEnd = { [teams[0]]: [...on[teams[0]]], [teams[1]]: [...on[teams[1]]] };
  }
  const diffs = Object.keys(box).map(id => Math.abs((secs[id] || 0) / 60 - box[id]));
  const teamMin = teams.map(t => [...roster[t]].reduce((a, id) => a + (secs[id] || 0), 0) / 60);
  return { periodsOk, periodsTotal, nStints, badStints, diffs, teamMin, maxPeriod, anomalies };
}

// --- C. shot zones --------------------------------------------------------------
const textDist = p => { const m = p.text.match(/(\d+)-foot/); return m ? +m[1] : null; };
function zone(p, hoop) {
  const { x, y } = p.coordinate;
  const d = Math.hypot(x - hoop.x, y - hoop.y);
  if (p.pointsAttempted === 3) return (y - hoop.y) <= 9 /* below the break, ~14ft from baseline */ ? 'c3' : 'ab3';
  if (d <= 4) return 'ra';
  if (Math.abs(x - hoop.x) <= 8 && (y - hoop.y) <= 13.75) return 'paint';
  return 'mid';
}

// ---------------------------------------------------------------------------------
const games = [];
for (const g of sample) {
  games.push(JSON.parse(await readFile(join(dir, `summary_${g.id}.json`), 'utf8')));
}

// fit hoop position from shots with "N-foot" in text (grid search, minimise MAE)
const shots = games.flatMap(s => s.plays.filter(p => isFGA(p) && p.coordinate.x > NO_COORD));
const withD = shots.filter(p => textDist(p) !== null);
let hoop = null, best = Infinity;
for (let hx = 23; hx <= 27; hx += 0.25) for (let hy = -3; hy <= 7; hy += 0.25) {
  let e = 0; for (const p of withD) e += Math.abs(Math.hypot(p.coordinate.x - hx, p.coordinate.y - hy) - textDist(p));
  if (e < best) { best = e; hoop = { x: hx, y: hy }; }
}
const distErr = withD.map(p => Math.abs(Math.hypot(p.coordinate.x - hoop.x, p.coordinate.y - hoop.y) - textDist(p)));

const rows = [];
let fgaPlays = 0, fgaBox = 0, fgaNoCoord = 0, tpaPlays = 0, tpaBox = 0;
const zoneCount = { ra: 0, paint: 0, mid: 0, c3: 0, ab3: 0 };
let threeShort = 0;
for (const s of games) {
  const comp = s.header.competitions[0];
  const label = `${comp.date.slice(0, 10)} ${comp.competitors.map(c => c.team.abbreviation).join('-')}`;
  const poss = possessions(s.plays);
  const est = {}, est2 = {}, boxFlags = [];
  for (const t of s.boxscore.teams) {
    const id = t.team.id;
    const [, fga] = pair(teamStat(t, 'fieldGoalsMade-fieldGoalsAttempted'));
    const [, fta] = pair(teamStat(t, 'freeThrowsMade-freeThrowsAttempted'));
    const [, tpa] = pair(teamStat(t, 'threePointFieldGoalsMade-threePointFieldGoalsAttempted'));
    const oreb = +teamStat(t, 'offensiveRebounds');
    let tov = +teamStat(t, 'totalTurnovers');
    est[id] = fga - oreb + tov + 0.44 * fta;
    // corrected: add live-ball team offensive rebounds (pbp), which ESPN box OREB omits,
    // and fall back to pbp turnovers when the box reports none
    const pl = s.plays;
    let teamOrebLive = 0;
    pl.forEach((p, i) => {
      if (p.team?.id !== id || p.type.text !== 'Offensive Rebound' || (p.participants || []).length) return;
      const prev = pl.slice(0, i).reverse().find(q => q.type.text !== 'Substitution' && !/Timeout/.test(q.type.text));
      const m = prev && isFT(prev) && prev.type.text.match(/(\d) of (\d)/);
      if (!(m && m[1] !== m[2])) teamOrebLive++;
    });
    const tovPbp = pl.filter(p => p.team?.id === id && isTO(p)).length;
    if (tov === 0 && tovPbp > 0) { boxFlags.push(`${t.team.abbreviation} box TOV=0 (pbp ${tovPbp})`); tov = tovPbp; }
    est2[id] = fga - oreb - teamOrebLive + tov + 0.44 * fta;
    fgaBox += fga; tpaBox += tpa;
  }
  const fg = s.plays.filter(isFGA);
  fgaPlays += fg.length; tpaPlays += fg.filter(p => p.pointsAttempted === 3).length;
  for (const p of fg) {
    if (p.coordinate.x <= NO_COORD) { fgaNoCoord++; continue; }
    zoneCount[zone(p, hoop)]++;
    if (p.pointsAttempted === 3 && Math.hypot(p.coordinate.x - hoop.x, p.coordinate.y - hoop.y) < 21) threeShort++;
  }
  const ids = Object.keys(est);
  const pPoss = ids.reduce((a, id) => a + (poss[id] || 0), 0) / 2;
  const pEst = ids.reduce((a, id) => a + est[id], 0) / 2;
  const pEst2 = ids.reduce((a, id) => a + est2[id], 0) / 2;
  const st = stints(s);
  rows.push({
    game: label, possPbp: pPoss, possBox: +pEst.toFixed(1), diffPct: +(100 * (pPoss - pEst) / pEst).toFixed(2),
    possBox2: +pEst2.toFixed(1), diffPct2: +(100 * (pPoss - pEst2) / pEst2).toFixed(2), boxFlags: boxFlags.join('; '),
    perTeam: ids.map(id => +(100 * ((poss[id] || 0) - est[id]) / est[id]).toFixed(1)),
    periods: `${st.periodsOk}/${st.periodsTotal}`, stints: st.nStints, badStints: st.badStints,
    teamMin: st.teamMin.map(m => +m.toFixed(1)), maxMinDiff: +Math.max(...st.diffs).toFixed(2),
    within1: st.diffs.filter(d => d <= 1).length, players: st.diffs.length, ot: st.maxPeriod > 4,
    anomalies: Object.values(st.anomalies).join('/'), _an: st.anomalies,
  });
}

const n = rows.length;
const pass = rows.filter(r => Math.abs(r.diffPct) <= 2).length;
const absd = rows.map(r => Math.abs(r.diffPct));
const absd2 = rows.map(r => Math.abs(r.diffPct2));
const mean = a => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
const summary = {
  games: n,
  possessions: { passWithin2pct: `${pass}/${n}`, meanAbsPct: mean(absd), meanSignedPct: mean(rows.map(r => r.diffPct)), maxAbsPct: Math.max(...absd) },
  possessionsCorrected: {
    passWithin2pct: `${absd2.filter(d => d <= 2).length}/${n}`, meanAbsPct: mean(absd2), meanSignedPct: mean(rows.map(r => r.diffPct2)), maxAbsPct: Math.max(...absd2),
    boxFlags: rows.filter(r => r.boxFlags).map(r => `${r.game}: ${r.boxFlags}`),
  },
  stints: {
    periodsWith5: rows.reduce((a, r) => a + +r.periods.split('/')[0], 0) + '/' + rows.reduce((a, r) => a + +r.periods.split('/')[1], 0),
    stintsTotal: rows.reduce((a, r) => a + r.stints, 0), stintsNot5: rows.reduce((a, r) => a + r.badStints, 0),
    playersMinWithin1: rows.reduce((a, r) => a + r.within1, 0) + '/' + rows.reduce((a, r) => a + r.players, 0),
    maxPlayerMinDiff: Math.max(...rows.map(r => r.maxMinDiff)),
    anomalies: rows.reduce((a, r) => { for (const k in r._an) a[k] = (a[k] || 0) + r._an[k]; return a; }, {}),
  },
  shots: {
    fgaPlays, fgaBox, fgaNoCoord, tpaPlays, tpaBox, hoop,
    textDistShots: withD.length, distMAE: +(distErr.reduce((a, b) => a + b, 0) / distErr.length).toFixed(2),
    distWithin2ft: `${distErr.filter(e => e <= 2).length}/${distErr.length}`, threesUnder21ft: threeShort,
    zoneShare: Object.fromEntries(Object.entries(zoneCount).map(([k, v]) => [k, +(100 * v / (fgaPlays - fgaNoCoord)).toFixed(1)])),
  },
};
console.table(rows.map(({ perTeam, teamMin, _an, boxFlags, ...r }) => ({ ...r, perTeam: perTeam.join('/'), teamMin: teamMin.join('/') })));
console.log(JSON.stringify(summary, null, 1));
if (jsonOut) await writeFile(jsonOut, JSON.stringify({ summary, rows }, null, 1));
