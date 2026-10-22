// P2 summary from data/checks/*.json and data/games/**: per-season check failures, possession
// error distribution, >3.5% games with diagnostics, heave-rule agreement. Writes docs/reports/p2-summary.json.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const SEASONS = ['2023-24', '2024-25', '2025-26', '2026-27'];
const LIMITS = { meanAbsPct: 2, p95AbsPct: 3.5, gameMaxPct: 3.5, excludedRatio: 0.05 };
const pct = (a, b) => (b ? +(100 * a / b).toFixed(2) : null);
const quantile = (xs, q) => { const s = [...xs].sort((a, b) => a - b); const i = (s.length - 1) * q; const lo = Math.floor(i); return +(s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo)).toFixed(3); };

const excludedAll = JSON.parse(await readFile('data/excluded_games.json', 'utf8'));
const out = { generatedAt: new Date().toISOString(), limits: LIMITS, seasons: {} };
for (const season of SEASONS) {
  let c;
  try { c = JSON.parse(await readFile(`data/checks/${season}.json`, 'utf8')); } catch { continue; }
  const sched = JSON.parse(await readFile(`data/schedule/${season}.json`, 'utf8'));
  const rows = c.checks;
  const usable = rows.filter(r => r.pbpComplete);
  const abs = usable.map(r => Math.abs(r.errPct2));
  const fails = {};
  for (const r of rows) for (const f of r.failed) fails[f] = (fails[f] || 0) + 1;
  const dataExcluded = excludedAll.filter(x => x.season === season && x.stage === 'data');

  // >3.5% games with per-game diagnostics from the stored record
  const over = usable.filter(r => Math.abs(r.errPct2) > LIMITS.gameMaxPct);
  const recsByDate = new Map();
  const overDetail = [];
  for (const r of over) {
    if (!recsByDate.has(r.usDate)) recsByDate.set(r.usDate, JSON.parse(gunzipSync(await readFile(`data/games/${season}/${r.usDate}.json.gz`))));
    const g = recsByDate.get(r.usDate).find(x => x.id === r.id);
    const hv = g.checks.heaveRule === 'excluded' ? g.checks.heaves[0] + g.checks.heaves[1] : 0;
    const est = g.checks.est2[0] + g.checks.est2[1], poss = g.checks.poss[0] + g.checks.poss[1];
    const adjErr = +(100 * (poss - (est + hv)) / (est + hv)).toFixed(2);
    const defects = r.issues.filter(x => !x.startsWith('fga_mismatch'));
    const cause = Math.abs(adjErr) <= LIMITS.gameMaxPct && hv > 0
      ? `heave ${hv}개가 2025-26부터 박스 FGA에서 빠져 추정식이 그만큼 적게 셈 (heave를 FGA에 되돌리면 ${adjErr}%)`
      : defects.length ? `데이터 결함: ${defects.join(', ')}` : '데이터 결함 없음; 추정식 자체 오차로 추정 (원인 미확정)';
    overDetail.push({ id: r.id, usDate: r.usDate, game: r.matchup, errPct2: r.errPct2, heaves: hv, heaveAdjustedErrPct: adjErr, periods: g.periods, issues: r.issues, cause });
  }

  const heaveGames = rows.filter(r => r.heaves[0] + r.heaves[1] > 0);
  // diagnostic: estimator with heaves added back to FGA (box excludes them from 2025-26)
  const adjAbs = [];
  for (const r of usable) {
    if (!recsByDate.has(r.usDate)) recsByDate.set(r.usDate, JSON.parse(gunzipSync(await readFile(`data/games/${season}/${r.usDate}.json.gz`))));
    const g = recsByDate.get(r.usDate).find(x => x.id === r.id);
    const hv = g.checks.heaveRule === 'excluded' ? g.checks.heaves[0] + g.checks.heaves[1] : 0;
    const est = g.checks.est2[0] + g.checks.est2[1] + hv;
    adjAbs.push(Math.abs(100 * (g.checks.poss[0] + g.checks.poss[1] - est) / est));
    r.periods = g.periods;
  }
  out.seasons[season] = {
    scheduled: sched.games, checked: rows.length,
    dataExcluded: dataExcluded.length, dataExcludedPct: pct(dataExcluded.length, sched.games), stopRuleTriggered: dataExcluded.length > LIMITS.excludedRatio * sched.games,
    failures: Object.fromEntries(Object.entries(fails).map(([k, v]) => [k, { count: v, pct: pct(v, rows.length) }])),
    possessions: {
      games: usable.length, meanAbsPct: +(abs.reduce((a, b) => a + b, 0) / abs.length).toFixed(3), p95AbsPct: quantile(abs, 0.95),
      p99AbsPct: quantile(abs, 0.99), maxAbsPct: +Math.max(...abs).toFixed(3),
      meanSignedPct: +(usable.reduce((a, r) => a + r.errPct2, 0) / usable.length).toFixed(3),
      formula1MeanAbsPct: +(usable.reduce((a, r) => a + Math.abs(r.errPct1), 0) / usable.length).toFixed(3),
      homeAwayDiffOver2: usable.filter(r => r.haDiff > 2).length,
      homeAwayDiffOverAllowance: usable.filter(r => r.haDiff > 2 + Math.max(0, r.periods - 4)).map(r => ({ id: r.id, usDate: r.usDate, game: r.matchup, haDiff: r.haDiff, periods: r.periods })),
      heaveAdjusted: { meanAbsPct: +(adjAbs.reduce((a, b) => a + b, 0) / adjAbs.length).toFixed(3), p95AbsPct: quantile(adjAbs, 0.95), over35: adjAbs.filter(x => x > LIMITS.gameMaxPct).length },
      over35: overDetail,
    },
    heave: {
      rule: rows[0]?.heaveRule, gamesWithHeave: heaveGames.length, heavePlays: rows.reduce((a, r) => a + r.heaves[0] + r.heaves[1], 0),
      fgaMatchAll: `${rows.filter(r => r.fgaMatch).length}/${rows.length}`, fgaMatchAllPct: pct(rows.filter(r => r.fgaMatch).length, rows.length),
      fgaMatchHeaveGames: `${heaveGames.filter(r => r.fgaMatch).length}/${heaveGames.length}`,
      mismatches: rows.filter(r => !r.fgaMatch).map(r => ({ id: r.id, usDate: r.usDate, game: r.matchup, heaves: r.heaves, pbpComplete: r.pbpComplete, issues: r.issues })),
    },
    teamMinutes: {
      ok: `${rows.filter(r => r.teamMinutesOk).length}/${rows.length}`, okPct: pct(rows.filter(r => r.teamMinutesOk).length, rows.length),
      failures: rows.filter(r => !r.teamMinutesOk).map(r => ({ id: r.id, usDate: r.usDate, game: r.matchup, teamMinutes: r.teamMinutes, pbpComplete: r.pbpComplete, issues: r.issues })),
    },
  };
  const s = out.seasons[season].possessions;
  s.pass = s.meanAbsPct <= LIMITS.meanAbsPct && s.p95AbsPct <= LIMITS.p95AbsPct;
}
const all = Object.values(out.seasons).flatMap(() => []);
await writeFile('docs/reports/p2-summary.json', JSON.stringify(out, null, 1));
for (const [season, s] of Object.entries(out.seasons)) {
  console.log(`\n== ${season}: checked ${s.checked}/${s.scheduled}, data-excluded ${s.dataExcluded} (${s.dataExcludedPct}%)`);
  console.log(' failures', JSON.stringify(s.failures));
  const { over35, ...p } = s.possessions;
  console.log(' possessions', JSON.stringify(p), `over3.5: ${over35.length}`);
  const { mismatches, ...h } = s.heave;
  console.log(' heave', JSON.stringify(h), `mismatches: ${mismatches.length}`);
  console.log(' teamMinutes', JSON.stringify(s.teamMinutes));
}
void all;
