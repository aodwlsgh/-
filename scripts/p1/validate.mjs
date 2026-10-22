// P1 completion check on the 20-game sample (plan §3 P1). Uses engine/collect + engine/parse.
// Games whose play-by-play is incomplete are excluded and replaced from the same date.
// Usage: NODE_USE_ENV_PROXY=1 node scripts/p1/validate.mjs [--out docs/reports/p1-validation.json]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createCollector } from '../../engine/collect.js';
import { fsCache } from '../../jobs/lib/fs-cache.js';
import { checkSummaryQuality } from '../../engine/schema/espn.js';
import {
  teamsOf, toPossessions, toStints, possessionEstimate, pbpTotals, boxTotals, shotZone, checkIntegrity, category, HOOP,
} from '../../engine/parse.js';

const outPath = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'docs/reports/p1-validation.json';
// same dates and counts as the P0 sample
const PLAN = [
  ['20250115', 3], ['20250310', 1], ['20251104', 3], ['20260120', 3], ['20260325', 2],
  ['20251225', 3], ['20261020', 2], ['20261021', 3],
];
const LIMITS = { meanAbsPct: 2, maxAbsPct: 3.5, homeAwayDiff: 2 };

const col = createCollector({ cache: fsCache() });
const games = [], excluded = [];
for (const [date, k] of PLAN) {
  const sb = await col.schedule(date);
  const fin = sb.events.filter(e => e.season.slug === 'regular-season' && e.competitions[0].status.type.name === 'STATUS_FINAL');
  let taken = 0;
  for (const e of fin) {
    if (taken === k) break;
    const s = await col.game(e.id);
    const integ = checkIntegrity(s);
    if (!integ.usable.pbp) { excluded.push({ id: e.id, game: e.shortName, date, issues: integ.issues }); continue; }
    games.push({ id: e.id, date, name: e.shortName, s });
    taken++;
  }
}

const rows = [];
const zoneCount = { ra: 0, paint: 0, mid: 0, c3: 0, ab3: 0, none: 0 };
const zoneCheck = { fga: 0, withCoord: 0, textDist: 0, within2ft: 0, absErrSum: 0, threeInside21: 0, twoOutside24: 0 };
const fgaCompare = { pbpFga: 0, boxFga: 0, pbpTpa: 0, boxTpa: 0, heaves: 0, teamsMismatch: [] };
for (const g of games) {
  const s = g.s;
  const { home, away } = teamsOf(s);
  const poss = toPossessions(s);
  const est = possessionEstimate(s);
  const st = toStints(s);
  const integ = checkIntegrity(s, { stints: st });
  const pt = pbpTotals(s), bt = boxTotals(s);
  const c = t => poss.count[t] ?? 0;
  const sumC = c(home) + c(away);
  const err2 = 100 * (sumC - (est[home].formula2 + est[away].formula2)) / (est[home].formula2 + est[away].formula2);
  const err1 = 100 * (sumC - (est[home].formula1 + est[away].formula1)) / (est[home].formula1 + est[away].formula1);
  for (const t of [home, away]) {
    fgaCompare.pbpFga += pt[t].fga; fgaCompare.boxFga += bt[t].fga;
    fgaCompare.pbpTpa += pt[t].tpa; fgaCompare.boxTpa += bt[t].tpa;
    fgaCompare.heaves += pt[t].heaves;
    if (pt[t].fga !== bt[t].fga || pt[t].tpa !== bt[t].tpa) fgaCompare.teamsMismatch.push(`${g.name} ${t}: FGA ${pt[t].fga}/${bt[t].fga} 3PA ${pt[t].tpa}/${bt[t].tpa}`);
  }
  for (const pl of s.plays) {
    const cat = category(pl);
    if (cat !== 'fga') continue;
    zoneCheck.fga++;
    const z = shotZone(pl);
    zoneCount[z ?? 'none']++;
    const has = pl.coordinate && pl.coordinate.x > -1e6;
    if (has) zoneCheck.withCoord++;
    const m = (pl.text ?? '').match(/(\d+)-foot/);
    if (has) {
      const d = Math.hypot(pl.coordinate.x - HOOP.x, pl.coordinate.y - HOOP.y);
      if (m) { zoneCheck.textDist++; const e = Math.abs(d - +m[1]); zoneCheck.absErrSum += e; if (e <= 2) zoneCheck.within2ft++; }
      if (pl.pointsAttempted === 3 && d < 21) zoneCheck.threeInside21++;
      if (pl.pointsAttempted === 2 && d > 24) zoneCheck.twoOutside24++;
    }
  }
  const secsBox = {};
  for (const t of s.boxscore.players) for (const a of t.statistics[0].athletes) {
    const v = a.didNotPlay ? 0 : +(a.stats[0] ?? 0);
    if (a.athlete?.id && Number.isFinite(v)) secsBox[a.athlete.id] = v;
  }
  const minDiffs = Object.entries(secsBox).map(([id, m]) => Math.abs((st.seconds[id] ?? 0) / 60 - m));
  rows.push({
    id: g.id, game: `${s.header.competitions[0].date.slice(0, 10)} ${g.name}`,
    poss: { home: c(home), away: c(away) }, est2: +((est[home].formula2 + est[away].formula2) / 2).toFixed(1),
    errPct2: +err2.toFixed(2), errPct1: +err1.toFixed(2), homeAwayDiff: Math.abs(c(home) - c(away)),
    stints: st.stints.length, stintsNot5: st.stints.filter(x => Object.values(x.lineups).some(l => l.length !== 5)).length,
    teamMinutes: Object.values(st.teamMinutes).map(m => +m.toFixed(1)), expectedMinutes: st.expectedMinutes,
    playersWithin1Min: `${minDiffs.filter(d => d <= 1).length}/${minDiffs.length}`, maxMinDiff: +Math.max(...minDiffs).toFixed(2),
    anomalies: st.anomalies, issues: integ.issues.map(i => i.code + (i.team ? `(${i.team})` : '')), usable: integ.usable,
    quality: checkSummaryQuality(s),
  });
}

const abs2 = rows.map(r => Math.abs(r.errPct2));
const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
const summary = {
  games: rows.length,
  excluded: excluded.map(e => ({ id: e.id, game: `${e.date} ${e.game}`, reason: e.issues.map(i => `${i.code}: ${i.detail ?? ''}`).join('; ') })),
  possessions: {
    criterion: LIMITS,
    meanAbsPct: +mean(abs2).toFixed(2), maxAbsPct: +Math.max(...abs2).toFixed(2), meanSignedPct: +mean(rows.map(r => r.errPct2)).toFixed(2),
    maxHomeAwayDiff: Math.max(...rows.map(r => r.homeAwayDiff)),
    gamesHomeAwayOver2: rows.filter(r => r.homeAwayDiff > LIMITS.homeAwayDiff).map(r => r.game),
    formula1Reference: { meanAbsPct: +mean(rows.map(r => Math.abs(r.errPct1))).toFixed(2), within2: `${rows.filter(r => Math.abs(r.errPct1) <= 2).length}/${rows.length}` },
  },
  stints: {
    stintsTotal: rows.reduce((a, r) => a + r.stints, 0), stintsNot5: rows.reduce((a, r) => a + r.stintsNot5, 0),
    playersWithin1Min: (() => { const [a, b] = rows.reduce(([x, y], r) => { const [p, q] = r.playersWithin1Min.split('/').map(Number); return [x + p, y + q]; }, [0, 0]); return `${a}/${b}`; })(),
    gamesTeamMinutesExact: `${rows.filter(r => r.teamMinutes.every(m => Math.abs(m - r.expectedMinutes) <= 1)).length}/${rows.length}`,
    maxPlayerMinDiff: Math.max(...rows.map(r => r.maxMinDiff)),
    anomalies: rows.reduce((acc, r) => { for (const [k, v] of Object.entries(r.anomalies)) acc[k] = (acc[k] || 0) + v; return acc; }, {}),
    gamesStintsUnusable: rows.filter(r => !r.usable.stints).map(r => r.game),
  },
  shots: {
    ...zoneCheck, meanDistErrFt: +(zoneCheck.absErrSum / zoneCheck.textDist).toFixed(2),
    zoneSharePct: Object.fromEntries(Object.entries(zoneCount).map(([k, v]) => [k, +(100 * v / zoneCheck.fga).toFixed(1)])),
    fgaCompare,
  },
};
summary.possessions.pass = summary.possessions.meanAbsPct <= LIMITS.meanAbsPct && summary.possessions.maxAbsPct <= LIMITS.maxAbsPct && summary.possessions.maxHomeAwayDiff <= LIMITS.homeAwayDiff;

console.table(rows.map(r => ({ game: r.game, poss: `${r.poss.home}/${r.poss.away}`, est2: r.est2, err2: r.errPct2, err1: r.errPct1, haDiff: r.homeAwayDiff, min: r.teamMinutes.join('/'), within1: r.playersWithin1Min, issues: r.issues.join(',') })));
console.log(JSON.stringify(summary, null, 1));
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), summary, rows }, null, 1));
